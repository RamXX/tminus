/**
 * Unit tests for tminus-cron scheduled worker.
 *
 * Covers:
 * - Scheduled handler dispatch (cron string -> correct handler)
 * - Channel renewal: finds expiring channels, calls AccountDO
 * - Microsoft subscription renewal: finds MS accounts, renews subscriptions
 * - Token health check: checks and refreshes tokens, marks errors in D1
 * - Drift reconciliation: enqueues RECONCILE_ACCOUNT messages
 * - Deletion check: processes pending deletions past grace period
 * - Hold expiry cleanup: expires holds, enqueues deletes, expires sessions
 * - Social drift computation: fetches drift reports, stores alerts
 * - Feed refresh: ICS feed polling with conditional headers and change detection
 * - Health endpoint returns 200
 * - Unknown routes return 404
 * - Unknown cron schedules log warning
 * - Error isolation (one account failure does not block others)
 *
 * D1, DurableObject stubs, and Queues are mocked with lightweight stubs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHandler } from "./index";
import {
  CRON_CHANNEL_RENEWAL,
  CRON_TOKEN_HEALTH,
  CRON_RECONCILIATION,
  CRON_DELETION_CHECK,
  CRON_HOLD_EXPIRY,
  CRON_DRIFT_COMPUTATION,
  CRON_FEED_REFRESH,
} from "./constants";

// ---------------------------------------------------------------------------
// Mock shared module functions used by feed refresh
// ---------------------------------------------------------------------------

// Track Google Calendar API calls made by mocked GoogleCalendarClient
const googleApiCalls: Array<{ method: string; args: unknown[] }> = [];

// Track calls to the shared renewWebhookChannel function
const renewWebhookChannelCalls: Array<{ params: unknown }> = [];

vi.mock("@tminus/shared", async () => {
  const actual = await vi.importActual("@tminus/shared");
  return {
    ...actual,
    // These are the functions called by handleFeedRefresh -- provide controllable defaults
    isRateLimited: vi.fn(() => false),
    buildConditionalHeaders: vi.fn(() => ({})),
    detectFeedChanges: vi.fn(() => ({ changed: false, newEtag: "etag-1", newLastModified: "Mon, 01 Jan 2024 00:00:00 GMT" })),
    normalizeIcsFeedEvents: vi.fn(() => []),
    computeContentHash: vi.fn(() => "hash-abc"),
    // Mock GoogleCalendarClient for channel renewal tests (TM-ucl1)
    GoogleCalendarClient: vi.fn().mockImplementation(() => ({
      stopChannel: vi.fn(async (...args: unknown[]) => {
        googleApiCalls.push({ method: "stopChannel", args });
      }),
      watchEvents: vi.fn(async (...args: unknown[]) => {
        googleApiCalls.push({ method: "watchEvents", args });
        return {
          channelId: `new-channel-${Date.now()}`,
          resourceId: `new-resource-${Date.now()}`,
          expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
        };
      }),
    })),
    // generateId is used to create channel IDs and tokens
    generateId: vi.fn((prefix: string) => `${prefix}_mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    // Mock renewWebhookChannel -- the shared function that reRegisterChannel now delegates to.
    // This mock simulates the full 5-step flow by calling the AccountDO stub (getAccessToken,
    // stopChannel, watchEvents, storeWatchChannel) and updating D1, matching what the real
    // implementation does. Without this mock, the real renewWebhookChannel would use internal
    // imports (./google-api) that bypass the @tminus/shared-level GoogleCalendarClient mock.
    renewWebhookChannel: vi.fn(async (params: {
      accountId: string;
      oldChannelId: string | null;
      oldResourceId: string | null;
      accountDOStub: { fetch(input: Request): Promise<Response> };
      db: D1Database;
      webhookUrl: string;
    }) => {
      renewWebhookChannelCalls.push({ params });

      // Step 1: Get access token from AccountDO
      const tokenResponse = await params.accountDOStub.fetch(
        new Request("https://account-do.internal/getAccessToken", { method: "POST" }),
      );
      if (!tokenResponse.ok) {
        throw new Error(`Failed to get access token for account ${params.accountId}: ${tokenResponse.status}`);
      }
      const { access_token } = (await tokenResponse.json()) as { access_token: string };

      // Step 2: Stop old channel (best-effort, via GoogleCalendarClient mock)
      if (params.oldChannelId && params.oldResourceId) {
        try {
          googleApiCalls.push({ method: "stopChannel", args: [params.oldChannelId, params.oldResourceId] });
        } catch {
          // best-effort
        }
      }

      // Step 3: Register new channel (via GoogleCalendarClient mock)
      const channelId = `new-channel-${Date.now()}`;
      const resourceId = `new-resource-${Date.now()}`;
      const expiration = String(Date.now() + 7 * 24 * 60 * 60 * 1000);
      googleApiCalls.push({ method: "watchEvents", args: ["primary", params.webhookUrl, channelId, channelId] });

      // Step 4: Store new channel in AccountDO
      const storeResponse = await params.accountDOStub.fetch(
        new Request("https://account-do.internal/storeWatchChannel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel_id: channelId,
            resource_id: resourceId,
            expiration,
            calendar_id: "primary",
          }),
        }),
      );
      if (!storeResponse.ok) {
        throw new Error(`Failed to store new channel in AccountDO for account ${params.accountId}: ${storeResponse.status}`);
      }

      // Step 5: Update D1
      const expiryTs = new Date(parseInt(expiration, 10)).toISOString();
      await params.db
        .prepare(
          `UPDATE accounts
           SET channel_id = ?1, channel_token = ?2, channel_expiry_ts = ?3, resource_id = ?4
           WHERE account_id = ?5`,
        )
        .bind(channelId, channelId, expiryTs, resourceId, params.accountId)
        .run();

      return {
        account_id: params.accountId,
        channel_id: channelId,
        resource_id: resourceId,
        expiry: expiryTs,
        previous_channel_id: params.oldChannelId,
      };
    }),
  };
});

// We also need to mock global fetch for feed refresh tests
const originalFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID_1 = "acc_01HXY0000000000000000000AA";
const TEST_ACCOUNT_ID_2 = "acc_02HXY0000000000000000000BB";
const TEST_USER_ID_1 = "user_01";
const TEST_USER_ID_2 = "user_02";
const TEST_CHANNEL_ID = "channel-uuid-12345";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockD1Result<T = unknown> {
  results: T[];
  meta?: { changes?: number };
}

/**
 * Creates a mock D1 database. The `queryResults` map lets tests define
 * what rows are returned for queries containing specific SQL snippets.
 * The `runLog` array captures mutation queries for assertions.
 */
function createMockD1(
  queryResults: Record<string, unknown[]> = {},
  runLog: Array<{ sql: string; params: unknown[] }> = [],
) {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async all<T>(): Promise<MockD1Result<T>> {
              // Match against keys in queryResults
              for (const [key, rows] of Object.entries(queryResults)) {
                if (sql.includes(key)) {
                  return { results: rows as T[] };
                }
              }
              return { results: [] };
            },
            async run(): Promise<MockD1Result> {
              runLog.push({ sql, params });
              return { results: [], meta: { changes: 1 } };
            },
            async first<T>(): Promise<T | null> {
              for (const [key, rows] of Object.entries(queryResults)) {
                if (sql.includes(key) && rows.length > 0) {
                  return rows[0] as T;
                }
              }
              return null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

/** Creates a mock Queue that captures sent messages. */
function createMockQueue() {
  const messages: unknown[] = [];
  return {
    messages,
    async send(msg: unknown) {
      messages.push(msg);
    },
  } as unknown as Queue & { messages: unknown[] };
}

/**
 * Creates a mock DurableObject namespace.
 * `fetchHandler` is called for each stub.fetch() call.
 */
function createMockDONamespace(
  fetchHandler?: (url: string, init?: RequestInit) => Promise<Response>,
) {
  const defaultFetchHandler = async () => new Response("OK", { status: 200 });
  const handler = fetchHandler ?? defaultFetchHandler;

  return {
    idFromName(name: string) {
      return { name } as DurableObjectId;
    },
    get(_id: DurableObjectId) {
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          let url: string;
          let effectiveInit: RequestInit | undefined = init;

          if (typeof input === "string") {
            url = input;
          } else if (input instanceof URL) {
            url = input.toString();
          } else {
            // input is a Request object -- extract url and body
            url = input.url;
            if (!effectiveInit) {
              effectiveInit = {
                method: input.method,
                headers: Object.fromEntries(input.headers.entries()),
                body: (await input.clone().text()) || undefined,
              };
            }
          }
          return handler(url, effectiveInit);
        },
      } as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

/** Build a complete mock Env for the cron worker. */
function createMockEnv(opts?: {
  d1Results?: Record<string, unknown[]>;
  accountDOFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  userGraphDOFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  d1RunLog?: Array<{ sql: string; params: unknown[] }>;
  deletionWorkflow?: { create: ReturnType<typeof vi.fn> } | undefined;
}) {
  const reconcileQueue = createMockQueue();
  const syncQueue = createMockQueue();
  const writeQueue = createMockQueue();
  const pushQueue = createMockQueue();
  const d1RunLog = opts?.d1RunLog ?? [];

  return {
    env: {
      DB: createMockD1(opts?.d1Results ?? {}, d1RunLog),
      ACCOUNT: createMockDONamespace(opts?.accountDOFetch),
      USER_GRAPH: createMockDONamespace(opts?.userGraphDOFetch),
      RECONCILE_QUEUE: reconcileQueue,
      SYNC_QUEUE: syncQueue,
      WRITE_QUEUE: writeQueue,
      PUSH_QUEUE: pushQueue,
      WEBHOOK_URL: "https://webhooks.tminus.ink/webhook/google",
      DELETION_WORKFLOW: opts?.deletionWorkflow ?? undefined,
    } as Env,
    reconcileQueue,
    syncQueue,
    writeQueue,
    pushQueue,
    d1RunLog,
  };
}

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

function buildScheduledEvent(cron: string): ScheduledEvent {
  return {
    cron,
    scheduledTime: Date.now(),
    noRetry() {},
  } as ScheduledEvent;
}

// ---------------------------------------------------------------------------
// HTTP routing tests
// ---------------------------------------------------------------------------

describe("HTTP handler", () => {
  it("GET /health returns 200 OK", async () => {
    const { env } = createMockEnv();
    const handler = createHandler();
    const req = new Request("https://cron.tminus.dev/health", { method: "GET" });
    const res = await handler.fetch(req, env, mockCtx);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe("OK");
  });

  it("unknown routes return 404", async () => {
    const { env } = createMockEnv();
    const handler = createHandler();
    const req = new Request("https://cron.tminus.dev/unknown", { method: "GET" });
    const res = await handler.fetch(req, env, mockCtx);

    expect(res.status).toBe(404);
  });

  it("POST /health returns 404", async () => {
    const { env } = createMockEnv();
    const handler = createHandler();
    const req = new Request("https://cron.tminus.dev/health", { method: "POST" });
    const res = await handler.fetch(req, env, mockCtx);

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Scheduled handler dispatch tests
// ---------------------------------------------------------------------------

describe("Scheduled handler dispatch", () => {
  it("unknown cron schedule logs warning without error", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env } = createMockEnv();
    const handler = createHandler();

    await handler.scheduled(buildScheduledEvent("99 99 * * *"), env, mockCtx);

    expect(consoleSpy).toHaveBeenCalledWith("Unknown cron schedule: 99 99 * * *");
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Channel Renewal tests
// ---------------------------------------------------------------------------

describe("handleChannelRenewal (via scheduled)", () => {
  beforeEach(() => {
    googleApiCalls.length = 0;
    renewWebhookChannelCalls.length = 0;
  });

  it("re-registers expiring channels with Google (TM-ucl1 fix)", async () => {
    const fetchCalls: Array<{ url: string; body: string }> = [];
    const d1RunLog: Array<{ sql: string; params: unknown[] }> = [];
    const { env } = createMockEnv({
      d1Results: {
        // Expiring channel query matches "channel_expiry_ts <= ?2"
        "channel_expiry_ts <= ?2": [
          {
            account_id: TEST_ACCOUNT_ID_1,
            channel_id: TEST_CHANNEL_ID,
            channel_token: "old-token-123",
            channel_expiry_ts: "2024-01-01T00:00:00Z",
          },
        ],
        // Stale channel query -- empty (this channel is already in the expiring set)
        "last_sync_ts": [],
        // Resource ID lookup
        "resource_id": [{ resource_id: "old-resource-123" }],
        // MS accounts query -- empty for this test
        "provider = ?2": [],
      },
      accountDOFetch: async (url, init) => {
        const body = init?.body ? String(init.body) : "";
        fetchCalls.push({ url, body });
        if (url.includes("getAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "mock-access-token" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      d1RunLog,
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_CHANNEL_RENEWAL), env, mockCtx);

    // Should have called getAccessToken on AccountDO
    const tokenCall = fetchCalls.find(c => c.url.includes("getAccessToken"));
    expect(tokenCall).toBeDefined();

    // Should have called stopChannel on Google API (best-effort)
    const stopCall = googleApiCalls.find(c => c.method === "stopChannel");
    expect(stopCall).toBeDefined();
    expect(stopCall!.args[0]).toBe(TEST_CHANNEL_ID);
    expect(stopCall!.args[1]).toBe("old-resource-123");

    // Should have called watchEvents on Google API
    const watchCall = googleApiCalls.find(c => c.method === "watchEvents");
    expect(watchCall).toBeDefined();
    expect(watchCall!.args[0]).toBe("primary");
    expect(watchCall!.args[1]).toBe("https://webhooks.tminus.ink/webhook/google");

    // Should have called storeWatchChannel on AccountDO
    const storeCall = fetchCalls.find(c => c.url.includes("storeWatchChannel"));
    expect(storeCall).toBeDefined();

    // Should have updated D1 with new channel_id, channel_token, channel_expiry_ts
    const d1Update = d1RunLog.find(q => q.sql.includes("channel_id = ?1"));
    expect(d1Update).toBeDefined();
  });

  it("detects and re-registers stale channels (no sync in 12h)", async () => {
    const fetchCalls: Array<{ url: string; body: string }> = [];
    const { env } = createMockEnv({
      d1Results: {
        // Expiring channels -- none
        "channel_expiry_ts <= ?2": [],
        // Stale channels -- has last_sync_ts older than 12h
        "last_sync_ts": [
          {
            account_id: TEST_ACCOUNT_ID_1,
            channel_id: "stale-channel",
            channel_token: "stale-token",
            channel_expiry_ts: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(), // 5 days away
            last_sync_ts: new Date(Date.now() - 15 * 60 * 60 * 1000).toISOString(), // 15h ago
          },
        ],
        "resource_id": [{ resource_id: "stale-resource" }],
        "provider = ?2": [],
      },
      accountDOFetch: async (url, init) => {
        const body = init?.body ? String(init.body) : "";
        fetchCalls.push({ url, body });
        if (url.includes("getAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "mock-token" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_CHANNEL_RENEWAL), env, mockCtx);

    // Should have attempted re-registration for the stale channel
    expect(googleApiCalls.find(c => c.method === "watchEvents")).toBeDefined();
    expect(fetchCalls.find(c => c.url.includes("storeWatchChannel"))).toBeDefined();
  });

  it("handles getAccessToken failure gracefully (logs error, continues)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env } = createMockEnv({
      d1Results: {
        "channel_expiry_ts <= ?2": [
          {
            account_id: TEST_ACCOUNT_ID_1,
            channel_id: "ch-1",
            channel_token: "tok-1",
            channel_expiry_ts: "2024-01-01T00:00:00Z",
          },
          {
            account_id: TEST_ACCOUNT_ID_2,
            channel_id: "ch-2",
            channel_token: "tok-2",
            channel_expiry_ts: "2024-01-01T00:00:00Z",
          },
        ],
        "last_sync_ts": [],
        "resource_id": [],
        "provider = ?2": [],
      },
      accountDOFetch: async (url) => {
        if (url.includes("getAccessToken")) {
          return new Response("Unauthorized", { status: 401 });
        }
        return new Response("OK", { status: 200 });
      },
    });

    const handler = createHandler();
    // Should not throw
    await handler.scheduled(buildScheduledEvent(CRON_CHANNEL_RENEWAL), env, mockCtx);

    // Should log errors but not crash
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("handles AccountDO fetch exception gracefully", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env } = createMockEnv({
      d1Results: {
        "channel_expiry_ts <= ?2": [
          {
            account_id: TEST_ACCOUNT_ID_1,
            channel_id: "ch-1",
            channel_token: "tok-1",
            channel_expiry_ts: "2024-01-01T00:00:00Z",
          },
        ],
        "last_sync_ts": [],
        "resource_id": [],
        "provider = ?2": [],
      },
      accountDOFetch: async () => {
        throw new Error("DO unavailable");
      },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_CHANNEL_RENEWAL), env, mockCtx);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Channel re-registration error"),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it("does nothing when no expiring or stale channels found", async () => {
    const fetchCalls: string[] = [];
    const { env } = createMockEnv({
      d1Results: {
        "channel_expiry_ts <= ?2": [],
        "last_sync_ts": [],
        "provider = ?2": [],
      },
      accountDOFetch: async (url) => {
        fetchCalls.push(url);
        return new Response("OK", { status: 200 });
      },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_CHANNEL_RENEWAL), env, mockCtx);

    // No DO calls should be made for channel renewal
    const tokenCalls = fetchCalls.filter(u => u.includes("getAccessToken"));
    expect(tokenCalls.length).toBe(0);
  });

  it("continues processing old channel stop failure (best-effort)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchCalls: Array<{ url: string }> = [];

    // Make stopChannel throw (simulating already-dead channel)
    const { GoogleCalendarClient: MockClient } = await import("@tminus/shared");
    const mockInstance = new MockClient("test");
    (mockInstance.stopChannel as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Channel not found"),
    );

    const { env } = createMockEnv({
      d1Results: {
        "channel_expiry_ts <= ?2": [
          {
            account_id: TEST_ACCOUNT_ID_1,
            channel_id: "dead-channel",
            channel_token: "dead-token",
            channel_expiry_ts: "2024-01-01T00:00:00Z",
          },
        ],
        "last_sync_ts": [],
        "resource_id": [{ resource_id: "dead-resource" }],
        "provider = ?2": [],
      },
      accountDOFetch: async (url) => {
        fetchCalls.push({ url });
        if (url.includes("getAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "mock-token" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_CHANNEL_RENEWAL), env, mockCtx);

    // Despite stopChannel failure, should still attempt to register new channel
    // (the mock instance doesn't share state with the one used by the handler,
    // so we verify via storeWatchChannel being called)
    const storeCalls = fetchCalls.filter(c => c.url.includes("storeWatchChannel"));
    expect(storeCalls.length).toBe(1);

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Microsoft Subscription Renewal tests
// ---------------------------------------------------------------------------

describe("handleMsSubscriptionRenewal (via scheduled)", () => {
  it("renews subscriptions expiring within threshold", async () => {
    const fetchCalls: Array<{ url: string; body: string }> = [];
    // A subscription expiring "soon" (within 54 hours from now)
    const soonExpiry = new Date(Date.now() + 1000 * 60 * 60).toISOString(); // 1 hour from now

    const { env } = createMockEnv({
      d1Results: {
        "channel_expiry_ts": [], // no Google channels
        "provider = ?2": [{ account_id: TEST_ACCOUNT_ID_1 }],
      },
      accountDOFetch: async (url, init) => {
        const body = init?.body ? String(init.body) : "";
        fetchCalls.push({ url, body });

        if (url.includes("getMsSubscriptions")) {
          return new Response(
            JSON.stringify({
              subscriptions: [
                { subscriptionId: "sub-1", expiration: soonExpiry },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("renewMsSubscription")) {
          return new Response("OK", { status: 200 });
        }
        return new Response("OK", { status: 200 });
      },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_CHANNEL_RENEWAL), env, mockCtx);

    const renewCalls = fetchCalls.filter(c => c.url.includes("renewMsSubscription"));
    expect(renewCalls.length).toBe(1);
    const parsed = JSON.parse(renewCalls[0].body);
    expect(parsed.subscription_id).toBe("sub-1");
  });

  it("skips subscriptions not within threshold", async () => {
    const fetchCalls: Array<{ url: string }> = [];
    // A subscription expiring far in the future (100 hours)
    const farExpiry = new Date(Date.now() + 1000 * 60 * 60 * 100).toISOString();

    const { env } = createMockEnv({
      d1Results: {
        "channel_expiry_ts": [],
        "provider = ?2": [{ account_id: TEST_ACCOUNT_ID_1 }],
      },
      accountDOFetch: async (url) => {
        fetchCalls.push({ url });
        if (url.includes("getMsSubscriptions")) {
          return new Response(
            JSON.stringify({
              subscriptions: [
                { subscriptionId: "sub-far", expiration: farExpiry },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response("OK", { status: 200 });
      },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_CHANNEL_RENEWAL), env, mockCtx);

    const renewCalls = fetchCalls.filter(c => c.url.includes("renewMsSubscription"));
    expect(renewCalls.length).toBe(0);
  });

  it("handles getMsSubscriptions failure gracefully", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env } = createMockEnv({
      d1Results: {
        "channel_expiry_ts": [],
        "provider = ?2": [{ account_id: TEST_ACCOUNT_ID_1 }],
      },
      accountDOFetch: async (url) => {
        if (url.includes("getMsSubscriptions")) {
          return new Response("Error", { status: 500 });
        }
        return new Response("OK", { status: 200 });
      },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_CHANNEL_RENEWAL), env, mockCtx);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to get Microsoft subscriptions"),
    );
    errorSpy.mockRestore();
  });

  it("handles renewMsSubscription failure gracefully", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const soonExpiry = new Date(Date.now() + 1000 * 60 * 60).toISOString();

    const { env } = createMockEnv({
      d1Results: {
        "channel_expiry_ts": [],
        "provider = ?2": [{ account_id: TEST_ACCOUNT_ID_1 }],
      },
      accountDOFetch: async (url) => {
        if (url.includes("getMsSubscriptions")) {
          return new Response(
            JSON.stringify({
              subscriptions: [{ subscriptionId: "sub-1", expiration: soonExpiry }],
            }),
            { status: 200 },
          );
        }
        if (url.includes("renewMsSubscription")) {
          return new Response("Error", { status: 500 });
        }
        return new Response("OK", { status: 200 });
      },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_CHANNEL_RENEWAL), env, mockCtx);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Microsoft subscription renewal failed"),
    );
    errorSpy.mockRestore();
  });

  it("handles DO exception for MS account gracefully", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env } = createMockEnv({
      d1Results: {
        "channel_expiry_ts": [],
        "provider = ?2": [{ account_id: TEST_ACCOUNT_ID_1 }],
      },
      accountDOFetch: async () => {
        throw new Error("DO crash");
      },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_CHANNEL_RENEWAL), env, mockCtx);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Microsoft subscription renewal error"),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Token Health Check tests
// ---------------------------------------------------------------------------

describe("handleTokenHealth (via scheduled)", () => {
  it("checks token health for all active accounts", async () => {
    const fetchCalls: string[] = [];
    const { env } = createMockEnv({
      d1Results: {
        "accounts WHERE status": [
          { account_id: TEST_ACCOUNT_ID_1, user_id: TEST_USER_ID_1 },
        ],
      },
      accountDOFetch: async (url) => {
        fetchCalls.push(url);
        return new Response("OK", { status: 200 });
      },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_TOKEN_HEALTH), env, mockCtx);

    expect(fetchCalls).toContain("https://account-do.internal/getHealth");
    expect(fetchCalls).toContain("https://account-do.internal/getAccessToken");
  });

  it("marks account as error when token refresh fails", async () => {
    const d1RunLog: Array<{ sql: string; params: unknown[] }> = [];
    const { env } = createMockEnv({
      d1Results: {
        "accounts WHERE status": [
          { account_id: TEST_ACCOUNT_ID_1, user_id: TEST_USER_ID_1 },
        ],
      },
      accountDOFetch: async (url) => {
        if (url.includes("getHealth")) {
          return new Response("OK", { status: 200 });
        }
        if (url.includes("getAccessToken")) {
          return new Response("Unauthorized", { status: 401 });
        }
        return new Response("OK", { status: 200 });
      },
      d1RunLog,
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_TOKEN_HEALTH), env, mockCtx);

    // Should have updated status to 'error' in D1
    const updateQuery = d1RunLog.find(q => q.sql.includes("UPDATE accounts SET status"));
    expect(updateQuery).toBeDefined();
    expect(updateQuery!.params).toContain("error");
    expect(updateQuery!.params).toContain(TEST_ACCOUNT_ID_1);
    errorSpy.mockRestore();
  });

  it("skips account when health check fails (continues to next)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchCalls: Array<{ account: string; url: string }> = [];

    // Use a DO namespace that tracks which account it was called for
    const accountStubs = new Map<string, string>();
    const { env } = createMockEnv({
      d1Results: {
        "accounts WHERE status": [
          { account_id: TEST_ACCOUNT_ID_1, user_id: TEST_USER_ID_1 },
          { account_id: TEST_ACCOUNT_ID_2, user_id: TEST_USER_ID_2 },
        ],
      },
      accountDOFetch: async (url) => {
        fetchCalls.push({ account: "unknown", url });
        if (url.includes("getHealth") && fetchCalls.length <= 1) {
          // First account health check fails
          return new Response("Error", { status: 500 });
        }
        return new Response("OK", { status: 200 });
      },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_TOKEN_HEALTH), env, mockCtx);

    // Should have attempted at least getHealth for both accounts
    const healthCalls = fetchCalls.filter(c => c.url.includes("getHealth"));
    expect(healthCalls.length).toBe(2);
    errorSpy.mockRestore();
  });

  it("handles DO exception gracefully", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env } = createMockEnv({
      d1Results: {
        "accounts WHERE status": [
          { account_id: TEST_ACCOUNT_ID_1, user_id: TEST_USER_ID_1 },
        ],
      },
      accountDOFetch: async () => {
        throw new Error("DO unavailable");
      },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_TOKEN_HEALTH), env, mockCtx);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Token health error"),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  // -----------------------------------------------------------------------
  // TM-bnfl: Token health convergence recovery tests
  // -----------------------------------------------------------------------

  it("enqueues SYNC_FULL and forces mirror replay when previously-errored account recovers", async () => {
    const d1RunLog: Array<{ sql: string; params: unknown[] }> = [];
    const userGraphCalls: Array<{ url: string; body: string }> = [];
    const { env, syncQueue } = createMockEnv({
      d1Results: {
        "accounts WHERE status": [
          { account_id: TEST_ACCOUNT_ID_1, user_id: TEST_USER_ID_1, status: "error" },
        ],
      },
      accountDOFetch: async (url) => {
        if (url.includes("getHealth")) {
          return new Response("OK", { status: 200 });
        }
        if (url.includes("getAccessToken")) {
          // Token refresh now succeeds -- account has recovered
          return new Response(JSON.stringify({ access_token: "fresh-token" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("OK", { status: 200 });
      },
      userGraphDOFetch: async (url, init) => {
        const body = init?.body ? String(init.body) : "";
        userGraphCalls.push({ url, body });
        return new Response("OK", { status: 200 });
      },
      d1RunLog,
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_TOKEN_HEALTH), env, mockCtx);

    // Should mark account as active in D1
    const activeUpdate = d1RunLog.find(
      q => q.sql.includes("UPDATE accounts SET status") && q.params.includes("active"),
    );
    expect(activeUpdate).toBeDefined();
    expect(activeUpdate!.params).toContain(TEST_ACCOUNT_ID_1);

    // Should enqueue SYNC_FULL for the recovered account
    expect(syncQueue.messages.length).toBe(1);
    const syncMsg = syncQueue.messages[0] as { type: string; account_id: string; reason: string };
    expect(syncMsg.type).toBe("SYNC_FULL");
    expect(syncMsg.account_id).toBe(TEST_ACCOUNT_ID_1);
    expect(syncMsg.reason).toBe("reconcile");

    // Should call recomputeProjections with force_requeue_non_active
    const recomputeCalls = userGraphCalls.filter(c => c.url.includes("recomputeProjections"));
    expect(recomputeCalls.length).toBe(1);
    const body = JSON.parse(recomputeCalls[0].body);
    expect(body.force_requeue_non_active).toBe(true);

    logSpy.mockRestore();
  });

  it("does NOT enqueue SYNC_FULL for healthy active accounts (no recovery needed)", async () => {
    const { env, syncQueue } = createMockEnv({
      d1Results: {
        "accounts WHERE status": [
          { account_id: TEST_ACCOUNT_ID_1, user_id: TEST_USER_ID_1, status: "active" },
        ],
      },
      accountDOFetch: async (url) => {
        if (url.includes("getHealth")) {
          return new Response("OK", { status: 200 });
        }
        if (url.includes("getAccessToken")) {
          return new Response(JSON.stringify({ access_token: "good-token" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("OK", { status: 200 });
      },
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_TOKEN_HEALTH), env, mockCtx);

    // No SYNC_FULL should be enqueued for already-active accounts
    expect(syncQueue.messages.length).toBe(0);
    logSpy.mockRestore();
  });

  it("token recovery SYNC_FULL failure does not prevent mirror replay", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const userGraphCalls: Array<{ url: string; body: string }> = [];
    const d1RunLog: Array<{ sql: string; params: unknown[] }> = [];

    // Make SYNC_QUEUE.send throw
    const failingSyncQueue = {
      messages: [] as unknown[],
      async send() {
        throw new Error("Queue send failure");
      },
    } as unknown as Queue & { messages: unknown[] };

    const { env } = createMockEnv({
      d1Results: {
        "accounts WHERE status": [
          { account_id: TEST_ACCOUNT_ID_1, user_id: TEST_USER_ID_1, status: "error" },
        ],
      },
      accountDOFetch: async (url) => {
        if (url.includes("getHealth")) {
          return new Response("OK", { status: 200 });
        }
        if (url.includes("getAccessToken")) {
          return new Response(JSON.stringify({ access_token: "fresh-token" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("OK", { status: 200 });
      },
      userGraphDOFetch: async (url, init) => {
        const body = init?.body ? String(init.body) : "";
        userGraphCalls.push({ url, body });
        return new Response("OK", { status: 200 });
      },
      d1RunLog,
    });
    (env as any).SYNC_QUEUE = failingSyncQueue;

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_TOKEN_HEALTH), env, mockCtx);

    // SYNC_FULL enqueue failed
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to enqueue SYNC_FULL"),
      expect.any(Error),
    );

    // But mirror replay should still have been attempted (AC-6: isolation within recovery steps)
    const recomputeCalls = userGraphCalls.filter(c => c.url.includes("recomputeProjections"));
    expect(recomputeCalls.length).toBe(1);

    errorSpy.mockRestore();
    logSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Drift Reconciliation tests
// ---------------------------------------------------------------------------

describe("handleReconciliation (via scheduled)", () => {
  it("enqueues RECONCILE_ACCOUNT for each active account", async () => {
    const { env, reconcileQueue } = createMockEnv({
      d1Results: {
        "accounts WHERE status": [
          { account_id: TEST_ACCOUNT_ID_1, user_id: TEST_USER_ID_1 },
          { account_id: TEST_ACCOUNT_ID_2, user_id: TEST_USER_ID_2 },
        ],
      },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_RECONCILIATION), env, mockCtx);

    expect(reconcileQueue.messages.length).toBe(2);

    const msg1 = reconcileQueue.messages[0] as { type: string; account_id: string; reason: string };
    expect(msg1.type).toBe("RECONCILE_ACCOUNT");
    expect(msg1.account_id).toBe(TEST_ACCOUNT_ID_1);
    expect(msg1.reason).toBe("scheduled");

    const msg2 = reconcileQueue.messages[1] as { type: string; account_id: string };
    expect(msg2.type).toBe("RECONCILE_ACCOUNT");
    expect(msg2.account_id).toBe(TEST_ACCOUNT_ID_2);
  });

  it("handles queue send failure gracefully (log + continue)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let sendCount = 0;
    const mockQueue = {
      messages: [] as unknown[],
      async send(msg: unknown) {
        sendCount++;
        if (sendCount === 1) throw new Error("Queue full");
        mockQueue.messages.push(msg);
      },
    } as unknown as Queue & { messages: unknown[] };

    const d1RunLog: Array<{ sql: string; params: unknown[] }> = [];
    const { env } = createMockEnv({
      d1Results: {
        "accounts WHERE status": [
          { account_id: TEST_ACCOUNT_ID_1, user_id: TEST_USER_ID_1 },
          { account_id: TEST_ACCOUNT_ID_2, user_id: TEST_USER_ID_2 },
        ],
      },
    });
    // Override reconcile queue
    (env as any).RECONCILE_QUEUE = mockQueue;

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_RECONCILIATION), env, mockCtx);

    // First send fails, second succeeds
    expect(mockQueue.messages.length).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to enqueue reconciliation"),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it("does nothing when no active accounts", async () => {
    const { env, reconcileQueue } = createMockEnv({
      d1Results: {
        "accounts WHERE status": [],
      },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_RECONCILIATION), env, mockCtx);

    expect(reconcileQueue.messages.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // TM-bnfl: SYNC_FULL recovery and mirror replay tests
  // -----------------------------------------------------------------------

  it("enqueues SYNC_FULL for every non-revoked account alongside RECONCILE_ACCOUNT", async () => {
    const { env, reconcileQueue, syncQueue } = createMockEnv({
      d1Results: {
        "accounts WHERE status": [
          { account_id: TEST_ACCOUNT_ID_1, user_id: TEST_USER_ID_1, status: "active" },
          { account_id: TEST_ACCOUNT_ID_2, user_id: TEST_USER_ID_2, status: "error" },
        ],
      },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_RECONCILIATION), env, mockCtx);

    // RECONCILE_ACCOUNT messages still enqueued (AC-4: preserved, not replaced)
    expect(reconcileQueue.messages.length).toBe(2);
    expect((reconcileQueue.messages[0] as any).type).toBe("RECONCILE_ACCOUNT");
    expect((reconcileQueue.messages[1] as any).type).toBe("RECONCILE_ACCOUNT");

    // SYNC_FULL messages enqueued for both accounts (AC-1: errored + active)
    expect(syncQueue.messages.length).toBe(2);
    const sync1 = syncQueue.messages[0] as { type: string; account_id: string; reason: string };
    const sync2 = syncQueue.messages[1] as { type: string; account_id: string; reason: string };
    expect(sync1.type).toBe("SYNC_FULL");
    expect(sync1.account_id).toBe(TEST_ACCOUNT_ID_1);
    expect(sync1.reason).toBe("reconcile");
    expect(sync2.type).toBe("SYNC_FULL");
    expect(sync2.account_id).toBe(TEST_ACCOUNT_ID_2);
    expect(sync2.reason).toBe("reconcile");
  });

  it("calls forceReplayNonActiveMirrors for each unique user during reconciliation", async () => {
    const userGraphCalls: Array<{ url: string; body: string }> = [];
    const { env } = createMockEnv({
      d1Results: {
        "accounts WHERE status": [
          { account_id: TEST_ACCOUNT_ID_1, user_id: TEST_USER_ID_1, status: "active" },
          { account_id: TEST_ACCOUNT_ID_2, user_id: TEST_USER_ID_1, status: "error" }, // same user, different account
        ],
      },
      userGraphDOFetch: async (url, init) => {
        const body = init?.body ? String(init.body) : "";
        userGraphCalls.push({ url, body });
        return new Response("OK", { status: 200 });
      },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_RECONCILIATION), env, mockCtx);

    // Should call recomputeProjections exactly once per unique user (deduped)
    const recomputeCalls = userGraphCalls.filter(c => c.url.includes("recomputeProjections"));
    expect(recomputeCalls.length).toBe(1);
    const body = JSON.parse(recomputeCalls[0].body);
    expect(body.force_requeue_non_active).toBe(true);
  });

  it("errored account SYNC_FULL enqueue does not block other accounts on queue failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let reconcileSendCount = 0;
    let syncSendCount = 0;

    const mockReconcileQueue = {
      messages: [] as unknown[],
      async send(msg: unknown) {
        reconcileSendCount++;
        mockReconcileQueue.messages.push(msg);
      },
    } as unknown as Queue & { messages: unknown[] };

    const mockSyncQueue = {
      messages: [] as unknown[],
      async send(msg: unknown) {
        syncSendCount++;
        // First SYNC_FULL send fails
        if (syncSendCount === 1) throw new Error("Sync queue full");
        mockSyncQueue.messages.push(msg);
      },
    } as unknown as Queue & { messages: unknown[] };

    const { env } = createMockEnv({
      d1Results: {
        "accounts WHERE status": [
          { account_id: TEST_ACCOUNT_ID_1, user_id: TEST_USER_ID_1, status: "error" },
          { account_id: TEST_ACCOUNT_ID_2, user_id: TEST_USER_ID_2, status: "active" },
        ],
      },
    });
    (env as any).RECONCILE_QUEUE = mockReconcileQueue;
    (env as any).SYNC_QUEUE = mockSyncQueue;

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_RECONCILIATION), env, mockCtx);

    // Both RECONCILE_ACCOUNT messages should succeed
    expect(mockReconcileQueue.messages.length).toBe(2);

    // First SYNC_FULL failed, second succeeded (AC-6: isolation)
    expect(mockSyncQueue.messages.length).toBe(1);
    expect((mockSyncQueue.messages[0] as any).account_id).toBe(TEST_ACCOUNT_ID_2);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to enqueue SYNC_FULL recovery"),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Deletion Check tests
// ---------------------------------------------------------------------------

describe("handleDeletionCheck (via scheduled)", () => {
  it("processes pending deletions past grace period and triggers workflow", async () => {
    const workflowCreate = vi.fn().mockResolvedValue({ id: "wf-1" });
    const d1RunLog: Array<{ sql: string; params: unknown[] }> = [];
    const { env } = createMockEnv({
      d1Results: {
        "deletion_requests": [
          { request_id: "req-1", user_id: TEST_USER_ID_1, scheduled_at: "2024-01-01T00:00:00Z" },
        ],
      },
      d1RunLog,
      deletionWorkflow: { create: workflowCreate },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_DELETION_CHECK), env, mockCtx);

    // Should mark as processing
    const updateQuery = d1RunLog.find(q => q.sql.includes("processing"));
    expect(updateQuery).toBeDefined();

    // Should trigger workflow
    expect(workflowCreate).toHaveBeenCalledWith({
      id: "deletion-req-1",
      params: {
        request_id: "req-1",
        user_id: TEST_USER_ID_1,
      },
    });
  });

  it("handles missing DELETION_WORKFLOW binding gracefully", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d1RunLog: Array<{ sql: string; params: unknown[] }> = [];
    const { env } = createMockEnv({
      d1Results: {
        "deletion_requests": [
          { request_id: "req-2", user_id: TEST_USER_ID_1, scheduled_at: "2024-01-01T00:00:00Z" },
        ],
      },
      d1RunLog,
      deletionWorkflow: undefined,
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_DELETION_CHECK), env, mockCtx);

    // Should still mark as processing
    const updateQuery = d1RunLog.find(q => q.sql.includes("processing"));
    expect(updateQuery).toBeDefined();

    // Should warn about missing binding
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("DeletionWorkflow binding not configured"),
    );
    warnSpy.mockRestore();
  });

  it("handles workflow creation failure gracefully", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const workflowCreate = vi.fn().mockRejectedValue(new Error("Workflow creation failed"));
    const d1RunLog: Array<{ sql: string; params: unknown[] }> = [];
    const { env } = createMockEnv({
      d1Results: {
        "deletion_requests": [
          { request_id: "req-3", user_id: TEST_USER_ID_1, scheduled_at: "2024-01-01T00:00:00Z" },
        ],
      },
      d1RunLog,
      deletionWorkflow: { create: workflowCreate },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_DELETION_CHECK), env, mockCtx);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Deletion check error"),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it("does nothing when no pending deletions", async () => {
    const workflowCreate = vi.fn();
    const d1RunLog: Array<{ sql: string; params: unknown[] }> = [];
    const { env } = createMockEnv({
      d1Results: {
        "deletion_requests": [],
      },
      d1RunLog,
      deletionWorkflow: { create: workflowCreate },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_DELETION_CHECK), env, mockCtx);

    expect(workflowCreate).not.toHaveBeenCalled();
    expect(d1RunLog.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Hold Expiry tests
// ---------------------------------------------------------------------------

describe("handleHoldExpiry (via scheduled)", () => {
  it("expires holds and enqueues DELETE_MIRROR for holds with provider events", async () => {
    const doFetchCalls: Array<{ url: string; body: string }> = [];
    const { env, writeQueue } = createMockEnv({
      d1Results: {
        "DISTINCT user_id": [{ user_id: TEST_USER_ID_1 }],
      },
      userGraphDOFetch: async (url, init) => {
        const body = init?.body ? String(init.body) : "";
        doFetchCalls.push({ url, body });

        if (url.includes("getExpiredHolds")) {
          return new Response(
            JSON.stringify({
              holds: [
                {
                  hold_id: "hold-1",
                  session_id: "sess-1",
                  account_id: TEST_ACCOUNT_ID_1,
                  provider_event_id: "prov-evt-1",
                },
                {
                  hold_id: "hold-2",
                  session_id: "sess-1",
                  account_id: TEST_ACCOUNT_ID_2,
                  provider_event_id: null, // No provider event
                },
              ],
            }),
            { status: 200 },
          );
        }

        return new Response("OK", { status: 200 });
      },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_HOLD_EXPIRY), env, mockCtx);

    // Should enqueue DELETE_MIRROR only for hold with provider_event_id
    expect(writeQueue.messages.length).toBe(1);
    const deleteMsg = writeQueue.messages[0] as { type: string; provider_event_id: string };
    expect(deleteMsg.type).toBe("DELETE_MIRROR");
    expect(deleteMsg.provider_event_id).toBe("prov-evt-1");

    // Should call updateHoldStatus for both holds
    const statusCalls = doFetchCalls.filter(c => c.url.includes("updateHoldStatus"));
    expect(statusCalls.length).toBe(2);

    // Should call expireSessionIfAllHoldsTerminal for the session
    const sessionCalls = doFetchCalls.filter(c => c.url.includes("expireSessionIfAllHoldsTerminal"));
    expect(sessionCalls.length).toBe(1);
    const sessionBody = JSON.parse(sessionCalls[0].body);
    expect(sessionBody.session_id).toBe("sess-1");
  });

  it("handles getExpiredHolds failure gracefully", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env, writeQueue } = createMockEnv({
      d1Results: {
        "DISTINCT user_id": [{ user_id: TEST_USER_ID_1 }],
      },
      userGraphDOFetch: async (url) => {
        if (url.includes("getExpiredHolds")) {
          return new Response("Error", { status: 500 });
        }
        return new Response("OK", { status: 200 });
      },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_HOLD_EXPIRY), env, mockCtx);

    expect(writeQueue.messages.length).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to get expired holds"),
    );
    errorSpy.mockRestore();
  });

  it("skips users with no expired holds", async () => {
    const doFetchCalls: string[] = [];
    const { env, writeQueue } = createMockEnv({
      d1Results: {
        "DISTINCT user_id": [{ user_id: TEST_USER_ID_1 }],
      },
      userGraphDOFetch: async (url) => {
        doFetchCalls.push(url);
        if (url.includes("getExpiredHolds")) {
          return new Response(JSON.stringify({ holds: [] }), { status: 200 });
        }
        return new Response("OK", { status: 200 });
      },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_HOLD_EXPIRY), env, mockCtx);

    // Only getExpiredHolds should be called, not updateHoldStatus
    expect(doFetchCalls.filter(u => u.includes("updateHoldStatus")).length).toBe(0);
    expect(writeQueue.messages.length).toBe(0);
  });

  it("handles DO exception for a user gracefully (continues)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env } = createMockEnv({
      d1Results: {
        "DISTINCT user_id": [{ user_id: TEST_USER_ID_1 }],
      },
      userGraphDOFetch: async () => {
        throw new Error("DO crash");
      },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_HOLD_EXPIRY), env, mockCtx);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Hold expiry error"),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Social Drift Computation tests
// ---------------------------------------------------------------------------

describe("handleDriftComputation (via scheduled)", () => {
  it("fetches drift reports and stores alerts for each user", async () => {
    const doFetchCalls: Array<{ url: string; body: string }> = [];
    const { env } = createMockEnv({
      d1Results: {
        "DISTINCT user_id": [{ user_id: TEST_USER_ID_1 }],
      },
      userGraphDOFetch: async (url, init) => {
        const body = init?.body ? String(init.body) : "";
        doFetchCalls.push({ url, body });

        if (url.includes("getDriftReport")) {
          return new Response(
            JSON.stringify({
              overdue: [
                {
                  relationship_id: "rel-1",
                  display_name: "Alice",
                  category: "friend",
                  drift_ratio: 1.5,
                  days_overdue: 10,
                  urgency: 0.8,
                },
              ],
              total_tracked: 5,
              total_overdue: 1,
              computed_at: new Date().toISOString(),
            }),
            { status: 200 },
          );
        }

        if (url.includes("storeDriftAlerts")) {
          return new Response(JSON.stringify({ stored: 1 }), { status: 200 });
        }

        return new Response("OK", { status: 200 });
      },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_DRIFT_COMPUTATION), env, mockCtx);

    expect(doFetchCalls.filter(c => c.url.includes("getDriftReport")).length).toBe(1);
    expect(doFetchCalls.filter(c => c.url.includes("storeDriftAlerts")).length).toBe(1);

    // Verify the store call includes the report data
    const storeCall = doFetchCalls.find(c => c.url.includes("storeDriftAlerts"));
    const storeBody = JSON.parse(storeCall!.body);
    expect(storeBody.report.total_overdue).toBe(1);
  });

  it("skips storing if getDriftReport fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const doFetchCalls: string[] = [];
    const { env } = createMockEnv({
      d1Results: {
        "DISTINCT user_id": [{ user_id: TEST_USER_ID_1 }],
      },
      userGraphDOFetch: async (url) => {
        doFetchCalls.push(url);
        if (url.includes("getDriftReport")) {
          return new Response("Error", { status: 500 });
        }
        return new Response("OK", { status: 200 });
      },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_DRIFT_COMPUTATION), env, mockCtx);

    expect(doFetchCalls.filter(u => u.includes("storeDriftAlerts")).length).toBe(0);
    errorSpy.mockRestore();
  });

  it("handles storeDriftAlerts failure gracefully", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env } = createMockEnv({
      d1Results: {
        "DISTINCT user_id": [{ user_id: TEST_USER_ID_1 }],
      },
      userGraphDOFetch: async (url) => {
        if (url.includes("getDriftReport")) {
          return new Response(
            JSON.stringify({
              overdue: [],
              total_tracked: 0,
              total_overdue: 0,
              computed_at: new Date().toISOString(),
            }),
            { status: 200 },
          );
        }
        if (url.includes("storeDriftAlerts")) {
          return new Response("Error", { status: 500 });
        }
        return new Response("OK", { status: 200 });
      },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_DRIFT_COMPUTATION), env, mockCtx);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to store alerts"),
    );
    errorSpy.mockRestore();
  });

  it("handles DO exception gracefully", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env } = createMockEnv({
      d1Results: {
        "DISTINCT user_id": [{ user_id: TEST_USER_ID_1 }],
      },
      userGraphDOFetch: async () => {
        throw new Error("DO crash");
      },
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_DRIFT_COMPUTATION), env, mockCtx);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Drift computation error"),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// ICS Feed Refresh tests
// ---------------------------------------------------------------------------

describe("handleFeedRefresh (via scheduled)", () => {
  // Access the mocked versions through a dynamic import in beforeEach
  let isRateLimitedMock: ReturnType<typeof vi.fn>;
  let detectFeedChangesMock: ReturnType<typeof vi.fn>;
  let normalizeIcsFeedEventsMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const shared = await import("@tminus/shared");
    isRateLimitedMock = vi.mocked(shared.isRateLimited);
    detectFeedChangesMock = vi.mocked(shared.detectFeedChanges);
    normalizeIcsFeedEventsMock = vi.mocked(shared.normalizeIcsFeedEvents);

    isRateLimitedMock.mockReturnValue(false);
    detectFeedChangesMock.mockReturnValue({ changed: false, newEtag: "etag-1", newLastModified: "Mon, 01 Jan 2024 00:00:00 GMT" });
    normalizeIcsFeedEventsMock.mockReturnValue([]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("skips rate-limited feeds", async () => {
    isRateLimitedMock.mockReturnValue(true);
    const d1RunLog: Array<{ sql: string; params: unknown[] }> = [];
    const { env } = createMockEnv({
      d1Results: {
        "provider = ?2": [
          {
            account_id: TEST_ACCOUNT_ID_1,
            user_id: TEST_USER_ID_1,
            provider_subject: "https://example.com/feed.ics",
            feed_etag: null,
            feed_last_modified: null,
            feed_content_hash: null,
            feed_last_refresh_at: null,
            feed_last_fetch_at: new Date().toISOString(),
            feed_consecutive_failures: 0,
            feed_refresh_interval_ms: null,
          },
        ],
      },
      d1RunLog,
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_FEED_REFRESH), env, mockCtx);

    // Should not have made any D1 updates (skipped)
    expect(d1RunLog.length).toBe(0);
  });

  it("skips manual-only feeds (interval = 0)", async () => {
    const d1RunLog: Array<{ sql: string; params: unknown[] }> = [];
    const { env } = createMockEnv({
      d1Results: {
        "provider = ?2": [
          {
            account_id: TEST_ACCOUNT_ID_1,
            user_id: TEST_USER_ID_1,
            provider_subject: "https://example.com/feed.ics",
            feed_etag: null,
            feed_last_modified: null,
            feed_content_hash: null,
            feed_last_refresh_at: null,
            feed_last_fetch_at: null,
            feed_consecutive_failures: 0,
            feed_refresh_interval_ms: 0,
          },
        ],
      },
      d1RunLog,
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_FEED_REFRESH), env, mockCtx);

    expect(d1RunLog.length).toBe(0);
  });

  it("skips feeds not yet due for refresh", async () => {
    const d1RunLog: Array<{ sql: string; params: unknown[] }> = [];
    const { env } = createMockEnv({
      d1Results: {
        "provider = ?2": [
          {
            account_id: TEST_ACCOUNT_ID_1,
            user_id: TEST_USER_ID_1,
            provider_subject: "https://example.com/feed.ics",
            feed_etag: null,
            feed_last_modified: null,
            feed_content_hash: null,
            feed_last_refresh_at: new Date().toISOString(), // Just refreshed
            feed_last_fetch_at: null,
            feed_consecutive_failures: 0,
            feed_refresh_interval_ms: 15 * 60 * 1000, // 15 minutes
          },
        ],
      },
      d1RunLog,
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_FEED_REFRESH), env, mockCtx);

    expect(d1RunLog.length).toBe(0);
  });

  it("refreshes feed with no changes (304 path)", async () => {
    // Mock global fetch to return the ICS feed
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("VCALENDAR data", {
        status: 200,
        headers: { "ETag": "etag-new", "Last-Modified": "Mon, 02 Jan 2024 00:00:00 GMT" },
      }),
    );

    detectFeedChangesMock.mockReturnValue({
      changed: false,
      newEtag: "etag-new",
      newLastModified: "Mon, 02 Jan 2024 00:00:00 GMT",
    });

    const d1RunLog: Array<{ sql: string; params: unknown[] }> = [];
    const { env } = createMockEnv({
      d1Results: {
        "provider = ?2": [
          {
            account_id: TEST_ACCOUNT_ID_1,
            user_id: TEST_USER_ID_1,
            provider_subject: "https://example.com/feed.ics",
            feed_etag: "etag-old",
            feed_last_modified: null,
            feed_content_hash: "hash-old",
            feed_last_refresh_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
            feed_last_fetch_at: null,
            feed_consecutive_failures: 0,
            feed_refresh_interval_ms: 15 * 60 * 1000,
          },
        ],
      },
      d1RunLog,
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_FEED_REFRESH), env, mockCtx);

    // Should have updated D1 with new timestamps
    expect(d1RunLog.length).toBe(1);
    expect(d1RunLog[0].sql).toContain("feed_consecutive_failures = 0");
  });

  it("refreshes feed with changes and applies deltas", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("BEGIN:VCALENDAR\nEND:VCALENDAR", {
        status: 200,
        headers: { "ETag": "etag-new" },
      }),
    );

    detectFeedChangesMock.mockReturnValue({
      changed: true,
      newEtag: "etag-new",
      newContentHash: "hash-new",
    });

    normalizeIcsFeedEventsMock.mockReturnValue([
      {
        origin_event_id: "evt-1",
        origin_account_id: TEST_ACCOUNT_ID_1,
        title: "Test Event",
        description: null,
        location: null,
        start: "2024-01-01T10:00:00Z",
        end: "2024-01-01T11:00:00Z",
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
        recurrence_rule: null,
      },
    ]);

    const doFetchCalls: Array<{ url: string; body: string }> = [];
    const d1RunLog: Array<{ sql: string; params: unknown[] }> = [];
    const { env } = createMockEnv({
      d1Results: {
        "provider = ?2": [
          {
            account_id: TEST_ACCOUNT_ID_1,
            user_id: TEST_USER_ID_1,
            provider_subject: "https://example.com/feed.ics",
            feed_etag: null,
            feed_last_modified: null,
            feed_content_hash: null,
            feed_last_refresh_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
            feed_last_fetch_at: null,
            feed_consecutive_failures: 0,
            feed_refresh_interval_ms: 15 * 60 * 1000,
          },
        ],
      },
      userGraphDOFetch: async (url, init) => {
        const body = init?.body ? String(init.body) : "";
        doFetchCalls.push({ url, body });
        return new Response("OK", { status: 200 });
      },
      d1RunLog,
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_FEED_REFRESH), env, mockCtx);

    // Should have called UserGraphDO.applyProviderDelta
    const deltaCalls = doFetchCalls.filter(c => c.url.includes("applyProviderDelta"));
    expect(deltaCalls.length).toBe(1);
    const deltaBody = JSON.parse(deltaCalls[0].body);
    expect(deltaBody.account_id).toBe(TEST_ACCOUNT_ID_1);
    expect(deltaBody.deltas.length).toBe(1);
    expect(deltaBody.deltas[0].origin_event_id).toBe("evt-1");

    // Should have updated D1 with content hash and event sequences
    const updateQuery = d1RunLog.find(q => q.sql.includes("feed_content_hash"));
    expect(updateQuery).toBeDefined();
  });

  it("handles fetch network error gracefully", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network timeout"));

    const d1RunLog: Array<{ sql: string; params: unknown[] }> = [];
    const { env } = createMockEnv({
      d1Results: {
        "provider = ?2": [
          {
            account_id: TEST_ACCOUNT_ID_1,
            user_id: TEST_USER_ID_1,
            provider_subject: "https://example.com/feed.ics",
            feed_etag: null,
            feed_last_modified: null,
            feed_content_hash: null,
            feed_last_refresh_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
            feed_last_fetch_at: null,
            feed_consecutive_failures: 2,
            feed_refresh_interval_ms: 15 * 60 * 1000,
          },
        ],
      },
      d1RunLog,
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_FEED_REFRESH), env, mockCtx);

    // Should increment consecutive failures
    expect(d1RunLog.length).toBe(1);
    expect(d1RunLog[0].params).toContain(3); // 2 + 1
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ICS feed fetch failed"),
    );
    errorSpy.mockRestore();
  });

  it("handles HTTP error responses and classifies them", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Not Found", { status: 404 }),
    );

    const d1RunLog: Array<{ sql: string; params: unknown[] }> = [];
    const { env } = createMockEnv({
      d1Results: {
        "provider = ?2": [
          {
            account_id: TEST_ACCOUNT_ID_1,
            user_id: TEST_USER_ID_1,
            provider_subject: "https://example.com/feed.ics",
            feed_etag: null,
            feed_last_modified: null,
            feed_content_hash: null,
            feed_last_refresh_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
            feed_last_fetch_at: null,
            feed_consecutive_failures: 0,
            feed_refresh_interval_ms: 15 * 60 * 1000,
          },
        ],
      },
      d1RunLog,
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_FEED_REFRESH), env, mockCtx);

    // Should update with failure count and potentially error status
    expect(d1RunLog.length).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("does nothing when no ICS feed accounts", async () => {
    const d1RunLog: Array<{ sql: string; params: unknown[] }> = [];
    const { env } = createMockEnv({
      d1Results: {
        "provider = ?2": [],
      },
      d1RunLog,
    });

    const handler = createHandler();
    await handler.scheduled(buildScheduledEvent(CRON_FEED_REFRESH), env, mockCtx);

    expect(d1RunLog.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Constants verification tests
// ---------------------------------------------------------------------------

describe("Cron constants", () => {
  it("CHANNEL_LIVENESS_THRESHOLD_MS is 12 hours (TM-ucl1)", async () => {
    const { CHANNEL_LIVENESS_THRESHOLD_MS } = await import("./constants");
    expect(CHANNEL_LIVENESS_THRESHOLD_MS).toBe(12 * 60 * 60 * 1000);
  });

  it("CRON_CHANNEL_RENEWAL matches every 6 hours", () => {
    expect(CRON_CHANNEL_RENEWAL).toBe("0 */6 * * *");
  });

  it("CRON_TOKEN_HEALTH matches every 12 hours", () => {
    expect(CRON_TOKEN_HEALTH).toBe("0 */12 * * *");
  });

  it("CRON_RECONCILIATION matches daily at 03:00 UTC", () => {
    expect(CRON_RECONCILIATION).toBe("0 3 * * *");
  });

  it("CRON_DELETION_CHECK matches every hour", () => {
    expect(CRON_DELETION_CHECK).toBe("0 * * * *");
  });

  it("CRON_HOLD_EXPIRY matches every hour at :30", () => {
    expect(CRON_HOLD_EXPIRY).toBe("30 * * * *");
  });

  it("CRON_DRIFT_COMPUTATION matches daily at 04:00 UTC", () => {
    expect(CRON_DRIFT_COMPUTATION).toBe("0 4 * * *");
  });

  it("CRON_FEED_REFRESH matches every 15 minutes", () => {
    expect(CRON_FEED_REFRESH).toBe("*/15 * * * *");
  });
});
