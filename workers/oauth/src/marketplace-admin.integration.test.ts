/**
 * Integration tests for Google Workspace Marketplace admin install flows.
 *
 * These tests verify the FULL end-to-end flow through the oauth worker:
 * 1. Admin install callback -> org_installations record created
 * 2. Org user activation -> user created, OAuth skipped, pre-connected
 * 3. Admin deactivation disconnects all org users (tested via API worker)
 * 4. Routing through the worker handler for new routes
 *
 * External Google APIs are mocked via injectable fetch, but the internal
 * flow (D1 queries, DO initialization, routing) is real.
 *
 * Pattern follows: marketplace.integration.test.ts
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
const TEST_AUTH_CODE = "4/0AbCdEf-admin-integ";
const TEST_ADMIN_SUB = "google-sub-admin-integ-12345";
const TEST_ADMIN_EMAIL = "admin@workspace-integ.dev";
const TEST_CUSTOMER_ID = "C01INTEG001";
const TEST_USER_SUB = "google-sub-user-integ-67890";
const TEST_USER_EMAIL = "user@workspace-integ.dev";

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Create a mock fetch for admin install flow. */
function createAdminMockFetch(overrides?: {
  sub?: string;
  email?: string;
  name?: string;
  hd?: string;
  tokenStatus?: number;
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
          access_token: "ya29.admin-integ-token",
          refresh_token: "1//admin-integ-refresh",
          expires_in: 3600,
          token_type: "Bearer",
          scope: GOOGLE_SCOPES,
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
          sub: overrides?.sub ?? TEST_ADMIN_SUB,
          email: overrides?.email ?? TEST_ADMIN_EMAIL,
          name: overrides?.name ?? "Admin User",
          hd: overrides?.hd ?? "workspace-integ.dev",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`Unexpected fetch URL in integration test: ${url}`);
  };
}

/** Create a mock D1 with full tracking for integration tests. */
function createMockD1() {
  const users: Array<Record<string, unknown>> = [];
  const accounts: Array<Record<string, unknown>> = [];
  const orgs: Array<Record<string, unknown>> = [];
  const installations: Array<Record<string, unknown>> = [];

  return {
    _users: users,
    _accounts: accounts,
    _orgs: orgs,
    _installations: installations,

    prepare(sql: string) {
      const statement = {
        sql,
        bindings: [] as unknown[],
        bind(...args: unknown[]) {
          statement.bindings = args;
          return statement;
        },
        async first<T>(): Promise<T | null> {
          // Org membership detection: admin_email LIKE pattern
          if (sql.includes("org_installations") && sql.includes("admin_email LIKE")) {
            const found = installations.find((i) => i.status === "active");
            return (found as T) ?? null;
          }
          // Check existing org installation by google_customer_id
          if (sql.includes("org_installations") && sql.includes("google_customer_id") && sql.includes("WHERE")) {
            const customerId = statement.bindings[0] as string;
            const found = installations.find((i) => i.google_customer_id === customerId);
            return (found as T) ?? null;
          }
          if (sql.includes("organizations") && sql.includes("name")) {
            return null;
          }
          if (sql.includes("org_installations") && sql.includes("status = 'active'")) {
            const found = installations.find((i) => i.status === "active");
            return (found as T) ?? null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[]; success: boolean }> {
          if (sql.includes("SELECT") && sql.includes("users") && sql.includes("email")) {
            const email = statement.bindings[0] as string;
            const found = users.filter((u) => u.email === email) as T[];
            return { results: found, success: true };
          }
          if (sql.includes("SELECT") && sql.includes("accounts") && sql.includes("provider_subject")) {
            const providerSubject = statement.bindings[1] as string;
            const found = accounts.filter((a) => a.provider_subject === providerSubject) as T[];
            return { results: found, success: true };
          }
          // processOrgUninstall: JOIN accounts+users by org_id
          if (sql.includes("accounts") && sql.includes("JOIN") && sql.includes("org_id")) {
            const orgId = statement.bindings[0] as string;
            const orgUserIds = users
              .filter((u) => u.org_id === orgId)
              .map((u) => u.user_id);
            const found = accounts.filter(
              (a) =>
                orgUserIds.includes(a.user_id as string) &&
                a.provider === "google" &&
                a.status === "active",
            );
            return { results: found as T[], success: true };
          }
          return { results: [], success: true };
        },
        async run(): Promise<{ success: boolean }> {
          if (sql.includes("INSERT") && sql.includes("org_installations")) {
            installations.push({
              install_id: statement.bindings[0],
              google_customer_id: statement.bindings[1],
              org_id: statement.bindings[2],
              admin_email: statement.bindings[3],
              admin_google_sub: statement.bindings[4],
              scopes_granted: statement.bindings[5],
              status: "active",
            });
          }
          if (sql.includes("UPDATE") && sql.includes("org_installations") && sql.includes("org_id =")) {
            // Backfill org_id on installation (from handleOrgUserActivation)
            const orgId = statement.bindings[0] as string;
            const installId = statement.bindings[1] as string;
            for (const inst of installations) {
              if (inst.install_id === installId) {
                inst.org_id = orgId;
              }
            }
          } else if (sql.includes("UPDATE") && sql.includes("org_installations") && sql.includes("inactive")) {
            // processOrgUninstall: deactivate installation
            const installId = statement.bindings[0] as string;
            for (const inst of installations) {
              if (inst.install_id === installId) {
                inst.status = "inactive";
              }
            }
          } else if (sql.includes("UPDATE") && sql.includes("org_installations")) {
            // handleAdminInstall: reactivate existing installation
            for (const inst of installations) {
              if (inst.install_id === statement.bindings[statement.bindings.length - 1]) {
                inst.status = "active";
                inst.admin_email = statement.bindings[0];
              }
            }
          }
          if (sql.includes("INSERT") && sql.includes("orgs") && !sql.includes("org_installations")) {
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
          if (sql.includes("UPDATE") && sql.includes("accounts") && sql.includes("revoked")) {
            // cleanupAccount: mark account as revoked
            const accountId = statement.bindings[0] as string;
            for (const acct of accounts) {
              if (acct.account_id === accountId) {
                acct.status = "revoked";
              }
            }
          } else if (sql.includes("UPDATE") && sql.includes("accounts")) {
            // handleOrgUserActivation: reactivate account
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
// Integration Test 1: Admin install callback creates org record
// ===========================================================================

describe("Integration: Admin install callback creates org installation record", () => {
  it("end-to-end: admin install -> org_installations created -> redirect to admin confirmation", async () => {
    const d1 = createMockD1();
    const env = createMockEnv({ d1 });
    const mockFetch = createAdminMockFetch();
    const handler = createHandler(mockFetch);

    const request = new Request(
      `https://oauth.tminus.dev/marketplace/admin-install?code=${TEST_AUTH_CODE}&customer_id=${TEST_CUSTOMER_ID}&hd=workspace-integ.dev`,
    );
    const response = await handler.fetch(request, env, mockCtx);

    // PROOF: redirects (admin confirmation)
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.pathname).toBe("/onboarding");

    // PROOF: admin_install flag set
    expect(location.searchParams.get("admin_install")).toBe("true");
    expect(location.searchParams.get("customer_id")).toBe(TEST_CUSTOMER_ID);
    expect(location.searchParams.get("admin_email")).toBe(TEST_ADMIN_EMAIL);

    // PROOF: org installation record created in D1
    expect(d1._installations.length).toBe(1);
    expect(d1._installations[0].google_customer_id).toBe(TEST_CUSTOMER_ID);
    expect(d1._installations[0].admin_email).toBe(TEST_ADMIN_EMAIL);
    expect(d1._installations[0].status).toBe("active");

    // PROOF: NO user records created (admin install is org-level only)
    expect(d1._users.length).toBe(0);

    // PROOF: NO account records created (BR-1: no auto-sync)
    expect(d1._accounts.length).toBe(0);
  });
});

// ===========================================================================
// Integration Test 2: Org user activation skips OAuth and pre-connects
// ===========================================================================

describe("Integration: Org user first visit skips OAuth and pre-connects", () => {
  it("end-to-end: org user activation -> user created -> account pre-connected -> redirect to onboarding", async () => {
    const d1 = createMockD1();
    const accountDO = createMockAccountDO();
    const workflow = createMockWorkflow();

    // Pre-populate active org installation
    d1._installations.push({
      install_id: "oin_INTEG_01",
      google_customer_id: TEST_CUSTOMER_ID,
      org_id: null,
      admin_email: TEST_ADMIN_EMAIL,
      admin_google_sub: TEST_ADMIN_SUB,
      scopes_granted: GOOGLE_SCOPES,
      status: "active",
    });

    const env = createMockEnv({ d1, accountDO, workflow });
    const mockFetch = createAdminMockFetch({
      sub: TEST_USER_SUB,
      email: TEST_USER_EMAIL,
      name: "Org User",
      hd: "workspace-integ.dev",
    });
    const handler = createHandler(mockFetch);

    const request = new Request(
      `https://oauth.tminus.dev/marketplace/org-activate?code=${TEST_AUTH_CODE}`,
    );
    const response = await handler.fetch(request, env, mockCtx);

    // PROOF: redirects to onboarding
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.pathname).toBe("/onboarding");

    // PROOF: org_install flag set (skipped individual OAuth)
    expect(location.searchParams.get("org_install")).toBe("true");
    expect(location.searchParams.get("marketplace_install")).toBe("true");
    expect(location.searchParams.get("provider")).toBe("google");
    expect(location.searchParams.get("email")).toBe(TEST_USER_EMAIL);

    // PROOF: user was created
    expect(d1._users.length).toBe(1);
    expect(d1._users[0].email).toBe(TEST_USER_EMAIL);
    const userId = d1._users[0].user_id as string;
    expect(userId).toMatch(/^usr_/);

    // PROOF: account was pre-connected
    expect(d1._accounts.length).toBe(1);
    expect(d1._accounts[0].provider_subject).toBe(TEST_USER_SUB);
    const accountId = d1._accounts[0].account_id as string;
    expect(accountId).toMatch(/^acc_/);

    // PROOF: AccountDO initialized with tokens
    expect(accountDO._calls.length).toBe(1);
    const doBody = accountDO._calls[0].body as Record<string, unknown>;
    const tokens = doBody.tokens as Record<string, string>;
    expect(tokens.access_token).toBe("ya29.admin-integ-token");
    expect(tokens.refresh_token).toBe("1//admin-integ-refresh");

    // PROOF: OnboardingWorkflow started
    expect(workflow._calls.length).toBe(1);
    expect(workflow._calls[0].params.account_id).toBe(accountId);
    expect(workflow._calls[0].params.user_id).toBe(userId);
  });

  it("org user lands in onboarding with Google account pre-connected (AC#3)", async () => {
    const d1 = createMockD1();
    const accountDO = createMockAccountDO();

    // Pre-populate active org installation
    d1._installations.push({
      install_id: "oin_INTEG_02",
      google_customer_id: TEST_CUSTOMER_ID,
      org_id: null,
      admin_email: TEST_ADMIN_EMAIL,
      admin_google_sub: TEST_ADMIN_SUB,
      scopes_granted: GOOGLE_SCOPES,
      status: "active",
    });

    const env = createMockEnv({ d1, accountDO });
    const mockFetch = createAdminMockFetch({
      sub: TEST_USER_SUB,
      email: TEST_USER_EMAIL,
      hd: "workspace-integ.dev",
    });
    const handler = createHandler(mockFetch);

    const request = new Request(
      `https://oauth.tminus.dev/marketplace/org-activate?code=${TEST_AUTH_CODE}`,
    );
    const response = await handler.fetch(request, env, mockCtx);

    const location = new URL(response.headers.get("Location")!);

    // PROOF: all pre-connection parameters present
    expect(location.searchParams.has("user_id")).toBe(true);
    expect(location.searchParams.has("account_id")).toBe(true);
    expect(location.searchParams.get("provider")).toBe("google");
    expect(location.searchParams.get("email")).toBe(TEST_USER_EMAIL);

    // PROOF: account ID in redirect matches D1
    expect(location.searchParams.get("account_id")).toBe(d1._accounts[0].account_id);
    expect(location.searchParams.get("user_id")).toBe(d1._users[0].user_id);

    // PROOF: AccountDO initialized BEFORE redirect
    expect(accountDO._calls.length).toBe(1);
    const doBody = accountDO._calls[0].body as Record<string, unknown>;
    expect(doBody.scopes).toContain("calendar");
  });
});

// ===========================================================================
// Integration Test 3: Routing through the worker handler
// ===========================================================================

describe("Integration: Worker routing handles admin install routes", () => {
  it("GET /marketplace/admin-install routes to admin install handler", async () => {
    const d1 = createMockD1();
    const env = createMockEnv({ d1 });
    const mockFetch = createAdminMockFetch();
    const handler = createHandler(mockFetch);

    const request = new Request(
      `https://oauth.tminus.dev/marketplace/admin-install?code=${TEST_AUTH_CODE}&customer_id=${TEST_CUSTOMER_ID}`,
    );
    const response = await handler.fetch(request, env, mockCtx);

    // PROOF: routed correctly (not 404)
    expect(response.status).toBe(302);
    const location = response.headers.get("Location")!;
    expect(location).toContain("/onboarding");
    expect(location).toContain("admin_install=true");
  });

  it("GET /marketplace/org-activate with error returns user-friendly error", async () => {
    const env = createMockEnv();
    const handler = createHandler();

    const request = new Request(
      "https://oauth.tminus.dev/marketplace/org-activate?error=access_denied",
    );
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("cancelled or denied");
  });

  it("GET /marketplace/org-activate without code returns 400", async () => {
    const env = createMockEnv();
    const handler = createHandler();

    const request = new Request(
      "https://oauth.tminus.dev/marketplace/org-activate",
    );
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(400);
  });

  it("existing Marketplace individual install route still works", async () => {
    const env = createMockEnv();
    const handler = createHandler();

    // Marketplace individual install without code returns 400
    const response = await handler.fetch(
      new Request("https://oauth.tminus.dev/marketplace/install"),
      env,
      mockCtx,
    );
    expect(response.status).toBe(400);
  });

  it("health check still works", async () => {
    const env = createMockEnv();
    const handler = createHandler();

    const response = await handler.fetch(
      new Request("https://oauth.tminus.dev/health"),
      env,
      mockCtx,
    );
    expect(response.status).toBe(200);
  });
});

// ===========================================================================
// Integration Test 4: org_id backfill after first user activation (TM-hmq bug fix)
// ===========================================================================

describe("Integration: org_id backfill after first user activation (TM-hmq)", () => {
  it("first user activation with null org_id backfills installation record", async () => {
    const d1 = createMockD1();
    const accountDO = createMockAccountDO();
    const workflow = createMockWorkflow();

    // Pre-populate active org installation with null org_id
    d1._installations.push({
      install_id: "oin_BACKFILL_INTEG_01",
      google_customer_id: TEST_CUSTOMER_ID,
      org_id: null,
      admin_email: TEST_ADMIN_EMAIL,
      admin_google_sub: TEST_ADMIN_SUB,
      scopes_granted: GOOGLE_SCOPES,
      status: "active",
    });

    const env = createMockEnv({ d1, accountDO, workflow });
    const mockFetch = createAdminMockFetch({
      sub: TEST_USER_SUB,
      email: TEST_USER_EMAIL,
      name: "First Org User",
      hd: "workspace-integ.dev",
    });
    const handler = createHandler(mockFetch);

    const request = new Request(
      `https://oauth.tminus.dev/marketplace/org-activate?code=${TEST_AUTH_CODE}`,
    );
    const response = await handler.fetch(request, env, mockCtx);

    // PROOF: activation succeeded
    expect(response.status).toBe(302);

    // PROOF: a new org was created
    expect(d1._orgs.length).toBe(1);
    const createdOrgId = d1._orgs[0].org_id as string;
    expect(createdOrgId).toMatch(/^org_/);

    // PROOF: installation.org_id was backfilled with the new org_id
    expect(d1._installations[0].org_id).toBe(createdOrgId);

    // PROOF: user was assigned to the same org
    expect(d1._users[0].org_id).toBe(createdOrgId);
  });

  it("second user activation joins the SAME org (not creates a new one)", async () => {
    const d1 = createMockD1();
    const accountDO = createMockAccountDO();
    const workflow = createMockWorkflow();

    // Pre-populate active org installation with null org_id
    d1._installations.push({
      install_id: "oin_MULTI_USER_01",
      google_customer_id: TEST_CUSTOMER_ID,
      org_id: null,
      admin_email: TEST_ADMIN_EMAIL,
      admin_google_sub: TEST_ADMIN_SUB,
      scopes_granted: GOOGLE_SCOPES,
      status: "active",
    });

    const env = createMockEnv({ d1, accountDO, workflow });

    // --- First user activates ---
    const firstUserFetch = createAdminMockFetch({
      sub: "google-sub-user1-111",
      email: "user1@workspace-integ.dev",
      name: "User One",
      hd: "workspace-integ.dev",
    });
    const handler1 = createHandler(firstUserFetch);
    const req1 = new Request(
      `https://oauth.tminus.dev/marketplace/org-activate?code=code-user1`,
    );
    const resp1 = await handler1.fetch(req1, env, mockCtx);
    expect(resp1.status).toBe(302);

    // Capture the org_id created by first user
    expect(d1._orgs.length).toBe(1);
    const firstOrgId = d1._orgs[0].org_id as string;
    expect(d1._installations[0].org_id).toBe(firstOrgId);

    // --- Second user activates ---
    const secondUserFetch = createAdminMockFetch({
      sub: "google-sub-user2-222",
      email: "user2@workspace-integ.dev",
      name: "User Two",
      hd: "workspace-integ.dev",
    });
    const handler2 = createHandler(secondUserFetch);
    const req2 = new Request(
      `https://oauth.tminus.dev/marketplace/org-activate?code=code-user2`,
    );
    const resp2 = await handler2.fetch(req2, env, mockCtx);
    expect(resp2.status).toBe(302);

    // PROOF: NO new org was created -- second user joins the first user's org
    expect(d1._orgs.length).toBe(1);

    // PROOF: both users share the SAME org_id
    expect(d1._users.length).toBe(2);
    expect(d1._users[0].org_id).toBe(firstOrgId);
    expect(d1._users[1].org_id).toBe(firstOrgId);

    // PROOF: installation still has the same backfilled org_id
    expect(d1._installations[0].org_id).toBe(firstOrgId);
  });
});

// ===========================================================================
// Integration Test 5: processOrgUninstall finds users after org_id backfill (TM-hmq)
// ===========================================================================

describe("Integration: processOrgUninstall finds users after org_id backfill (TM-hmq)", () => {
  it("org uninstall correctly finds all users after activation backfilled org_id", async () => {
    const d1 = createMockD1();
    const accountDO = createMockAccountDO();
    const workflow = createMockWorkflow();

    // Start with null org_id installation
    d1._installations.push({
      install_id: "oin_UNINSTALL_TEST_01",
      google_customer_id: TEST_CUSTOMER_ID,
      org_id: null,
      admin_email: TEST_ADMIN_EMAIL,
      admin_google_sub: TEST_ADMIN_SUB,
      scopes_granted: GOOGLE_SCOPES,
      status: "active",
    });

    const env = createMockEnv({ d1, accountDO, workflow });

    // Activate two users (which should backfill org_id)
    const user1Fetch = createAdminMockFetch({
      sub: "google-sub-uninstall-u1",
      email: "u1@workspace-integ.dev",
      name: "Uninstall User1",
      hd: "workspace-integ.dev",
    });
    const handler1 = createHandler(user1Fetch);
    await handler1.fetch(
      new Request(`https://oauth.tminus.dev/marketplace/org-activate?code=code-u1`),
      env,
      mockCtx,
    );

    const user2Fetch = createAdminMockFetch({
      sub: "google-sub-uninstall-u2",
      email: "u2@workspace-integ.dev",
      name: "Uninstall User2",
      hd: "workspace-integ.dev",
    });
    const handler2 = createHandler(user2Fetch);
    await handler2.fetch(
      new Request(`https://oauth.tminus.dev/marketplace/org-activate?code=code-u2`),
      env,
      mockCtx,
    );

    // Verify both users were created in same org
    expect(d1._users.length).toBe(2);
    const orgId = d1._installations[0].org_id as string;
    expect(orgId).toBeTruthy();
    expect(d1._users[0].org_id).toBe(orgId);
    expect(d1._users[1].org_id).toBe(orgId);
    expect(d1._accounts.length).toBe(2);

    // Now simulate processOrgUninstall by importing and calling it directly
    const { processOrgUninstall } = await import("./marketplace-uninstall");

    // We need an env that supports the uninstall mock patterns.
    // The D1 already has the correct data; we just need the AccountDO
    // to handle get-token/delete-credentials/stop-sync requests.
    const uninstallAccountDO = {
      idFromName(name: string) { return { name }; },
      get(id: { name: string }) {
        return {
          async fetch(request: Request) {
            if (request.url.includes("get-token")) {
              return new Response(JSON.stringify({
                access_token: "ya29.tok",
                refresh_token: "1//ref",
              }), { status: 200 });
            }
            if (request.url.includes("delete-credentials")) {
              return new Response("OK", { status: 200 });
            }
            if (request.url.includes("stop-sync")) {
              return new Response("OK", { status: 200 });
            }
            return new Response("OK", { status: 200 });
          },
        };
      },
    };

    // Create a fetch mock that handles revocation
    const uninstallFetch: FetchFn = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("oauth2.googleapis.com/revoke")) {
        return new Response("", { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    // Override env for uninstall
    const uninstallEnv = {
      ...env,
      ACCOUNT: uninstallAccountDO,
    } as unknown as Env;

    // PROOF: processOrgUninstall finds both users via the backfilled org_id
    const results = await processOrgUninstall(TEST_CUSTOMER_ID, uninstallEnv, uninstallFetch);

    // PROOF: BOTH accounts were processed (not zero, which was the pre-fix behavior)
    expect(results.length).toBe(2);
    const processedAccountIds = results.map((r) => r.account_id);
    expect(processedAccountIds).toContain(d1._accounts[0].account_id);
    expect(processedAccountIds).toContain(d1._accounts[1].account_id);

    // PROOF: credentials were deleted for both accounts
    for (const result of results) {
      expect(result.credentials_deleted).toBe(true);
    }
  });
});
