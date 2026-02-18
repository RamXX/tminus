/**
 * Unit tests for the internal/admin route handler.
 *
 * Tests the routeInternalRequest dispatcher and handleRenewChannel handler
 * using mock D1, mock DOs, and mock env.
 *
 * Unit tests use mocks for DOs and external calls (Google API).
 * Integration tests (in internal.integration.test.ts) use real D1 via
 * better-sqlite3.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { routeInternalRequest } from "./internal";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ADMIN_KEY = "test-admin-key-for-unit-tests";

const TEST_ACCOUNT_GOOGLE = {
  account_id: "acc_01HXYZ0000000000000000GOOG",
  provider: "google",
  status: "active",
  channel_id: "old-channel-123",
  resource_id: "old-resource-456",
} as const;

const TEST_ACCOUNT_MS = {
  account_id: "acc_01HXYZ0000000000000000MSFT",
  provider: "microsoft",
  status: "active",
  channel_id: null,
  resource_id: null,
} as const;

const TEST_ACCOUNT_ERROR = {
  account_id: "acc_01HXYZ0000000000000000ERRR",
  provider: "google",
  status: "error",
  channel_id: "dead-channel",
  resource_id: "dead-resource",
} as const;

// ---------------------------------------------------------------------------
// Mock D1
// ---------------------------------------------------------------------------

function createMockD1(accounts: Map<string, Record<string, unknown>>): D1Database {
  const mockStatement = {
    bind: (...args: unknown[]) => {
      const accountId = args[0] as string;
      return {
        first: async () => accounts.get(accountId) ?? null,
        all: async () => ({ results: [], success: true, meta: {} }),
        run: async () => ({ results: [], success: true, meta: {} }),
      };
    },
  };
  return {
    prepare: (_sql: string) => mockStatement,
    dump: async () => new ArrayBuffer(0),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
  } as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// Mock DO namespace (captures calls, returns configured responses)
// ---------------------------------------------------------------------------

interface DOCallRecord {
  path: string;
  method: string;
  body?: unknown;
}

function createMockAccountDO(
  responses?: Map<string, { status: number; body: unknown }>,
): DurableObjectNamespace & { calls: DOCallRecord[] } {
  const calls: DOCallRecord[] = [];
  return {
    calls,
    idFromName: (_name: string) =>
      ({ toString: () => _name, equals: () => false } as unknown as DurableObjectId),
    get: (_id: DurableObjectId) => ({
      async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const url = typeof input === "string" ? new URL(input) : new URL((input as Request).url);
        const method = init?.method
          ?? (typeof input === "object" && "method" in input ? (input as Request).method : "GET");
        let parsedBody: unknown;
        if (init?.body) {
          try { parsedBody = JSON.parse(init.body as string); } catch { parsedBody = init.body; }
        } else if (typeof input === "object" && "json" in input) {
          try { parsedBody = await (input as Request).clone().json(); } catch { /* no body */ }
        }
        calls.push({ path: url.pathname, method, body: parsedBody });

        const customResp = responses?.get(url.pathname);
        if (customResp) {
          return new Response(JSON.stringify(customResp.body), {
            status: customResp.status,
            headers: { "Content-Type": "application/json" },
          });
        }

        // Default: success for getAccessToken, 200 for storeWatchChannel
        if (url.pathname === "/getAccessToken") {
          return new Response(
            JSON.stringify({ access_token: "mock-google-token" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.pathname === "/storeWatchChannel") {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    } as unknown as DurableObjectStub),
    idFromString: () => ({ toString: () => "x", equals: () => false } as unknown as DurableObjectId),
    newUniqueId: () => ({ toString: () => "u", equals: () => false } as unknown as DurableObjectId),
    jurisdiction: function() { return this; },
  } as unknown as DurableObjectNamespace & { calls: DOCallRecord[] };
}

// ---------------------------------------------------------------------------
// Mock GoogleCalendarClient
// ---------------------------------------------------------------------------

const watchEventsResult = {
  channelId: "new-channel-from-google",
  resourceId: "new-resource-from-google",
  expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
};

vi.mock("@tminus/shared", async () => {
  const actual = await vi.importActual("@tminus/shared");
  return {
    ...actual,
    GoogleCalendarClient: vi.fn().mockImplementation(() => ({
      stopChannel: vi.fn(async () => {}),
      watchEvents: vi.fn(async () => watchEventsResult),
    })),
    generateId: vi.fn((prefix: string) => `${prefix}_mock_${Date.now()}`),
    // Mock renewWebhookChannel -- the shared function that renewChannelForAccount
    // now delegates to. Without this mock, the real renewWebhookChannel would use
    // internal imports (./google-api) that bypass the @tminus/shared-level
    // GoogleCalendarClient mock, causing real HTTP calls to Google.
    renewWebhookChannel: vi.fn(async (params: {
      accountId: string;
      oldChannelId: string | null;
      oldResourceId: string | null;
      accountDOStub: { fetch(input: Request): Promise<Response> };
      db: D1Database;
      webhookUrl: string;
    }) => {
      // Step 1: Get access token from AccountDO
      const tokenResponse = await params.accountDOStub.fetch(
        new Request("https://account-do.internal/getAccessToken", { method: "POST" }),
      );
      if (!tokenResponse.ok) {
        throw new Error(`Failed to get access token for account ${params.accountId}: ${tokenResponse.status}`);
      }

      // Step 2: Stop old channel (best-effort)
      if (params.oldChannelId && params.oldResourceId) {
        // best-effort, no-op in test
      }

      // Step 3 + 4: Register new channel and store in AccountDO
      const storeResponse = await params.accountDOStub.fetch(
        new Request("https://account-do.internal/storeWatchChannel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel_id: watchEventsResult.channelId,
            resource_id: watchEventsResult.resourceId,
            expiration: watchEventsResult.expiration,
            calendar_id: "primary",
          }),
        }),
      );
      if (!storeResponse.ok) {
        throw new Error(`Failed to store new channel in AccountDO for account ${params.accountId}: ${storeResponse.status}`);
      }

      // Step 5: Update D1
      const expiryTs = new Date(parseInt(watchEventsResult.expiration, 10)).toISOString();
      await params.db
        .prepare(
          `UPDATE accounts
           SET channel_id = ?1, channel_token = ?2, channel_expiry_ts = ?3, resource_id = ?4
           WHERE account_id = ?5`,
        )
        .bind(watchEventsResult.channelId, "token_mock", expiryTs, watchEventsResult.resourceId, params.accountId)
        .run();

      return {
        account_id: params.accountId,
        channel_id: watchEventsResult.channelId,
        resource_id: watchEventsResult.resourceId,
        expiry: expiryTs,
        previous_channel_id: params.oldChannelId,
      };
    }),
  };
});

// ---------------------------------------------------------------------------
// Env builder
// ---------------------------------------------------------------------------

function buildEnv(overrides?: {
  accounts?: Map<string, Record<string, unknown>>;
  accountDO?: DurableObjectNamespace;
  adminKey?: string;
  webhookUrl?: string;
}): Env {
  const accounts = overrides?.accounts ?? new Map([
    [TEST_ACCOUNT_GOOGLE.account_id, { ...TEST_ACCOUNT_GOOGLE }],
    [TEST_ACCOUNT_MS.account_id, { ...TEST_ACCOUNT_MS }],
    [TEST_ACCOUNT_ERROR.account_id, { ...TEST_ACCOUNT_ERROR }],
  ]);

  return {
    DB: createMockD1(accounts),
    USER_GRAPH: {} as DurableObjectNamespace,
    ACCOUNT: overrides?.accountDO ?? createMockAccountDO(),
    SYNC_QUEUE: {} as Queue,
    WRITE_QUEUE: {} as Queue,
    SESSIONS: {} as KVNamespace,
    RATE_LIMITS: {} as KVNamespace,
    JWT_SECRET: "unused-in-unit",
    ADMIN_KEY: overrides?.adminKey ?? ADMIN_KEY,
    WEBHOOK_URL: overrides?.webhookUrl ?? "https://webhooks.tminus.ink/webhook/google",
  };
}

// ---------------------------------------------------------------------------
// Helper: make internal request
// ---------------------------------------------------------------------------

function makeRequest(
  pathname: string,
  method = "POST",
  adminKey?: string,
): Request {
  const headers: Record<string, string> = {};
  if (adminKey !== undefined) {
    headers["X-Admin-Key"] = adminKey;
  }
  return new Request(`https://api.tminus.ink${pathname}`, { method, headers });
}

// ===========================================================================
// Tests
// ===========================================================================

describe("Internal route dispatcher", () => {
  it("returns null for non-internal paths", async () => {
    const env = buildEnv();
    const req = makeRequest("/v1/accounts", "GET", ADMIN_KEY);
    const result = await routeInternalRequest(req, "GET", "/v1/accounts", env);
    expect(result).toBeNull();
  });

  it("returns 401 when admin key is missing", async () => {
    const env = buildEnv();
    const req = makeRequest("/internal/accounts/acc_123/renew-channel", "POST");
    const result = await routeInternalRequest(
      req, "POST", "/internal/accounts/acc_123/renew-channel", env,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
    const body = await result!.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("admin key");
  });

  it("returns 401 when admin key is wrong", async () => {
    const env = buildEnv();
    const req = makeRequest(
      "/internal/accounts/acc_123/renew-channel", "POST", "wrong-key",
    );
    const result = await routeInternalRequest(
      req, "POST", "/internal/accounts/acc_123/renew-channel", env,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it("returns 401 when ADMIN_KEY is not configured", async () => {
    const env = buildEnv({ adminKey: undefined });
    // Need to explicitly set to undefined since buildEnv sets it
    delete (env as Record<string, unknown>).ADMIN_KEY;
    const req = makeRequest(
      "/internal/accounts/acc_123/renew-channel", "POST", "some-key",
    );
    const result = await routeInternalRequest(
      req, "POST", "/internal/accounts/acc_123/renew-channel", env,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it("returns 404 for unknown internal route with valid admin key", async () => {
    const env = buildEnv();
    const req = makeRequest("/internal/unknown", "GET", ADMIN_KEY);
    const result = await routeInternalRequest(
      req, "GET", "/internal/unknown", env,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(404);
  });
});

describe("POST /internal/accounts/:id/renew-channel", () => {
  it("returns 404 when account does not exist", async () => {
    const env = buildEnv();
    const req = makeRequest(
      "/internal/accounts/acc_nonexistent/renew-channel", "POST", ADMIN_KEY,
    );
    const result = await routeInternalRequest(
      req, "POST", "/internal/accounts/acc_nonexistent/renew-channel", env,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(404);
    const body = await result!.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("not found");
  });

  it("returns 400 when account is not a Google account", async () => {
    const env = buildEnv();
    const req = makeRequest(
      `/internal/accounts/${TEST_ACCOUNT_MS.account_id}/renew-channel`,
      "POST",
      ADMIN_KEY,
    );
    const result = await routeInternalRequest(
      req,
      "POST",
      `/internal/accounts/${TEST_ACCOUNT_MS.account_id}/renew-channel`,
      env,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(400);
    const body = await result!.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("microsoft");
    expect(body.error).toContain("Google");
  });

  it("returns 400 when account status is not active", async () => {
    const env = buildEnv();
    const req = makeRequest(
      `/internal/accounts/${TEST_ACCOUNT_ERROR.account_id}/renew-channel`,
      "POST",
      ADMIN_KEY,
    );
    const result = await routeInternalRequest(
      req,
      "POST",
      `/internal/accounts/${TEST_ACCOUNT_ERROR.account_id}/renew-channel`,
      env,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(400);
    const body = await result!.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("error");
    expect(body.error).toContain("active");
  });

  it("returns 200 with new channel details on success", async () => {
    const accountDO = createMockAccountDO();
    const env = buildEnv({ accountDO });
    const req = makeRequest(
      `/internal/accounts/${TEST_ACCOUNT_GOOGLE.account_id}/renew-channel`,
      "POST",
      ADMIN_KEY,
    );
    const result = await routeInternalRequest(
      req,
      "POST",
      `/internal/accounts/${TEST_ACCOUNT_GOOGLE.account_id}/renew-channel`,
      env,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(200);
    const body = await result!.json() as {
      ok: boolean;
      data: {
        account_id: string;
        channel_id: string;
        resource_id: string;
        expiry: string;
        previous_channel_id: string | null;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.account_id).toBe(TEST_ACCOUNT_GOOGLE.account_id);
    expect(body.data.channel_id).toBe("new-channel-from-google");
    expect(body.data.resource_id).toBe("new-resource-from-google");
    expect(body.data.expiry).toBeTruthy();
    expect(body.data.previous_channel_id).toBe("old-channel-123");
  });

  it("calls AccountDO to get access token and store new channel", async () => {
    const accountDO = createMockAccountDO();
    const env = buildEnv({ accountDO });
    const req = makeRequest(
      `/internal/accounts/${TEST_ACCOUNT_GOOGLE.account_id}/renew-channel`,
      "POST",
      ADMIN_KEY,
    );
    await routeInternalRequest(
      req,
      "POST",
      `/internal/accounts/${TEST_ACCOUNT_GOOGLE.account_id}/renew-channel`,
      env,
    );

    // Verify DO calls: getAccessToken + storeWatchChannel
    expect(accountDO.calls.length).toBe(2);
    expect(accountDO.calls[0].path).toBe("/getAccessToken");
    expect(accountDO.calls[0].method).toBe("POST");
    expect(accountDO.calls[1].path).toBe("/storeWatchChannel");
    expect(accountDO.calls[1].method).toBe("POST");
    expect(accountDO.calls[1].body).toHaveProperty("channel_id", "new-channel-from-google");
    expect(accountDO.calls[1].body).toHaveProperty("resource_id", "new-resource-from-google");
  });

  it("returns 500 when AccountDO fails to provide access token", async () => {
    const accountDO = createMockAccountDO(
      new Map([["/getAccessToken", { status: 500, body: { error: "token_expired" } }]]),
    );
    const env = buildEnv({ accountDO });
    const req = makeRequest(
      `/internal/accounts/${TEST_ACCOUNT_GOOGLE.account_id}/renew-channel`,
      "POST",
      ADMIN_KEY,
    );
    const result = await routeInternalRequest(
      req,
      "POST",
      `/internal/accounts/${TEST_ACCOUNT_GOOGLE.account_id}/renew-channel`,
      env,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(500);
    const body = await result!.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("access token");
  });

  it("returns 500 when WEBHOOK_URL is not configured", async () => {
    const env = buildEnv({ webhookUrl: undefined });
    delete (env as Record<string, unknown>).WEBHOOK_URL;
    const req = makeRequest(
      `/internal/accounts/${TEST_ACCOUNT_GOOGLE.account_id}/renew-channel`,
      "POST",
      ADMIN_KEY,
    );
    const result = await routeInternalRequest(
      req,
      "POST",
      `/internal/accounts/${TEST_ACCOUNT_GOOGLE.account_id}/renew-channel`,
      env,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(500);
    const body = await result!.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("WEBHOOK_URL");
  });

  it("returns 500 when AccountDO fails to store new channel", async () => {
    const accountDO = createMockAccountDO(
      new Map([["/storeWatchChannel", { status: 500, body: { error: "storage_failed" } }]]),
    );
    const env = buildEnv({ accountDO });
    const req = makeRequest(
      `/internal/accounts/${TEST_ACCOUNT_GOOGLE.account_id}/renew-channel`,
      "POST",
      ADMIN_KEY,
    );
    const result = await routeInternalRequest(
      req,
      "POST",
      `/internal/accounts/${TEST_ACCOUNT_GOOGLE.account_id}/renew-channel`,
      env,
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(500);
    const body = await result!.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("store new channel");
  });
});
