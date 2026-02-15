/**
 * Integration tests for Google Workspace Marketplace uninstall webhook.
 *
 * These tests verify the FULL end-to-end flow through the oauth worker router:
 * 1. Individual uninstall: POST /marketplace/uninstall revokes tokens and deletes credentials
 * 2. Org uninstall: POST /marketplace/uninstall processes all org users
 * 3. Partial failure: token revocation fails but credential cleanup continues
 * 4. Router integration: POST routes correctly, GET returns 404
 *
 * External Google APIs are mocked via injectable fetch, but the internal
 * flow (D1 queries, DO calls, routing) exercises the real code paths.
 *
 * Pattern follows: workers/oauth/src/marketplace.integration.test.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHandler, type FetchFn } from "./index";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const TEST_CLIENT_SECRET = "test-client-secret";
const TEST_MS_CLIENT_ID = "test-ms-client-id";
const TEST_MS_CLIENT_SECRET = "test-ms-secret";
const TEST_JWT_SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
const TEST_GOOGLE_SUB = "google-sub-integ-uninstall-12345";
const TEST_EMAIL = "uninstall-user@workspace.dev";
const TEST_CUSTOMER_ID = "C01_integ_uninstall";

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

// ---------------------------------------------------------------------------
// RSA key utilities for test JWT creation
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

beforeEach(async () => {
  testKeyPair = await generateTestKeyPair();
  testKid = "integ-kid-" + Math.random().toString(36).slice(2, 8);
});

// ---------------------------------------------------------------------------
// Mock factories (matching marketplace.integration.test.ts pattern)
// ---------------------------------------------------------------------------

function createIntegrationMockFetch(
  jwk: Record<string, unknown>,
  overrides?: { revokeStatus?: number },
): FetchFn {
  return async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    // Google JWKS
    if (url.includes("googleapis.com/oauth2/v3/certs")) {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Google token revocation
    if (url.includes("oauth2.googleapis.com/revoke")) {
      return new Response("", { status: overrides?.revokeStatus ?? 200 });
    }

    // Google token exchange (for other marketplace routes that might be called)
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({
        access_token: "ya29.unused",
        refresh_token: "1//unused",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "openid email",
      }), { status: 200 });
    }

    // Google userinfo
    if (url.includes("googleapis.com/oauth2/v3/userinfo")) {
      return new Response(JSON.stringify({
        sub: "unused-sub",
        email: "unused@test.com",
      }), { status: 200 });
    }

    throw new Error(`Unexpected integration test fetch URL: ${url}`);
  };
}

function createIntegrationMockD1() {
  const accounts: Array<Record<string, unknown>> = [];
  const users: Array<Record<string, unknown>> = [];
  const orgs: Array<Record<string, unknown>> = [];
  const installations: Array<Record<string, unknown>> = [];
  const auditLog: Array<Record<string, unknown>> = [];

  return {
    _accounts: accounts,
    _users: users,
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
          // Org installation by customer_id
          if (sql.includes("org_installations") && sql.includes("google_customer_id")) {
            const customerId = statement.bindings[0] as string;
            const found = installations.find(
              (i) => i.google_customer_id === customerId && i.status === "active",
            );
            return (found as T) ?? null;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[]; success: boolean }> {
          // Accounts by provider_subject
          if (sql.includes("accounts") && sql.includes("provider_subject") && !sql.includes("JOIN")) {
            const providerSubject = statement.bindings[0] as string;
            const found = accounts.filter(
              (a) => a.provider_subject === providerSubject && a.provider === "google",
            );
            return { results: found as T[], success: true };
          }
          // Accounts by org_id (JOIN)
          if (sql.includes("accounts") && sql.includes("org_id")) {
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
          // Users by email
          if (sql.includes("users") && sql.includes("email")) {
            const email = statement.bindings[0] as string;
            return { results: users.filter((u) => u.email === email) as T[], success: true };
          }
          // Accounts by provider + provider_subject (for marketplace install)
          if (sql.includes("accounts") && sql.includes("provider")) {
            return { results: [], success: true };
          }
          return { results: [], success: true };
        },
        async run(): Promise<{ success: boolean }> {
          // UPDATE accounts status
          if (sql.includes("UPDATE") && sql.includes("accounts") && sql.includes("revoked")) {
            const accountId = statement.bindings[0] as string;
            for (const acct of accounts) {
              if (acct.account_id === accountId) {
                acct.status = "revoked";
              }
            }
          }
          // UPDATE org_installations
          if (sql.includes("UPDATE") && sql.includes("org_installations") && sql.includes("inactive")) {
            const installId = statement.bindings[0] as string;
            for (const inst of installations) {
              if (inst.install_id === installId) {
                inst.status = "inactive";
              }
            }
          }
          // INSERT INTO uninstall_audit_log
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
          // INSERT INTO orgs
          if (sql.includes("INSERT") && sql.includes("orgs") && !sql.includes("org_installations")) {
            orgs.push({ org_id: statement.bindings[0], name: statement.bindings[1] });
          }
          // INSERT INTO users
          if (sql.includes("INSERT") && sql.includes("users") && !sql.includes("orgs")) {
            users.push({
              user_id: statement.bindings[0],
              org_id: statement.bindings[1],
              email: statement.bindings[2],
              display_name: statement.bindings[3],
            });
          }
          // INSERT INTO accounts
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
          return { success: true };
        },
      };
      return statement;
    },
  };
}

function createIntegrationMockAccountDO(overrides?: {
  getTokenStatus?: number;
  deleteCredentialsStatus?: number;
  stopSyncStatus?: number;
}) {
  const calls: Array<{ id: string; url: string; method: string }> = [];

  return {
    _calls: calls,
    idFromName(name: string) {
      return { name };
    },
    get(id: { name: string }) {
      return {
        async fetch(request: Request) {
          let body: unknown = null;
          // Only try to read JSON for POST requests with expected content
          if (request.method === "POST" && request.url.includes("initialize")) {
            body = await request.json();
          }
          calls.push({ id: id.name, url: request.url, method: request.method });

          if (request.url.includes("get-token")) {
            const status = overrides?.getTokenStatus ?? 200;
            return new Response(
              JSON.stringify({
                access_token: "ya29.integ-access-token",
                refresh_token: "1//integ-refresh-token",
              }),
              { status },
            );
          }
          if (request.url.includes("delete-credentials")) {
            return new Response("OK", {
              status: overrides?.deleteCredentialsStatus ?? 200,
            });
          }
          if (request.url.includes("stop-sync")) {
            return new Response("OK", {
              status: overrides?.stopSyncStatus ?? 200,
            });
          }
          // Default: initialize (from marketplace install)
          return new Response("OK", { status: 200 });
        },
      };
    },
  };
}

function createIntegrationMockWorkflow() {
  return {
    _calls: [] as Array<Record<string, unknown>>,
    async create(options: Record<string, unknown>) {
      this._calls.push(options);
      return { id: "auto" };
    },
  };
}

function createIntegrationMockEnv(overrides?: {
  d1?: ReturnType<typeof createIntegrationMockD1>;
  accountDO?: ReturnType<typeof createIntegrationMockAccountDO>;
  workflow?: ReturnType<typeof createIntegrationMockWorkflow>;
}) {
  return {
    DB: overrides?.d1 ?? createIntegrationMockD1(),
    USER_GRAPH: {} as DurableObjectNamespace,
    ACCOUNT: overrides?.accountDO ?? createIntegrationMockAccountDO(),
    ONBOARDING_WORKFLOW: overrides?.workflow ?? createIntegrationMockWorkflow(),
    GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: TEST_CLIENT_SECRET,
    MS_CLIENT_ID: TEST_MS_CLIENT_ID,
    MS_CLIENT_SECRET: TEST_MS_CLIENT_SECRET,
    JWT_SECRET: TEST_JWT_SECRET,
  } as unknown as Env;
}

// ===========================================================================
// Integration Test 1: Individual uninstall revokes tokens and deletes credentials
// ===========================================================================

describe("Integration: Individual uninstall revokes tokens and deletes credentials", () => {
  it("end-to-end: POST /marketplace/uninstall with individual JWT -> tokens revoked -> credentials deleted -> 200", async () => {
    const d1 = createIntegrationMockD1();
    const accountDO = createIntegrationMockAccountDO();
    d1._accounts.push({
      account_id: "acc_INTEG_IND_01",
      user_id: "usr_INTEG_IND_01",
      provider: "google",
      provider_subject: TEST_GOOGLE_SUB,
      email: TEST_EMAIL,
      status: "active",
    });

    const env = createIntegrationMockEnv({ d1, accountDO });

    // Create valid JWT for individual uninstall
    const jwk = await exportTestPublicKeyJWK(testKeyPair.publicKey, testKid);
    const now = Math.floor(Date.now() / 1000);
    const token = await createTestJWT(
      {
        iss: "Google Workspace Marketplace",
        aud: TEST_CLIENT_ID,
        sub: TEST_GOOGLE_SUB,
        email: TEST_EMAIL,
        event_type: "uninstall",
        iat: now,
        exp: now + 300,
      },
      testKeyPair,
      testKid,
    );

    const mockFetch = createIntegrationMockFetch(jwk);
    const handler = createHandler(mockFetch);

    const request = new Request("https://oauth.tminus.dev/marketplace/uninstall", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `jwt=${encodeURIComponent(token)}`,
    });

    const response = await handler.fetch(request, env, mockCtx);

    // PROOF: 200 response
    expect(response.status).toBe(200);

    const body = await response.json() as Record<string, unknown>;

    // PROOF: individual uninstall type
    expect(body.type).toBe("individual");

    // PROOF: account was processed
    const accounts = body.accounts as Array<Record<string, unknown>>;
    expect(accounts.length).toBe(1);
    expect(accounts[0].account_id).toBe("acc_INTEG_IND_01");

    // PROOF: tokens were revoked
    expect(accounts[0].token_revoked).toBe(true);

    // PROOF: credentials were deleted (BR-1: GDPR mandatory)
    expect(accounts[0].credentials_deleted).toBe(true);

    // PROOF: sync was stopped
    expect(accounts[0].sync_stopped).toBe(true);

    // PROOF: D1 account status updated to revoked
    expect(d1._accounts[0].status).toBe("revoked");

    // PROOF: AccountDO calls made (get-token, delete-credentials, stop-sync)
    const doCalls = accountDO._calls.filter((c) => c.id === "acc_INTEG_IND_01");
    expect(doCalls.length).toBe(3);
    expect(doCalls[0].url).toContain("get-token");
    expect(doCalls[1].url).toContain("delete-credentials");
    expect(doCalls[2].url).toContain("stop-sync");

    // PROOF: audit log recorded (BR-4)
    expect(body.audit_id).toBeTruthy();
    expect(d1._auditLog.length).toBe(1);
    expect(d1._auditLog[0].event_type).toBe("individual");
    expect(d1._auditLog[0].identity_sub).toBe(TEST_GOOGLE_SUB);
  });
});

// ===========================================================================
// Integration Test 2: Org uninstall processes all org users
// ===========================================================================

describe("Integration: Org uninstall processes all org users", () => {
  it("end-to-end: POST with org JWT -> all org users cleaned up -> installation deactivated -> 200", async () => {
    const d1 = createIntegrationMockD1();
    const accountDO = createIntegrationMockAccountDO();

    // Set up org installation with multiple users
    d1._installations.push({
      install_id: "oin_INTEG_01",
      google_customer_id: TEST_CUSTOMER_ID,
      org_id: "org_INTEG_01",
      status: "active",
    });
    d1._users.push(
      { user_id: "usr_O_01", org_id: "org_INTEG_01", email: "alice@acme.dev" },
      { user_id: "usr_O_02", org_id: "org_INTEG_01", email: "bob@acme.dev" },
      { user_id: "usr_O_03", org_id: "org_INTEG_01", email: "carol@acme.dev" },
    );
    d1._accounts.push(
      {
        account_id: "acc_O_01",
        user_id: "usr_O_01",
        provider: "google",
        provider_subject: "sub-alice",
        email: "alice@acme.dev",
        status: "active",
      },
      {
        account_id: "acc_O_02",
        user_id: "usr_O_02",
        provider: "google",
        provider_subject: "sub-bob",
        email: "bob@acme.dev",
        status: "active",
      },
      {
        account_id: "acc_O_03",
        user_id: "usr_O_03",
        provider: "google",
        provider_subject: "sub-carol",
        email: "carol@acme.dev",
        status: "active",
      },
    );

    const env = createIntegrationMockEnv({ d1, accountDO });

    // Create JWT with customer_id (org-level uninstall)
    const jwk = await exportTestPublicKeyJWK(testKeyPair.publicKey, testKid);
    const now = Math.floor(Date.now() / 1000);
    const token = await createTestJWT(
      {
        iss: "Google Workspace Marketplace",
        aud: TEST_CLIENT_ID,
        customer_id: TEST_CUSTOMER_ID,
        event_type: "uninstall",
        iat: now,
        exp: now + 300,
      },
      testKeyPair,
      testKid,
    );

    const mockFetch = createIntegrationMockFetch(jwk);
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

    // PROOF: all 3 org users' accounts were processed
    const accounts = body.accounts as Array<Record<string, unknown>>;
    expect(accounts.length).toBe(3);
    const accountIds = accounts.map((a) => a.account_id);
    expect(accountIds).toContain("acc_O_01");
    expect(accountIds).toContain("acc_O_02");
    expect(accountIds).toContain("acc_O_03");

    // PROOF: all credentials deleted (BR-1)
    for (const acct of accounts) {
      expect(acct.credentials_deleted).toBe(true);
    }

    // PROOF: all D1 accounts revoked
    expect(d1._accounts[0].status).toBe("revoked");
    expect(d1._accounts[1].status).toBe("revoked");
    expect(d1._accounts[2].status).toBe("revoked");

    // PROOF: org installation deactivated
    expect(d1._installations[0].status).toBe("inactive");

    // PROOF: audit log recorded with customer_id (BR-4)
    expect(d1._auditLog.length).toBe(1);
    expect(d1._auditLog[0].identity_customer_id).toBe(TEST_CUSTOMER_ID);
  });
});

// ===========================================================================
// Integration Test 3: Partial failure -- token revocation fails, cleanup continues
// ===========================================================================

describe("Integration: Partial failure (token revocation fails) still completes credential cleanup", () => {
  it("token revocation returns 500 but credentials are still deleted (BR-2 + BR-1)", async () => {
    const d1 = createIntegrationMockD1();
    const accountDO = createIntegrationMockAccountDO();
    d1._accounts.push({
      account_id: "acc_PARTIAL_01",
      user_id: "usr_PARTIAL_01",
      provider: "google",
      provider_subject: TEST_GOOGLE_SUB,
      email: TEST_EMAIL,
      status: "active",
    });

    const env = createIntegrationMockEnv({ d1, accountDO });

    const jwk = await exportTestPublicKeyJWK(testKeyPair.publicKey, testKid);
    const now = Math.floor(Date.now() / 1000);
    const token = await createTestJWT(
      {
        iss: "Google Workspace Marketplace",
        aud: TEST_CLIENT_ID,
        sub: TEST_GOOGLE_SUB,
        email: TEST_EMAIL,
        event_type: "uninstall",
        iat: now,
        exp: now + 300,
      },
      testKeyPair,
      testKid,
    );

    // Token revocation returns 500 (Google API down)
    const mockFetch = createIntegrationMockFetch(jwk, { revokeStatus: 500 });
    const handler = createHandler(mockFetch);

    const request = new Request("https://oauth.tminus.dev/marketplace/uninstall", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `jwt=${encodeURIComponent(token)}`,
    });

    const response = await handler.fetch(request, env, mockCtx);

    // PROOF: still returns 200 (uninstall completes despite partial failure)
    expect(response.status).toBe(200);

    const body = await response.json() as Record<string, unknown>;
    const accounts = body.accounts as Array<Record<string, unknown>>;
    expect(accounts.length).toBe(1);

    // PROOF: token revocation FAILED (BR-2: best-effort)
    expect(accounts[0].token_revoked).toBe(false);

    // PROOF: credentials STILL deleted (BR-1: mandatory, not blocked by revocation failure)
    expect(accounts[0].credentials_deleted).toBe(true);

    // PROOF: sync STILL stopped
    expect(accounts[0].sync_stopped).toBe(true);

    // PROOF: D1 account STILL marked as revoked
    expect(d1._accounts[0].status).toBe("revoked");

    // PROOF: audit log STILL recorded (BR-4)
    expect(d1._auditLog.length).toBe(1);
  });
});

// ===========================================================================
// Integration Test 4: Router wiring verification
// ===========================================================================

describe("Integration: Worker routing handles /marketplace/uninstall", () => {
  it("POST /marketplace/uninstall routes to uninstall handler", async () => {
    const env = createIntegrationMockEnv();
    const jwk = await exportTestPublicKeyJWK(testKeyPair.publicKey, testKid);
    const mockFetch = createIntegrationMockFetch(jwk);
    const handler = createHandler(mockFetch);

    // Invalid JWT will return 401 (proving the route exists and is handling POST)
    const request = new Request("https://oauth.tminus.dev/marketplace/uninstall", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "jwt=invalid.jwt.token",
    });

    const response = await handler.fetch(request, env, mockCtx);
    // 401 means we reached the handler (not 404 or 405)
    expect(response.status).toBe(401);
  });

  it("GET /marketplace/uninstall returns 405 (webhooks are POST-only)", async () => {
    const env = createIntegrationMockEnv();
    const handler = createHandler();

    const request = new Request("https://oauth.tminus.dev/marketplace/uninstall");
    const response = await handler.fetch(request, env, mockCtx);

    // GET to a POST-only webhook path returns 405 (path exists, wrong method)
    expect(response.status).toBe(405);
  });

  it("existing GET routes still work after adding POST uninstall route", async () => {
    const env = createIntegrationMockEnv();
    const handler = createHandler();

    // Health check still works
    const healthResp = await handler.fetch(
      new Request("https://oauth.tminus.dev/health"),
      env,
      mockCtx,
    );
    expect(healthResp.status).toBe(200);

    // Google start still works (returns 400 for missing user_id)
    const startResp = await handler.fetch(
      new Request("https://oauth.tminus.dev/oauth/google/start"),
      env,
      mockCtx,
    );
    expect(startResp.status).toBe(400);

    // Unknown paths still 404
    const unknownResp = await handler.fetch(
      new Request("https://oauth.tminus.dev/unknown"),
      env,
      mockCtx,
    );
    expect(unknownResp.status).toBe(404);
  });

  it("PUT to /marketplace/uninstall returns 405 (method not allowed)", async () => {
    const env = createIntegrationMockEnv();
    const handler = createHandler();

    const request = new Request("https://oauth.tminus.dev/marketplace/uninstall", {
      method: "PUT",
    });
    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(405);
  });
});

// ===========================================================================
// Integration Test 5: Idempotent uninstall
// ===========================================================================

describe("Integration: Idempotent uninstall (duplicate webhooks handled safely)", () => {
  it("processing same individual uninstall webhook twice succeeds both times", async () => {
    const d1 = createIntegrationMockD1();
    const accountDO = createIntegrationMockAccountDO();
    d1._accounts.push({
      account_id: "acc_IDEMP_INTEG_01",
      user_id: "usr_IDEMP_01",
      provider: "google",
      provider_subject: TEST_GOOGLE_SUB,
      email: TEST_EMAIL,
      status: "active",
    });

    const env = createIntegrationMockEnv({ d1, accountDO });

    const jwk = await exportTestPublicKeyJWK(testKeyPair.publicKey, testKid);
    const now = Math.floor(Date.now() / 1000);
    const token = await createTestJWT(
      {
        iss: "Google Workspace Marketplace",
        aud: TEST_CLIENT_ID,
        sub: TEST_GOOGLE_SUB,
        email: TEST_EMAIL,
        event_type: "uninstall",
        iat: now,
        exp: now + 300,
      },
      testKeyPair,
      testKid,
    );

    const mockFetch = createIntegrationMockFetch(jwk);
    const handler = createHandler(mockFetch);

    // First webhook
    const request1 = new Request("https://oauth.tminus.dev/marketplace/uninstall", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `jwt=${encodeURIComponent(token)}`,
    });
    const response1 = await handler.fetch(request1, env, mockCtx);

    // PROOF: first call succeeds
    expect(response1.status).toBe(200);
    const body1 = await response1.json() as Record<string, unknown>;
    expect((body1.accounts as unknown[]).length).toBe(1);

    // Second webhook (duplicate)
    const request2 = new Request("https://oauth.tminus.dev/marketplace/uninstall", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `jwt=${encodeURIComponent(token)}`,
    });
    const response2 = await handler.fetch(request2, env, mockCtx);

    // PROOF: second call also succeeds (idempotent)
    expect(response2.status).toBe(200);
    const body2 = await response2.json() as Record<string, unknown>;
    // Account still found (we query by provider_subject, not status)
    // but re-processing is safe
    expect((body2.accounts as unknown[]).length).toBe(1);
  });
});
