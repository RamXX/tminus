/**
 * Phase 6B E2E Validation Test Suite
 *
 * Proves the complete Google Workspace Marketplace integration lifecycle
 * works end-to-end. This is the capstone test for the Phase 6B epic,
 * validating the FULL lifecycle:
 *
 *   1. Individual install from Marketplace -> onboarding with Google pre-connected
 *   2. Organization install from admin console -> org users activate without OAuth
 *   3. Individual uninstall -> credentials removed, sync stopped
 *   4. Organization uninstall -> all org users disconnected
 *   5. Re-install after uninstall -> clean state, no ghosts
 *   6. Edge cases: individual + org overlap, dual connections
 *
 * Test strategy:
 *   Uses real OAuth worker handler chain (createHandler) with injectable fetch.
 *   External Google APIs are mocked via fetchFn, but internal flow (D1 queries,
 *   DO initialization, routing, workflow creation) exercises real code paths.
 *
 * Pattern follows: workers/oauth/src/marketplace.integration.test.ts
 *
 * Run with:
 *   make test-e2e-phase6b
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHandler, type FetchFn } from "../../workers/oauth/src/index";
import { GOOGLE_SCOPES } from "../../workers/oauth/src/google";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
const TEST_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const TEST_CLIENT_SECRET = "test-client-secret";
const TEST_MS_CLIENT_ID = "test-ms-client-id-00000000-0000-0000-0000-000000000000";
const TEST_MS_CLIENT_SECRET = "test-ms-client-secret";

// Individual install identities
const INDIVIDUAL_AUTH_CODE = "4/0AbCdEf-e2e-individual";
const INDIVIDUAL_SUB = "google-sub-e2e-individual-001";
const INDIVIDUAL_EMAIL = "jane@personal.dev";

// Org admin identity
const ADMIN_AUTH_CODE = "4/0AbCdEf-e2e-admin";
const ADMIN_SUB = "google-sub-e2e-admin-001";
const ADMIN_EMAIL = "admin@acme-corp.dev";
const CUSTOMER_ID = "C01E2E001";

// Org user identities
const ORG_USER1_AUTH_CODE = "4/0AbCdEf-e2e-org-user1";
const ORG_USER1_SUB = "google-sub-e2e-org-user1-001";
const ORG_USER1_EMAIL = "alice@acme-corp.dev";
const ORG_USER2_AUTH_CODE = "4/0AbCdEf-e2e-org-user2";
const ORG_USER2_SUB = "google-sub-e2e-org-user2-001";
const ORG_USER2_EMAIL = "bob@acme-corp.dev";

// Overlap user: installs individually, then joins org
const OVERLAP_SUB = "google-sub-e2e-overlap-001";
const OVERLAP_EMAIL = "charlie@acme-corp.dev";
const OVERLAP_AUTH_CODE = "4/0AbCdEf-e2e-overlap";

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

// ---------------------------------------------------------------------------
// RSA key utilities for JWT-signed uninstall webhooks
// ---------------------------------------------------------------------------

let testKeyPair: CryptoKeyPair;
let testKid: string;

async function generateTestKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
}

function bytesToB64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function strToB64Url(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createTestJWT(
  claims: Record<string, unknown>,
  keyPair: CryptoKeyPair,
  kid: string,
): Promise<string> {
  const header = { alg: "RS256", kid, typ: "JWT" };
  const headerB64 = strToB64Url(JSON.stringify(header));
  const payloadB64 = strToB64Url(JSON.stringify(claims));

  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    signingInput,
  );
  const signatureB64 = bytesToB64Url(new Uint8Array(signature));
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

async function exportTestPublicKeyJWK(publicKey: CryptoKey, kid: string) {
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  return { ...jwk, kid, use: "sig", alg: "RS256" };
}

// ---------------------------------------------------------------------------
// Mock D1 -- tracks users, accounts, orgs, installations, audit log
// ---------------------------------------------------------------------------

function createMockD1() {
  const users: Array<Record<string, unknown>> = [];
  const accounts: Array<Record<string, unknown>> = [];
  const orgs: Array<Record<string, unknown>> = [];
  const installations: Array<Record<string, unknown>> = [];
  const auditLog: Array<Record<string, unknown>> = [];

  return {
    _users: users,
    _accounts: accounts,
    _orgs: orgs,
    _installations: installations,
    _auditLog: auditLog,

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
            const domain = (statement.bindings[0] as string).replace("%@", "");
            const found = installations.find(
              (i) => i.status === "active" && (i.admin_email as string).endsWith(`@${domain}`),
            );
            return (found as T) ?? null;
          }
          // Check existing org installation by google_customer_id
          if (sql.includes("org_installations") && sql.includes("google_customer_id")) {
            const customerId = statement.bindings[0] as string;
            // When searching for active installations, filter by status
            if (sql.includes("status = 'active'")) {
              const found = installations.find(
                (i) => i.google_customer_id === customerId && i.status === "active",
              );
              return (found as T) ?? null;
            }
            const found = installations.find(
              (i) => i.google_customer_id === customerId,
            );
            return (found as T) ?? null;
          }
          // Org lookup by name
          if (sql.includes("organizations") && sql.includes("name")) {
            return null;
          }
          return null;
        },

        async all<T>(): Promise<{ results: T[]; success: boolean }> {
          if (sql.includes("SELECT") && sql.includes("users") && sql.includes("email")) {
            const email = statement.bindings[0] as string;
            const found = users.filter((u) => u.email === email) as T[];
            return { results: found, success: true };
          }
          // Accounts query: SELECT ... FROM accounts WHERE provider = ? AND provider_subject = ?
          // (2 bindings: provider, provider_subject)
          if (sql.includes("SELECT") && sql.includes("accounts") && sql.includes("provider_subject") && !sql.includes("JOIN") && !sql.includes("provider = 'google'")) {
            const providerSubject = statement.bindings[1] as string;
            const found = accounts.filter(
              (a) => a.provider_subject === providerSubject,
            ) as T[];
            return { results: found, success: true };
          }
          // Individual uninstall: SELECT ... FROM accounts WHERE provider = 'google' AND provider_subject = ?
          // (1 binding: provider_subject -- provider is inlined in SQL)
          if (sql.includes("SELECT") && sql.includes("accounts") && sql.includes("provider = 'google'") && sql.includes("provider_subject") && !sql.includes("JOIN")) {
            const sub = statement.bindings[0] as string;
            const found = accounts.filter(
              (a) => a.provider === "google" && a.provider_subject === sub,
            ) as T[];
            return { results: found, success: true };
          }
          // Org accounts (JOIN query for org uninstall)
          if (sql.includes("accounts") && sql.includes("org_id") && sql.includes("JOIN")) {
            const orgId = statement.bindings[0] as string;
            const orgUserIds = users
              .filter((u) => u.org_id === orgId)
              .map((u) => u.user_id);
            const found = accounts.filter(
              (a) =>
                orgUserIds.includes(a.user_id as string) &&
                a.provider === "google" &&
                a.status === "active",
            ) as T[];
            return { results: found, success: true };
          }
          return { results: [], success: true };
        },

        async run(): Promise<{ success: boolean }> {
          // INSERT org_installations
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
          // UPDATE org_installations -- reactivation
          if (sql.includes("UPDATE") && sql.includes("org_installations") && sql.includes("status = 'active'")) {
            const installId = statement.bindings[statement.bindings.length - 1] as string;
            for (const inst of installations) {
              if (inst.install_id === installId) {
                inst.status = "active";
                inst.admin_email = statement.bindings[0];
                inst.deactivated_at = null;
              }
            }
          }
          // UPDATE org_installations -- deactivation
          if (sql.includes("UPDATE") && sql.includes("org_installations") && sql.includes("inactive")) {
            const installId = statement.bindings[0] as string;
            for (const inst of installations) {
              if (inst.install_id === installId) {
                inst.status = "inactive";
                inst.deactivated_at = new Date().toISOString();
              }
            }
          }
          // INSERT orgs
          if (sql.includes("INSERT") && sql.includes("orgs") && !sql.includes("org_installations")) {
            orgs.push({
              org_id: statement.bindings[0],
              name: statement.bindings[1],
            });
          }
          // INSERT users
          if (sql.includes("INSERT") && sql.includes("users") && !sql.includes("orgs")) {
            users.push({
              user_id: statement.bindings[0],
              org_id: statement.bindings[1],
              email: statement.bindings[2],
              display_name: statement.bindings[3],
            });
          }
          // INSERT accounts
          if (sql.includes("INSERT") && sql.includes("accounts") && !sql.includes("UPDATE")) {
            accounts.push({
              account_id: statement.bindings[0],
              user_id: statement.bindings[1],
              provider: "google",
              provider_subject: statement.bindings[2],
              email: statement.bindings[3],
              status: "active",
            });
          }
          // UPDATE accounts (reactivate)
          if (sql.includes("UPDATE") && sql.includes("accounts") && sql.includes("status = 'active'")) {
            const targetId = statement.bindings[statement.bindings.length - 1];
            for (const acct of accounts) {
              if (acct.account_id === targetId) {
                acct.status = "active";
              }
            }
          }
          // UPDATE accounts (revoke)
          if (sql.includes("UPDATE") && sql.includes("accounts") && sql.includes("revoked")) {
            const accountId = statement.bindings[0] as string;
            for (const acct of accounts) {
              if (acct.account_id === accountId) {
                acct.status = "revoked";
              }
            }
          }
          // INSERT audit log
          if (sql.includes("INSERT") && sql.includes("uninstall_audit_log")) {
            auditLog.push({
              audit_id: statement.bindings[0],
              event_type: statement.bindings[1],
              identity_sub: statement.bindings[2],
              identity_email: statement.bindings[3],
              identity_customer_id: statement.bindings[4],
              account_results: statement.bindings[5],
              created_at: statement.bindings[6],
            });
          }
          return { success: true };
        },
      };
      return statement;
    },
  };
}

// ---------------------------------------------------------------------------
// Mock AccountDO -- tracks init/get-token/delete/stop calls
// ---------------------------------------------------------------------------

function createMockAccountDO() {
  const calls: Array<{ id: string; url: string; method: string; body?: unknown }> = [];

  return {
    _calls: calls,
    idFromName(name: string) {
      return { name };
    },
    get(id: { name: string }) {
      return {
        async fetch(request: Request) {
          const callRecord: { id: string; url: string; method: string; body?: unknown } = {
            id: id.name,
            url: request.url,
            method: request.method,
          };

          if (request.method === "POST" && request.url.includes("initialize")) {
            callRecord.body = await request.json();
          }

          calls.push(callRecord);

          if (request.url.includes("get-token")) {
            return new Response(
              JSON.stringify({
                access_token: "ya29.e2e-access-token",
                refresh_token: "1//e2e-refresh-token",
              }),
              { status: 200 },
            );
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
}

// ---------------------------------------------------------------------------
// Mock Workflow
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Mock fetch factory -- configurable per identity
// ---------------------------------------------------------------------------

function createMockFetch(
  jwk: Record<string, unknown> | null,
  overrides?: {
    sub?: string;
    email?: string;
    name?: string;
    hd?: string;
    tokenResponse?: Partial<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    }>;
    tokenStatus?: number;
    userInfoStatus?: number;
    revokeStatus?: number;
  },
): FetchFn {
  return async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes("oauth2.googleapis.com/token")) {
      const status = overrides?.tokenStatus ?? 200;
      if (status !== 200) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status });
      }
      return new Response(
        JSON.stringify({
          access_token: "ya29.e2e-access-" + (overrides?.sub || "default"),
          refresh_token: "1//e2e-refresh-" + (overrides?.sub || "default"),
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
          sub: overrides?.sub ?? "default-sub",
          email: overrides?.email ?? "default@test.dev",
          name: overrides?.name ?? "Test User",
          hd: overrides?.hd,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Google JWKS
    if (url.includes("googleapis.com/oauth2/v3/certs")) {
      if (!jwk) {
        return new Response(JSON.stringify({ keys: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Google token revocation
    if (url.includes("oauth2.googleapis.com/revoke")) {
      return new Response("", { status: overrides?.revokeStatus ?? 200 });
    }

    throw new Error(`Unexpected fetch URL in E2E test: ${url}`);
  };
}

// ---------------------------------------------------------------------------
// Environment factory
// ---------------------------------------------------------------------------

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
// TEST SUITE 1: Individual Marketplace Install Flow (AC#1)
//
// Proves: User installs from Marketplace -> lands in onboarding with
// Google account pre-connected -> onboarding workflow starts
// ===========================================================================

describe("Phase 6B E2E: Individual Marketplace install flow (AC#1)", () => {
  let d1: ReturnType<typeof createMockD1>;
  let accountDO: ReturnType<typeof createMockAccountDO>;
  let workflow: ReturnType<typeof createMockWorkflow>;
  let env: Env;

  beforeEach(() => {
    d1 = createMockD1();
    accountDO = createMockAccountDO();
    workflow = createMockWorkflow();
    env = createMockEnv({ d1, accountDO, workflow });
  });

  it("complete individual install: Marketplace callback -> user created -> account pre-connected -> redirect to onboarding", async () => {
    const mockFetch = createMockFetch(null, {
      sub: INDIVIDUAL_SUB,
      email: INDIVIDUAL_EMAIL,
      name: "Jane Doe",
    });
    const handler = createHandler(mockFetch);

    const request = new Request(
      `https://oauth.tminus.dev/marketplace/install?code=${INDIVIDUAL_AUTH_CODE}`,
    );
    const response = await handler.fetch(request, env, mockCtx);

    // PROOF: redirects to onboarding (302)
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.pathname).toBe("/onboarding");

    // PROOF: marketplace_install flag is set
    expect(location.searchParams.get("marketplace_install")).toBe("true");

    // PROOF: Google provider pre-connected
    expect(location.searchParams.get("provider")).toBe("google");
    expect(location.searchParams.get("email")).toBe(INDIVIDUAL_EMAIL);

    // PROOF: user was created
    expect(d1._users.length).toBe(1);
    expect(d1._users[0].email).toBe(INDIVIDUAL_EMAIL);
    const userId = d1._users[0].user_id as string;
    expect(userId).toMatch(/^usr_/);
    expect(location.searchParams.get("user_id")).toBe(userId);

    // PROOF: Google account was linked
    expect(d1._accounts.length).toBe(1);
    expect(d1._accounts[0].provider).toBe("google");
    expect(d1._accounts[0].provider_subject).toBe(INDIVIDUAL_SUB);
    expect(d1._accounts[0].status).toBe("active");
    const accountId = d1._accounts[0].account_id as string;
    expect(accountId).toMatch(/^acc_/);
    expect(location.searchParams.get("account_id")).toBe(accountId);

    // PROOF: AccountDO initialized with real tokens
    expect(accountDO._calls.length).toBe(1);
    const doBody = accountDO._calls[0].body as Record<string, unknown>;
    const tokens = doBody.tokens as Record<string, string>;
    expect(tokens.access_token).toContain("ya29.");
    expect(tokens.refresh_token).toContain("1//");
    expect(tokens.expiry).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // PROOF: OnboardingWorkflow was started for new account
    expect(workflow._calls.length).toBe(1);
    expect(workflow._calls[0].params.account_id).toBe(accountId);
    expect(workflow._calls[0].params.user_id).toBe(userId);
  });

  it("Marketplace install for existing user links account to existing user", async () => {
    // Pre-populate existing user
    d1._users.push({
      user_id: "usr_EXISTING_E2E_01",
      org_id: "org_existing",
      email: INDIVIDUAL_EMAIL,
      display_name: "Pre-existing Jane",
    });

    const mockFetch = createMockFetch(null, {
      sub: INDIVIDUAL_SUB,
      email: INDIVIDUAL_EMAIL,
      name: "Jane Doe",
    });
    const handler = createHandler(mockFetch);

    const request = new Request(
      `https://oauth.tminus.dev/marketplace/install?code=${INDIVIDUAL_AUTH_CODE}`,
    );
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);

    // PROOF: existing user reused (not duplicated)
    expect(location.searchParams.get("user_id")).toBe("usr_EXISTING_E2E_01");
    expect(location.searchParams.get("existing_user")).toBe("true");
    expect(d1._users.length).toBe(1);

    // PROOF: account still created and linked
    expect(d1._accounts.length).toBe(1);
    expect(d1._accounts[0].user_id).toBe("usr_EXISTING_E2E_01");
  });

  it("install cancelled by user shows user-friendly error", async () => {
    const handler = createHandler();

    const request = new Request(
      "https://oauth.tminus.dev/marketplace/install?error=access_denied",
    );
    const response = await handler.fetch(request, env, mockCtx);

    // PROOF: not a 5xx error -- user-friendly message
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("cancelled or denied");
  });
});

// ===========================================================================
// TEST SUITE 2: Organization Install Flow (AC#2)
//
// Proves: Admin installs from admin console -> org installation record created
// -> org users visit and activate without OAuth consent
// ===========================================================================

describe("Phase 6B E2E: Organization install flow (AC#2)", () => {
  let d1: ReturnType<typeof createMockD1>;
  let accountDO: ReturnType<typeof createMockAccountDO>;
  let workflow: ReturnType<typeof createMockWorkflow>;
  let env: Env;

  beforeEach(() => {
    d1 = createMockD1();
    accountDO = createMockAccountDO();
    workflow = createMockWorkflow();
    env = createMockEnv({ d1, accountDO, workflow });
  });

  it("admin install creates org record and redirects to confirmation", async () => {
    const mockFetch = createMockFetch(null, {
      sub: ADMIN_SUB,
      email: ADMIN_EMAIL,
      name: "Admin User",
      hd: "acme-corp.dev",
    });
    const handler = createHandler(mockFetch);

    const request = new Request(
      `https://oauth.tminus.dev/marketplace/admin-install?code=${ADMIN_AUTH_CODE}&customer_id=${CUSTOMER_ID}&hd=acme-corp.dev`,
    );
    const response = await handler.fetch(request, env, mockCtx);

    // PROOF: redirects to admin confirmation page
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.pathname).toBe("/onboarding");
    expect(location.searchParams.get("admin_install")).toBe("true");
    expect(location.searchParams.get("customer_id")).toBe(CUSTOMER_ID);
    expect(location.searchParams.get("admin_email")).toBe(ADMIN_EMAIL);

    // PROOF: org installation record created
    expect(d1._installations.length).toBe(1);
    expect(d1._installations[0].google_customer_id).toBe(CUSTOMER_ID);
    expect(d1._installations[0].admin_email).toBe(ADMIN_EMAIL);
    expect(d1._installations[0].status).toBe("active");

    // PROOF: NO user records created (org install is org-level only, BR-1)
    expect(d1._users.length).toBe(0);

    // PROOF: NO accounts created (no auto-sync, BR-1)
    expect(d1._accounts.length).toBe(0);
  });

  it("org user activates without OAuth consent and gets pre-connected", async () => {
    // Pre-populate active org installation
    d1._installations.push({
      install_id: "oin_E2E_01",
      google_customer_id: CUSTOMER_ID,
      org_id: null,
      admin_email: ADMIN_EMAIL,
      admin_google_sub: ADMIN_SUB,
      scopes_granted: GOOGLE_SCOPES,
      status: "active",
    });

    const mockFetch = createMockFetch(null, {
      sub: ORG_USER1_SUB,
      email: ORG_USER1_EMAIL,
      name: "Alice",
      hd: "acme-corp.dev",
    });
    const handler = createHandler(mockFetch);

    const request = new Request(
      `https://oauth.tminus.dev/marketplace/org-activate?code=${ORG_USER1_AUTH_CODE}`,
    );
    const response = await handler.fetch(request, env, mockCtx);

    // PROOF: redirects to onboarding
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.pathname).toBe("/onboarding");
    expect(location.searchParams.get("org_install")).toBe("true");
    expect(location.searchParams.get("marketplace_install")).toBe("true");
    expect(location.searchParams.get("provider")).toBe("google");
    expect(location.searchParams.get("email")).toBe(ORG_USER1_EMAIL);

    // PROOF: user was created
    expect(d1._users.length).toBe(1);
    expect(d1._users[0].email).toBe(ORG_USER1_EMAIL);

    // PROOF: account was pre-connected
    expect(d1._accounts.length).toBe(1);
    expect(d1._accounts[0].provider_subject).toBe(ORG_USER1_SUB);

    // PROOF: AccountDO initialized
    expect(accountDO._calls.length).toBe(1);

    // PROOF: OnboardingWorkflow started
    expect(workflow._calls.length).toBe(1);
  });

  it("multiple org users activate independently using same org installation", async () => {
    // Pre-populate active org installation
    d1._installations.push({
      install_id: "oin_E2E_MULTI_01",
      google_customer_id: CUSTOMER_ID,
      org_id: null,
      admin_email: ADMIN_EMAIL,
      admin_google_sub: ADMIN_SUB,
      scopes_granted: GOOGLE_SCOPES,
      status: "active",
    });

    // User 1 activates
    const mockFetch1 = createMockFetch(null, {
      sub: ORG_USER1_SUB,
      email: ORG_USER1_EMAIL,
      name: "Alice",
      hd: "acme-corp.dev",
    });
    const handler1 = createHandler(mockFetch1);
    const request1 = new Request(
      `https://oauth.tminus.dev/marketplace/org-activate?code=${ORG_USER1_AUTH_CODE}`,
    );
    const response1 = await handler1.fetch(request1, env, mockCtx);
    expect(response1.status).toBe(302);

    // User 2 activates (different handler/fetch to simulate different identity)
    const mockFetch2 = createMockFetch(null, {
      sub: ORG_USER2_SUB,
      email: ORG_USER2_EMAIL,
      name: "Bob",
      hd: "acme-corp.dev",
    });
    const handler2 = createHandler(mockFetch2);
    const request2 = new Request(
      `https://oauth.tminus.dev/marketplace/org-activate?code=${ORG_USER2_AUTH_CODE}`,
    );
    const response2 = await handler2.fetch(request2, env, mockCtx);
    expect(response2.status).toBe(302);

    // PROOF: both users were created independently
    expect(d1._users.length).toBe(2);
    const userEmails = d1._users.map((u) => u.email).sort();
    expect(userEmails).toEqual([ORG_USER1_EMAIL, ORG_USER2_EMAIL]);

    // PROOF: both accounts pre-connected independently
    expect(d1._accounts.length).toBe(2);
    const accountSubs = d1._accounts.map((a) => a.provider_subject).sort();
    expect(accountSubs).toEqual([ORG_USER1_SUB, ORG_USER2_SUB]);

    // PROOF: each user got their own AccountDO init
    expect(accountDO._calls.length).toBe(2);

    // PROOF: each user got their own OnboardingWorkflow
    expect(workflow._calls.length).toBe(2);

    // PROOF: org installation record unchanged (still 1)
    expect(d1._installations.length).toBe(1);
    expect(d1._installations[0].status).toBe("active");
  });

  it("org user without matching org installation gets 403", async () => {
    // No installations exist
    const mockFetch = createMockFetch(null, {
      sub: ORG_USER1_SUB,
      email: "stranger@other-corp.dev",
      hd: "other-corp.dev",
    });
    const handler = createHandler(mockFetch);

    const request = new Request(
      `https://oauth.tminus.dev/marketplace/org-activate?code=some_code`,
    );
    const response = await handler.fetch(request, env, mockCtx);

    // PROOF: 403 -- org not found
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toContain("Organization Not Found");
  });
});

// ===========================================================================
// TEST SUITE 3: Individual Uninstall Flow (AC#3)
//
// Proves: Individual uninstall cleanly removes credentials and stops sync
// ===========================================================================

describe("Phase 6B E2E: Individual uninstall flow (AC#3)", () => {
  let d1: ReturnType<typeof createMockD1>;
  let accountDO: ReturnType<typeof createMockAccountDO>;
  let env: Env;

  beforeEach(async () => {
    d1 = createMockD1();
    accountDO = createMockAccountDO();
    env = createMockEnv({ d1, accountDO });

    // Generate fresh RSA keys for JWT signing
    testKeyPair = await generateTestKeyPair();
    testKid = "e2e-kid-" + Math.random().toString(36).slice(2, 8);
  });

  it("individual uninstall: credentials deleted, tokens revoked, sync stopped, account revoked, audit recorded", async () => {
    // Set up existing user with active account
    d1._users.push({
      user_id: "usr_UNINSTALL_01",
      org_id: "org_01",
      email: INDIVIDUAL_EMAIL,
    });
    d1._accounts.push({
      account_id: "acc_UNINSTALL_01",
      user_id: "usr_UNINSTALL_01",
      provider: "google",
      provider_subject: INDIVIDUAL_SUB,
      email: INDIVIDUAL_EMAIL,
      status: "active",
    });

    const jwk = await exportTestPublicKeyJWK(testKeyPair.publicKey, testKid);
    const now = Math.floor(Date.now() / 1000);
    const token = await createTestJWT(
      {
        iss: "Google Workspace Marketplace",
        aud: TEST_CLIENT_ID,
        sub: INDIVIDUAL_SUB,
        email: INDIVIDUAL_EMAIL,
        event_type: "uninstall",
        iat: now,
        exp: now + 300,
      },
      testKeyPair,
      testKid,
    );

    const mockFetch = createMockFetch(jwk);
    const handler = createHandler(mockFetch);

    const request = new Request("https://oauth.tminus.dev/marketplace/uninstall", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `jwt=${encodeURIComponent(token)}`,
    });
    const response = await handler.fetch(request, env, mockCtx);

    // PROOF: 200 response (Google expects 200)
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;

    // PROOF: individual uninstall type
    expect(body.type).toBe("individual");

    // PROOF: account processed
    const accounts = body.accounts as Array<Record<string, unknown>>;
    expect(accounts.length).toBe(1);
    expect(accounts[0].account_id).toBe("acc_UNINSTALL_01");

    // PROOF: tokens revoked (BR-2: best-effort)
    expect(accounts[0].token_revoked).toBe(true);

    // PROOF: credentials deleted (BR-1: GDPR mandatory)
    expect(accounts[0].credentials_deleted).toBe(true);

    // PROOF: sync stopped
    expect(accounts[0].sync_stopped).toBe(true);

    // PROOF: D1 account status set to revoked
    expect(d1._accounts[0].status).toBe("revoked");

    // PROOF: AccountDO was called for get-token, delete-credentials, stop-sync
    const doCalls = accountDO._calls.filter((c) => c.id === "acc_UNINSTALL_01");
    expect(doCalls.length).toBe(3);
    expect(doCalls[0].url).toContain("get-token");
    expect(doCalls[1].url).toContain("delete-credentials");
    expect(doCalls[2].url).toContain("stop-sync");

    // PROOF: audit log entry created (BR-4)
    expect(body.audit_id).toBeTruthy();
    expect(d1._auditLog.length).toBe(1);
    expect(d1._auditLog[0].event_type).toBe("individual");
    expect(d1._auditLog[0].identity_sub).toBe(INDIVIDUAL_SUB);
  });
});

// ===========================================================================
// TEST SUITE 4: Organization Uninstall Flow (AC#4)
//
// Proves: Org uninstall cleanly removes all org users' data and credentials
// ===========================================================================

describe("Phase 6B E2E: Organization uninstall flow (AC#4)", () => {
  let d1: ReturnType<typeof createMockD1>;
  let accountDO: ReturnType<typeof createMockAccountDO>;
  let env: Env;

  beforeEach(async () => {
    d1 = createMockD1();
    accountDO = createMockAccountDO();
    env = createMockEnv({ d1, accountDO });

    testKeyPair = await generateTestKeyPair();
    testKid = "e2e-kid-org-" + Math.random().toString(36).slice(2, 8);
  });

  it("org uninstall: all org users cleaned up, installation deactivated, audit recorded", async () => {
    // Set up org installation with 3 users
    d1._installations.push({
      install_id: "oin_UNINSTALL_01",
      google_customer_id: CUSTOMER_ID,
      org_id: "org_UNINSTALL_01",
      admin_email: ADMIN_EMAIL,
      status: "active",
    });
    d1._users.push(
      { user_id: "usr_ORG_U1", org_id: "org_UNINSTALL_01", email: "alice@acme-corp.dev" },
      { user_id: "usr_ORG_U2", org_id: "org_UNINSTALL_01", email: "bob@acme-corp.dev" },
      { user_id: "usr_ORG_U3", org_id: "org_UNINSTALL_01", email: "carol@acme-corp.dev" },
    );
    d1._accounts.push(
      { account_id: "acc_ORG_U1", user_id: "usr_ORG_U1", provider: "google", provider_subject: "sub-alice", email: "alice@acme-corp.dev", status: "active" },
      { account_id: "acc_ORG_U2", user_id: "usr_ORG_U2", provider: "google", provider_subject: "sub-bob", email: "bob@acme-corp.dev", status: "active" },
      { account_id: "acc_ORG_U3", user_id: "usr_ORG_U3", provider: "google", provider_subject: "sub-carol", email: "carol@acme-corp.dev", status: "active" },
    );

    const jwk = await exportTestPublicKeyJWK(testKeyPair.publicKey, testKid);
    const now = Math.floor(Date.now() / 1000);
    const token = await createTestJWT(
      {
        iss: "Google Workspace Marketplace",
        aud: TEST_CLIENT_ID,
        customer_id: CUSTOMER_ID,
        event_type: "uninstall",
        iat: now,
        exp: now + 300,
      },
      testKeyPair,
      testKid,
    );

    const mockFetch = createMockFetch(jwk);
    const handler = createHandler(mockFetch);

    const request = new Request("https://oauth.tminus.dev/marketplace/uninstall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jwt: token }),
    });
    const response = await handler.fetch(request, env, mockCtx);

    // PROOF: 200 response
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;

    // PROOF: organization uninstall type
    expect(body.type).toBe("organization");

    // PROOF: all 3 org users' accounts processed
    const accounts = body.accounts as Array<Record<string, unknown>>;
    expect(accounts.length).toBe(3);
    const accountIds = accounts.map((a) => a.account_id).sort();
    expect(accountIds).toEqual(["acc_ORG_U1", "acc_ORG_U2", "acc_ORG_U3"]);

    // PROOF: all credentials deleted
    for (const acct of accounts) {
      expect(acct.credentials_deleted).toBe(true);
      expect(acct.sync_stopped).toBe(true);
    }

    // PROOF: all D1 accounts set to revoked
    for (const acct of d1._accounts) {
      expect(acct.status).toBe("revoked");
    }

    // PROOF: org installation deactivated
    expect(d1._installations[0].status).toBe("inactive");

    // PROOF: audit log recorded with customer_id
    expect(d1._auditLog.length).toBe(1);
    expect(d1._auditLog[0].event_type).toBe("organization");
    expect(d1._auditLog[0].identity_customer_id).toBe(CUSTOMER_ID);
  });
});

// ===========================================================================
// TEST SUITE 5: Re-install After Uninstall (AC#5)
//
// Proves: Re-install starts with clean state, no ghost accounts
// ===========================================================================

describe("Phase 6B E2E: Re-install after uninstall (AC#5)", () => {
  let d1: ReturnType<typeof createMockD1>;
  let accountDO: ReturnType<typeof createMockAccountDO>;
  let workflow: ReturnType<typeof createMockWorkflow>;
  let env: Env;

  beforeEach(async () => {
    d1 = createMockD1();
    accountDO = createMockAccountDO();
    workflow = createMockWorkflow();
    env = createMockEnv({ d1, accountDO, workflow });

    testKeyPair = await generateTestKeyPair();
    testKid = "e2e-kid-reinstall-" + Math.random().toString(36).slice(2, 8);
  });

  it("individual: uninstall -> re-install reactivates account with clean state", async () => {
    // Phase 1: User already existed and has a revoked account (post-uninstall)
    d1._users.push({
      user_id: "usr_REINSTALL_01",
      org_id: "org_01",
      email: INDIVIDUAL_EMAIL,
      display_name: "Jane Doe",
    });
    d1._accounts.push({
      account_id: "acc_REINSTALL_01",
      user_id: "usr_REINSTALL_01",
      provider: "google",
      provider_subject: INDIVIDUAL_SUB,
      email: INDIVIDUAL_EMAIL,
      status: "revoked", // <-- was uninstalled
    });

    // Phase 2: User re-installs from Marketplace
    const mockFetch = createMockFetch(null, {
      sub: INDIVIDUAL_SUB,
      email: INDIVIDUAL_EMAIL,
      name: "Jane Doe",
    });
    const handler = createHandler(mockFetch);

    const request = new Request(
      `https://oauth.tminus.dev/marketplace/install?code=${INDIVIDUAL_AUTH_CODE}`,
    );
    const response = await handler.fetch(request, env, mockCtx);

    // PROOF: redirects to onboarding
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.pathname).toBe("/onboarding");

    // PROOF: existing user reused
    expect(location.searchParams.get("user_id")).toBe("usr_REINSTALL_01");
    expect(location.searchParams.get("existing_user")).toBe("true");

    // PROOF: account was REACTIVATED (not duplicated)
    expect(d1._accounts.length).toBe(1);
    expect(d1._accounts[0].account_id).toBe("acc_REINSTALL_01");
    expect(d1._accounts[0].status).toBe("active"); // reactivated

    // PROOF: AccountDO re-initialized with fresh tokens (clean state)
    expect(accountDO._calls.length).toBe(1);
    const doBody = accountDO._calls[0].body as Record<string, unknown>;
    const tokens = doBody.tokens as Record<string, string>;
    expect(tokens.access_token).toContain("ya29.");
    expect(tokens.refresh_token).toContain("1//");

    // PROOF: OnboardingWorkflow NOT started (account was not new, just reactivated)
    // The code checks `isNewAccount` -- reactivation means `existing` path is taken
    expect(workflow._calls.length).toBe(0);
  });

  it("org: deactivated org installation -> admin re-installs -> installation reactivated", async () => {
    // Phase 1: Org installation exists but is inactive (was deactivated)
    d1._installations.push({
      install_id: "oin_REINSTALL_01",
      google_customer_id: CUSTOMER_ID,
      org_id: null,
      admin_email: ADMIN_EMAIL,
      admin_google_sub: ADMIN_SUB,
      scopes_granted: GOOGLE_SCOPES,
      status: "inactive",
      deactivated_at: "2025-01-01T00:00:00.000Z",
    });

    // Phase 2: Admin re-installs
    const mockFetch = createMockFetch(null, {
      sub: ADMIN_SUB,
      email: ADMIN_EMAIL,
      name: "Admin User",
      hd: "acme-corp.dev",
    });
    const handler = createHandler(mockFetch);

    const request = new Request(
      `https://oauth.tminus.dev/marketplace/admin-install?code=${ADMIN_AUTH_CODE}&customer_id=${CUSTOMER_ID}`,
    );
    const response = await handler.fetch(request, env, mockCtx);

    // PROOF: redirects to admin confirmation
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.searchParams.get("admin_install")).toBe("true");

    // PROOF: existing installation reactivated (not duplicated)
    expect(d1._installations.length).toBe(1);
    expect(d1._installations[0].install_id).toBe("oin_REINSTALL_01");
    expect(d1._installations[0].status).toBe("active");

    // PROOF: admin email updated
    expect(d1._installations[0].admin_email).toBe(ADMIN_EMAIL);
  });
});

// ===========================================================================
// TEST SUITE 6: Edge Cases (AC#6)
//
// Proves: Individual + org overlap handled without duplicates or errors
// ===========================================================================

describe("Phase 6B E2E: Edge cases (AC#6)", () => {
  let d1: ReturnType<typeof createMockD1>;
  let accountDO: ReturnType<typeof createMockAccountDO>;
  let workflow: ReturnType<typeof createMockWorkflow>;
  let env: Env;

  beforeEach(async () => {
    d1 = createMockD1();
    accountDO = createMockAccountDO();
    workflow = createMockWorkflow();
    env = createMockEnv({ d1, accountDO, workflow });

    testKeyPair = await generateTestKeyPair();
    testKid = "e2e-kid-edge-" + Math.random().toString(36).slice(2, 8);
  });

  it("user installs individually, then org install covers their domain -- no duplicate accounts", async () => {
    // Step 1: Charlie installs individually from Marketplace
    const individualFetch = createMockFetch(null, {
      sub: OVERLAP_SUB,
      email: OVERLAP_EMAIL,
      name: "Charlie",
      hd: "acme-corp.dev",
    });
    const handler1 = createHandler(individualFetch);
    const installReq = new Request(
      `https://oauth.tminus.dev/marketplace/install?code=${OVERLAP_AUTH_CODE}`,
    );
    const installResp = await handler1.fetch(installReq, env, mockCtx);
    expect(installResp.status).toBe(302);

    // Verify Charlie has 1 user and 1 account
    expect(d1._users.length).toBe(1);
    expect(d1._accounts.length).toBe(1);
    const charlesAccountId = d1._accounts[0].account_id;

    // Step 2: Admin installs for the org
    const adminFetch = createMockFetch(null, {
      sub: ADMIN_SUB,
      email: ADMIN_EMAIL,
      name: "Admin",
      hd: "acme-corp.dev",
    });
    const handler2 = createHandler(adminFetch);
    const adminReq = new Request(
      `https://oauth.tminus.dev/marketplace/admin-install?code=${ADMIN_AUTH_CODE}&customer_id=${CUSTOMER_ID}`,
    );
    const adminResp = await handler2.fetch(adminReq, env, mockCtx);
    expect(adminResp.status).toBe(302);

    // Verify org installation created
    expect(d1._installations.length).toBe(1);

    // Step 3: Charlie tries org-activate (already has individual install)
    d1._installations[0].status = "active"; // ensure active
    const orgActivateFetch = createMockFetch(null, {
      sub: OVERLAP_SUB,
      email: OVERLAP_EMAIL,
      name: "Charlie",
      hd: "acme-corp.dev",
    });
    const handler3 = createHandler(orgActivateFetch);
    const activateReq = new Request(
      `https://oauth.tminus.dev/marketplace/org-activate?code=new-code-for-charlie`,
    );
    const activateResp = await handler3.fetch(activateReq, env, mockCtx);
    expect(activateResp.status).toBe(302);

    // PROOF: still only 1 user (not duplicated)
    expect(d1._users.length).toBe(1);
    expect(d1._users[0].email).toBe(OVERLAP_EMAIL);

    // PROOF: still only 1 account (same provider_subject matched, reactivated)
    expect(d1._accounts.length).toBe(1);
    expect(d1._accounts[0].account_id).toBe(charlesAccountId);
    expect(d1._accounts[0].status).toBe("active");
  });

  it("user with both Marketplace and direct OAuth has single account (same provider_subject)", async () => {
    // Simulate: user installed via Marketplace first
    d1._users.push({
      user_id: "usr_DUAL_01",
      org_id: "org_01",
      email: INDIVIDUAL_EMAIL,
    });
    d1._accounts.push({
      account_id: "acc_DUAL_01",
      user_id: "usr_DUAL_01",
      provider: "google",
      provider_subject: INDIVIDUAL_SUB,
      email: INDIVIDUAL_EMAIL,
      status: "active",
    });

    // User re-connects via direct OAuth (same provider_subject)
    // This goes through /marketplace/install which reuses existing accounts
    const mockFetch = createMockFetch(null, {
      sub: INDIVIDUAL_SUB,
      email: INDIVIDUAL_EMAIL,
      name: "Jane Doe",
    });
    const handler = createHandler(mockFetch);

    const request = new Request(
      `https://oauth.tminus.dev/marketplace/install?code=direct-oauth-code`,
    );
    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(302);

    // PROOF: still only 1 account (no duplicate from re-auth)
    expect(d1._accounts.length).toBe(1);
    expect(d1._accounts[0].account_id).toBe("acc_DUAL_01");
    expect(d1._accounts[0].status).toBe("active");

    // PROOF: AccountDO refreshed with new tokens
    expect(accountDO._calls.length).toBe(1);
  });

  it("re-install after uninstall (full lifecycle: install -> uninstall -> re-install)", async () => {
    const startTime = Date.now();

    // PHASE 1: Individual install from Marketplace
    const installFetch = createMockFetch(null, {
      sub: INDIVIDUAL_SUB,
      email: INDIVIDUAL_EMAIL,
      name: "Jane Doe",
    });
    const installHandler = createHandler(installFetch);
    const installReq = new Request(
      `https://oauth.tminus.dev/marketplace/install?code=install-phase-1`,
    );
    const installResp = await installHandler.fetch(installReq, env, mockCtx);
    expect(installResp.status).toBe(302);

    // Verify initial state
    expect(d1._users.length).toBe(1);
    expect(d1._accounts.length).toBe(1);
    expect(d1._accounts[0].status).toBe("active");
    const originalAccountId = d1._accounts[0].account_id;

    // PHASE 2: Individual uninstall via webhook
    const jwk = await exportTestPublicKeyJWK(testKeyPair.publicKey, testKid);
    const now = Math.floor(Date.now() / 1000);
    const uninstallToken = await createTestJWT(
      {
        iss: "Google Workspace Marketplace",
        aud: TEST_CLIENT_ID,
        sub: INDIVIDUAL_SUB,
        email: INDIVIDUAL_EMAIL,
        event_type: "uninstall",
        iat: now,
        exp: now + 300,
      },
      testKeyPair,
      testKid,
    );

    const uninstallFetch = createMockFetch(jwk);
    const uninstallHandler = createHandler(uninstallFetch);
    const uninstallReq = new Request("https://oauth.tminus.dev/marketplace/uninstall", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `jwt=${encodeURIComponent(uninstallToken)}`,
    });
    const uninstallResp = await uninstallHandler.fetch(uninstallReq, env, mockCtx);
    expect(uninstallResp.status).toBe(200);

    // Verify post-uninstall state
    expect(d1._accounts[0].status).toBe("revoked");
    expect(d1._auditLog.length).toBe(1);

    // PHASE 3: Re-install from Marketplace
    const reinstallFetch = createMockFetch(null, {
      sub: INDIVIDUAL_SUB,
      email: INDIVIDUAL_EMAIL,
      name: "Jane Doe",
    });
    const reinstallHandler = createHandler(reinstallFetch);
    const reinstallReq = new Request(
      `https://oauth.tminus.dev/marketplace/install?code=reinstall-phase-3`,
    );
    const reinstallResp = await reinstallHandler.fetch(reinstallReq, env, mockCtx);

    // PROOF: redirects to onboarding (successful re-install)
    expect(reinstallResp.status).toBe(302);
    const location = new URL(reinstallResp.headers.get("Location")!);
    expect(location.pathname).toBe("/onboarding");
    expect(location.searchParams.get("marketplace_install")).toBe("true");

    // PROOF: same user reused (not duplicated)
    expect(d1._users.length).toBe(1);
    expect(location.searchParams.get("existing_user")).toBe("true");

    // PROOF: same account reactivated (not duplicated -- clean state)
    expect(d1._accounts.length).toBe(1);
    expect(d1._accounts[0].account_id).toBe(originalAccountId);
    expect(d1._accounts[0].status).toBe("active"); // reactivated from "revoked"

    // PROOF: AccountDO re-initialized with fresh tokens
    // 1 from install, 3 from uninstall (get-token + delete + stop), 1 from re-install
    const reinitCalls = accountDO._calls.filter(
      (c) => c.url.includes("initialize"),
    );
    expect(reinitCalls.length).toBe(2); // install + re-install

    // PROOF: full lifecycle completed in reasonable time
    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeLessThan(10_000);
  });
});

// ===========================================================================
// TEST SUITE 7: Test Automation and Repeatability (AC#7)
//
// Proves: Tests are fully automated and repeatable. Each test is isolated
// with fresh D1/DO/Workflow mocks in beforeEach.
// ===========================================================================

describe("Phase 6B E2E: Test automation verification (AC#7)", () => {
  it("tests are isolated: running the same scenario twice produces identical results", async () => {
    // Run the same individual install scenario twice with fresh state
    for (let run = 0; run < 2; run++) {
      const d1 = createMockD1();
      const accountDO = createMockAccountDO();
      const workflow = createMockWorkflow();
      const env = createMockEnv({ d1, accountDO, workflow });

      const mockFetch = createMockFetch(null, {
        sub: INDIVIDUAL_SUB,
        email: INDIVIDUAL_EMAIL,
        name: "Jane Doe",
      });
      const handler = createHandler(mockFetch);

      const request = new Request(
        `https://oauth.tminus.dev/marketplace/install?code=repeat-${run}`,
      );
      const response = await handler.fetch(request, env, mockCtx);

      // PROOF: each run produces the same shape of results
      expect(response.status).toBe(302);
      expect(d1._users.length).toBe(1);
      expect(d1._accounts.length).toBe(1);
      expect(accountDO._calls.length).toBe(1);
      expect(workflow._calls.length).toBe(1);
    }
  });

  it("routing verification: all Marketplace endpoints respond correctly", async () => {
    const env = createMockEnv();
    const handler = createHandler();

    // Health check (baseline)
    const healthResp = await handler.fetch(
      new Request("https://oauth.tminus.dev/health"),
      env,
      mockCtx,
    );
    expect(healthResp.status).toBe(200);

    // Individual install (no code = 400)
    const installResp = await handler.fetch(
      new Request("https://oauth.tminus.dev/marketplace/install"),
      env,
      mockCtx,
    );
    expect(installResp.status).toBe(400);

    // Admin install (no code = 400)
    const adminResp = await handler.fetch(
      new Request("https://oauth.tminus.dev/marketplace/admin-install"),
      env,
      mockCtx,
    );
    expect(adminResp.status).toBe(400);

    // Org activate (no code = 400)
    const orgResp = await handler.fetch(
      new Request("https://oauth.tminus.dev/marketplace/org-activate"),
      env,
      mockCtx,
    );
    expect(orgResp.status).toBe(400);

    // Uninstall (GET = 405, because it only accepts POST)
    const uninstallGetResp = await handler.fetch(
      new Request("https://oauth.tminus.dev/marketplace/uninstall"),
      env,
      mockCtx,
    );
    expect(uninstallGetResp.status).toBe(405);

    // Uninstall (POST with invalid JWT = 401)
    const jwk = await exportTestPublicKeyJWK(
      (await generateTestKeyPair()).publicKey,
      "test",
    );
    const uninstallFetch = createMockFetch(jwk);
    const handler2 = createHandler(uninstallFetch);
    const uninstallPostResp = await handler2.fetch(
      new Request("https://oauth.tminus.dev/marketplace/uninstall", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "jwt=invalid.jwt.token",
      }),
      env,
      mockCtx,
    );
    expect(uninstallPostResp.status).toBe(401);

    // Unknown path (404)
    const unknownResp = await handler.fetch(
      new Request("https://oauth.tminus.dev/marketplace/unknown"),
      env,
      mockCtx,
    );
    expect(unknownResp.status).toBe(404);
  });
});

// ===========================================================================
// TEST SUITE 8: Full Lifecycle (AC#1-6 Combined)
//
// Single test proving the entire lifecycle works end-to-end:
// admin install -> multiple org users activate -> individual uninstall
// -> org uninstall -> re-install
// ===========================================================================

describe("Phase 6B E2E: Full lifecycle integration (AC#1-6 combined)", () => {
  it("complete lifecycle: admin install -> org users activate -> individual uninstall -> org uninstall -> re-install", async () => {
    const d1 = createMockD1();
    const accountDO = createMockAccountDO();
    const workflow = createMockWorkflow();
    const env = createMockEnv({ d1, accountDO, workflow });

    testKeyPair = await generateTestKeyPair();
    testKid = "e2e-kid-lifecycle-" + Math.random().toString(36).slice(2, 8);

    const startTime = Date.now();

    // STEP 1: Admin installs for the org
    const adminFetch = createMockFetch(null, {
      sub: ADMIN_SUB,
      email: ADMIN_EMAIL,
      name: "Admin",
      hd: "acme-corp.dev",
    });
    const adminHandler = createHandler(adminFetch);
    const adminReq = new Request(
      `https://oauth.tminus.dev/marketplace/admin-install?code=${ADMIN_AUTH_CODE}&customer_id=${CUSTOMER_ID}`,
    );
    const adminResp = await adminHandler.fetch(adminReq, env, mockCtx);
    expect(adminResp.status).toBe(302);
    expect(d1._installations.length).toBe(1);
    expect(d1._installations[0].status).toBe("active");

    // STEP 2: Alice activates (org user)
    const aliceFetch = createMockFetch(null, {
      sub: ORG_USER1_SUB,
      email: ORG_USER1_EMAIL,
      name: "Alice",
      hd: "acme-corp.dev",
    });
    const aliceHandler = createHandler(aliceFetch);
    const aliceReq = new Request(
      `https://oauth.tminus.dev/marketplace/org-activate?code=alice-code`,
    );
    const aliceResp = await aliceHandler.fetch(aliceReq, env, mockCtx);
    expect(aliceResp.status).toBe(302);

    // Link the org installation to the org created during Alice's activation.
    // In production, this linking happens when the admin install finds an existing
    // org or when org-activate creates one. Here we simulate the linkage to ensure
    // org uninstall can find all org users by org_id.
    const aliceOrgId = d1._users[0].org_id as string;
    d1._installations[0].org_id = aliceOrgId;

    // STEP 3: Bob activates (org user)
    const bobFetch = createMockFetch(null, {
      sub: ORG_USER2_SUB,
      email: ORG_USER2_EMAIL,
      name: "Bob",
      hd: "acme-corp.dev",
    });
    const bobHandler = createHandler(bobFetch);
    const bobReq = new Request(
      `https://oauth.tminus.dev/marketplace/org-activate?code=bob-code`,
    );
    const bobResp = await bobHandler.fetch(bobReq, env, mockCtx);
    expect(bobResp.status).toBe(302);

    // PROOF: 2 users and 2 accounts created
    expect(d1._users.length).toBe(2);
    expect(d1._accounts.length).toBe(2);

    // STEP 4: Individual install from Jane (outside org)
    const janeFetch = createMockFetch(null, {
      sub: INDIVIDUAL_SUB,
      email: INDIVIDUAL_EMAIL,
      name: "Jane",
    });
    const janeHandler = createHandler(janeFetch);
    const janeReq = new Request(
      `https://oauth.tminus.dev/marketplace/install?code=jane-code`,
    );
    const janeResp = await janeHandler.fetch(janeReq, env, mockCtx);
    expect(janeResp.status).toBe(302);

    // PROOF: 3 users, 3 accounts total
    expect(d1._users.length).toBe(3);
    expect(d1._accounts.length).toBe(3);

    // STEP 5: Jane uninstalls (individual)
    const jwk = await exportTestPublicKeyJWK(testKeyPair.publicKey, testKid);
    const now = Math.floor(Date.now() / 1000);
    const janeUninstallToken = await createTestJWT(
      {
        iss: "Google Workspace Marketplace",
        aud: TEST_CLIENT_ID,
        sub: INDIVIDUAL_SUB,
        email: INDIVIDUAL_EMAIL,
        event_type: "uninstall",
        iat: now,
        exp: now + 300,
      },
      testKeyPair,
      testKid,
    );

    const janeUninstallFetch = createMockFetch(jwk);
    const janeUninstallHandler = createHandler(janeUninstallFetch);
    const janeUninstallReq = new Request("https://oauth.tminus.dev/marketplace/uninstall", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `jwt=${encodeURIComponent(janeUninstallToken)}`,
    });
    const janeUninstallResp = await janeUninstallHandler.fetch(janeUninstallReq, env, mockCtx);
    expect(janeUninstallResp.status).toBe(200);

    // PROOF: Jane's account revoked, org users unaffected
    const janeAccount = d1._accounts.find((a) => a.provider_subject === INDIVIDUAL_SUB);
    expect(janeAccount!.status).toBe("revoked");
    const orgAccounts = d1._accounts.filter((a) => a.provider_subject !== INDIVIDUAL_SUB);
    for (const acct of orgAccounts) {
      expect(acct.status).toBe("active");
    }

    // STEP 6: Org uninstall
    const orgUninstallToken = await createTestJWT(
      {
        iss: "Google Workspace Marketplace",
        aud: TEST_CLIENT_ID,
        customer_id: CUSTOMER_ID,
        event_type: "uninstall",
        iat: now,
        exp: now + 300,
      },
      testKeyPair,
      testKid,
    );

    const orgUninstallFetch = createMockFetch(jwk);
    const orgUninstallHandler = createHandler(orgUninstallFetch);
    const orgUninstallReq = new Request("https://oauth.tminus.dev/marketplace/uninstall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jwt: orgUninstallToken }),
    });
    const orgUninstallResp = await orgUninstallHandler.fetch(orgUninstallReq, env, mockCtx);
    expect(orgUninstallResp.status).toBe(200);

    // PROOF: all org users' accounts revoked
    for (const acct of d1._accounts.filter((a) => a.provider_subject !== INDIVIDUAL_SUB)) {
      expect(acct.status).toBe("revoked");
    }

    // PROOF: org installation deactivated
    expect(d1._installations[0].status).toBe("inactive");

    // STEP 7: Jane re-installs
    const janeReinstallFetch = createMockFetch(null, {
      sub: INDIVIDUAL_SUB,
      email: INDIVIDUAL_EMAIL,
      name: "Jane",
    });
    const janeReinstallHandler = createHandler(janeReinstallFetch);
    const janeReinstallReq = new Request(
      `https://oauth.tminus.dev/marketplace/install?code=jane-reinstall`,
    );
    const janeReinstallResp = await janeReinstallHandler.fetch(janeReinstallReq, env, mockCtx);

    // PROOF: re-install succeeds
    expect(janeReinstallResp.status).toBe(302);
    const reinstallLocation = new URL(janeReinstallResp.headers.get("Location")!);
    expect(reinstallLocation.searchParams.get("marketplace_install")).toBe("true");

    // PROOF: account reactivated (not duplicated)
    const janeAccountAfter = d1._accounts.find((a) => a.provider_subject === INDIVIDUAL_SUB);
    expect(janeAccountAfter!.status).toBe("active");
    // Total accounts still 3 (not 4)
    expect(d1._accounts.length).toBe(3);

    // PROOF: 2 audit log entries (1 individual + 1 org uninstall)
    expect(d1._auditLog.length).toBe(2);

    // PROOF: full lifecycle completed in reasonable time
    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeLessThan(30_000);
  });
});
