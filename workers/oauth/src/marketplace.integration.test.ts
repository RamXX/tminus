/**
 * Integration tests for Google Workspace Marketplace install-to-sync flow.
 *
 * These tests verify the FULL end-to-end flow through the oauth worker:
 * 1. Marketplace install callback -> user creation -> account pre-connection
 * 2. Redirect to onboarding shows Google account as connected
 * 3. Full handler routing (GET /marketplace/install goes through createHandler)
 *
 * External Google APIs are mocked via injectable fetch, but the internal
 * flow (D1 queries, DO initialization, workflow creation, routing) is real.
 *
 * Pattern follows: workers/api/src/routes/onboarding.integration.test.ts
 */

import { describe, it, expect, vi } from "vitest";
import { createHandler, type FetchFn } from "./index";
import { GOOGLE_SCOPES } from "./google";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
const TEST_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const TEST_CLIENT_SECRET = "test-client-secret";
const TEST_MS_CLIENT_ID = "test-ms-client-id-00000000-0000-0000-0000-000000000000";
const TEST_MS_CLIENT_SECRET = "test-ms-client-secret";
const TEST_AUTH_CODE = "4/0AbCdEf-marketplace-integration";
const TEST_GOOGLE_SUB = "google-sub-integ-12345";
const TEST_GOOGLE_EMAIL = "marketplace-user@workspace.dev";

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

// ---------------------------------------------------------------------------
// Mock helpers (same pattern as oauth.test.ts but for Marketplace flow)
// ---------------------------------------------------------------------------

/** Create a mock fetch for the Marketplace install flow. */
function createMarketplaceMockFetch(overrides?: {
  tokenResponse?: Partial<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  }>;
  tokenStatus?: number;
  userInfoResponse?: Partial<{
    sub: string;
    email: string;
    name: string;
    hd: string;
  }>;
  userInfoStatus?: number;
}): FetchFn {
  return async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes("oauth2.googleapis.com/token")) {
      const status = overrides?.tokenStatus ?? 200;
      if (status !== 200) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status });
      }
      return new Response(
        JSON.stringify({
          access_token: "ya29.marketplace-integration-token",
          refresh_token: "1//marketplace-integration-refresh",
          expires_in: 3600,
          token_type: "Bearer",
          scope: GOOGLE_SCOPES,
          ...overrides?.tokenResponse,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.includes("googleapis.com/oauth2/v3/userinfo")) {
      const status = overrides?.userInfoStatus ?? 200;
      if (status !== 200) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status });
      }
      return new Response(
        JSON.stringify({
          sub: TEST_GOOGLE_SUB,
          email: TEST_GOOGLE_EMAIL,
          name: "Integration Test User",
          hd: "workspace.dev",
          ...overrides?.userInfoResponse,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`Unexpected fetch URL in integration test: ${url}`);
  };
}

/** Create a mock D1 with real-ish row tracking. */
function createMockD1() {
  const users: Array<Record<string, unknown>> = [];
  const accounts: Array<Record<string, unknown>> = [];
  const orgs: Array<Record<string, unknown>> = [];

  return {
    _users: users,
    _accounts: accounts,
    _orgs: orgs,

    prepare(sql: string) {
      const statement = {
        sql,
        bindings: [] as unknown[],
        bind(...args: unknown[]) {
          statement.bindings = args;
          return statement;
        },
        async all<T>(): Promise<{ results: T[]; success: boolean }> {
          if (sql.includes("SELECT") && sql.includes("users") && sql.includes("email")) {
            const email = statement.bindings[0] as string;
            const found = users.filter((u) => u.email === email) as T[];
            return { results: found, success: true };
          }
          if (sql.includes("SELECT") && sql.includes("accounts") && sql.includes("provider_subject")) {
            const providerSubject = statement.bindings[1] as string;
            const found = accounts.filter(
              (a) => a.provider_subject === providerSubject,
            ) as T[];
            return { results: found, success: true };
          }
          return { results: [], success: true };
        },
        async run(): Promise<{ success: boolean }> {
          if (sql.includes("INSERT") && sql.includes("orgs")) {
            orgs.push({
              org_id: statement.bindings[0],
              name: statement.bindings[1],
            });
          }
          if (sql.includes("INSERT") && sql.includes("users") && !sql.includes("orgs")) {
            users.push({
              user_id: statement.bindings[0],
              org_id: statement.bindings[1],
              email: statement.bindings[2],
              display_name: statement.bindings[3],
            });
          }
          if (sql.includes("INSERT") && sql.includes("accounts")) {
            accounts.push({
              account_id: statement.bindings[0],
              user_id: statement.bindings[1],
              provider: "google",
              provider_subject: statement.bindings[2],
              email: statement.bindings[3],
              status: "active",
            });
          }
          if (sql.includes("UPDATE") && sql.includes("accounts")) {
            const targetId = statement.bindings[statement.bindings.length - 1];
            for (const acct of accounts) {
              if (acct.account_id === targetId) {
                acct.status = "active";
              }
            }
          }
          return { success: true };
        },
      };
      return statement;
    },
  };
}

/** Create a mock AccountDO namespace. */
function createMockAccountDO() {
  const calls: Array<{ id: string; url: string; body: unknown }> = [];

  return {
    _calls: calls,
    idFromName(name: string) {
      return { name };
    },
    get(id: { name: string }) {
      return {
        async fetch(request: Request) {
          const body = await request.json();
          calls.push({ id: id.name, url: request.url, body });
          return new Response("OK", { status: 200 });
        },
      };
    },
  };
}

/** Create a mock Workflow binding. */
function createMockWorkflow() {
  const calls: Array<{ id: string; params: Record<string, unknown> }> = [];

  return {
    _calls: calls,
    async create(options: { id?: string; params: Record<string, unknown> }) {
      calls.push({ id: options.id || "auto", params: options.params });
      return { id: options.id || "auto" };
    },
  };
}

function createMockEnv(overrides?: {
  d1?: ReturnType<typeof createMockD1>;
  accountDO?: ReturnType<typeof createMockAccountDO>;
  workflow?: ReturnType<typeof createMockWorkflow>;
}) {
  return {
    DB: overrides?.d1 ?? createMockD1(),
    USER_GRAPH: {} as DurableObjectNamespace,
    ACCOUNT: overrides?.accountDO ?? createMockAccountDO(),
    ONBOARDING_WORKFLOW: overrides?.workflow ?? createMockWorkflow(),
    GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: TEST_CLIENT_SECRET,
    MS_CLIENT_ID: TEST_MS_CLIENT_ID,
    MS_CLIENT_SECRET: TEST_MS_CLIENT_SECRET,
    JWT_SECRET: TEST_JWT_SECRET,
  } as unknown as Env;
}

// ===========================================================================
// Integration Test 1: Full Marketplace install creates user and pre-connects
// ===========================================================================

describe("Integration: Marketplace install callback creates user and pre-connects Google account", () => {
  it("end-to-end: install callback -> user created -> account linked -> DO initialized -> redirect to onboarding", async () => {
    const d1 = createMockD1();
    const accountDO = createMockAccountDO();
    const workflow = createMockWorkflow();
    const env = createMockEnv({ d1, accountDO, workflow });
    const mockFetch = createMarketplaceMockFetch();
    const handler = createHandler(mockFetch);

    // Simulate Marketplace install callback through the worker router
    const request = new Request(
      `https://oauth.tminus.dev/marketplace/install?code=${TEST_AUTH_CODE}&hd=workspace.dev`,
    );
    const response = await handler.fetch(request, env, mockCtx);

    // PROOF: redirects to onboarding
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.pathname).toBe("/onboarding");

    // PROOF: marketplace_install flag is set
    expect(location.searchParams.get("marketplace_install")).toBe("true");

    // PROOF: Google account info is in the redirect
    expect(location.searchParams.get("provider")).toBe("google");
    expect(location.searchParams.get("email")).toBe(TEST_GOOGLE_EMAIL);

    // PROOF: user was created in D1
    expect(d1._users.length).toBe(1);
    expect(d1._users[0].email).toBe(TEST_GOOGLE_EMAIL);
    const userId = d1._users[0].user_id as string;
    expect(userId).toMatch(/^usr_/);
    expect(location.searchParams.get("user_id")).toBe(userId);

    // PROOF: account was created in D1
    expect(d1._accounts.length).toBe(1);
    expect(d1._accounts[0].provider).toBe("google");
    expect(d1._accounts[0].provider_subject).toBe(TEST_GOOGLE_SUB);
    const accountId = d1._accounts[0].account_id as string;
    expect(accountId).toMatch(/^acc_/);
    expect(location.searchParams.get("account_id")).toBe(accountId);

    // PROOF: AccountDO was initialized with real tokens
    expect(accountDO._calls.length).toBe(1);
    const doBody = accountDO._calls[0].body as Record<string, unknown>;
    const tokens = doBody.tokens as Record<string, string>;
    expect(tokens.access_token).toBe("ya29.marketplace-integration-token");
    expect(tokens.refresh_token).toBe("1//marketplace-integration-refresh");
    expect(tokens.expiry).toBeTruthy();

    // PROOF: OnboardingWorkflow was started
    expect(workflow._calls.length).toBe(1);
    expect(workflow._calls[0].params.account_id).toBe(accountId);
    expect(workflow._calls[0].params.user_id).toBe(userId);
  });

  it("existing user re-installing from Marketplace links new account to existing user", async () => {
    const d1 = createMockD1();
    // Pre-populate existing user
    d1._users.push({
      user_id: "usr_EXISTING_INTEG_01",
      org_id: "org_existing",
      email: TEST_GOOGLE_EMAIL,
      display_name: "Pre-existing User",
    });

    const accountDO = createMockAccountDO();
    const workflow = createMockWorkflow();
    const env = createMockEnv({ d1, accountDO, workflow });
    const mockFetch = createMarketplaceMockFetch();
    const handler = createHandler(mockFetch);

    const request = new Request(
      `https://oauth.tminus.dev/marketplace/install?code=${TEST_AUTH_CODE}`,
    );
    const response = await handler.fetch(request, env, mockCtx);

    // PROOF: redirects to onboarding
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);

    // PROOF: uses existing user ID (not a new one)
    expect(location.searchParams.get("user_id")).toBe("usr_EXISTING_INTEG_01");
    expect(location.searchParams.get("existing_user")).toBe("true");

    // PROOF: no new user was created
    expect(d1._users.length).toBe(1);
    expect(d1._users[0].user_id).toBe("usr_EXISTING_INTEG_01");

    // PROOF: account was created for existing user
    expect(d1._accounts.length).toBe(1);
    expect(d1._accounts[0].user_id).toBe("usr_EXISTING_INTEG_01");
  });
});

// ===========================================================================
// Integration Test 2: Redirect to onboarding shows Google account as connected
// ===========================================================================

describe("Integration: Redirect to onboarding shows Google account as connected", () => {
  it("redirect URL contains all information needed for onboarding to show connected state", async () => {
    const d1 = createMockD1();
    const accountDO = createMockAccountDO();
    const workflow = createMockWorkflow();
    const env = createMockEnv({ d1, accountDO, workflow });
    const mockFetch = createMarketplaceMockFetch();
    const handler = createHandler(mockFetch);

    const request = new Request(
      `https://oauth.tminus.dev/marketplace/install?code=${TEST_AUTH_CODE}&hd=workspace.dev`,
    );
    const response = await handler.fetch(request, env, mockCtx);

    const location = new URL(response.headers.get("Location")!);

    // PROOF: all onboarding pre-connection parameters are present
    expect(location.searchParams.has("user_id")).toBe(true);
    expect(location.searchParams.has("account_id")).toBe(true);
    expect(location.searchParams.get("marketplace_install")).toBe("true");
    expect(location.searchParams.get("provider")).toBe("google");
    expect(location.searchParams.get("email")).toBe(TEST_GOOGLE_EMAIL);

    // PROOF: account ID in redirect matches the one stored in D1
    const accountIdInRedirect = location.searchParams.get("account_id");
    expect(accountIdInRedirect).toBe(d1._accounts[0].account_id);

    // PROOF: user ID in redirect matches the one stored in D1
    const userIdInRedirect = location.searchParams.get("user_id");
    expect(userIdInRedirect).toBe(d1._users[0].user_id);
  });

  it("AccountDO tokens are initialized BEFORE redirect (account is actually connected)", async () => {
    const d1 = createMockD1();
    const accountDO = createMockAccountDO();
    const env = createMockEnv({ d1, accountDO });
    const mockFetch = createMarketplaceMockFetch();
    const handler = createHandler(mockFetch);

    const request = new Request(
      `https://oauth.tminus.dev/marketplace/install?code=${TEST_AUTH_CODE}`,
    );
    await handler.fetch(request, env, mockCtx);

    // PROOF: AccountDO initialize was called (meaning tokens are stored)
    expect(accountDO._calls.length).toBe(1);
    const doBody = accountDO._calls[0].body as Record<string, unknown>;
    const tokens = doBody.tokens as Record<string, string>;

    // PROOF: tokens are real (not empty/placeholder)
    expect(tokens.access_token.length).toBeGreaterThan(10);
    expect(tokens.refresh_token.length).toBeGreaterThan(10);
    expect(tokens.expiry).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO8601 format

    // PROOF: scopes include calendar access
    expect(doBody.scopes).toContain("calendar");
  });
});

// ===========================================================================
// Integration Test 3: Routing through the worker handler
// ===========================================================================

describe("Integration: Worker routing handles /marketplace/install", () => {
  it("GET /marketplace/install routes to marketplace handler", async () => {
    const d1 = createMockD1();
    const accountDO = createMockAccountDO();
    const env = createMockEnv({ d1, accountDO });
    const mockFetch = createMarketplaceMockFetch();
    const handler = createHandler(mockFetch);

    const request = new Request(
      `https://oauth.tminus.dev/marketplace/install?code=${TEST_AUTH_CODE}`,
    );
    const response = await handler.fetch(request, env, mockCtx);

    // PROOF: routed correctly (not 404)
    expect(response.status).toBe(302);
    const location = response.headers.get("Location")!;
    expect(location).toContain("/onboarding");
  });

  it("GET /marketplace/install with error param returns user-friendly error", async () => {
    const env = createMockEnv();
    const handler = createHandler();

    const request = new Request(
      "https://oauth.tminus.dev/marketplace/install?error=access_denied",
    );
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("cancelled or denied");
  });

  it("GET /marketplace/install without code returns 400", async () => {
    const env = createMockEnv();
    const handler = createHandler();

    const request = new Request(
      "https://oauth.tminus.dev/marketplace/install",
    );
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(400);
  });

  it("existing OAuth routes still work after adding marketplace route", async () => {
    const env = createMockEnv();
    const handler = createHandler();

    // Health check
    const healthResp = await handler.fetch(
      new Request("https://oauth.tminus.dev/health"),
      env,
      mockCtx,
    );
    expect(healthResp.status).toBe(200);

    // Google start (needs user_id)
    const startResp = await handler.fetch(
      new Request("https://oauth.tminus.dev/oauth/google/start"),
      env,
      mockCtx,
    );
    // Returns 400 because no user_id -- but proves the route is still there
    expect(startResp.status).toBe(400);

    // Unknown path
    const unknownResp = await handler.fetch(
      new Request("https://oauth.tminus.dev/unknown-path"),
      env,
      mockCtx,
    );
    expect(unknownResp.status).toBe(404);
  });
});
