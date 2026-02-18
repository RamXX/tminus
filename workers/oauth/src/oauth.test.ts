/**
 * Tests for tminus-oauth worker.
 *
 * Covers:
 * - PKCE generation (unit, real crypto)
 * - State encryption/decryption (unit, real crypto)
 * - /oauth/google/start handler
 * - /oauth/google/callback handler (all paths)
 *
 * Google API calls are mocked via injectable fetch. D1 and DO are mocked
 * with lightweight stubs that verify correct interactions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateCodeVerifier, generateCodeChallenge } from "./pkce";
import { encryptState, decryptState, type StatePayload } from "./state";
import { createHandler, type FetchFn } from "./index";
import { GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL, GOOGLE_SCOPES } from "./google";
import { MS_AUTH_URL, MS_TOKEN_URL, MS_USERINFO_URL, MS_SCOPES, MS_CALLBACK_PATH } from "./microsoft";
import { renderOAuthSuccessPage, handleOAuthSuccess } from "./oauth-success";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

// 32 bytes = 64 hex chars
const TEST_JWT_SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
const TEST_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const TEST_CLIENT_SECRET = "test-client-secret";
const TEST_MS_CLIENT_ID = "test-ms-client-id-00000000-0000-0000-0000-000000000000";
const TEST_MS_CLIENT_SECRET = "test-ms-client-secret";
const TEST_USER_ID = "usr_01HXY0000000000000000000AA";
const TEST_GOOGLE_SUB = "google-sub-12345";
const TEST_GOOGLE_EMAIL = "user@gmail.com";
const TEST_MS_SUB = "microsoft-oid-67890";
const TEST_MS_EMAIL = "user@outlook.com";
const TEST_AUTH_CODE = "4/0AbCdEfGhIjKlMnOpQrStUvWxYz";
const TEST_MS_AUTH_CODE = "M.C107_BAY.2.xxxxxxxx";

// ---------------------------------------------------------------------------
// PKCE unit tests (real crypto)
// ---------------------------------------------------------------------------

describe("PKCE", () => {
  describe("generateCodeVerifier", () => {
    it("produces a string of at least 43 characters", () => {
      const verifier = generateCodeVerifier();
      expect(verifier.length).toBeGreaterThanOrEqual(43);
    });

    it("produces only URL-safe characters (base64url)", () => {
      const verifier = generateCodeVerifier();
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("produces unique values on successive calls", () => {
      const v1 = generateCodeVerifier();
      const v2 = generateCodeVerifier();
      expect(v1).not.toBe(v2);
    });
  });

  describe("generateCodeChallenge", () => {
    it("produces a base64url-encoded SHA-256 hash", async () => {
      const verifier = "test-verifier-string-that-is-long-enough-for-pkce";
      const challenge = await generateCodeChallenge(verifier);

      // SHA-256 digest is 32 bytes => 43 base64url chars (no padding)
      expect(challenge.length).toBe(43);
      expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("is deterministic for the same input", async () => {
      const verifier = "deterministic-test-verifier";
      const c1 = await generateCodeChallenge(verifier);
      const c2 = await generateCodeChallenge(verifier);
      expect(c1).toBe(c2);
    });

    it("produces different challenges for different verifiers", async () => {
      const c1 = await generateCodeChallenge("verifier-one");
      const c2 = await generateCodeChallenge("verifier-two");
      expect(c1).not.toBe(c2);
    });

    it("matches known RFC 7636 Appendix B test vector", async () => {
      // RFC 7636 Appendix B:
      // code_verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
      // code_challenge (S256) = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
      const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
      const challenge = await generateCodeChallenge(verifier);
      expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    });
  });
});

// ---------------------------------------------------------------------------
// State encryption unit tests (real crypto)
// ---------------------------------------------------------------------------

describe("State encryption", () => {
  it("round-trips: encrypt then decrypt returns original payload", async () => {
    const state = await encryptState(
      TEST_JWT_SECRET,
      "test-code-verifier-1234567890abcdefghijklmnop",
      TEST_USER_ID,
      "https://app.example.com/done",
    );

    // State is a non-empty URL-safe string
    expect(state.length).toBeGreaterThan(0);
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);

    const payload = await decryptState(TEST_JWT_SECRET, state);
    expect(payload).not.toBeNull();
    expect(payload!.code_verifier).toBe("test-code-verifier-1234567890abcdefghijklmnop");
    expect(payload!.user_id).toBe(TEST_USER_ID);
    expect(payload!.redirect_uri).toBe("https://app.example.com/done");
    expect(payload!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("returns null for tampered state", async () => {
    const state = await encryptState(TEST_JWT_SECRET, "verifier", "user", "https://x.com");
    // Tamper with the ciphertext
    const tampered = state.slice(0, -3) + "xxx";
    const payload = await decryptState(TEST_JWT_SECRET, tampered);
    expect(payload).toBeNull();
  });

  it("returns null for wrong key", async () => {
    const state = await encryptState(TEST_JWT_SECRET, "verifier", "user", "https://x.com");
    const wrongKey = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const payload = await decryptState(wrongKey, state);
    expect(payload).toBeNull();
  });

  it("returns null for expired state", async () => {
    // Encrypt state, then time-travel past expiry
    const state = await encryptState(TEST_JWT_SECRET, "verifier", "user", "https://x.com");

    // Mock Date.now to be 6 minutes in the future (past 5 min TTL)
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60 * 1000;
    try {
      const payload = await decryptState(TEST_JWT_SECRET, state);
      expect(payload).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it("returns null for empty string", async () => {
    const payload = await decryptState(TEST_JWT_SECRET, "");
    expect(payload).toBeNull();
  });

  it("returns null for garbage input", async () => {
    const payload = await decryptState(TEST_JWT_SECRET, "not-valid-state-data");
    expect(payload).toBeNull();
  });

  it("produces unique ciphertexts for same input (random IV)", async () => {
    const s1 = await encryptState(TEST_JWT_SECRET, "v", "u", "https://x.com");
    const s2 = await encryptState(TEST_JWT_SECRET, "v", "u", "https://x.com");
    expect(s1).not.toBe(s2);
  });

  // TM-qt2f: Non-hex key support (base64 secrets, arbitrary strings)
  describe("non-hex key support (TM-qt2f)", () => {
    const BASE64_SECRET = "8LtWFEQU/GdWiTWQKredhwuJ6/Bn2HYV3XUzBYK8vNI=";

    it("round-trips with base64-encoded secret", async () => {
      const state = await encryptState(
        BASE64_SECRET,
        "pkce-verifier-for-base64-test",
        "usr_base64_test_user",
        "https://app.example.com/callback",
      );

      expect(state.length).toBeGreaterThan(0);
      expect(state).toMatch(/^[A-Za-z0-9_-]+$/);

      const payload = await decryptState(BASE64_SECRET, state);
      expect(payload).not.toBeNull();
      expect(payload!.code_verifier).toBe("pkce-verifier-for-base64-test");
      expect(payload!.user_id).toBe("usr_base64_test_user");
      expect(payload!.redirect_uri).toBe("https://app.example.com/callback");
      expect(payload!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it("returns null when decrypting with wrong non-hex key", async () => {
      const state = await encryptState(BASE64_SECRET, "v", "u", "https://x.com");
      const wrongKey = "wrong-base64-secret-value!=";
      const payload = await decryptState(wrongKey, state);
      expect(payload).toBeNull();
    });

    it("hex key and non-hex key produce different ciphertexts", async () => {
      // Ensure hex and non-hex paths use different derived keys
      const stateHex = await encryptState(TEST_JWT_SECRET, "v", "u", "https://x.com");
      const stateBase64 = await encryptState(BASE64_SECRET, "v", "u", "https://x.com");

      // They should not be decryptable with each other's key
      const crossDecrypt1 = await decryptState(TEST_JWT_SECRET, stateBase64);
      const crossDecrypt2 = await decryptState(BASE64_SECRET, stateHex);
      expect(crossDecrypt1).toBeNull();
      expect(crossDecrypt2).toBeNull();
    });

    it("handles arbitrary string as secret", async () => {
      const arbitrarySecret = "my-super-secret-password-that-is-not-hex";
      const state = await encryptState(
        arbitrarySecret,
        "verifier",
        "user_123",
        "https://done.example.com",
      );

      const payload = await decryptState(arbitrarySecret, state);
      expect(payload).not.toBeNull();
      expect(payload!.user_id).toBe("user_123");
    });
  });
});

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Create a minimal mock D1 database. */
function createMockD1() {
  const rows: Record<string, unknown[]> = {};

  return {
    _rows: rows,
    _statements: [] as Array<{ sql: string; bindings: unknown[] }>,

    prepare(sql: string) {
      const statement = {
        sql,
        bindings: [] as unknown[],
        bind(...args: unknown[]) {
          statement.bindings = args;
          return statement;
        },
        async all<T>(): Promise<{ results: T[]; success: boolean }> {
          // Record the call
          rows._lastQuery = { sql, bindings: statement.bindings } as unknown;

          // Simulate SELECT on accounts table
          if (sql.includes("SELECT") && sql.includes("accounts")) {
            const results = (rows["accounts"] || []) as T[];
            // Filter by provider_subject if in the query
            if (sql.includes("provider_subject")) {
              const providerSubject = statement.bindings[1];
              const filtered = results.filter(
                (r: any) => r.provider_subject === providerSubject,
              );
              return { results: filtered as T[], success: true };
            }
            return { results, success: true };
          }
          return { results: [], success: true };
        },
        async run(): Promise<{ success: boolean }> {
          // Record INSERT/UPDATE
          if (sql.includes("INSERT")) {
            if (!rows["accounts"]) rows["accounts"] = [];
            // Parse bindings into an account row
            if (sql.includes("accounts")) {
              // Detect provider from SQL literal or bindings
              let provider = "google";
              if (sql.includes("'microsoft'")) {
                provider = "microsoft";
              } else if (statement.bindings.length >= 5) {
                // Provider is a binding parameter (parameterized INSERT)
                provider = statement.bindings[2] as string;
              }
              const newRow = {
                account_id: statement.bindings[0],
                user_id: statement.bindings[1],
                provider,
                provider_subject: sql.includes("'microsoft'") ? statement.bindings[2] : statement.bindings[2],
                email: statement.bindings[3],
                status: "active",
              };
              // For parameterized INSERT with provider as binding
              if (statement.bindings.length >= 5) {
                newRow.provider_subject = statement.bindings[3] as string;
                newRow.email = statement.bindings[4] as string;
              }
              (rows["accounts"] as unknown[]).push(newRow);
            }
          }
          if (sql.includes("UPDATE")) {
            // Update status in existing rows
            const targetId = statement.bindings[statement.bindings.length - 1];
            const accts = (rows["accounts"] || []) as any[];
            for (const acct of accts) {
              if (acct.account_id === targetId) {
                acct.status = "active";
              }
            }
          }
          return { success: true };
        },
      };

      // Track all statements
      (rows as any)._statements = (rows as any)._statements || [];
      (rows as any)._statements.push(statement);

      return statement;
    },
  };
}

/** Create a minimal mock DO namespace. */
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

/** Create a minimal mock Workflow binding. */
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

/** Create a mock fetch that handles Google token and userinfo endpoints. */
function createMockGoogleFetch(overrides?: {
  tokenResponse?: Partial<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
    scope: string;
  }>;
  tokenStatus?: number;
  userInfoResponse?: Partial<{ sub: string; email: string; name: string }>;
  userInfoStatus?: number;
}): FetchFn {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes("oauth2.googleapis.com/token")) {
      const status = overrides?.tokenStatus ?? 200;
      if (status !== 200) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status });
      }
      return new Response(
        JSON.stringify({
          access_token: "ya29.mock-access-token",
          refresh_token: "1//mock-refresh-token",
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
          name: "Test User",
          ...overrides?.userInfoResponse,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };
}

/** Create a mock fetch that handles Microsoft token and userinfo endpoints. */
function createMockMicrosoftFetch(overrides?: {
  tokenResponse?: Partial<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
    scope: string;
  }>;
  tokenStatus?: number;
  tokenBody?: string; // Raw body string, for non-JSON error tests
  userInfoResponse?: Partial<{ id: string; mail: string; displayName: string; userPrincipalName: string }>;
  userInfoStatus?: number;
}): FetchFn {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes("login.microsoftonline.com") && url.includes("token")) {
      const status = overrides?.tokenStatus ?? 200;
      if (status !== 200) {
        const body = overrides?.tokenBody ?? JSON.stringify({ error: "invalid_grant" });
        return new Response(body, { status });
      }
      return new Response(
        JSON.stringify({
          access_token: "EwB0A8l6BAAURSN_mock_ms_access_token",
          refresh_token: "M.C107_BAY.2.mock_ms_refresh_token",
          expires_in: 3600,
          token_type: "Bearer",
          scope: MS_SCOPES,
          ...overrides?.tokenResponse,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.includes("graph.microsoft.com") && url.includes("/me")) {
      const status = overrides?.userInfoStatus ?? 200;
      if (status !== 200) {
        return new Response(JSON.stringify({ error: { code: "Unauthorized" } }), { status });
      }
      return new Response(
        JSON.stringify({
          id: TEST_MS_SUB,
          mail: TEST_MS_EMAIL,
          displayName: "Test MS User",
          userPrincipalName: TEST_MS_EMAIL,
          ...overrides?.userInfoResponse,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };
}

/** Build the mock Env. */
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

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

// ---------------------------------------------------------------------------
// /oauth/google/start tests
// ---------------------------------------------------------------------------

describe("GET /oauth/google/start", () => {
  it("redirects to Google with PKCE challenge and correct params", async () => {
    const env = createMockEnv();
    const handler = createHandler();

    const request = new Request(
      `https://oauth.tminus.dev/oauth/google/start?user_id=${TEST_USER_ID}`,
    );
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(302);
    const location = response.headers.get("Location")!;
    expect(location).toBeTruthy();

    const redirectUrl = new URL(location);
    expect(redirectUrl.origin + redirectUrl.pathname).toBe(GOOGLE_AUTH_URL);
    expect(redirectUrl.searchParams.get("client_id")).toBe(TEST_CLIENT_ID);
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
      "https://oauth.tminus.dev/oauth/google/callback",
    );
    expect(redirectUrl.searchParams.get("response_type")).toBe("code");
    expect(redirectUrl.searchParams.get("scope")).toBe(GOOGLE_SCOPES);
    expect(redirectUrl.searchParams.get("access_type")).toBe("offline");
    expect(redirectUrl.searchParams.get("prompt")).toBe("consent");
    expect(redirectUrl.searchParams.get("code_challenge_method")).toBe("S256");

    // Verify state and code_challenge are present and non-empty
    const state = redirectUrl.searchParams.get("state")!;
    const codeChallenge = redirectUrl.searchParams.get("code_challenge")!;
    expect(state.length).toBeGreaterThan(0);
    expect(codeChallenge.length).toBe(43); // SHA-256 => 32 bytes => 43 base64url chars
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);

    // Verify state is decryptable and contains user_id
    const payload = await decryptState(TEST_JWT_SECRET, state);
    expect(payload).not.toBeNull();
    expect(payload!.user_id).toBe(TEST_USER_ID);
    expect(payload!.code_verifier.length).toBeGreaterThanOrEqual(43);
  });

  it("uses custom redirect_uri when provided", async () => {
    const env = createMockEnv();
    const handler = createHandler();
    const customRedirect = "https://myapp.com/oauth/complete";

    const request = new Request(
      `https://oauth.tminus.dev/oauth/google/start?user_id=${TEST_USER_ID}&redirect_uri=${encodeURIComponent(customRedirect)}`,
    );
    const response = await handler.fetch(request, env, mockCtx);

    const location = response.headers.get("Location")!;
    const state = new URL(location).searchParams.get("state")!;
    const payload = await decryptState(TEST_JWT_SECRET, state);
    expect(payload!.redirect_uri).toBe(customRedirect);
  });

  it("uses default redirect_uri when not provided", async () => {
    const env = createMockEnv();
    const handler = createHandler();

    const request = new Request(
      `https://oauth.tminus.dev/oauth/google/start?user_id=${TEST_USER_ID}`,
    );
    const response = await handler.fetch(request, env, mockCtx);

    const location = response.headers.get("Location")!;
    const state = new URL(location).searchParams.get("state")!;
    const payload = await decryptState(TEST_JWT_SECRET, state);
    expect(payload!.redirect_uri).toBe("https://oauth.tminus.dev/oauth/google/done");
  });

  it("returns 400 when user_id is missing", async () => {
    const env = createMockEnv();
    const handler = createHandler();

    const request = new Request("https://oauth.tminus.dev/oauth/google/start");
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toContain("user_id");
  });
});

// ---------------------------------------------------------------------------
// /oauth/google/callback tests -- success paths
// ---------------------------------------------------------------------------

describe("GET /oauth/google/callback", () => {
  /** Helper: create a valid state for callback tests. */
  async function createValidState(userId?: string, redirectUri?: string) {
    const verifier = generateCodeVerifier();
    const state = await encryptState(
      TEST_JWT_SECRET,
      verifier,
      userId || TEST_USER_ID,
      redirectUri || "https://app.tminus.dev/done",
    );
    return { verifier, state };
  }

  describe("new account (happy path)", () => {
    it("exchanges code, creates D1 row, initializes AccountDO, starts workflow, redirects", async () => {
      const d1 = createMockD1();
      const accountDO = createMockAccountDO();
      const workflow = createMockWorkflow();
      const env = createMockEnv({ d1, accountDO, workflow });
      const mockFetch = createMockGoogleFetch();
      const handler = createHandler(mockFetch);

      const { state } = await createValidState();

      const request = new Request(
        `https://oauth.tminus.dev/oauth/google/callback?code=${TEST_AUTH_CODE}&state=${state}`,
      );
      const response = await handler.fetch(request, env, mockCtx);

      // Should redirect to success URL
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("Location")!);
      expect(location.origin + location.pathname).toBe("https://app.tminus.dev/done");
      const accountId = location.searchParams.get("account_id")!;
      expect(accountId).toMatch(/^acc_/); // Prefixed ULID

      // D1: account row was inserted
      const insertedAccounts = (d1._rows["accounts"] || []) as any[];
      expect(insertedAccounts.length).toBe(1);
      expect(insertedAccounts[0].user_id).toBe(TEST_USER_ID);
      expect(insertedAccounts[0].provider).toBe("google");
      expect(insertedAccounts[0].provider_subject).toBe(TEST_GOOGLE_SUB);
      expect(insertedAccounts[0].email).toBe(TEST_GOOGLE_EMAIL);

      // AccountDO: initialize was called with tokens
      expect(accountDO._calls.length).toBe(1);
      expect(accountDO._calls[0].url).toContain("initialize");
      const doBody = accountDO._calls[0].body as any;
      expect(doBody.tokens.access_token).toBe("ya29.mock-access-token");
      expect(doBody.tokens.refresh_token).toBe("1//mock-refresh-token");
      expect(doBody.tokens.expiry).toBeTruthy();
      expect(doBody.scopes).toBe(GOOGLE_SCOPES);

      // OnboardingWorkflow: was started
      expect(workflow._calls.length).toBe(1);
      expect(workflow._calls[0].params.account_id).toBe(accountId);
      expect(workflow._calls[0].params.user_id).toBe(TEST_USER_ID);
    });
  });

  describe("re-activation (same user)", () => {
    it("reuses existing account, refreshes tokens, skips workflow", async () => {
      const d1 = createMockD1();
      const accountDO = createMockAccountDO();
      const workflow = createMockWorkflow();
      const env = createMockEnv({ d1, accountDO, workflow });

      // Pre-populate: same user already linked this Google account
      d1._rows["accounts"] = [{
        account_id: "acc_EXISTING01",
        user_id: TEST_USER_ID,
        provider: "google",
        provider_subject: TEST_GOOGLE_SUB,
        email: "old@gmail.com",
        status: "revoked",
      }];

      const mockFetch = createMockGoogleFetch();
      const handler = createHandler(mockFetch);
      const { state } = await createValidState();

      const request = new Request(
        `https://oauth.tminus.dev/oauth/google/callback?code=${TEST_AUTH_CODE}&state=${state}`,
      );
      const response = await handler.fetch(request, env, mockCtx);

      // Should redirect with the existing account_id and reactivated flag
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("Location")!);
      expect(location.searchParams.get("account_id")).toBe("acc_EXISTING01");
      expect(location.searchParams.get("reactivated")).toBe("true");

      // AccountDO: initialize was called (to refresh tokens)
      expect(accountDO._calls.length).toBe(1);
      expect(accountDO._calls[0].id).toBe("acc_EXISTING01");

      // OnboardingWorkflow: was NOT started (existing account)
      expect(workflow._calls.length).toBe(0);
    });
  });

  describe("cross-user linking rejection", () => {
    it("returns 409 when Google account is linked to a different user", async () => {
      const d1 = createMockD1();
      const env = createMockEnv({ d1 });

      // Pre-populate: different user owns this Google account
      d1._rows["accounts"] = [{
        account_id: "acc_OTHER_USER",
        user_id: "usr_DIFFERENT_USER_0000000000AA",
        provider: "google",
        provider_subject: TEST_GOOGLE_SUB,
        email: "other@gmail.com",
        status: "active",
      }];

      const mockFetch = createMockGoogleFetch();
      const handler = createHandler(mockFetch);
      const { state } = await createValidState();

      const request = new Request(
        `https://oauth.tminus.dev/oauth/google/callback?code=${TEST_AUTH_CODE}&state=${state}`,
      );
      const response = await handler.fetch(request, env, mockCtx);

      expect(response.status).toBe(409);
      const body = await response.text();
      expect(body).toContain("already linked to another user");
    });
  });

  // -------------------------------------------------------------------------
  // Error paths
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("returns user-friendly message when Google consent is denied", async () => {
      const env = createMockEnv();
      const handler = createHandler();

      const request = new Request(
        "https://oauth.tminus.dev/oauth/google/callback?error=access_denied",
      );
      const response = await handler.fetch(request, env, mockCtx);

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("declined access");
    });

    it("returns error when state parameter is invalid/tampered", async () => {
      const env = createMockEnv();
      const handler = createHandler(createMockGoogleFetch());

      const request = new Request(
        `https://oauth.tminus.dev/oauth/google/callback?code=${TEST_AUTH_CODE}&state=tampered-state`,
      );
      const response = await handler.fetch(request, env, mockCtx);

      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain("Please try again");
    });

    it("returns error when state is expired", async () => {
      const env = createMockEnv();
      const handler = createHandler(createMockGoogleFetch());

      const { state } = await createValidState();

      // Time-travel 6 minutes
      const realNow = Date.now;
      Date.now = () => realNow() + 6 * 60 * 1000;
      try {
        const request = new Request(
          `https://oauth.tminus.dev/oauth/google/callback?code=${TEST_AUTH_CODE}&state=${state}`,
        );
        const response = await handler.fetch(request, env, mockCtx);

        expect(response.status).toBe(400);
        const body = await response.text();
        expect(body).toContain("Please try again");
      } finally {
        Date.now = realNow;
      }
    });

    it("returns 502 when token exchange fails", async () => {
      const env = createMockEnv();
      const mockFetch = createMockGoogleFetch({ tokenStatus: 400 });
      const handler = createHandler(mockFetch);

      const { state } = await createValidState();

      const request = new Request(
        `https://oauth.tminus.dev/oauth/google/callback?code=bad-code&state=${state}`,
      );
      const response = await handler.fetch(request, env, mockCtx);

      expect(response.status).toBe(502);
      const body = await response.text();
      expect(body).toContain("Something went wrong");
    });

    it("returns 502 when no refresh_token in response", async () => {
      const env = createMockEnv();
      const mockFetch = createMockGoogleFetch({
        tokenResponse: { refresh_token: undefined } as any,
      });
      const handler = createHandler(mockFetch);

      const { state } = await createValidState();

      const request = new Request(
        `https://oauth.tminus.dev/oauth/google/callback?code=${TEST_AUTH_CODE}&state=${state}`,
      );
      const response = await handler.fetch(request, env, mockCtx);

      expect(response.status).toBe(502);
    });

    it("returns 502 when userinfo fetch fails", async () => {
      const env = createMockEnv();
      const mockFetch = createMockGoogleFetch({ userInfoStatus: 401 });
      const handler = createHandler(mockFetch);

      const { state } = await createValidState();

      const request = new Request(
        `https://oauth.tminus.dev/oauth/google/callback?code=${TEST_AUTH_CODE}&state=${state}`,
      );
      const response = await handler.fetch(request, env, mockCtx);

      expect(response.status).toBe(502);
    });

    it("returns 400 when code is missing", async () => {
      const env = createMockEnv();
      const handler = createHandler();

      const request = new Request(
        "https://oauth.tminus.dev/oauth/google/callback?state=something",
      );
      const response = await handler.fetch(request, env, mockCtx);

      expect(response.status).toBe(400);
    });

    it("returns 400 when state is missing", async () => {
      const env = createMockEnv();
      const handler = createHandler();

      const request = new Request(
        `https://oauth.tminus.dev/oauth/google/callback?code=${TEST_AUTH_CODE}`,
      );
      const response = await handler.fetch(request, env, mockCtx);

      expect(response.status).toBe(400);
    });
  });
});

// ---------------------------------------------------------------------------
// Routing tests
// ---------------------------------------------------------------------------

describe("Worker routing", () => {
  it("returns 404 for unknown paths", async () => {
    const env = createMockEnv();
    const handler = createHandler();

    const request = new Request("https://oauth.tminus.dev/unknown");
    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(404);
  });

  it("returns 405 for non-GET methods", async () => {
    const env = createMockEnv();
    const handler = createHandler();

    const request = new Request("https://oauth.tminus.dev/oauth/google/start", {
      method: "POST",
    });
    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// /oauth/microsoft/start tests
// ---------------------------------------------------------------------------

describe("GET /oauth/microsoft/start", () => {
  it("redirects to Microsoft with correct params and scopes", async () => {
    const env = createMockEnv();
    const handler = createHandler();

    const request = new Request(
      `https://oauth.tminus.dev/oauth/microsoft/start?user_id=${TEST_USER_ID}`,
    );
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(302);
    const location = response.headers.get("Location")!;
    expect(location).toBeTruthy();

    const redirectUrl = new URL(location);
    expect(redirectUrl.origin + redirectUrl.pathname).toBe(MS_AUTH_URL);
    expect(redirectUrl.searchParams.get("client_id")).toBe(TEST_MS_CLIENT_ID);
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
      "https://oauth.tminus.dev/oauth/microsoft/callback",
    );
    expect(redirectUrl.searchParams.get("response_type")).toBe("code");
    expect(redirectUrl.searchParams.get("scope")).toBe(MS_SCOPES);
    expect(redirectUrl.searchParams.get("response_mode")).toBe("query");
    expect(redirectUrl.searchParams.get("prompt")).toBe("consent");

    // Verify state is present and decryptable
    const state = redirectUrl.searchParams.get("state")!;
    expect(state.length).toBeGreaterThan(0);
    const payload = await decryptState(TEST_JWT_SECRET, state);
    expect(payload).not.toBeNull();
    expect(payload!.user_id).toBe(TEST_USER_ID);
  });

  it("uses custom redirect_uri when provided", async () => {
    const env = createMockEnv();
    const handler = createHandler();
    const customRedirect = "https://myapp.com/ms-oauth/complete";

    const request = new Request(
      `https://oauth.tminus.dev/oauth/microsoft/start?user_id=${TEST_USER_ID}&redirect_uri=${encodeURIComponent(customRedirect)}`,
    );
    const response = await handler.fetch(request, env, mockCtx);

    const location = response.headers.get("Location")!;
    const state = new URL(location).searchParams.get("state")!;
    const payload = await decryptState(TEST_JWT_SECRET, state);
    expect(payload!.redirect_uri).toBe(customRedirect);
  });

  it("returns 400 when user_id is missing", async () => {
    const env = createMockEnv();
    const handler = createHandler();

    const request = new Request("https://oauth.tminus.dev/oauth/microsoft/start");
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toContain("user_id");
  });
});

// ---------------------------------------------------------------------------
// /oauth/microsoft/callback tests
// ---------------------------------------------------------------------------

describe("GET /oauth/microsoft/callback", () => {
  /** Helper: create a valid state for Microsoft callback tests. */
  async function createValidMsState(userId?: string, redirectUri?: string) {
    const state = await encryptState(
      TEST_JWT_SECRET,
      "not-used-for-ms", // Microsoft flow doesn't use PKCE code_verifier
      userId || TEST_USER_ID,
      redirectUri || "https://app.tminus.dev/done",
    );
    return { state };
  }

  describe("new account (happy path)", () => {
    it("exchanges code, creates D1 row with provider=microsoft, initializes AccountDO, starts workflow, redirects", async () => {
      const d1 = createMockD1();
      const accountDO = createMockAccountDO();
      const workflow = createMockWorkflow();
      const env = createMockEnv({ d1, accountDO, workflow });
      const mockFetch = createMockMicrosoftFetch();
      const handler = createHandler(mockFetch);

      const { state } = await createValidMsState();

      const request = new Request(
        `https://oauth.tminus.dev/oauth/microsoft/callback?code=${TEST_MS_AUTH_CODE}&state=${state}`,
      );
      const response = await handler.fetch(request, env, mockCtx);

      // Should redirect to success URL
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("Location")!);
      expect(location.origin + location.pathname).toBe("https://app.tminus.dev/done");
      const accountId = location.searchParams.get("account_id")!;
      expect(accountId).toMatch(/^acc_/); // Prefixed ULID

      // D1: account row was inserted with provider=microsoft
      const insertedAccounts = (d1._rows["accounts"] || []) as any[];
      expect(insertedAccounts.length).toBe(1);
      expect(insertedAccounts[0].user_id).toBe(TEST_USER_ID);
      expect(insertedAccounts[0].provider).toBe("microsoft");
      expect(insertedAccounts[0].provider_subject).toBe(TEST_MS_SUB);
      expect(insertedAccounts[0].email).toBe(TEST_MS_EMAIL);

      // AccountDO: initialize was called with tokens
      expect(accountDO._calls.length).toBe(1);
      expect(accountDO._calls[0].url).toContain("initialize");
      const doBody = accountDO._calls[0].body as any;
      expect(doBody.tokens.access_token).toBe("EwB0A8l6BAAURSN_mock_ms_access_token");
      expect(doBody.tokens.refresh_token).toBe("M.C107_BAY.2.mock_ms_refresh_token");
      expect(doBody.tokens.expiry).toBeTruthy();
      expect(doBody.scopes).toBe(MS_SCOPES);

      // OnboardingWorkflow: was started
      expect(workflow._calls.length).toBe(1);
      expect(workflow._calls[0].params.account_id).toBe(accountId);
      expect(workflow._calls[0].params.user_id).toBe(TEST_USER_ID);
    });
  });

  describe("re-activation (same user)", () => {
    it("reuses existing Microsoft account, refreshes tokens, skips workflow", async () => {
      const d1 = createMockD1();
      const accountDO = createMockAccountDO();
      const workflow = createMockWorkflow();
      const env = createMockEnv({ d1, accountDO, workflow });

      // Pre-populate: same user already linked this Microsoft account
      d1._rows["accounts"] = [{
        account_id: "acc_MSEXISTING01",
        user_id: TEST_USER_ID,
        provider: "microsoft",
        provider_subject: TEST_MS_SUB,
        email: "old@outlook.com",
        status: "revoked",
      }];

      const mockFetch = createMockMicrosoftFetch();
      const handler = createHandler(mockFetch);
      const { state } = await createValidMsState();

      const request = new Request(
        `https://oauth.tminus.dev/oauth/microsoft/callback?code=${TEST_MS_AUTH_CODE}&state=${state}`,
      );
      const response = await handler.fetch(request, env, mockCtx);

      // Should redirect with the existing account_id and reactivated flag
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("Location")!);
      expect(location.searchParams.get("account_id")).toBe("acc_MSEXISTING01");
      expect(location.searchParams.get("reactivated")).toBe("true");

      // AccountDO: initialize was called (to refresh tokens)
      expect(accountDO._calls.length).toBe(1);
      expect(accountDO._calls[0].id).toBe("acc_MSEXISTING01");

      // OnboardingWorkflow: was NOT started (existing account)
      expect(workflow._calls.length).toBe(0);
    });
  });

  describe("cross-user linking rejection", () => {
    it("returns 409 when Microsoft account is linked to a different user", async () => {
      const d1 = createMockD1();
      const env = createMockEnv({ d1 });

      // Pre-populate: different user owns this Microsoft account
      d1._rows["accounts"] = [{
        account_id: "acc_MS_OTHER_USER",
        user_id: "usr_DIFFERENT_USER_0000000000AA",
        provider: "microsoft",
        provider_subject: TEST_MS_SUB,
        email: "other@outlook.com",
        status: "active",
      }];

      const mockFetch = createMockMicrosoftFetch();
      const handler = createHandler(mockFetch);
      const { state } = await createValidMsState();

      const request = new Request(
        `https://oauth.tminus.dev/oauth/microsoft/callback?code=${TEST_MS_AUTH_CODE}&state=${state}`,
      );
      const response = await handler.fetch(request, env, mockCtx);

      expect(response.status).toBe(409);
      const body = await response.text();
      expect(body).toContain("already linked to another user");
    });
  });

  describe("error handling", () => {
    it("returns user-friendly message when Microsoft consent is denied", async () => {
      const env = createMockEnv();
      const handler = createHandler();

      const request = new Request(
        "https://oauth.tminus.dev/oauth/microsoft/callback?error=access_denied",
      );
      const response = await handler.fetch(request, env, mockCtx);

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("declined access");
    });

    it("returns error when state parameter is invalid/tampered", async () => {
      const env = createMockEnv();
      const handler = createHandler(createMockMicrosoftFetch());

      const request = new Request(
        `https://oauth.tminus.dev/oauth/microsoft/callback?code=${TEST_MS_AUTH_CODE}&state=tampered-state`,
      );
      const response = await handler.fetch(request, env, mockCtx);

      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain("Please try again");
    });

    it("returns 502 when Microsoft token exchange fails", async () => {
      const env = createMockEnv();
      const mockFetch = createMockMicrosoftFetch({ tokenStatus: 400 });
      const handler = createHandler(mockFetch);

      const { state } = await createValidMsState();

      const request = new Request(
        `https://oauth.tminus.dev/oauth/microsoft/callback?code=bad-code&state=${state}`,
      );
      const response = await handler.fetch(request, env, mockCtx);

      expect(response.status).toBe(502);
      const body = await response.text();
      expect(body).toContain("Something went wrong");
    });

    it("returns 502 when Microsoft token endpoint returns non-JSON (HTML error page)", async () => {
      const env = createMockEnv();
      const htmlError = "<html><body>Service Unavailable</body></html>";
      const mockFetch = createMockMicrosoftFetch({
        tokenStatus: 503,
        tokenBody: htmlError,
      });
      const handler = createHandler(mockFetch);

      const { state } = await createValidMsState();

      const request = new Request(
        `https://oauth.tminus.dev/oauth/microsoft/callback?code=some-code&state=${state}`,
      );
      const response = await handler.fetch(request, env, mockCtx);

      expect(response.status).toBe(502);
      const body = await response.text();
      expect(body).toContain("Something went wrong");
    });

    it("returns 502 when no refresh_token in response", async () => {
      const env = createMockEnv();
      const mockFetch = createMockMicrosoftFetch({
        tokenResponse: { refresh_token: undefined } as any,
      });
      const handler = createHandler(mockFetch);

      const { state } = await createValidMsState();

      const request = new Request(
        `https://oauth.tminus.dev/oauth/microsoft/callback?code=${TEST_MS_AUTH_CODE}&state=${state}`,
      );
      const response = await handler.fetch(request, env, mockCtx);

      expect(response.status).toBe(502);
    });

    it("returns 502 when Microsoft userinfo fetch fails", async () => {
      const env = createMockEnv();
      const mockFetch = createMockMicrosoftFetch({ userInfoStatus: 401 });
      const handler = createHandler(mockFetch);

      const { state } = await createValidMsState();

      const request = new Request(
        `https://oauth.tminus.dev/oauth/microsoft/callback?code=${TEST_MS_AUTH_CODE}&state=${state}`,
      );
      const response = await handler.fetch(request, env, mockCtx);

      expect(response.status).toBe(502);
    });

    it("returns 400 when code is missing", async () => {
      const env = createMockEnv();
      const handler = createHandler();

      const request = new Request(
        "https://oauth.tminus.dev/oauth/microsoft/callback?state=something",
      );
      const response = await handler.fetch(request, env, mockCtx);

      expect(response.status).toBe(400);
    });

    it("returns 400 when state is missing", async () => {
      const env = createMockEnv();
      const handler = createHandler();

      const request = new Request(
        `https://oauth.tminus.dev/oauth/microsoft/callback?code=${TEST_MS_AUTH_CODE}`,
      );
      const response = await handler.fetch(request, env, mockCtx);

      expect(response.status).toBe(400);
    });

    it("handles Microsoft userinfo with userPrincipalName fallback for email", async () => {
      const d1 = createMockD1();
      const accountDO = createMockAccountDO();
      const workflow = createMockWorkflow();
      const env = createMockEnv({ d1, accountDO, workflow });

      const mockFetch = createMockMicrosoftFetch({
        userInfoResponse: {
          id: TEST_MS_SUB,
          mail: null as any, // Some accounts have null mail
          userPrincipalName: "user@contoso.onmicrosoft.com",
        },
      });
      const handler = createHandler(mockFetch);
      const { state } = await createValidMsState();

      const request = new Request(
        `https://oauth.tminus.dev/oauth/microsoft/callback?code=${TEST_MS_AUTH_CODE}&state=${state}`,
      );
      const response = await handler.fetch(request, env, mockCtx);

      expect(response.status).toBe(302);
      const insertedAccounts = (d1._rows["accounts"] || []) as any[];
      expect(insertedAccounts[0].email).toBe("user@contoso.onmicrosoft.com");
    });
  });
});

// ---------------------------------------------------------------------------
// Microsoft constants tests
// ---------------------------------------------------------------------------

describe("Microsoft OAuth constants", () => {
  it("MS_AUTH_URL points to Microsoft login endpoint", () => {
    expect(MS_AUTH_URL).toContain("login.microsoftonline.com");
    expect(MS_AUTH_URL).toContain("oauth2/v2.0/authorize");
  });

  it("MS_TOKEN_URL points to Microsoft token endpoint", () => {
    expect(MS_TOKEN_URL).toContain("login.microsoftonline.com");
    expect(MS_TOKEN_URL).toContain("oauth2/v2.0/token");
  });

  it("MS_SCOPES includes calendar, user, and offline access scopes", () => {
    expect(MS_SCOPES).toContain("Calendars.ReadWrite");
    expect(MS_SCOPES).toContain("User.Read");
    expect(MS_SCOPES).toContain("offline_access");
  });

  it("MS_CALLBACK_PATH is correct", () => {
    expect(MS_CALLBACK_PATH).toBe("/oauth/microsoft/callback");
  });

  it("MS_USERINFO_URL points to Microsoft Graph", () => {
    expect(MS_USERINFO_URL).toContain("graph.microsoft.com");
  });
});

// ---------------------------------------------------------------------------
// Google constants tests
// ---------------------------------------------------------------------------

describe("Google OAuth constants", () => {
  it("GOOGLE_SCOPES includes calendar, events, and identity scopes", () => {
    expect(GOOGLE_SCOPES).toContain("calendar");
    expect(GOOGLE_SCOPES).toContain("calendar.events");
    expect(GOOGLE_SCOPES).toContain("openid");
    expect(GOOGLE_SCOPES).toContain("email");
    expect(GOOGLE_SCOPES).toContain("profile");
  });
});

// ---------------------------------------------------------------------------
// OAuth success page unit tests (TM-s8gz)
// ---------------------------------------------------------------------------

describe("renderOAuthSuccessPage", () => {
  it("renders Google provider name for new account", () => {
    const html = renderOAuthSuccessPage("google", "user@gmail.com", false);
    expect(html).toContain("Google Account Linked");
    expect(html).toContain("user@gmail.com");
    expect(html).toContain("Calendar sync is starting");
    expect(html).toContain("Connected");
    expect(html).not.toContain("Reconnected");
  });

  it("renders Microsoft provider name for new account", () => {
    const html = renderOAuthSuccessPage("microsoft", "user@outlook.com", false);
    expect(html).toContain("Microsoft Account Linked");
    expect(html).toContain("user@outlook.com");
    expect(html).toContain("Calendar sync is starting");
  });

  it("renders reactivated status message for reconnected account", () => {
    const html = renderOAuthSuccessPage("google", "user@gmail.com", true);
    expect(html).toContain("reconnected");
    expect(html).toContain("Calendar sync is resuming");
    expect(html).toContain("Reconnected");
    expect(html).not.toContain("Connected</");
  });

  it("renders without email when email is null", () => {
    const html = renderOAuthSuccessPage("google", null, false);
    expect(html).toContain("Google Account Linked");
    expect(html).not.toContain("<strong>Email:</strong>");
    // Should still have provider and status
    expect(html).toContain("Provider:");
    expect(html).toContain("Status:");
  });

  it("includes close-tab instruction", () => {
    const html = renderOAuthSuccessPage("google", "test@test.com", false);
    expect(html).toContain("close this tab");
  });

  it("escapes HTML special characters in email to prevent XSS", () => {
    const html = renderOAuthSuccessPage("google", '<script>alert("xss")</script>', false);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("includes proper HTML structure", () => {
    const html = renderOAuthSuccessPage("google", "user@gmail.com", false);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>Account Linked - T-Minus</title>");
    expect(html).toContain("</html>");
  });
});

// ---------------------------------------------------------------------------
// OAuth success page handler tests (TM-s8gz)
// ---------------------------------------------------------------------------

describe("handleOAuthSuccess", () => {
  it("returns 200 HTML for /oauth/google/done", () => {
    const request = new Request(
      "https://oauth.tminus.dev/oauth/google/done?account_id=acc_123&email=user@gmail.com",
    );
    const response = handleOAuthSuccess(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("returns 200 HTML for /oauth/microsoft/done", () => {
    const request = new Request(
      "https://oauth.tminus.dev/oauth/microsoft/done?account_id=acc_456&email=user@outlook.com",
    );
    const response = handleOAuthSuccess(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("returns 200 HTML for /oauth/google/done/ with trailing slash", () => {
    const request = new Request(
      "https://oauth.tminus.dev/oauth/google/done/?account_id=acc_123&email=user@gmail.com",
    );
    const response = handleOAuthSuccess(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("returns 404 for unrecognized path", () => {
    const request = new Request("https://oauth.tminus.dev/oauth/apple/done");
    const response = handleOAuthSuccess(request);

    expect(response.status).toBe(404);
  });

  it("includes provider-specific content in Google response body", async () => {
    const request = new Request(
      "https://oauth.tminus.dev/oauth/google/done?account_id=acc_123&email=user@gmail.com",
    );
    const response = handleOAuthSuccess(request);
    const body = await response.text();

    expect(body).toContain("Google Account Linked");
    expect(body).toContain("user@gmail.com");
  });

  it("includes provider-specific content in Microsoft response body", async () => {
    const request = new Request(
      "https://oauth.tminus.dev/oauth/microsoft/done?account_id=acc_456&email=user@outlook.com",
    );
    const response = handleOAuthSuccess(request);
    const body = await response.text();

    expect(body).toContain("Microsoft Account Linked");
    expect(body).toContain("user@outlook.com");
  });

  it("handles reactivated flag correctly", async () => {
    const request = new Request(
      "https://oauth.tminus.dev/oauth/google/done?account_id=acc_123&email=user@gmail.com&reactivated=true",
    );
    const response = handleOAuthSuccess(request);
    const body = await response.text();

    expect(body).toContain("reconnected");
    expect(body).toContain("Calendar sync is resuming");
  });

  it("handles missing email gracefully", async () => {
    const request = new Request(
      "https://oauth.tminus.dev/oauth/google/done?account_id=acc_123",
    );
    const response = handleOAuthSuccess(request);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Google Account Linked");
    expect(body).not.toContain("<strong>Email:</strong>");
  });

  it("sets no-store cache control to prevent caching dynamic content", () => {
    const request = new Request(
      "https://oauth.tminus.dev/oauth/google/done?account_id=acc_123",
    );
    const response = handleOAuthSuccess(request);

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

// ---------------------------------------------------------------------------
// /oauth/{provider}/done routing tests via worker handler (TM-s8gz)
// ---------------------------------------------------------------------------

describe("GET /oauth/google/done (routed via worker)", () => {
  it("returns success HTML page (not 404)", async () => {
    const env = createMockEnv();
    const handler = createHandler();

    const request = new Request(
      "https://oauth.tminus.dev/oauth/google/done?account_id=acc_123&email=user@gmail.com",
    );
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const body = await response.text();
    expect(body).toContain("Google Account Linked");
    expect(body).toContain("user@gmail.com");
  });
});

describe("GET /oauth/microsoft/done (routed via worker)", () => {
  it("returns success HTML page (not 404)", async () => {
    const env = createMockEnv();
    const handler = createHandler();

    const request = new Request(
      "https://oauth.tminus.dev/oauth/microsoft/done?account_id=acc_456&email=user@outlook.com",
    );
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const body = await response.text();
    expect(body).toContain("Microsoft Account Linked");
    expect(body).toContain("user@outlook.com");
  });

  it("returns success HTML page for trailing slash route", async () => {
    const env = createMockEnv();
    const handler = createHandler();

    const request = new Request(
      "https://oauth.tminus.dev/oauth/microsoft/done/?account_id=acc_456&email=user@outlook.com",
    );
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const body = await response.text();
    expect(body).toContain("Microsoft Account Linked");
  });
});

// ---------------------------------------------------------------------------
// Callback redirect includes email param (TM-s8gz)
// ---------------------------------------------------------------------------

describe("Google callback redirect includes email", () => {
  async function createValidState(userId?: string, redirectUri?: string) {
    const verifier = generateCodeVerifier();
    const state = await encryptState(
      TEST_JWT_SECRET,
      verifier,
      userId || TEST_USER_ID,
      redirectUri || "https://app.tminus.dev/done",
    );
    return { verifier, state };
  }

  it("includes email query param in the success redirect", async () => {
    const d1 = createMockD1();
    const accountDO = createMockAccountDO();
    const workflow = createMockWorkflow();
    const env = createMockEnv({ d1, accountDO, workflow });
    const mockFetch = createMockGoogleFetch();
    const handler = createHandler(mockFetch);

    const { state } = await createValidState();

    const request = new Request(
      `https://oauth.tminus.dev/oauth/google/callback?code=${TEST_AUTH_CODE}&state=${state}`,
    );
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.searchParams.get("email")).toBe(TEST_GOOGLE_EMAIL);
  });
});

describe("Microsoft callback redirect includes email", () => {
  async function createValidMsState(userId?: string, redirectUri?: string) {
    const state = await encryptState(
      TEST_JWT_SECRET,
      "not-used-for-ms",
      userId || TEST_USER_ID,
      redirectUri || "https://app.tminus.dev/done",
    );
    return { state };
  }

  it("includes email query param in the success redirect", async () => {
    const d1 = createMockD1();
    const accountDO = createMockAccountDO();
    const workflow = createMockWorkflow();
    const env = createMockEnv({ d1, accountDO, workflow });
    const mockFetch = createMockMicrosoftFetch();
    const handler = createHandler(mockFetch);

    const { state } = await createValidMsState();

    const request = new Request(
      `https://oauth.tminus.dev/oauth/microsoft/callback?code=${TEST_MS_AUTH_CODE}&state=${state}`,
    );
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.searchParams.get("email")).toBe(TEST_MS_EMAIL);
  });

  it("includes userPrincipalName fallback email in redirect", async () => {
    const d1 = createMockD1();
    const accountDO = createMockAccountDO();
    const workflow = createMockWorkflow();
    const env = createMockEnv({ d1, accountDO, workflow });

    const mockFetch = createMockMicrosoftFetch({
      userInfoResponse: {
        id: TEST_MS_SUB,
        mail: null as any,
        userPrincipalName: "user@contoso.onmicrosoft.com",
      },
    });
    const handler = createHandler(mockFetch);
    const { state } = await createValidMsState();

    const request = new Request(
      `https://oauth.tminus.dev/oauth/microsoft/callback?code=${TEST_MS_AUTH_CODE}&state=${state}`,
    );
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.searchParams.get("email")).toBe("user@contoso.onmicrosoft.com");
  });
});
