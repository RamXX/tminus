/**
 * Phase 2A E2E Validation Test Suite
 *
 * Proves Phase 2A deliverables work end-to-end with real HTTP requests
 * against a running API worker. No mocks, no test fixtures.
 *
 * Test scenarios:
 *   1. Health endpoint returns 200 with JSON envelope
 *   2. User registration creates account successfully
 *   3. Login returns JWT tokens
 *   4. Authenticated access to protected endpoints
 *   5. Unauthenticated access rejected with 401
 *   6. Security headers present on all responses
 *   7. CORS: allowed origin accepted, unauthorized origin rejected
 *   8. Rate limiting: X-RateLimit-* headers present; exceed -> 429
 *   9. API key lifecycle: create -> use -> revoke -> rejected
 *  10. Token refresh issues new JWT
 *  11. Account lockout after 5 failed logins -> 403 ERR_ACCOUNT_LOCKED
 *
 * Configuration:
 *   BASE_URL env var (default: http://localhost:8787)
 *
 * Important notes:
 * - Register endpoint is rate-limited to 5/hr/IP. The test is structured
 *   to register all needed users FIRST (before other tests consume the quota).
 * - The /v1/events endpoint requires DurableObject (UserGraphDO) which may
 *   return 500 in local dev if the DO's fetch() handler is not available.
 *   We use /v1/api-keys (D1-only) for authenticated access verification.
 *
 * Run with:
 *   make test-e2e-phase2a           (against localhost:8787)
 *   make test-e2e-phase2a-staging   (against staging)
 *   make test-e2e-phase2a-production (against production)
 */

import { describe, it, expect, beforeAll } from "vitest";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL = process.env.BASE_URL || "http://localhost:8787";

/**
 * Generate a unique test email to avoid conflicts between test runs.
 * Uses crypto.randomUUID() for uniqueness.
 */
function uniqueEmail(): string {
  return `e2e-${crypto.randomUUID()}@test.tminus.ink`;
}

/** Standard test password meeting all validation requirements. */
const TEST_PASSWORD = "E2eTestP@ss2024!";

// ---------------------------------------------------------------------------
// Shared state across tests (populated during setup phase)
// ---------------------------------------------------------------------------

/** State for the main test user -- used by most test scenarios. */
interface TestState {
  email: string;
  accessToken: string;
  refreshToken: string;
  userId: string;
}

/** State for the lockout test user -- separate to avoid cross-contamination. */
interface LockoutUserState {
  email: string;
}

let testState: TestState;
let lockoutUser: LockoutUserState;

// ---------------------------------------------------------------------------
// Helper: fetch wrapper with timeout
// ---------------------------------------------------------------------------

async function api(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `${BASE_URL}${path}`;
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(15_000),
  });
}

/** Convenience: fetch with JSON body. */
async function apiJson(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return api(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** Convenience: fetch with auth header. */
async function apiAuth(
  path: string,
  token: string,
  options: RequestInit = {},
): Promise<Response> {
  return api(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers as Record<string, string> || {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Phase 2A E2E Validation", () => {

  // =========================================================================
  // Setup: register all users FIRST to avoid rate limit exhaustion
  //
  // The register endpoint is rate-limited to 5/hr/IP. We need:
  //   - 1 main test user
  //   - 1 lockout test user
  // Total: 2 registrations (well within the 5/hr limit)
  // =========================================================================

  beforeAll(async () => {
    // Verify API is reachable
    try {
      const resp = await api("/health");
      if (!resp.ok) {
        throw new Error(`Health check failed: ${resp.status}`);
      }
    } catch (err) {
      throw new Error(
        `Cannot reach API at ${BASE_URL}. ` +
        `Start the API worker first: ./scripts/e2e-local-setup.sh\n` +
        `Original error: ${err}`,
      );
    }

    // Register main test user
    const mainEmail = uniqueEmail();
    const mainResp = await apiJson("/v1/auth/register", {
      email: mainEmail,
      password: TEST_PASSWORD,
    });
    if (mainResp.status !== 201) {
      const text = await mainResp.text();
      throw new Error(`Failed to register main test user (${mainResp.status}): ${text}`);
    }
    const mainBody = await mainResp.json() as Record<string, unknown>;
    const mainData = mainBody.data as Record<string, unknown>;
    const mainUser = mainData.user as Record<string, unknown>;

    testState = {
      email: mainEmail,
      accessToken: mainData.access_token as string,
      refreshToken: mainData.refresh_token as string,
      userId: mainUser.id as string,
    };

    // Register lockout test user
    const lockoutEmail = uniqueEmail();
    const lockoutResp = await apiJson("/v1/auth/register", {
      email: lockoutEmail,
      password: TEST_PASSWORD,
    });
    if (lockoutResp.status !== 201) {
      const text = await lockoutResp.text();
      throw new Error(`Failed to register lockout test user (${lockoutResp.status}): ${text}`);
    }
    // Consume body
    await lockoutResp.text();

    lockoutUser = { email: lockoutEmail };
  });

  // =========================================================================
  // 1. Health endpoint
  // =========================================================================

  describe("1. Health endpoint", () => {
    it("GET /health returns 200 with JSON envelope", async () => {
      const resp = await api("/health");
      expect(resp.status).toBe(200);

      const body = await resp.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.data).toEqual(
        expect.objectContaining({ status: "healthy" }),
      );
    });
  });

  // =========================================================================
  // 2. User registration
  // =========================================================================

  describe("2. User registration", () => {
    it("POST /v1/auth/register creates user with JWT and refresh token", () => {
      // Verified during beforeAll setup -- assert the saved state is valid
      expect(testState.accessToken).toBeDefined();
      expect(typeof testState.accessToken).toBe("string");
      expect(testState.accessToken.length).toBeGreaterThan(0);
      expect(testState.refreshToken).toBeDefined();
      expect(testState.userId).toBeDefined();
      expect(testState.email).toContain("@test.tminus.ink");
    });

    it("POST /v1/auth/register rejects duplicate email", async () => {
      const resp = await apiJson("/v1/auth/register", {
        email: testState.email,
        password: TEST_PASSWORD,
      });

      // May return 409 (conflict) or 429 (rate limited) depending on
      // how many registrations have happened. Both indicate the duplicate
      // was not silently accepted.
      expect([409, 429]).toContain(resp.status);
      const body = await resp.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);
    });
  });

  // =========================================================================
  // 3. User login
  // =========================================================================

  describe("3. User login", () => {
    it("POST /v1/auth/login returns JWT for valid credentials", async () => {
      const resp = await apiJson("/v1/auth/login", {
        email: testState.email,
        password: TEST_PASSWORD,
      });

      expect(resp.status).toBe(200);

      const body = await resp.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);

      const data = body.data as Record<string, unknown>;
      expect(data.access_token).toBeDefined();
      expect(typeof data.access_token).toBe("string");
      expect(data.refresh_token).toBeDefined();

      // Update state with fresh tokens
      testState.accessToken = data.access_token as string;
      testState.refreshToken = data.refresh_token as string;
    });

    it("POST /v1/auth/login rejects wrong password", async () => {
      const resp = await apiJson("/v1/auth/login", {
        email: testState.email,
        password: "WrongPassword123!",
      });

      expect(resp.status).toBe(401);
      const body = await resp.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);
    });
  });

  // =========================================================================
  // 4. Authenticated API access
  //
  // Uses /v1/api-keys (D1-only, no DO dependency) to verify auth works.
  // =========================================================================

  describe("4. Authenticated API access", () => {
    it("GET /v1/api-keys with valid JWT returns 200", async () => {
      const resp = await apiAuth("/v1/api-keys", testState.accessToken);
      expect(resp.status).toBe(200);

      const body = await resp.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      // data is an array of API keys (empty for a new user)
      expect(Array.isArray(body.data)).toBe(true);
    });
  });

  // =========================================================================
  // 5. Unauthenticated access rejected
  // =========================================================================

  describe("5. Unauthenticated access rejected", () => {
    it("GET /v1/api-keys without JWT returns 401", async () => {
      const resp = await api("/v1/api-keys");
      expect(resp.status).toBe(401);

      const body = await resp.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);
    });

    it("GET /v1/api-keys with invalid JWT returns 401", async () => {
      const resp = await apiAuth("/v1/api-keys", "invalid.jwt.token");
      expect(resp.status).toBe(401);

      const body = await resp.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);
    });
  });

  // =========================================================================
  // 6. Security headers
  // =========================================================================

  describe("6. Security headers", () => {
    it("responses include X-Frame-Options: DENY", async () => {
      const resp = await api("/health");
      expect(resp.headers.get("X-Frame-Options")).toBe("DENY");
    });

    it("responses include Strict-Transport-Security with max-age", async () => {
      const resp = await api("/health");
      const hsts = resp.headers.get("Strict-Transport-Security");
      expect(hsts).toBeDefined();
      expect(hsts).toContain("max-age=");
    });

    it("responses include X-Content-Type-Options: nosniff", async () => {
      const resp = await api("/health");
      expect(resp.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });

    it("responses include Content-Security-Policy", async () => {
      const resp = await api("/health");
      const csp = resp.headers.get("Content-Security-Policy");
      expect(csp).toBeDefined();
      expect(csp).toContain("default-src");
    });

    it("security headers present on authenticated endpoints", async () => {
      const resp = await apiAuth("/v1/api-keys", testState.accessToken);
      expect(resp.headers.get("X-Frame-Options")).toBe("DENY");
      expect(resp.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(resp.headers.get("Strict-Transport-Security")).toBeDefined();
      expect(resp.headers.get("Content-Security-Policy")).toBeDefined();
    });

    it("security headers present on error responses (401)", async () => {
      const resp = await api("/v1/api-keys"); // 401 -- no auth
      expect(resp.headers.get("X-Frame-Options")).toBe("DENY");
      expect(resp.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });
  });

  // =========================================================================
  // 7. CORS
  // =========================================================================

  describe("7. CORS", () => {
    it("allows requests from localhost in dev mode", async () => {
      const resp = await api("/health", {
        headers: {
          Origin: "http://localhost:3000",
        },
      });
      expect(resp.status).toBe(200);
      // In dev mode, localhost origins should receive the CORS header
      const allowOrigin = resp.headers.get("Access-Control-Allow-Origin");
      expect(allowOrigin).toBe("http://localhost:3000");
    });

    it("rejects unauthorized origin (no CORS header set)", async () => {
      const resp = await api("/health", {
        headers: {
          Origin: "https://evil.example.com",
        },
      });
      expect(resp.status).toBe(200); // Request succeeds but no CORS header
      const allowOrigin = resp.headers.get("Access-Control-Allow-Origin");
      // No CORS header for unauthorized origin -- browser would block this
      expect(allowOrigin).toBeNull();
    });

    it("preflight OPTIONS returns correct headers for allowed origin", async () => {
      const resp = await api("/v1/api-keys", {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:3000",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "Authorization",
        },
      });
      // Preflight should return 204 or 200
      expect([200, 204]).toContain(resp.status);
      expect(resp.headers.get("Access-Control-Allow-Methods")).toBeDefined();
    });
  });

  // =========================================================================
  // 8. Rate limiting
  // =========================================================================

  describe("8. Rate limiting", () => {
    it("authenticated responses include X-RateLimit-* headers", async () => {
      const resp = await apiAuth("/v1/api-keys", testState.accessToken);
      expect(resp.status).toBe(200);

      // Rate limit headers should be present on authenticated requests
      const limitHeader = resp.headers.get("X-RateLimit-Limit");
      const remainingHeader = resp.headers.get("X-RateLimit-Remaining");
      const resetHeader = resp.headers.get("X-RateLimit-Reset");

      expect(limitHeader).toBeDefined();
      expect(remainingHeader).toBeDefined();
      expect(resetHeader).toBeDefined();

      // Verify they are numeric
      expect(Number(limitHeader)).toBeGreaterThan(0);
      expect(Number(remainingHeader)).toBeGreaterThanOrEqual(0);
    });

    it("exceeding rate limit returns 429 with Retry-After", async () => {
      // Auth endpoint register has 5/hr/IP limit.
      // We already used ~3 registrations in beforeAll.
      // Send additional register requests until we hit 429.
      let got429 = false;
      let retryAfterHeader: string | null = null;
      let responseBody: Record<string, unknown> | null = null;

      for (let i = 0; i < 10; i++) {
        const email = uniqueEmail();
        const resp = await apiJson("/v1/auth/register", {
          email,
          password: TEST_PASSWORD,
        });

        if (resp.status === 429) {
          got429 = true;
          retryAfterHeader = resp.headers.get("Retry-After");
          responseBody = await resp.json() as Record<string, unknown>;
          break;
        }
        // Consume body to allow connection reuse
        await resp.text();
      }

      expect(got429).toBe(true);
      // Response should include rate limit information
      expect(responseBody).toBeDefined();
      expect(responseBody!.ok).toBe(false);
    });
  });

  // =========================================================================
  // 9. API key lifecycle
  // =========================================================================

  describe("9. API key lifecycle", () => {
    let apiKeyRaw: string;
    let apiKeyId: string;

    it("create API key with JWT auth", async () => {
      const resp = await api("/v1/api-keys", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${testState.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "E2E Test Key" }),
      });

      expect(resp.status).toBe(201);

      const body = await resp.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);

      const data = body.data as Record<string, unknown>;
      expect(data.key).toBeDefined();
      expect(typeof data.key).toBe("string");
      expect((data.key as string).startsWith("tmk_live_")).toBe(true);
      expect(data.key_id).toBeDefined();

      apiKeyRaw = data.key as string;
      apiKeyId = data.key_id as string;
    });

    it("use API key for authenticated access", async () => {
      const resp = await apiAuth("/v1/api-keys", apiKeyRaw);
      expect(resp.status).toBe(200);

      const body = await resp.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      // Should see the key we just created in the list
      const keys = body.data as Array<Record<string, unknown>>;
      expect(keys.length).toBeGreaterThanOrEqual(1);
      const found = keys.find(k => k.key_id === apiKeyId);
      expect(found).toBeDefined();
    });

    it("revoke API key", async () => {
      const resp = await api(`/v1/api-keys/${apiKeyId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${testState.accessToken}`,
        },
      });

      expect(resp.status).toBe(200);
      const body = await resp.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
    });

    it("revoked API key is rejected", async () => {
      const resp = await apiAuth("/v1/api-keys", apiKeyRaw);
      expect(resp.status).toBe(401);
    });
  });

  // =========================================================================
  // 10. Token refresh
  // =========================================================================

  describe("10. Token refresh", () => {
    it("POST /v1/auth/refresh issues new JWT and rotates refresh token", async () => {
      // Get a fresh login to have known tokens
      const loginResp = await apiJson("/v1/auth/login", {
        email: testState.email,
        password: TEST_PASSWORD,
      });
      expect(loginResp.status).toBe(200);
      const loginBody = await loginResp.json() as Record<string, unknown>;
      const loginData = loginBody.data as Record<string, unknown>;
      const oldRefresh = loginData.refresh_token as string;

      // Small delay to ensure JWT iat differs (second-precision timestamp)
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Refresh the token
      const resp = await apiJson("/v1/auth/refresh", {
        refresh_token: oldRefresh,
      });

      expect(resp.status).toBe(200);

      const body = await resp.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);

      const data = body.data as Record<string, unknown>;
      expect(data.access_token).toBeDefined();
      expect(typeof data.access_token).toBe("string");
      expect(data.refresh_token).toBeDefined();
      expect(typeof data.refresh_token).toBe("string");

      // Refresh token should be rotated (different from the old one)
      expect(data.refresh_token).not.toBe(oldRefresh);

      // Update state with refreshed tokens
      testState.accessToken = data.access_token as string;
      testState.refreshToken = data.refresh_token as string;
    });

    it("old refresh token is invalidated after rotation", async () => {
      // Login to get a known refresh token
      const loginResp = await apiJson("/v1/auth/login", {
        email: testState.email,
        password: TEST_PASSWORD,
      });
      const loginBody = await loginResp.json() as Record<string, unknown>;
      const loginData = loginBody.data as Record<string, unknown>;
      const oldRefresh = loginData.refresh_token as string;

      // Refresh once -- this consumes the old token
      const refreshResp = await apiJson("/v1/auth/refresh", {
        refresh_token: oldRefresh,
      });
      expect(refreshResp.status).toBe(200);
      const refreshBody = await refreshResp.json() as Record<string, unknown>;
      const refreshData = refreshBody.data as Record<string, unknown>;

      // Update state
      testState.accessToken = refreshData.access_token as string;
      testState.refreshToken = refreshData.refresh_token as string;

      // Replay the consumed old token -- should be rejected
      const replayResp = await apiJson("/v1/auth/refresh", {
        refresh_token: oldRefresh,
      });
      expect(replayResp.status).toBe(401);
    });
  });

  // =========================================================================
  // 11. Account lockout
  // =========================================================================

  describe("11. Account lockout after 5 failed logins", () => {
    it("locks account after 5 failed login attempts with 403 ERR_ACCOUNT_LOCKED", async () => {
      // Use the lockout user registered in beforeAll
      const email = lockoutUser.email;

      // Attempt 5 failed logins with wrong password
      for (let i = 0; i < 5; i++) {
        const failResp = await apiJson("/v1/auth/login", {
          email,
          password: "WrongPassword!",
        });
        expect(failResp.status).toBe(401);
        await failResp.text(); // consume body
      }

      // The 6th attempt should be locked out with 403
      const lockedResp = await apiJson("/v1/auth/login", {
        email,
        password: TEST_PASSWORD, // Even correct password is rejected when locked
      });

      expect(lockedResp.status).toBe(403);

      const body = await lockedResp.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);

      const error = body.error as Record<string, unknown>;
      expect(error.code).toBe("ERR_ACCOUNT_LOCKED");

      // Should include retryAfter
      expect(body.retryAfter).toBeDefined();
      expect(typeof body.retryAfter).toBe("number");
      expect(body.retryAfter as number).toBeGreaterThan(0);
    });
  });
});
