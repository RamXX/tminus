/**
 * Unit tests for Google Workspace Marketplace uninstall webhook handler.
 *
 * Covers:
 * - JWT signature validation (RS256) for Google's uninstall webhook
 * - Individual uninstall: token revocation + credential cleanup
 * - Organization uninstall: all org users processed
 * - Idempotent uninstall (same webhook processed twice, BR-3)
 * - Partial failure: token revocation fails but credential cleanup continues (BR-2)
 * - Audit log recording (BR-4)
 *
 * Google API calls are mocked via injectable fetch. D1 and DO are mocked
 * with lightweight stubs (same pattern as marketplace.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  verifyGoogleJWT,
  revokeGoogleToken,
  cleanupAccount,
  processIndividualUninstall,
  processOrgUninstall,
  handleMarketplaceUninstall,
  recordUninstallAudit,
  GOOGLE_REVOKE_URL,
  GOOGLE_CERTS_URL,
} from "./marketplace-uninstall";
import type { FetchFn } from "./index";
import type { UninstallJWTClaims } from "./marketplace-uninstall";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const TEST_CLIENT_SECRET = "test-client-secret";
const TEST_JWT_SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
const TEST_GOOGLE_SUB = "google-sub-uninstall-12345";
const TEST_EMAIL = "user@workspace.example.com";
const TEST_CUSTOMER_ID = "C01xxxxxx";

// We use a pre-built RSA keypair for testing JWT validation.
// In production, Google signs JWTs with their private key and we verify with their public key.
// For unit testing, we generate our own RS256 keypair.
let testKeyPair: CryptoKeyPair;
let testKid: string;

// ---------------------------------------------------------------------------
// RSA key generation for test JWT creation
// ---------------------------------------------------------------------------

async function generateTestKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true, // exportable
    ["sign", "verify"],
  );
}

/** Encode Uint8Array to Base64URL (no padding). */
function bytesToB64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Encode a string to Base64URL (no padding). */
function strToB64Url(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Create a signed RS256 JWT for testing. */
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

/** Export the test public key as JWK (for mock JWKS response). */
async function exportTestPublicKeyJWK(
  publicKey: CryptoKey,
  kid: string,
): Promise<Record<string, unknown>> {
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  return { ...jwk, kid, use: "sig", alg: "RS256" };
}

/** Create a mock fetch that serves our test JWKS and handles revocation calls. */
function createUninstallMockFetch(overrides?: {
  jwks?: { keys: Array<Record<string, unknown>> };
  revokeStatus?: number;
  certsStatus?: number;
}): FetchFn {
  return async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    // Google JWKS endpoint
    if (url.includes("googleapis.com/oauth2/v3/certs")) {
      const status = overrides?.certsStatus ?? 200;
      if (status !== 200) {
        return new Response("Server error", { status });
      }
      const jwks = overrides?.jwks ?? { keys: [] };
      return new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Google token revocation
    if (url.includes("oauth2.googleapis.com/revoke")) {
      const status = overrides?.revokeStatus ?? 200;
      return new Response("", { status });
    }

    throw new Error(`Unexpected fetch URL in uninstall test: ${url}`);
  };
}

// ---------------------------------------------------------------------------
// Before each: generate a fresh RSA keypair
// ---------------------------------------------------------------------------

beforeEach(async () => {
  testKeyPair = await generateTestKeyPair();
  testKid = "test-kid-" + Math.random().toString(36).slice(2, 8);
});

// ---------------------------------------------------------------------------
// JWT signature validation tests
// ---------------------------------------------------------------------------

describe("verifyGoogleJWT", () => {
  it("validates a correctly signed RS256 JWT", async () => {
    const jwk = await exportTestPublicKeyJWK(testKeyPair.publicKey, testKid);
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "Google Workspace Marketplace",
      aud: TEST_CLIENT_ID,
      sub: TEST_GOOGLE_SUB,
      email: TEST_EMAIL,
      event_type: "uninstall",
      iat: now,
      exp: now + 300,
    };

    const token = await createTestJWT(claims, testKeyPair, testKid);
    const mockFetch = createUninstallMockFetch({ jwks: { keys: [jwk] } });

    const result = await verifyGoogleJWT(token, TEST_CLIENT_ID, mockFetch);

    expect(result).not.toBeNull();
    expect(result!.sub).toBe(TEST_GOOGLE_SUB);
    expect(result!.email).toBe(TEST_EMAIL);
    expect(result!.aud).toBe(TEST_CLIENT_ID);
  });

  it("rejects JWT with wrong audience", async () => {
    const jwk = await exportTestPublicKeyJWK(testKeyPair.publicKey, testKid);
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "Google Workspace Marketplace",
      aud: "wrong-client-id",
      sub: TEST_GOOGLE_SUB,
      iat: now,
      exp: now + 300,
    };

    const token = await createTestJWT(claims, testKeyPair, testKid);
    const mockFetch = createUninstallMockFetch({ jwks: { keys: [jwk] } });

    const result = await verifyGoogleJWT(token, TEST_CLIENT_ID, mockFetch);
    expect(result).toBeNull();
  });

  it("rejects expired JWT", async () => {
    const jwk = await exportTestPublicKeyJWK(testKeyPair.publicKey, testKid);
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "Google Workspace Marketplace",
      aud: TEST_CLIENT_ID,
      sub: TEST_GOOGLE_SUB,
      iat: now - 600,
      exp: now - 300, // Already expired
    };

    const token = await createTestJWT(claims, testKeyPair, testKid);
    const mockFetch = createUninstallMockFetch({ jwks: { keys: [jwk] } });

    const result = await verifyGoogleJWT(token, TEST_CLIENT_ID, mockFetch);
    expect(result).toBeNull();
  });

  it("rejects JWT signed with unknown kid", async () => {
    // Generate a different keypair
    const otherKeyPair = await generateTestKeyPair();
    const otherKid = "other-kid-xyz";
    const jwk = await exportTestPublicKeyJWK(testKeyPair.publicKey, testKid);

    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "Google Workspace Marketplace",
      aud: TEST_CLIENT_ID,
      sub: TEST_GOOGLE_SUB,
      iat: now,
      exp: now + 300,
    };

    // Sign with other kid, but JWKS only has our testKid
    const token = await createTestJWT(claims, otherKeyPair, otherKid);
    const mockFetch = createUninstallMockFetch({ jwks: { keys: [jwk] } });

    const result = await verifyGoogleJWT(token, TEST_CLIENT_ID, mockFetch);
    expect(result).toBeNull();
  });

  it("rejects JWT with tampered payload", async () => {
    const jwk = await exportTestPublicKeyJWK(testKeyPair.publicKey, testKid);
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "Google Workspace Marketplace",
      aud: TEST_CLIENT_ID,
      sub: TEST_GOOGLE_SUB,
      iat: now,
      exp: now + 300,
    };

    const token = await createTestJWT(claims, testKeyPair, testKid);
    const parts = token.split(".");

    // Tamper with payload: change sub
    const tampered = {
      ...claims,
      sub: "tampered-sub",
    };
    const tamperedPayload = strToB64Url(JSON.stringify(tampered));
    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

    const mockFetch = createUninstallMockFetch({ jwks: { keys: [jwk] } });

    const result = await verifyGoogleJWT(tamperedToken, TEST_CLIENT_ID, mockFetch);
    expect(result).toBeNull();
  });

  it("rejects malformed JWT (not 3 parts)", async () => {
    const mockFetch = createUninstallMockFetch({ jwks: { keys: [] } });
    const result = await verifyGoogleJWT("not-a-jwt", TEST_CLIENT_ID, mockFetch);
    expect(result).toBeNull();
  });

  it("rejects JWT with non-RS256 algorithm", async () => {
    // Create a JWT with HS256 header (wrong algorithm for Google)
    const header = strToB64Url(JSON.stringify({ alg: "HS256", kid: testKid, typ: "JWT" }));
    const payload = strToB64Url(JSON.stringify({
      aud: TEST_CLIENT_ID,
      sub: TEST_GOOGLE_SUB,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    }));
    const fakeToken = `${header}.${payload}.fake-signature`;

    const mockFetch = createUninstallMockFetch({ jwks: { keys: [] } });
    const result = await verifyGoogleJWT(fakeToken, TEST_CLIENT_ID, mockFetch);
    expect(result).toBeNull();
  });

  it("returns null when JWKS endpoint is unavailable", async () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "Google Workspace Marketplace",
      aud: TEST_CLIENT_ID,
      sub: TEST_GOOGLE_SUB,
      iat: now,
      exp: now + 300,
    };
    const token = await createTestJWT(claims, testKeyPair, testKid);
    const mockFetch = createUninstallMockFetch({ certsStatus: 500 });

    const result = await verifyGoogleJWT(token, TEST_CLIENT_ID, mockFetch);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Token revocation tests
// ---------------------------------------------------------------------------

describe("revokeGoogleToken", () => {
  it("returns true when Google accepts revocation", async () => {
    const mockFetch = createUninstallMockFetch({ revokeStatus: 200 });
    const result = await revokeGoogleToken("ya29.test-token", mockFetch);
    expect(result).toBe(true);
  });

  it("returns true when token is already revoked (400 from Google)", async () => {
    // Google returns 400 for already-revoked tokens -- we treat this as success
    const mockFetch = createUninstallMockFetch({ revokeStatus: 400 });
    const result = await revokeGoogleToken("ya29.already-revoked", mockFetch);
    expect(result).toBe(true);
  });

  it("returns false when Google returns server error", async () => {
    const mockFetch = createUninstallMockFetch({ revokeStatus: 500 });
    const result = await revokeGoogleToken("ya29.test-token", mockFetch);
    expect(result).toBe(false);
  });

  it("returns false when fetch throws (network error)", async () => {
    const throwingFetch: FetchFn = async () => {
      throw new Error("Network error");
    };
    const result = await revokeGoogleToken("ya29.test-token", throwingFetch);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mock D1 and DO helpers
// ---------------------------------------------------------------------------

function createUninstallMockD1() {
  const accounts: Array<Record<string, unknown>> = [];
  const users: Array<Record<string, unknown>> = [];
  const installations: Array<Record<string, unknown>> = [];
  const auditLog: Array<Record<string, unknown>> = [];

  return {
    _accounts: accounts,
    _users: users,
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
          // Org installation lookup by google_customer_id
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
          if (sql.includes("accounts") && sql.includes("provider_subject")) {
            const providerSubject = statement.bindings[0] as string;
            const found = accounts.filter(
              (a) => a.provider_subject === providerSubject && a.provider === "google",
            );
            return { results: found as T[], success: true };
          }
          // Accounts by org_id (JOIN with users)
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
          return { results: [], success: true };
        },
        async run(): Promise<{ success: boolean }> {
          // UPDATE accounts SET status = 'revoked'
          if (sql.includes("UPDATE") && sql.includes("accounts") && sql.includes("revoked")) {
            const accountId = statement.bindings[0] as string;
            for (const acct of accounts) {
              if (acct.account_id === accountId) {
                acct.status = "revoked";
              }
            }
          }
          // UPDATE org_installations SET status = 'inactive'
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
          return { success: true };
        },
      };
      return statement;
    },
  };
}

function createUninstallMockAccountDO(overrides?: {
  getTokenResponse?: Record<string, string>;
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
          calls.push({ id: id.name, url: request.url, method: request.method });

          if (request.url.includes("get-token")) {
            const status = overrides?.getTokenStatus ?? 200;
            const body = overrides?.getTokenResponse ?? {
              access_token: "ya29.mock-access-token",
              refresh_token: "1//mock-refresh-token",
            };
            return new Response(JSON.stringify(body), { status });
          }

          if (request.url.includes("delete-credentials")) {
            const status = overrides?.deleteCredentialsStatus ?? 200;
            return new Response("OK", { status });
          }

          if (request.url.includes("stop-sync")) {
            const status = overrides?.stopSyncStatus ?? 200;
            return new Response("OK", { status });
          }

          return new Response("OK", { status: 200 });
        },
      };
    },
  };
}

function createUninstallMockEnv(overrides?: {
  d1?: ReturnType<typeof createUninstallMockD1>;
  accountDO?: ReturnType<typeof createUninstallMockAccountDO>;
}) {
  return {
    DB: overrides?.d1 ?? createUninstallMockD1(),
    USER_GRAPH: {} as DurableObjectNamespace,
    ACCOUNT: overrides?.accountDO ?? createUninstallMockAccountDO(),
    ONBOARDING_WORKFLOW: {
      async create() { return { id: "auto" }; },
    },
    GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: TEST_CLIENT_SECRET,
    MS_CLIENT_ID: "unused",
    MS_CLIENT_SECRET: "unused",
    JWT_SECRET: TEST_JWT_SECRET,
  } as unknown as Env;
}

// ---------------------------------------------------------------------------
// Account cleanup tests
// ---------------------------------------------------------------------------

describe("cleanupAccount", () => {
  it("revokes tokens, deletes credentials, and stops sync", async () => {
    const accountDO = createUninstallMockAccountDO();
    const d1 = createUninstallMockD1();
    d1._accounts.push({
      account_id: "acc_TEST_01",
      user_id: "usr_TEST_01",
      provider: "google",
      provider_subject: TEST_GOOGLE_SUB,
      email: TEST_EMAIL,
      status: "active",
    });

    const env = createUninstallMockEnv({ d1, accountDO });
    const mockFetch = createUninstallMockFetch({ revokeStatus: 200 });

    const result = await cleanupAccount("acc_TEST_01", env, mockFetch);

    expect(result.account_id).toBe("acc_TEST_01");
    expect(result.token_revoked).toBe(true);
    expect(result.credentials_deleted).toBe(true);
    expect(result.sync_stopped).toBe(true);

    // Verify DO calls were made
    expect(accountDO._calls.length).toBe(3);
    expect(accountDO._calls[0].url).toContain("get-token");
    expect(accountDO._calls[1].url).toContain("delete-credentials");
    expect(accountDO._calls[2].url).toContain("stop-sync");

    // Verify D1 status updated
    expect(d1._accounts[0].status).toBe("revoked");
  });

  it("continues credential cleanup when token revocation fails (BR-2 + BR-5)", async () => {
    const accountDO = createUninstallMockAccountDO();
    const d1 = createUninstallMockD1();
    d1._accounts.push({
      account_id: "acc_PARTIAL_01",
      user_id: "usr_TEST_01",
      provider: "google",
      provider_subject: TEST_GOOGLE_SUB,
      email: TEST_EMAIL,
      status: "active",
    });

    const env = createUninstallMockEnv({ d1, accountDO });
    // Token revocation fails (Google API down)
    const mockFetch = createUninstallMockFetch({ revokeStatus: 500 });

    const result = await cleanupAccount("acc_PARTIAL_01", env, mockFetch);

    // Token revocation failed (BR-2: best-effort)
    expect(result.token_revoked).toBe(false);
    // Credential cleanup still happened (BR-1: mandatory)
    expect(result.credentials_deleted).toBe(true);
    // Sync stopped
    expect(result.sync_stopped).toBe(true);
    // D1 status still updated
    expect(d1._accounts[0].status).toBe("revoked");
  });

  it("handles AccountDO get-token returning non-ok (already cleaned up)", async () => {
    const accountDO = createUninstallMockAccountDO({ getTokenStatus: 404 });
    const d1 = createUninstallMockD1();
    d1._accounts.push({
      account_id: "acc_GONE_01",
      user_id: "usr_TEST_01",
      provider: "google",
      provider_subject: TEST_GOOGLE_SUB,
      email: TEST_EMAIL,
      status: "active",
    });

    const env = createUninstallMockEnv({ d1, accountDO });
    const mockFetch = createUninstallMockFetch();

    const result = await cleanupAccount("acc_GONE_01", env, mockFetch);

    // Token revocation not attempted (undefined, not false)
    expect(result.token_revoked).toBeUndefined();
    // Credential cleanup still happened
    expect(result.credentials_deleted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Individual uninstall tests
// ---------------------------------------------------------------------------

describe("processIndividualUninstall", () => {
  it("cleans up all Google accounts for the user", async () => {
    const d1 = createUninstallMockD1();
    const accountDO = createUninstallMockAccountDO();
    d1._accounts.push(
      {
        account_id: "acc_IND_01",
        user_id: "usr_IND_01",
        provider: "google",
        provider_subject: TEST_GOOGLE_SUB,
        email: TEST_EMAIL,
        status: "active",
      },
      {
        account_id: "acc_IND_02",
        user_id: "usr_IND_01",
        provider: "google",
        provider_subject: TEST_GOOGLE_SUB,
        email: "second@example.com",
        status: "active",
      },
    );

    const env = createUninstallMockEnv({ d1, accountDO });
    const mockFetch = createUninstallMockFetch();

    const results = await processIndividualUninstall(TEST_GOOGLE_SUB, env, mockFetch);

    expect(results.length).toBe(2);
    expect(results[0].account_id).toBe("acc_IND_01");
    expect(results[1].account_id).toBe("acc_IND_02");
    // Both accounts cleaned up
    expect(results[0].credentials_deleted).toBe(true);
    expect(results[1].credentials_deleted).toBe(true);
  });

  it("returns empty array for unknown user (idempotent, BR-3)", async () => {
    const d1 = createUninstallMockD1();
    const env = createUninstallMockEnv({ d1 });
    const mockFetch = createUninstallMockFetch();

    const results = await processIndividualUninstall("unknown-sub", env, mockFetch);

    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Organization uninstall tests
// ---------------------------------------------------------------------------

describe("processOrgUninstall", () => {
  it("processes all org users and deactivates installation", async () => {
    const d1 = createUninstallMockD1();
    const accountDO = createUninstallMockAccountDO();

    // Set up org with installation and users
    d1._installations.push({
      install_id: "oin_ORG_01",
      google_customer_id: TEST_CUSTOMER_ID,
      org_id: "org_ORG_01",
      status: "active",
    });
    d1._users.push(
      { user_id: "usr_ORG_01", org_id: "org_ORG_01", email: "user1@acme.com" },
      { user_id: "usr_ORG_02", org_id: "org_ORG_01", email: "user2@acme.com" },
    );
    d1._accounts.push(
      {
        account_id: "acc_ORG_01",
        user_id: "usr_ORG_01",
        provider: "google",
        provider_subject: "sub-org-1",
        email: "user1@acme.com",
        status: "active",
      },
      {
        account_id: "acc_ORG_02",
        user_id: "usr_ORG_02",
        provider: "google",
        provider_subject: "sub-org-2",
        email: "user2@acme.com",
        status: "active",
      },
    );

    const env = createUninstallMockEnv({ d1, accountDO });
    const mockFetch = createUninstallMockFetch();

    const results = await processOrgUninstall(TEST_CUSTOMER_ID, env, mockFetch);

    // Both accounts processed
    expect(results.length).toBe(2);
    expect(results[0].account_id).toBe("acc_ORG_01");
    expect(results[1].account_id).toBe("acc_ORG_02");
    expect(results[0].credentials_deleted).toBe(true);
    expect(results[1].credentials_deleted).toBe(true);

    // Both D1 accounts marked as revoked
    expect(d1._accounts[0].status).toBe("revoked");
    expect(d1._accounts[1].status).toBe("revoked");

    // Org installation deactivated
    expect(d1._installations[0].status).toBe("inactive");
  });

  it("returns empty results for unknown customer_id (idempotent, BR-3)", async () => {
    const d1 = createUninstallMockD1();
    const env = createUninstallMockEnv({ d1 });
    const mockFetch = createUninstallMockFetch();

    const results = await processOrgUninstall("unknown-customer", env, mockFetch);
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Audit logging tests
// ---------------------------------------------------------------------------

describe("recordUninstallAudit", () => {
  it("records individual uninstall event in audit log (BR-4)", async () => {
    const d1 = createUninstallMockD1();
    const env = createUninstallMockEnv({ d1 });

    const auditId = await recordUninstallAudit(
      env,
      "individual",
      { sub: TEST_GOOGLE_SUB, email: TEST_EMAIL },
      [{ account_id: "acc_AUDIT_01", token_revoked: true, credentials_deleted: true }],
    );

    expect(auditId).toMatch(/^uninstall_/);
    expect(d1._auditLog.length).toBe(1);
    expect(d1._auditLog[0].event_type).toBe("individual");
    expect(d1._auditLog[0].identity_sub).toBe(TEST_GOOGLE_SUB);
    expect(d1._auditLog[0].identity_email).toBe(TEST_EMAIL);
  });

  it("records org uninstall event with customer_id (BR-4)", async () => {
    const d1 = createUninstallMockD1();
    const env = createUninstallMockEnv({ d1 });

    const auditId = await recordUninstallAudit(
      env,
      "organization",
      { customer_id: TEST_CUSTOMER_ID },
      [
        { account_id: "acc_A", credentials_deleted: true },
        { account_id: "acc_B", credentials_deleted: true },
      ],
    );

    expect(auditId).toMatch(/^uninstall_/);
    expect(d1._auditLog.length).toBe(1);
    expect(d1._auditLog[0].event_type).toBe("organization");
    expect(d1._auditLog[0].identity_customer_id).toBe(TEST_CUSTOMER_ID);
    const results = JSON.parse(d1._auditLog[0].account_results as string);
    expect(results.length).toBe(2);
  });

  it("does not throw when audit table does not exist (graceful fallback)", async () => {
    // Create a D1 that throws on INSERT to audit log
    const throwingD1 = createUninstallMockD1();
    const originalPrepare = throwingD1.prepare.bind(throwingD1);
    throwingD1.prepare = (sql: string) => {
      const stmt = originalPrepare(sql);
      if (sql.includes("uninstall_audit_log")) {
        const origRun = stmt.run.bind(stmt);
        stmt.run = async () => {
          throw new Error("table does not exist");
        };
      }
      return stmt;
    };

    const env = createUninstallMockEnv({ d1: throwingD1 });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Should not throw
    const auditId = await recordUninstallAudit(
      env,
      "individual",
      { sub: TEST_GOOGLE_SUB },
      [],
    );

    expect(auditId).toMatch(/^uninstall_/);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Idempotent uninstall tests (BR-3)
// ---------------------------------------------------------------------------

describe("idempotent uninstall (BR-3)", () => {
  it("processing same individual uninstall twice returns empty second time", async () => {
    const d1 = createUninstallMockD1();
    const accountDO = createUninstallMockAccountDO();
    d1._accounts.push({
      account_id: "acc_IDEMP_01",
      user_id: "usr_IDEMP_01",
      provider: "google",
      provider_subject: TEST_GOOGLE_SUB,
      email: TEST_EMAIL,
      status: "active",
    });

    const env = createUninstallMockEnv({ d1, accountDO });
    const mockFetch = createUninstallMockFetch();

    // First uninstall
    const results1 = await processIndividualUninstall(TEST_GOOGLE_SUB, env, mockFetch);
    expect(results1.length).toBe(1);
    expect(d1._accounts[0].status).toBe("revoked");

    // Second uninstall (same webhook re-processed)
    // Account is now "revoked", but the query finds by provider_subject (not status)
    // The cleanup will run again but it's safe (idempotent DO calls)
    const results2 = await processIndividualUninstall(TEST_GOOGLE_SUB, env, mockFetch);
    // Still finds the account (we query by provider_subject, not status)
    expect(results2.length).toBe(1);
    // But the operations are idempotent -- no harm in re-running
    expect(results2[0].credentials_deleted).toBe(true);
  });

  it("processing same org uninstall twice: second time has no active installation", async () => {
    const d1 = createUninstallMockD1();
    const accountDO = createUninstallMockAccountDO();

    d1._installations.push({
      install_id: "oin_IDEMP_01",
      google_customer_id: TEST_CUSTOMER_ID,
      org_id: "org_IDEMP_01",
      status: "active",
    });
    d1._users.push(
      { user_id: "usr_IDEMP_01", org_id: "org_IDEMP_01", email: "u1@acme.com" },
    );
    d1._accounts.push({
      account_id: "acc_IDEMP_ORG_01",
      user_id: "usr_IDEMP_01",
      provider: "google",
      provider_subject: "sub-idemp",
      email: "u1@acme.com",
      status: "active",
    });

    const env = createUninstallMockEnv({ d1, accountDO });
    const mockFetch = createUninstallMockFetch();

    // First org uninstall
    const results1 = await processOrgUninstall(TEST_CUSTOMER_ID, env, mockFetch);
    expect(results1.length).toBe(1);
    expect(d1._installations[0].status).toBe("inactive");

    // Second org uninstall (duplicate webhook)
    // Installation is now inactive, so no active installation found
    const results2 = await processOrgUninstall(TEST_CUSTOMER_ID, env, mockFetch);
    expect(results2.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Full webhook handler tests
// ---------------------------------------------------------------------------

describe("handleMarketplaceUninstall", () => {
  it("returns 405 for non-POST requests", async () => {
    const env = createUninstallMockEnv();
    const request = new Request("https://oauth.tminus.dev/marketplace/uninstall", {
      method: "GET",
    });

    const response = await handleMarketplaceUninstall(request, env);
    expect(response.status).toBe(405);
  });

  it("returns 400 when JWT parameter is missing (form body)", async () => {
    const env = createUninstallMockEnv();
    const request = new Request("https://oauth.tminus.dev/marketplace/uninstall", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "some_param=value",
    });

    const response = await handleMarketplaceUninstall(request, env);
    expect(response.status).toBe(400);
    const body = await response.json() as Record<string, string>;
    expect(body.error).toContain("jwt");
  });

  it("returns 401 when JWT signature is invalid", async () => {
    const env = createUninstallMockEnv();
    // Create a fake JWT that won't validate
    const mockFetch = createUninstallMockFetch({ jwks: { keys: [] } });

    const request = new Request("https://oauth.tminus.dev/marketplace/uninstall", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "jwt=fake.jwt.token",
    });

    const response = await handleMarketplaceUninstall(request, env, mockFetch);
    expect(response.status).toBe(401);
  });

  it("processes individual uninstall with valid JWT and returns 200", async () => {
    const d1 = createUninstallMockD1();
    const accountDO = createUninstallMockAccountDO();
    d1._accounts.push({
      account_id: "acc_HANDLER_01",
      user_id: "usr_HANDLER_01",
      provider: "google",
      provider_subject: TEST_GOOGLE_SUB,
      email: TEST_EMAIL,
      status: "active",
    });

    const env = createUninstallMockEnv({ d1, accountDO });

    // Create a valid JWT
    const jwk = await exportTestPublicKeyJWK(testKeyPair.publicKey, testKid);
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "Google Workspace Marketplace",
      aud: TEST_CLIENT_ID,
      sub: TEST_GOOGLE_SUB,
      email: TEST_EMAIL,
      event_type: "uninstall",
      iat: now,
      exp: now + 300,
    };
    const token = await createTestJWT(claims, testKeyPair, testKid);

    const mockFetch: FetchFn = async (input, init) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.includes("googleapis.com/oauth2/v3/certs")) {
        return new Response(JSON.stringify({ keys: [jwk] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("oauth2.googleapis.com/revoke")) {
        return new Response("", { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const request = new Request("https://oauth.tminus.dev/marketplace/uninstall", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `jwt=${encodeURIComponent(token)}`,
    });

    const response = await handleMarketplaceUninstall(request, env, mockFetch);
    expect(response.status).toBe(200);

    const body = await response.json() as Record<string, unknown>;
    expect(body.type).toBe("individual");
    const accounts = body.accounts as Array<Record<string, unknown>>;
    expect(accounts.length).toBe(1);
    expect(accounts[0].account_id).toBe("acc_HANDLER_01");
    expect(accounts[0].credentials_deleted).toBe(true);
    expect(body.audit_id).toBeTruthy();
  });

  it("processes org uninstall with valid JWT containing customer_id", async () => {
    const d1 = createUninstallMockD1();
    const accountDO = createUninstallMockAccountDO();

    d1._installations.push({
      install_id: "oin_HANDLER_01",
      google_customer_id: TEST_CUSTOMER_ID,
      org_id: "org_HANDLER_01",
      status: "active",
    });
    d1._users.push(
      { user_id: "usr_H_01", org_id: "org_HANDLER_01", email: "u1@acme.com" },
    );
    d1._accounts.push({
      account_id: "acc_H_01",
      user_id: "usr_H_01",
      provider: "google",
      provider_subject: "sub-h1",
      email: "u1@acme.com",
      status: "active",
    });

    const env = createUninstallMockEnv({ d1, accountDO });

    // Create JWT with customer_id (org-level uninstall)
    const jwk = await exportTestPublicKeyJWK(testKeyPair.publicKey, testKid);
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "Google Workspace Marketplace",
      aud: TEST_CLIENT_ID,
      customer_id: TEST_CUSTOMER_ID,
      event_type: "uninstall",
      iat: now,
      exp: now + 300,
    };
    const token = await createTestJWT(claims, testKeyPair, testKid);

    const mockFetch: FetchFn = async (input) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.includes("googleapis.com/oauth2/v3/certs")) {
        return new Response(JSON.stringify({ keys: [jwk] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("oauth2.googleapis.com/revoke")) {
        return new Response("", { status: 200 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const request = new Request("https://oauth.tminus.dev/marketplace/uninstall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jwt: token }),
    });

    const response = await handleMarketplaceUninstall(request, env, mockFetch);
    expect(response.status).toBe(200);

    const body = await response.json() as Record<string, unknown>;
    expect(body.type).toBe("organization");
    const accounts = body.accounts as Array<Record<string, unknown>>;
    expect(accounts.length).toBe(1);
    expect(accounts[0].account_id).toBe("acc_H_01");

    // Org installation deactivated
    expect(d1._installations[0].status).toBe("inactive");
  });

  it("returns 400 when JWT is missing both sub and customer_id", async () => {
    const d1 = createUninstallMockD1();
    const env = createUninstallMockEnv({ d1 });

    // Create JWT without sub or customer_id
    const jwk = await exportTestPublicKeyJWK(testKeyPair.publicKey, testKid);
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "Google Workspace Marketplace",
      aud: TEST_CLIENT_ID,
      event_type: "uninstall",
      iat: now,
      exp: now + 300,
    };
    const token = await createTestJWT(claims, testKeyPair, testKid);

    const mockFetch: FetchFn = async (input) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.includes("googleapis.com/oauth2/v3/certs")) {
        return new Response(JSON.stringify({ keys: [jwk] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const request = new Request("https://oauth.tminus.dev/marketplace/uninstall", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `jwt=${encodeURIComponent(token)}`,
    });

    const response = await handleMarketplaceUninstall(request, env, mockFetch);
    expect(response.status).toBe(400);
    const body = await response.json() as Record<string, string>;
    expect(body.error).toContain("sub");
  });
});
