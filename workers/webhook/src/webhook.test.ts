/**
 * Tests for tminus-webhook worker.
 *
 * Covers:
 * - Valid webhook with known channel_token enqueues SYNC_INCREMENTAL
 * - Unknown channel_token returns 200 but does NOT enqueue
 * - Missing Google headers returns 200 (always 200 to Google)
 * - 'sync' resource_state returns 200 WITHOUT enqueueing
 * - 'exists' resource_state enqueues correctly
 * - 'not_exists' resource_state enqueues correctly
 * - Health endpoint returns 200
 * - Unknown routes return 404
 * - Enqueued message has correct shape
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

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Minimal mock D1 that supports prepare().bind().first() pattern. */
function createMockD1(accounts: Array<{ account_id: string; channel_token: string }> = []) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              // Look up by channel_token
              const token = args[0] as string;
              const match = accounts.find((a) => a.channel_token === token);
              return (match as T) ?? null;
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
function createMockEnv(
  accounts: Array<{ account_id: string; channel_token: string }> = [],
) {
  const queue = createMockQueue();
  return {
    env: {
      DB: createMockD1(accounts),
      SYNC_QUEUE: queue,
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

// ---------------------------------------------------------------------------
// Webhook tests
// ---------------------------------------------------------------------------

describe("POST /webhook/google", () => {
  it("valid webhook with known channel_token enqueues SYNC_INCREMENTAL and returns 200", async () => {
    const { env, queue } = createMockEnv([
      { account_id: TEST_ACCOUNT_ID, channel_token: TEST_CHANNEL_TOKEN },
    ]);
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
    };
    expect(msg.type).toBe("SYNC_INCREMENTAL");
    expect(msg.account_id).toBe(TEST_ACCOUNT_ID);
    expect(msg.channel_id).toBe(TEST_CHANNEL_ID);
    expect(msg.resource_id).toBe(TEST_RESOURCE_ID);
    expect(msg.ping_ts).toBeTruthy();
  });

  it("unknown channel_token returns 200 but does NOT enqueue", async () => {
    const { env, queue } = createMockEnv([
      { account_id: TEST_ACCOUNT_ID, channel_token: "different-token" },
    ]);
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
    const { env, queue } = createMockEnv([
      { account_id: TEST_ACCOUNT_ID, channel_token: TEST_CHANNEL_TOKEN },
    ]);
    const handler = createHandler();

    const request = buildWebhookRequest({ resourceState: "sync" });
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    expect(queue.messages.length).toBe(0);
  });

  it("'exists' resource_state enqueues correctly", async () => {
    const { env, queue } = createMockEnv([
      { account_id: TEST_ACCOUNT_ID, channel_token: TEST_CHANNEL_TOKEN },
    ]);
    const handler = createHandler();

    const request = buildWebhookRequest({ resourceState: "exists" });
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    expect(queue.messages.length).toBe(1);
    expect((queue.messages[0] as { type: string }).type).toBe("SYNC_INCREMENTAL");
  });

  it("'not_exists' resource_state enqueues correctly", async () => {
    const { env, queue } = createMockEnv([
      { account_id: TEST_ACCOUNT_ID, channel_token: TEST_CHANNEL_TOKEN },
    ]);
    const handler = createHandler();

    const request = buildWebhookRequest({ resourceState: "not_exists" });
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    expect(queue.messages.length).toBe(1);
    expect((queue.messages[0] as { type: string }).type).toBe("SYNC_INCREMENTAL");
  });

  it("enqueued message has correct shape", async () => {
    const { env, queue } = createMockEnv([
      { account_id: TEST_ACCOUNT_ID, channel_token: TEST_CHANNEL_TOKEN },
    ]);
    const handler = createHandler();

    const before = new Date().toISOString();
    const request = buildWebhookRequest({ resourceState: "exists" });
    await handler.fetch(request, env, mockCtx);
    const after = new Date().toISOString();

    expect(queue.messages.length).toBe(1);
    const msg = queue.messages[0] as Record<string, unknown>;

    // Verify exact shape: only expected keys
    const keys = Object.keys(msg).sort();
    expect(keys).toEqual(["account_id", "channel_id", "ping_ts", "resource_id", "type"]);

    // Verify types
    expect(typeof msg.type).toBe("string");
    expect(typeof msg.account_id).toBe("string");
    expect(typeof msg.channel_id).toBe("string");
    expect(typeof msg.resource_id).toBe("string");
    expect(typeof msg.ping_ts).toBe("string");

    // Verify values
    expect(msg.type).toBe("SYNC_INCREMENTAL");
    expect(msg.account_id).toBe(TEST_ACCOUNT_ID);
    expect(msg.channel_id).toBe(TEST_CHANNEL_ID);
    expect(msg.resource_id).toBe(TEST_RESOURCE_ID);

    // Verify ping_ts is a valid ISO timestamp within test window
    const pingTs = msg.ping_ts as string;
    expect(pingTs >= before).toBe(true);
    expect(pingTs <= after).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Routing tests
// ---------------------------------------------------------------------------

describe("Worker routing", () => {
  it("GET /health returns 200", async () => {
    const { env } = createMockEnv();
    const handler = createHandler();

    const request = new Request("https://webhook.tminus.dev/health", {
      method: "GET",
    });
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
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

// ---------------------------------------------------------------------------
// Provider-based routing (AC 6: Webhook worker routes by provider path)
// ---------------------------------------------------------------------------

describe("POST /webhook/microsoft (Phase 5 placeholder)", () => {
  it("returns 501 Not Implemented", async () => {
    const { env } = createMockEnv();
    const handler = createHandler();

    const request = new Request("https://webhook.tminus.dev/webhook/microsoft", {
      method: "POST",
    });
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(501);
    const body = await response.text();
    expect(body).toBe("Not Implemented");
  });

  it("does not enqueue any messages", async () => {
    const { env, queue } = createMockEnv();
    const handler = createHandler();

    const request = new Request("https://webhook.tminus.dev/webhook/microsoft", {
      method: "POST",
    });
    await handler.fetch(request, env, mockCtx);

    expect(queue.messages.length).toBe(0);
  });

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
