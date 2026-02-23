/**
 * Tests for tminus-webhook worker.
 *
 * Covers:
 * - Valid Google webhook with known channel_token enqueues SYNC_INCREMENTAL
 * - Google webhook resolves to account + scoped calendar_id (per-scope routing)
 * - Google webhook with null calendar_id (legacy) still enqueues with telemetry
 * - Unknown channel_token returns 200 but does NOT enqueue
 * - Missing Google headers returns 200 (always 200 to Google)
 * - 'sync' resource_state returns 200 WITHOUT enqueueing
 * - 'exists' resource_state enqueues correctly
 * - 'not_exists' resource_state enqueues correctly
 * - Health endpoint returns 200
 * - Unknown routes return 404
 * - Enqueued message has correct shape including calendar_id
 * - Microsoft validation handshake returns token as plain text
 * - Microsoft change notification enqueues SYNC_INCREMENTAL with calendar_id
 * - Microsoft clientState mismatch is skipped without failing the whole batch
 * - Microsoft malformed body returns 400
 * - Microsoft legacy subscription fallback resolves calendar_id
 *
 * D1 and Queue are mocked with lightweight stubs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHandler } from "./index";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_ACCOUNT_ID = "acc_01HXY0000000000000000000AA";
const TEST_CHANNEL_TOKEN = "secret-token-abc123";
const TEST_CHANNEL_ID = "channel-uuid-12345";
const TEST_RESOURCE_ID = "resource-id-67890";
const TEST_CALENDAR_ID = "user@example.com";
const TEST_MS_CLIENT_STATE = "ms-webhook-secret-xyz";
const TEST_MS_SUBSCRIPTION_ID = "ms-sub-aaa-111-bbb";
const TEST_MS_CALENDAR_ID = "AAMkAGU0OGRh";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Minimal mock D1 that supports prepare().bind().first() pattern. */
function createMockD1(
  accounts: Array<{
    account_id: string;
    channel_token: string | null;
    channel_id?: string;
    channel_calendar_id?: string | null;
    provider?: string;
    status?: string;
  }> = [],
  msSubscriptions: Array<{
    subscription_id: string;
    account_id: string;
    calendar_id?: string | null;
  }> = [],
) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (
                sql.includes("provider = 'microsoft'") &&
                sql.includes("channel_id = ?1")
              ) {
                const subscriptionId = args[0] as string;
                const match = accounts.find(
                  (a) =>
                    a.provider === "microsoft" &&
                    (a.status ?? "active") !== "revoked" &&
                    a.channel_id === subscriptionId,
                );
                if (!match) return null;
                return ({
                  account_id: match.account_id,
                  channel_token: match.channel_token,
                  channel_calendar_id: match.channel_calendar_id ?? null,
                } as T);
              }

              if (sql.includes("FROM ms_subscriptions ms")) {
                const subId = args[0] as string;
                const sub = msSubscriptions.find((s) => s.subscription_id === subId);
                if (!sub) return null;
                const account = accounts.find((a) => a.account_id === sub.account_id);
                if (!account) return null;
                return ({
                  account_id: account.account_id,
                  channel_token: account.channel_token,
                  calendar_id: sub.calendar_id ?? null,
                } as T);
              }

              if (sql.includes("ms_subscriptions")) {
                const subId = args[0] as string;
                const match = msSubscriptions.find(
                  (s) => s.subscription_id === subId,
                );
                return (match as T) ?? null;
              }

              // Look up by channel_token -- now returns channel_calendar_id too
              const token = args[0] as string;
              const match = accounts.find((a) => a.channel_token === token);
              if (!match) return null;
              return ({
                account_id: match.account_id,
                channel_calendar_id: match.channel_calendar_id ?? null,
              } as T);
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

/** Minimal mock Queue that captures sent messages. */
function createMockQueue() {
  const messages: unknown[] = [];
  return {
    messages,
    async send(msg: unknown) {
      messages.push(msg);
    },
  } as unknown as Queue & { messages: unknown[] };
}

/** Build a mock Env with optional D1 data. */
function createMockEnv(opts?: {
  accounts?: Array<{
    account_id: string;
    channel_token: string | null;
    channel_id?: string;
    channel_calendar_id?: string | null;
    provider?: string;
    status?: string;
  }>;
  msSubscriptions?: Array<{
    subscription_id: string;
    account_id: string;
    calendar_id?: string | null;
  }>;
  msClientState?: string;
}) {
  const queue = createMockQueue();
  return {
    env: {
      DB: createMockD1(opts?.accounts ?? [], opts?.msSubscriptions ?? []),
      SYNC_QUEUE: queue,
      MS_WEBHOOK_CLIENT_STATE: opts?.msClientState ?? TEST_MS_CLIENT_STATE,
    } as Env,
    queue,
  };
}

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

/** Build a POST /webhook/google request with Google headers. */
function buildWebhookRequest(overrides?: {
  channelId?: string;
  resourceId?: string;
  resourceState?: string;
  channelToken?: string;
  method?: string;
  path?: string;
}) {
  const method = overrides?.method ?? "POST";
  const path = overrides?.path ?? "/webhook/google";
  const headers: Record<string, string> = {};

  if (overrides?.channelId !== undefined) {
    headers["X-Goog-Channel-ID"] = overrides.channelId;
  } else {
    headers["X-Goog-Channel-ID"] = TEST_CHANNEL_ID;
  }

  if (overrides?.resourceId !== undefined) {
    headers["X-Goog-Resource-ID"] = overrides.resourceId;
  } else {
    headers["X-Goog-Resource-ID"] = TEST_RESOURCE_ID;
  }

  if (overrides?.resourceState !== undefined) {
    headers["X-Goog-Resource-State"] = overrides.resourceState;
  } else {
    headers["X-Goog-Resource-State"] = "exists";
  }

  if (overrides?.channelToken !== undefined) {
    headers["X-Goog-Channel-Token"] = overrides.channelToken;
  } else {
    headers["X-Goog-Channel-Token"] = TEST_CHANNEL_TOKEN;
  }

  return new Request(`https://webhook.tminus.dev${path}`, {
    method,
    headers,
  });
}

/** Build a Microsoft change notification POST body. */
function buildMsNotificationBody(overrides?: {
  subscriptionId?: string;
  changeType?: string;
  clientState?: string;
  resource?: string;
}) {
  return {
    value: [
      {
        subscriptionId: overrides?.subscriptionId ?? TEST_MS_SUBSCRIPTION_ID,
        changeType: overrides?.changeType ?? "updated",
        clientState: overrides?.clientState ?? TEST_MS_CLIENT_STATE,
        resource: overrides?.resource ?? "users/abc123/events/evt-1",
        resourceData: {
          "@odata.type": "#microsoft.graph.event",
          id: "evt-1",
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Google Webhook tests
// ---------------------------------------------------------------------------

describe("POST /webhook/google", () => {
  it("valid webhook with known channel_token enqueues SYNC_INCREMENTAL and returns 200", async () => {
    const { env, queue } = createMockEnv({
      accounts: [{
        account_id: TEST_ACCOUNT_ID,
        channel_token: TEST_CHANNEL_TOKEN,
        channel_calendar_id: TEST_CALENDAR_ID,
      }],
    });
    const handler = createHandler();

    const request = buildWebhookRequest({ resourceState: "exists" });
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    expect(queue.messages.length).toBe(1);

    const msg = queue.messages[0] as {
      type: string;
      account_id: string;
      channel_id: string;
      resource_id: string;
      ping_ts: string;
      calendar_id: string | null;
    };
    expect(msg.type).toBe("SYNC_INCREMENTAL");
    expect(msg.account_id).toBe(TEST_ACCOUNT_ID);
    expect(msg.channel_id).toBe(TEST_CHANNEL_ID);
    expect(msg.resource_id).toBe(TEST_RESOURCE_ID);
    expect(msg.ping_ts).toBeTruthy();
    expect(msg.calendar_id).toBe(TEST_CALENDAR_ID);
  });

  it("resolves to scoped calendar_id when channel_calendar_id is set (AC 1)", async () => {
    const { env, queue } = createMockEnv({
      accounts: [{
        account_id: TEST_ACCOUNT_ID,
        channel_token: TEST_CHANNEL_TOKEN,
        channel_calendar_id: "work-calendar-123",
      }],
    });
    const handler = createHandler();

    const request = buildWebhookRequest();
    await handler.fetch(request, env, mockCtx);

    expect(queue.messages.length).toBe(1);
    const msg = queue.messages[0] as { calendar_id: string | null };
    expect(msg.calendar_id).toBe("work-calendar-123");
  });

  it("enqueues with calendar_id: null for legacy channel (no channel_calendar_id)", async () => {
    const { env, queue } = createMockEnv({
      accounts: [{
        account_id: TEST_ACCOUNT_ID,
        channel_token: TEST_CHANNEL_TOKEN,
        // No channel_calendar_id -- legacy channel
      }],
    });
    const handler = createHandler();

    const request = buildWebhookRequest();
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    expect(queue.messages.length).toBe(1);
    const msg = queue.messages[0] as { calendar_id: string | null };
    expect(msg.calendar_id).toBeNull();
  });

  it("unknown channel_token returns 200 but does NOT enqueue", async () => {
    const { env, queue } = createMockEnv({
      accounts: [{ account_id: TEST_ACCOUNT_ID, channel_token: "different-token" }],
    });
    const handler = createHandler();

    const request = buildWebhookRequest({ channelToken: "unknown-token" });
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    expect(queue.messages.length).toBe(0);
  });

  it("missing Google headers returns 200 (always 200 to Google)", async () => {
    const { env, queue } = createMockEnv();
    const handler = createHandler();

    // Send a bare POST with no Google headers
    const request = new Request("https://webhook.tminus.dev/webhook/google", {
      method: "POST",
    });
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    expect(queue.messages.length).toBe(0);
  });

  it("'sync' resource_state returns 200 WITHOUT enqueueing", async () => {
    const { env, queue } = createMockEnv({
      accounts: [{ account_id: TEST_ACCOUNT_ID, channel_token: TEST_CHANNEL_TOKEN }],
    });
    const handler = createHandler();

    const request = buildWebhookRequest({ resourceState: "sync" });
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    expect(queue.messages.length).toBe(0);
  });

  it("'exists' resource_state enqueues correctly", async () => {
    const { env, queue } = createMockEnv({
      accounts: [{
        account_id: TEST_ACCOUNT_ID,
        channel_token: TEST_CHANNEL_TOKEN,
        channel_calendar_id: "primary",
      }],
    });
    const handler = createHandler();

    const request = buildWebhookRequest({ resourceState: "exists" });
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    expect(queue.messages.length).toBe(1);
    expect((queue.messages[0] as { type: string }).type).toBe("SYNC_INCREMENTAL");
  });

  it("'not_exists' resource_state enqueues correctly", async () => {
    const { env, queue } = createMockEnv({
      accounts: [{
        account_id: TEST_ACCOUNT_ID,
        channel_token: TEST_CHANNEL_TOKEN,
        channel_calendar_id: "primary",
      }],
    });
    const handler = createHandler();

    const request = buildWebhookRequest({ resourceState: "not_exists" });
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    expect(queue.messages.length).toBe(1);
    expect((queue.messages[0] as { type: string }).type).toBe("SYNC_INCREMENTAL");
  });

  it("enqueued message has correct shape including calendar_id", async () => {
    const { env, queue } = createMockEnv({
      accounts: [{
        account_id: TEST_ACCOUNT_ID,
        channel_token: TEST_CHANNEL_TOKEN,
        channel_calendar_id: "work@example.com",
      }],
    });
    const handler = createHandler();

    const before = new Date().toISOString();
    const request = buildWebhookRequest({ resourceState: "exists" });
    await handler.fetch(request, env, mockCtx);
    const after = new Date().toISOString();

    expect(queue.messages.length).toBe(1);
    const msg = queue.messages[0] as Record<string, unknown>;

    // Verify exact shape: only expected keys (now includes calendar_id)
    const keys = Object.keys(msg).sort();
    expect(keys).toEqual(["account_id", "calendar_id", "channel_id", "ping_ts", "resource_id", "type"]);

    // Verify types
    expect(typeof msg.type).toBe("string");
    expect(typeof msg.account_id).toBe("string");
    expect(typeof msg.channel_id).toBe("string");
    expect(typeof msg.resource_id).toBe("string");
    expect(typeof msg.ping_ts).toBe("string");
    expect(typeof msg.calendar_id).toBe("string");

    // Verify values
    expect(msg.type).toBe("SYNC_INCREMENTAL");
    expect(msg.account_id).toBe(TEST_ACCOUNT_ID);
    expect(msg.channel_id).toBe(TEST_CHANNEL_ID);
    expect(msg.resource_id).toBe(TEST_RESOURCE_ID);
    expect(msg.calendar_id).toBe("work@example.com");

    // Verify ping_ts is a valid ISO timestamp within test window
    const pingTs = msg.ping_ts as string;
    expect(pingTs >= before).toBe(true);
    expect(pingTs <= after).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Microsoft Webhook tests
// ---------------------------------------------------------------------------

describe("POST /webhook/microsoft", () => {
  // AC 1: Validation handshake
  it("returns validationToken as plain text for subscription handshake (AC 1)", async () => {
    const { env } = createMockEnv();
    const handler = createHandler();

    const request = new Request(
      "https://webhook.tminus.dev/webhook/microsoft?validationToken=test-validation-token-xyz",
      { method: "POST" },
    );
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe("test-validation-token-xyz");
    expect(response.headers.get("Content-Type")).toBe("text/plain");
  });

  it("returns URL-encoded validationToken correctly", async () => {
    const { env } = createMockEnv();
    const handler = createHandler();

    const token = "abc+def/ghi=jkl";
    const request = new Request(
      `https://webhook.tminus.dev/webhook/microsoft?validationToken=${encodeURIComponent(token)}`,
      { method: "POST" },
    );
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe(token);
  });

  // AC 2: Change notification enqueues SYNC_INCREMENTAL with calendar_id
  it("change notification enqueues SYNC_INCREMENTAL with scoped calendar_id (AC 2)", async () => {
    const { env, queue } = createMockEnv({
      accounts: [{
        account_id: TEST_ACCOUNT_ID,
        provider: "microsoft",
        status: "active",
        channel_id: TEST_MS_SUBSCRIPTION_ID,
        channel_token: TEST_MS_CLIENT_STATE,
        channel_calendar_id: TEST_MS_CALENDAR_ID,
      }],
    });
    const handler = createHandler();

    const body = buildMsNotificationBody();
    const request = new Request("https://webhook.tminus.dev/webhook/microsoft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(202);
    expect(queue.messages.length).toBe(1);

    const msg = queue.messages[0] as Record<string, unknown>;
    expect(msg.type).toBe("SYNC_INCREMENTAL");
    expect(msg.account_id).toBe(TEST_ACCOUNT_ID);
    expect(msg.channel_id).toBe(TEST_MS_SUBSCRIPTION_ID);
    expect(msg.resource_id).toBe("users/abc123/events/evt-1");
    expect(typeof msg.ping_ts).toBe("string");
    expect(msg.calendar_id).toBe(TEST_MS_CALENDAR_ID);
  });

  it("enqueues with calendar_id: null for legacy Microsoft subscription (no calendar_id)", async () => {
    const { env, queue } = createMockEnv({
      accounts: [{
        account_id: TEST_ACCOUNT_ID,
        provider: "microsoft",
        status: "active",
        channel_id: TEST_MS_SUBSCRIPTION_ID,
        channel_token: TEST_MS_CLIENT_STATE,
        // No channel_calendar_id -- legacy subscription
      }],
    });
    const handler = createHandler();

    const body = buildMsNotificationBody();
    const request = new Request("https://webhook.tminus.dev/webhook/microsoft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(202);
    expect(queue.messages.length).toBe(1);
    const msg = queue.messages[0] as { calendar_id: string | null };
    expect(msg.calendar_id).toBeNull();
  });

  it("legacy ms_subscriptions fallback resolves calendar_id", async () => {
    const { env, queue } = createMockEnv({
      accounts: [{
        account_id: TEST_ACCOUNT_ID,
        provider: "microsoft",
        status: "active",
        channel_token: TEST_MS_CLIENT_STATE,
        // No channel_id -- won't match direct lookup
      }],
      msSubscriptions: [{
        subscription_id: TEST_MS_SUBSCRIPTION_ID,
        account_id: TEST_ACCOUNT_ID,
        calendar_id: "legacy-cal-789",
      }],
    });
    const handler = createHandler();

    const body = buildMsNotificationBody();
    const request = new Request("https://webhook.tminus.dev/webhook/microsoft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(202);
    expect(queue.messages.length).toBe(1);
    const msg = queue.messages[0] as { calendar_id: string | null };
    expect(msg.calendar_id).toBe("legacy-cal-789");
  });

  it("accepts microsoft accounts in status='error' (only revoked is excluded)", async () => {
    const { env, queue } = createMockEnv({
      accounts: [{
        account_id: TEST_ACCOUNT_ID,
        provider: "microsoft",
        status: "error",
        channel_id: TEST_MS_SUBSCRIPTION_ID,
        channel_token: TEST_MS_CLIENT_STATE,
        channel_calendar_id: TEST_MS_CALENDAR_ID,
      }],
    });
    const handler = createHandler();

    const body = buildMsNotificationBody();
    const request = new Request("https://webhook.tminus.dev/webhook/microsoft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(202);
    expect(queue.messages.length).toBe(1);
  });

  it("excludes microsoft accounts in status='revoked'", async () => {
    const { env, queue } = createMockEnv({
      accounts: [{
        account_id: TEST_ACCOUNT_ID,
        provider: "microsoft",
        status: "revoked",
        channel_id: TEST_MS_SUBSCRIPTION_ID,
        channel_token: TEST_MS_CLIENT_STATE,
      }],
    });
    const handler = createHandler();

    const body = buildMsNotificationBody();
    const request = new Request("https://webhook.tminus.dev/webhook/microsoft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(202);
    expect(queue.messages.length).toBe(0);
  });

  // AC 5: clientState validation (security check)
  it("returns 202 and skips enqueue when clientState does not match (AC 5)", async () => {
    const { env, queue } = createMockEnv({
      accounts: [{
        account_id: TEST_ACCOUNT_ID,
        provider: "microsoft",
        status: "active",
        channel_id: TEST_MS_SUBSCRIPTION_ID,
        channel_token: TEST_MS_CLIENT_STATE,
      }],
    });
    const handler = createHandler();

    const body = buildMsNotificationBody({
      clientState: "wrong-secret",
    });
    const request = new Request("https://webhook.tminus.dev/webhook/microsoft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(202);
    expect(queue.messages.length).toBe(0);
  });

  it("continues processing valid notifications when one clientState mismatches", async () => {
    const { env, queue } = createMockEnv({
      accounts: [
        {
          account_id: "acc_valid",
          provider: "microsoft",
          status: "active",
          channel_id: "sub-valid",
          channel_token: TEST_MS_CLIENT_STATE,
          channel_calendar_id: "cal-valid",
        },
        {
          account_id: "acc_bad",
          provider: "microsoft",
          status: "active",
          channel_id: "sub-bad",
          channel_token: "expected-bad-secret",
        },
      ],
    });
    const handler = createHandler();

    const body = {
      value: [
        {
          subscriptionId: "sub-bad",
          changeType: "updated",
          clientState: "wrong-secret",
          resource: "users/b/events/e2",
        },
        {
          subscriptionId: "sub-valid",
          changeType: "created",
          clientState: TEST_MS_CLIENT_STATE,
          resource: "users/a/events/e1",
        },
      ],
    };
    const request = new Request("https://webhook.tminus.dev/webhook/microsoft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(202);
    expect(queue.messages.length).toBe(1);
    expect((queue.messages[0] as { account_id: string }).account_id).toBe("acc_valid");
  });

  // Malformed body handling
  it("returns 400 for malformed (non-JSON) body", async () => {
    const { env, queue } = createMockEnv();
    const handler = createHandler();

    const request = new Request("https://webhook.tminus.dev/webhook/microsoft", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not json at all",
    });

    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(400);
    expect(queue.messages.length).toBe(0);
  });

  // Empty body
  it("returns 400 for empty body", async () => {
    const { env, queue } = createMockEnv();
    const handler = createHandler();

    const request = new Request("https://webhook.tminus.dev/webhook/microsoft", {
      method: "POST",
    });

    const response = await handler.fetch(request, env, mockCtx);

    // Empty body fails JSON.parse -> 400
    expect(response.status).toBe(400);
    expect(queue.messages.length).toBe(0);
  });

  // Empty value array
  it("returns 202 for empty value array", async () => {
    const { env, queue } = createMockEnv();
    const handler = createHandler();

    const request = new Request("https://webhook.tminus.dev/webhook/microsoft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: [] }),
    });

    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(202);
    expect(queue.messages.length).toBe(0);
  });

  // Unknown subscription
  it("returns 202 but does not enqueue for unknown subscriptionId (AC 4)", async () => {
    const { env, queue } = createMockEnv({
      msSubscriptions: [], // no subscriptions registered
    });
    const handler = createHandler();

    const body = buildMsNotificationBody();
    const request = new Request("https://webhook.tminus.dev/webhook/microsoft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(202);
    expect(queue.messages.length).toBe(0);
  });

  // TM-9fc9: webhook_change_type passthrough
  it("enqueued message includes webhook_change_type from notification.changeType", async () => {
    const { env, queue } = createMockEnv({
      accounts: [{
        account_id: TEST_ACCOUNT_ID,
        provider: "microsoft",
        status: "active",
        channel_id: TEST_MS_SUBSCRIPTION_ID,
        channel_token: TEST_MS_CLIENT_STATE,
        channel_calendar_id: TEST_MS_CALENDAR_ID,
      }],
    });
    const handler = createHandler();

    const body = buildMsNotificationBody({ changeType: "deleted" });
    const request = new Request("https://webhook.tminus.dev/webhook/microsoft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(202);
    expect(queue.messages.length).toBe(1);

    const msg = queue.messages[0] as Record<string, unknown>;
    expect(msg.type).toBe("SYNC_INCREMENTAL");
    expect(msg.webhook_change_type).toBe("deleted");
  });

  it("enqueued message includes webhook_change_type='created' when notification is created", async () => {
    const { env, queue } = createMockEnv({
      accounts: [{
        account_id: TEST_ACCOUNT_ID,
        provider: "microsoft",
        status: "active",
        channel_id: TEST_MS_SUBSCRIPTION_ID,
        channel_token: TEST_MS_CLIENT_STATE,
        channel_calendar_id: TEST_MS_CALENDAR_ID,
      }],
    });
    const handler = createHandler();

    const body = buildMsNotificationBody({ changeType: "created" });
    const request = new Request("https://webhook.tminus.dev/webhook/microsoft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    await handler.fetch(request, env, mockCtx);

    expect(queue.messages.length).toBe(1);
    const msg = queue.messages[0] as Record<string, unknown>;
    expect(msg.webhook_change_type).toBe("created");
  });

  // Multiple notifications with per-scope routing
  it("processes multiple notifications with per-scope calendar_ids", async () => {
    const { env, queue } = createMockEnv({
      accounts: [
        {
          account_id: "acc_01",
          provider: "microsoft",
          status: "active",
          channel_id: "sub-1",
          channel_token: TEST_MS_CLIENT_STATE,
          channel_calendar_id: "cal-work",
        },
        {
          account_id: "acc_02",
          provider: "microsoft",
          status: "active",
          channel_id: "sub-2",
          channel_token: TEST_MS_CLIENT_STATE,
          channel_calendar_id: "cal-personal",
        },
      ],
    });
    const handler = createHandler();

    const body = {
      value: [
        {
          subscriptionId: "sub-1",
          changeType: "created",
          clientState: TEST_MS_CLIENT_STATE,
          resource: "users/a/events/e1",
        },
        {
          subscriptionId: "sub-2",
          changeType: "updated",
          clientState: TEST_MS_CLIENT_STATE,
          resource: "users/b/events/e2",
        },
      ],
    };
    const request = new Request("https://webhook.tminus.dev/webhook/microsoft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(202);
    expect(queue.messages.length).toBe(2);

    const msgs = queue.messages as Array<Record<string, unknown>>;
    expect(msgs[0].account_id).toBe("acc_01");
    expect(msgs[0].calendar_id).toBe("cal-work");
    expect(msgs[1].account_id).toBe("acc_02");
    expect(msgs[1].calendar_id).toBe("cal-personal");
  });

  // GET /webhook/microsoft still returns 404
  it("GET /webhook/microsoft returns 404 (only POST accepted)", async () => {
    const { env } = createMockEnv();
    const handler = createHandler();

    const request = new Request("https://webhook.tminus.dev/webhook/microsoft", {
      method: "GET",
    });
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Routing tests
// ---------------------------------------------------------------------------

describe("Worker routing", () => {
  it("GET /health returns 200 with enriched health data", async () => {
    const { env } = createMockEnv();
    const handler = createHandler();

    const request = new Request("https://webhook.tminus.dev/health", {
      method: "GET",
    });
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      data: {
        status: string;
        version: string;
        worker: string;
        environment: string;
        bindings: Array<{ name: string; type: string; available: boolean }>;
      };
      error: null;
      meta: { timestamp: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBeDefined();
    expect(body.data.version).toBe("0.0.1");
    expect(body.data.worker).toBe("tminus-webhook");
    expect(body.data.environment).toBe("development");
    expect(Array.isArray(body.data.bindings)).toBe(true);
    const bindingNames = body.data.bindings.map((b) => b.name);
    expect(bindingNames).toContain("DB");
    expect(bindingNames).toContain("SYNC_QUEUE");
    expect(body.error).toBeNull();
    expect(body.meta.timestamp).toBeTruthy();
  });

  it("unknown routes return 404", async () => {
    const { env } = createMockEnv();
    const handler = createHandler();

    const request = new Request("https://webhook.tminus.dev/unknown", {
      method: "GET",
    });
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(404);
  });

  it("GET /webhook/google returns 404 (only POST accepted)", async () => {
    const { env } = createMockEnv();
    const handler = createHandler();

    const request = new Request("https://webhook.tminus.dev/webhook/google", {
      method: "GET",
    });
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(404);
  });
});
