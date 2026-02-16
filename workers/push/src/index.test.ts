/**
 * Unit tests for tminus-push worker.
 *
 * Covers:
 * - HTTP handler routing (health, 404, device-tokens)
 * - Device token registration: validation, upsert, error handling
 * - Device token deregistration: validation, deletion, error handling
 * - Queue batch processing: JWT generation, message dispatch
 * - Single message processing: type validation, preference filtering, APNs delivery
 * - Notification settings fetch: success, DO failure fallback to defaults
 * - Invalid token auto-cleanup (BadDeviceToken, Unregistered)
 * - hashTokenId: deterministic, correct format
 *
 * D1, DurableObject stubs, and APNs are mocked with lightweight stubs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHandler, handleFetch, hashTokenId } from "./index";

// ---------------------------------------------------------------------------
// Mock APNs module
// ---------------------------------------------------------------------------

vi.mock("./apns", () => ({
  generateAPNsJWT: vi.fn().mockResolvedValue("mock-jwt-token"),
  sendToAPNs: vi.fn().mockResolvedValue({ success: true, statusCode: 200, deviceToken: "device-abc" }),
  APNS_UNREGISTERED_REASONS: new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic", "ExpiredProviderToken"]),
}));

// Clear mock state between every test to prevent leaks
beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_USER_ID = "user_01";
const TEST_DEVICE_TOKEN = "abc123def456";
const TEST_TOKEN_ID = "dtk_mock";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockD1QueryResult<T = unknown> {
  results: T[];
  meta?: { changes?: number };
}

/**
 * Creates a mock D1 database.
 * `queryResults` maps SQL snippet -> rows returned.
 * `runLog` captures mutation queries.
 * `runBehavior` can throw to simulate D1 errors.
 */
function createMockD1(
  queryResults: Record<string, unknown[]> = {},
  runLog: Array<{ sql: string; params: unknown[] }> = [],
  runBehavior?: "throw",
) {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async all<T>(): Promise<MockD1QueryResult<T>> {
              for (const [key, rows] of Object.entries(queryResults)) {
                if (sql.includes(key)) {
                  return { results: rows as T[] };
                }
              }
              return { results: [] };
            },
            async run(): Promise<MockD1QueryResult> {
              if (runBehavior === "throw") {
                throw new Error("D1 write error");
              }
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

/** Creates a mock DurableObject namespace. */
function createMockDONamespace(
  fetchHandler?: (url: string, init?: RequestInit) => Promise<Response>,
) {
  const defaultHandler = async () => new Response("OK", { status: 200 });
  const handler = fetchHandler ?? defaultHandler;

  return {
    idFromName(name: string) {
      return { name } as DurableObjectId;
    },
    get(_id: DurableObjectId) {
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          let url: string;
          if (typeof input === "string") {
            url = input;
          } else if (input instanceof URL) {
            url = input.toString();
          } else {
            url = input.url;
          }
          return handler(url, init);
        },
      } as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

/** Creates a mock Queue. */
function createMockQueue() {
  return {
    async send() {},
  } as unknown as Queue;
}

/** Build a complete mock Env for the push worker. */
function createMockEnv(opts?: {
  d1Results?: Record<string, unknown[]>;
  d1RunLog?: Array<{ sql: string; params: unknown[] }>;
  d1RunBehavior?: "throw";
  userGraphDOFetch?: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const d1RunLog = opts?.d1RunLog ?? [];

  return {
    env: {
      DB: createMockD1(opts?.d1Results ?? {}, d1RunLog, opts?.d1RunBehavior),
      USER_GRAPH: createMockDONamespace(opts?.userGraphDOFetch),
      PUSH_QUEUE: createMockQueue(),
      APNS_KEY_ID: "KEY123",
      APNS_TEAM_ID: "TEAM456",
      APNS_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nMIGH...fake...\n-----END PRIVATE KEY-----",
      APNS_TOPIC: "ink.tminus.app",
      ENVIRONMENT: "development",
    } as Env,
    d1RunLog,
  };
}

// ---------------------------------------------------------------------------
// HTTP Handler: Routing tests
// ---------------------------------------------------------------------------

describe("HTTP handler routing", () => {
  it("GET /health returns 200 OK", async () => {
    const { env } = createMockEnv();
    const res = await handleFetch(
      new Request("https://push.tminus.dev/health", { method: "GET" }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe("OK");
  });

  it("unknown routes return 404", async () => {
    const { env } = createMockEnv();
    const res = await handleFetch(
      new Request("https://push.tminus.dev/unknown", { method: "GET" }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("GET /v1/device-tokens returns 405 (no GET handler)", async () => {
    const { env } = createMockEnv();
    const res = await handleFetch(
      new Request("https://push.tminus.dev/v1/device-tokens", { method: "GET" }),
      env,
    );
    expect(res.status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// Device Token Registration
// ---------------------------------------------------------------------------

describe("POST /v1/device-tokens (register)", () => {
  it("registers a new device token successfully", async () => {
    const d1RunLog: Array<{ sql: string; params: unknown[] }> = [];
    const { env } = createMockEnv({ d1RunLog });

    const res = await handleFetch(
      new Request("https://push.tminus.dev/v1/device-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: TEST_USER_ID,
          device_token: TEST_DEVICE_TOKEN,
          platform: "ios",
        }),
      }),
      env,
    );

    expect(res.status).toBe(201);
    const body = await res.json() as { ok: boolean; data: { token_id: string } };
    expect(body.ok).toBe(true);
    expect(body.data.token_id).toMatch(/^dtk_/);

    // Verify D1 INSERT was called
    expect(d1RunLog.length).toBe(1);
    expect(d1RunLog[0].sql).toContain("INSERT INTO device_tokens");
    expect(d1RunLog[0].params).toContain(TEST_USER_ID);
    expect(d1RunLog[0].params).toContain(TEST_DEVICE_TOKEN);
    expect(d1RunLog[0].params).toContain("ios");
  });

  it("returns 400 for invalid JSON body", async () => {
    const { env } = createMockEnv();

    const res = await handleFetch(
      new Request("https://push.tminus.dev/v1/device-tokens", {
        method: "POST",
        body: "not json",
      }),
      env,
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Invalid JSON");
  });

  it("returns 400 when missing required fields", async () => {
    const { env } = createMockEnv();

    const res = await handleFetch(
      new Request("https://push.tminus.dev/v1/device-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: TEST_USER_ID }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Missing required fields");
  });

  it("returns 400 for invalid platform", async () => {
    const { env } = createMockEnv();

    const res = await handleFetch(
      new Request("https://push.tminus.dev/v1/device-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: TEST_USER_ID,
          device_token: TEST_DEVICE_TOKEN,
          platform: "windows",
        }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Invalid platform");
  });

  it("accepts all valid platforms: ios, android, web", async () => {
    for (const platform of ["ios", "android", "web"]) {
      const d1RunLog: Array<{ sql: string; params: unknown[] }> = [];
      const { env } = createMockEnv({ d1RunLog });

      const res = await handleFetch(
        new Request("https://push.tminus.dev/v1/device-tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_id: TEST_USER_ID,
            device_token: `token-${platform}`,
            platform,
          }),
        }),
        env,
      );

      expect(res.status).toBe(201);
    }
  });

  it("returns 500 when D1 write fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env } = createMockEnv({ d1RunBehavior: "throw" });

    const res = await handleFetch(
      new Request("https://push.tminus.dev/v1/device-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: TEST_USER_ID,
          device_token: TEST_DEVICE_TOKEN,
          platform: "ios",
        }),
      }),
      env,
    );

    expect(res.status).toBe(500);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Failed to register");
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Device Token Deregistration
// ---------------------------------------------------------------------------

describe("DELETE /v1/device-tokens (deregister)", () => {
  it("deregisters a device token successfully", async () => {
    const d1RunLog: Array<{ sql: string; params: unknown[] }> = [];
    const { env } = createMockEnv({ d1RunLog });

    const res = await handleFetch(
      new Request("https://push.tminus.dev/v1/device-tokens", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: TEST_USER_ID,
          device_token: TEST_DEVICE_TOKEN,
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; data: { deleted: number } };
    expect(body.ok).toBe(true);
    expect(body.data.deleted).toBe(1);

    // Verify D1 DELETE was called
    expect(d1RunLog.length).toBe(1);
    expect(d1RunLog[0].sql).toContain("DELETE FROM device_tokens");
    expect(d1RunLog[0].params).toContain(TEST_USER_ID);
    expect(d1RunLog[0].params).toContain(TEST_DEVICE_TOKEN);
  });

  it("returns 400 for invalid JSON body", async () => {
    const { env } = createMockEnv();

    const res = await handleFetch(
      new Request("https://push.tminus.dev/v1/device-tokens", {
        method: "DELETE",
        body: "bad json",
      }),
      env,
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Invalid JSON");
  });

  it("returns 400 when missing required fields", async () => {
    const { env } = createMockEnv();

    const res = await handleFetch(
      new Request("https://push.tminus.dev/v1/device-tokens", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: TEST_USER_ID }),
      }),
      env,
    );

    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Missing required fields");
  });

  it("returns 500 when D1 write fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env } = createMockEnv({ d1RunBehavior: "throw" });

    const res = await handleFetch(
      new Request("https://push.tminus.dev/v1/device-tokens", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: TEST_USER_ID,
          device_token: TEST_DEVICE_TOKEN,
        }),
      }),
      env,
    );

    expect(res.status).toBe(500);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Failed to deregister");
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Queue Batch Processing
// ---------------------------------------------------------------------------

describe("Queue batch processing", () => {
  it("retries all messages when JWT generation fails", async () => {
    const { generateAPNsJWT } = await import("./apns");
    const jwtMock = vi.mocked(generateAPNsJWT);
    jwtMock.mockRejectedValueOnce(new Error("JWT generation failed"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env } = createMockEnv();
    const handler = createHandler();

    const retryAllFn = vi.fn();
    const mockBatch = {
      messages: [
        {
          body: {
            user_id: TEST_USER_ID,
            notification_type: "drift_alert",
            title: "Test",
            body: "Test body",
            deep_link_path: "/drift/rel-1",
          },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ],
      retryAll: retryAllFn,
    } as unknown as MessageBatch<any>;

    await handler.queue(mockBatch, env, {} as ExecutionContext);

    expect(retryAllFn).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("Failed to generate APNs JWT:", expect.any(Error));
    errorSpy.mockRestore();
    jwtMock.mockResolvedValue("mock-jwt-token"); // restore
  });

  it("acks messages on successful processing", async () => {
    const { generateAPNsJWT, sendToAPNs } = await import("./apns");
    vi.mocked(generateAPNsJWT).mockResolvedValue("mock-jwt-token");
    vi.mocked(sendToAPNs).mockResolvedValue({ success: true, statusCode: 200, deviceToken: "abc" });

    const { env } = createMockEnv({
      d1Results: {
        "device_tokens WHERE user_id": [
          { token_id: "dtk_1", user_id: TEST_USER_ID, device_token: "device-abc", platform: "ios" },
        ],
      },
      userGraphDOFetch: async (url) => {
        if (url.includes("getNotificationSettings")) {
          return new Response(JSON.stringify({
            preferences: {
              drift_alert: { enabled: true },
              reconnection_suggestion: { enabled: true },
              scheduling_proposal: { enabled: true },
              risk_warning: { enabled: true },
              hold_expiry: { enabled: true },
            },
            quiet_hours: { enabled: false, start: "22:00", end: "07:00", timezone: "UTC" },
          }), { status: 200 });
        }
        return new Response("OK", { status: 200 });
      },
    });

    const handler = createHandler();
    const ackFn = vi.fn();
    const retryFn = vi.fn();

    const mockBatch = {
      messages: [
        {
          body: {
            user_id: TEST_USER_ID,
            notification_type: "drift_alert",
            title: "Drift Alert",
            body: "You have a drift alert",
            deep_link_path: "/drift/rel-1",
          },
          ack: ackFn,
          retry: retryFn,
        },
      ],
      retryAll: vi.fn(),
    } as unknown as MessageBatch<any>;

    await handler.queue(mockBatch, env, {} as ExecutionContext);

    expect(ackFn).toHaveBeenCalled();
    expect(retryFn).not.toHaveBeenCalled();
  });

  it("retries individual messages on processing failure", async () => {
    const { generateAPNsJWT } = await import("./apns");
    vi.mocked(generateAPNsJWT).mockResolvedValue("mock-jwt-token");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Create env with D1 that throws on all queries (simulating failure)
    const { env } = createMockEnv({
      userGraphDOFetch: async () => {
        throw new Error("DO unavailable");
      },
    });

    // The getUserNotificationSettings function catches errors and falls back to defaults,
    // so we need to make the D1 device_tokens query throw to force a failure
    const failingD1 = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              async all() {
                if (sql.includes("device_tokens")) {
                  throw new Error("D1 unavailable");
                }
                return { results: [] };
              },
              async run() { return { results: [], meta: { changes: 0 } }; },
              async first() { return null; },
            };
          },
        };
      },
    } as unknown as D1Database;
    (env as any).DB = failingD1;

    const handler = createHandler();
    const ackFn = vi.fn();
    const retryFn = vi.fn();

    const mockBatch = {
      messages: [
        {
          body: {
            user_id: TEST_USER_ID,
            notification_type: "drift_alert",
            title: "Test",
            body: "Test body",
            deep_link_path: "/drift/rel-1",
          },
          ack: ackFn,
          retry: retryFn,
        },
      ],
      retryAll: vi.fn(),
    } as unknown as MessageBatch<any>;

    await handler.queue(mockBatch, env, {} as ExecutionContext);

    expect(retryFn).toHaveBeenCalled();
    expect(ackFn).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Message Processing (processMessage)
// ---------------------------------------------------------------------------

describe("Message processing", () => {
  it("drops messages with invalid notification type", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { generateAPNsJWT, sendToAPNs } = await import("./apns");
    vi.mocked(generateAPNsJWT).mockResolvedValue("mock-jwt-token");
    vi.mocked(sendToAPNs).mockResolvedValue({ success: true, statusCode: 200, deviceToken: "abc" });

    const { env } = createMockEnv();
    const handler = createHandler();

    const ackFn = vi.fn();
    const mockBatch = {
      messages: [
        {
          body: {
            user_id: TEST_USER_ID,
            notification_type: "invalid_type",
            title: "Test",
            body: "Test",
            deep_link_path: "/test",
          },
          ack: ackFn,
          retry: vi.fn(),
        },
      ],
      retryAll: vi.fn(),
    } as unknown as MessageBatch<any>;

    await handler.queue(mockBatch, env, {} as ExecutionContext);

    // Should ack (dropped, not retried) since processMessage returns void without throwing
    expect(ackFn).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid notification type"));
    warnSpy.mockRestore();
  });

  it("suppresses notifications when type is disabled", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { generateAPNsJWT, sendToAPNs } = await import("./apns");
    vi.mocked(generateAPNsJWT).mockResolvedValue("mock-jwt-token");

    const { env } = createMockEnv({
      userGraphDOFetch: async (url) => {
        if (url.includes("getNotificationSettings")) {
          return new Response(JSON.stringify({
            preferences: {
              drift_alert: { enabled: false }, // Disabled!
              reconnection_suggestion: { enabled: true },
              scheduling_proposal: { enabled: true },
              risk_warning: { enabled: true },
              hold_expiry: { enabled: true },
            },
            quiet_hours: { enabled: false, start: "22:00", end: "07:00", timezone: "UTC" },
          }), { status: 200 });
        }
        return new Response("OK", { status: 200 });
      },
    });

    const handler = createHandler();
    const ackFn = vi.fn();
    const mockBatch = {
      messages: [
        {
          body: {
            user_id: TEST_USER_ID,
            notification_type: "drift_alert",
            title: "Drift Alert",
            body: "Test",
            deep_link_path: "/drift/rel-1",
          },
          ack: ackFn,
          retry: vi.fn(),
        },
      ],
      retryAll: vi.fn(),
    } as unknown as MessageBatch<any>;

    await handler.queue(mockBatch, env, {} as ExecutionContext);

    expect(ackFn).toHaveBeenCalled();
    // sendToAPNs should NOT have been called
    expect(vi.mocked(sendToAPNs)).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Notification suppressed"));
    logSpy.mockRestore();
  });

  it("does not send when no device tokens found", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { generateAPNsJWT, sendToAPNs } = await import("./apns");
    vi.mocked(generateAPNsJWT).mockResolvedValue("mock-jwt-token");

    const { env } = createMockEnv({
      d1Results: {
        "device_tokens WHERE user_id": [], // No tokens
      },
    });

    const handler = createHandler();
    const ackFn = vi.fn();
    const mockBatch = {
      messages: [
        {
          body: {
            user_id: TEST_USER_ID,
            notification_type: "drift_alert",
            title: "Test",
            body: "Test",
            deep_link_path: "/test",
          },
          ack: ackFn,
          retry: vi.fn(),
        },
      ],
      retryAll: vi.fn(),
    } as unknown as MessageBatch<any>;

    await handler.queue(mockBatch, env, {} as ExecutionContext);

    expect(ackFn).toHaveBeenCalled();
    expect(vi.mocked(sendToAPNs)).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No device tokens"));
    logSpy.mockRestore();
  });

  it("only sends to iOS tokens (filters by platform)", async () => {
    const { generateAPNsJWT, sendToAPNs } = await import("./apns");
    vi.mocked(generateAPNsJWT).mockResolvedValue("mock-jwt-token");
    vi.mocked(sendToAPNs).mockResolvedValue({ success: true, statusCode: 200, deviceToken: "ios-token-1" });

    const { env } = createMockEnv({
      d1Results: {
        "device_tokens WHERE user_id": [
          { token_id: "dtk_1", user_id: TEST_USER_ID, device_token: "ios-token-1", platform: "ios" },
          { token_id: "dtk_2", user_id: TEST_USER_ID, device_token: "android-token-1", platform: "android" },
          { token_id: "dtk_3", user_id: TEST_USER_ID, device_token: "web-token-1", platform: "web" },
        ],
      },
    });

    const handler = createHandler();
    const ackFn = vi.fn();
    const mockBatch = {
      messages: [
        {
          body: {
            user_id: TEST_USER_ID,
            notification_type: "drift_alert",
            title: "Test",
            body: "Test",
            deep_link_path: "/test",
          },
          ack: ackFn,
          retry: vi.fn(),
        },
      ],
      retryAll: vi.fn(),
    } as unknown as MessageBatch<any>;

    await handler.queue(mockBatch, env, {} as ExecutionContext);

    // Should only call sendToAPNs for the iOS token
    expect(vi.mocked(sendToAPNs)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendToAPNs)).toHaveBeenCalledWith(
      "ios-token-1",
      expect.any(Object),
      "mock-jwt-token",
      "ink.tminus.app",
      "development",
    );
  });

  it("auto-cleans invalid device tokens (BadDeviceToken)", async () => {
    const { generateAPNsJWT, sendToAPNs } = await import("./apns");
    vi.mocked(generateAPNsJWT).mockResolvedValue("mock-jwt-token");
    vi.mocked(sendToAPNs).mockResolvedValue({
      success: false,
      statusCode: 410,
      reason: "BadDeviceToken",
      deviceToken: "bad-token",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const d1RunLog: Array<{ sql: string; params: unknown[] }> = [];
    const { env } = createMockEnv({
      d1Results: {
        "device_tokens WHERE user_id": [
          { token_id: "dtk_bad", user_id: TEST_USER_ID, device_token: "bad-token", platform: "ios" },
        ],
      },
      d1RunLog,
    });

    const handler = createHandler();
    const ackFn = vi.fn();
    const mockBatch = {
      messages: [
        {
          body: {
            user_id: TEST_USER_ID,
            notification_type: "drift_alert",
            title: "Test",
            body: "Test",
            deep_link_path: "/test",
          },
          ack: ackFn,
          retry: vi.fn(),
        },
      ],
      retryAll: vi.fn(),
    } as unknown as MessageBatch<any>;

    await handler.queue(mockBatch, env, {} as ExecutionContext);

    // Should have deleted the bad token from D1
    const deleteQuery = d1RunLog.find(q => q.sql.includes("DELETE FROM device_tokens"));
    expect(deleteQuery).toBeDefined();
    expect(deleteQuery!.params).toContain("dtk_bad");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Removing invalid device token"));
    logSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Notification Settings
// ---------------------------------------------------------------------------

describe("getUserNotificationSettings", () => {
  it("falls back to defaults when DO returns error", async () => {
    // We test this indirectly through message processing
    const { generateAPNsJWT, sendToAPNs } = await import("./apns");
    vi.mocked(generateAPNsJWT).mockResolvedValue("mock-jwt-token");
    vi.mocked(sendToAPNs).mockResolvedValue({ success: true, statusCode: 200, deviceToken: "abc" });

    const { env } = createMockEnv({
      d1Results: {
        "device_tokens WHERE user_id": [
          { token_id: "dtk_1", user_id: TEST_USER_ID, device_token: "device-abc", platform: "ios" },
        ],
      },
      userGraphDOFetch: async () => {
        return new Response("Error", { status: 500 });
      },
    });

    const handler = createHandler();
    const ackFn = vi.fn();
    const mockBatch = {
      messages: [
        {
          body: {
            user_id: TEST_USER_ID,
            notification_type: "drift_alert",
            title: "Test",
            body: "Test",
            deep_link_path: "/test",
          },
          ack: ackFn,
          retry: vi.fn(),
        },
      ],
      retryAll: vi.fn(),
    } as unknown as MessageBatch<any>;

    await handler.queue(mockBatch, env, {} as ExecutionContext);

    // Should still send (defaults = all enabled)
    expect(vi.mocked(sendToAPNs)).toHaveBeenCalled();
    expect(ackFn).toHaveBeenCalled();
  });

  it("falls back to defaults when DO throws", async () => {
    const { generateAPNsJWT, sendToAPNs } = await import("./apns");
    vi.mocked(generateAPNsJWT).mockResolvedValue("mock-jwt-token");
    vi.mocked(sendToAPNs).mockResolvedValue({ success: true, statusCode: 200, deviceToken: "abc" });

    const { env } = createMockEnv({
      d1Results: {
        "device_tokens WHERE user_id": [
          { token_id: "dtk_1", user_id: TEST_USER_ID, device_token: "device-abc", platform: "ios" },
        ],
      },
      userGraphDOFetch: async () => {
        throw new Error("DO unreachable");
      },
    });

    const handler = createHandler();
    const ackFn = vi.fn();
    const mockBatch = {
      messages: [
        {
          body: {
            user_id: TEST_USER_ID,
            notification_type: "risk_warning",
            title: "Test",
            body: "Test",
            deep_link_path: "/test",
          },
          ack: ackFn,
          retry: vi.fn(),
        },
      ],
      retryAll: vi.fn(),
    } as unknown as MessageBatch<any>;

    await handler.queue(mockBatch, env, {} as ExecutionContext);

    // Should still send (fail open with defaults)
    expect(vi.mocked(sendToAPNs)).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// hashTokenId
// ---------------------------------------------------------------------------

describe("hashTokenId", () => {
  it("returns deterministic output for same input", async () => {
    const hash1 = await hashTokenId("user-1", "token-abc");
    const hash2 = await hashTokenId("user-1", "token-abc");
    expect(hash1).toBe(hash2);
  });

  it("returns different output for different inputs", async () => {
    const hash1 = await hashTokenId("user-1", "token-abc");
    const hash2 = await hashTokenId("user-2", "token-abc");
    expect(hash1).not.toBe(hash2);
  });

  it("returns 16 hex characters", async () => {
    const hash = await hashTokenId("user-1", "token-abc");
    expect(hash.length).toBe(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// createHandler factory
// ---------------------------------------------------------------------------

describe("createHandler factory", () => {
  it("returns object with fetch and queue methods", () => {
    const handler = createHandler();
    expect(typeof handler.fetch).toBe("function");
    expect(typeof handler.queue).toBe("function");
  });
});
