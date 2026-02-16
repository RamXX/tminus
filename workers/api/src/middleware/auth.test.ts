/**
 * Unit tests for the auth middleware.
 *
 * Tests:
 * - Missing Authorization header returns 401
 * - Non-Bearer scheme returns 401
 * - Invalid/expired JWT returns 401
 * - Valid JWT attaches user context
 * - Error response matches canonical shared.ts envelope format {ok, error, error_code, meta}
 * - API key routing: tmk_ tokens route to API key validation
 * - API key without DB configured returns 401
 * - Invalid API key format returns 401
 * - Valid API key attaches user context
 * - Revoked API key returns 401
 */

import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { generateJWT } from "@tminus/shared";
import { authMiddleware } from "./auth";
import type { AuthEnv, AuthDB } from "./auth";
import { generateApiKey, hashApiKey } from "../api-keys";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const JWT_SECRET = "test-jwt-secret-must-be-at-least-this-long-for-testing";
const TEST_USER = {
  sub: "usr_01HXYZ00000000000000000001",
  email: "test@example.com",
  tier: "free" as const,
  pwd_ver: 1,
};

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

/** Create a minimal Hono app with auth middleware on /protected/* */
function createTestApp() {
  const app = new Hono<{ Bindings: { JWT_SECRET: string } } & AuthEnv>();

  // Apply auth middleware to protected routes
  app.use("/protected/*", authMiddleware((c) => c.env.JWT_SECRET));

  // Protected route that returns the user context
  app.get("/protected/me", (c) => {
    const user = c.get("user");
    return c.json({ ok: true, data: user });
  });

  // Unprotected route
  app.get("/public/health", (c) => {
    return c.json({ ok: true, data: "healthy" });
  });

  return app;
}

/** Helper to generate a valid auth header. */
async function makeAuthHeader(
  overrides?: Partial<typeof TEST_USER>,
): Promise<string> {
  const payload = { ...TEST_USER, ...overrides };
  const token = await generateJWT(payload, JWT_SECRET);
  return `Bearer ${token}`;
}

/** Standard env binding for test requests. */
const TEST_ENV = { JWT_SECRET };

// ---------------------------------------------------------------------------
// Auth middleware: missing/invalid Authorization
// ---------------------------------------------------------------------------

describe("authMiddleware: rejection cases", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const app = createTestApp();
    const res = await app.request(
      "/protected/me",
      { method: "GET" },
      TEST_ENV,
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("AUTH_REQUIRED");
    expect(body.error).toContain("Missing");
  });

  it("returns 401 when Authorization header is not Bearer", async () => {
    const app = createTestApp();
    const res = await app.request(
      "/protected/me",
      {
        method: "GET",
        headers: { Authorization: "Basic dXNlcjpwYXNz" },
      },
      TEST_ENV,
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("AUTH_REQUIRED");
    expect(body.error).toContain("Invalid");
  });

  it("returns 401 when Bearer token is malformed", async () => {
    const app = createTestApp();
    const res = await app.request(
      "/protected/me",
      {
        method: "GET",
        headers: { Authorization: "Bearer not-a-valid-jwt" },
      },
      TEST_ENV,
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("AUTH_REQUIRED");
  });

  it("returns 401 when Bearer token is expired", async () => {
    const app = createTestApp();
    // Create a token that expired 1 hour ago
    const pastTime = Math.floor(Date.now() / 1000) - 7200;
    const token = await generateJWT(
      { ...TEST_USER, iat: pastTime, exp: pastTime + 3600 },
      JWT_SECRET,
    );

    const res = await app.request(
      "/protected/me",
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
      TEST_ENV,
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("AUTH_REQUIRED");
    expect(body.error).toContain("Invalid or expired");
  });

  it("returns 401 when token was signed with different secret", async () => {
    const app = createTestApp();
    const token = await generateJWT(TEST_USER, "different-secret-entirely");

    const res = await app.request(
      "/protected/me",
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
      TEST_ENV,
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("AUTH_REQUIRED");
  });

  it("returns 401 when Authorization header has no token after Bearer", async () => {
    const app = createTestApp();
    const res = await app.request(
      "/protected/me",
      {
        method: "GET",
        headers: { Authorization: "Bearer" },
      },
      TEST_ENV,
    );

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Auth middleware: success cases
// ---------------------------------------------------------------------------

describe("authMiddleware: success cases", () => {
  it("passes through and attaches user context with valid token", async () => {
    const app = createTestApp();
    const authHeader = await makeAuthHeader();

    const res = await app.request(
      "/protected/me",
      {
        method: "GET",
        headers: { Authorization: authHeader },
      },
      TEST_ENV,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.user_id).toBe(TEST_USER.sub);
    expect(body.data.email).toBe(TEST_USER.email);
    expect(body.data.tier).toBe(TEST_USER.tier);
  });

  it("attaches correct tier for premium user", async () => {
    const app = createTestApp();
    const authHeader = await makeAuthHeader({ tier: "premium" });

    const res = await app.request(
      "/protected/me",
      {
        method: "GET",
        headers: { Authorization: authHeader },
      },
      TEST_ENV,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.tier).toBe("premium");
  });

  it("attaches correct tier for enterprise user", async () => {
    const app = createTestApp();
    const authHeader = await makeAuthHeader({ tier: "enterprise" });

    const res = await app.request(
      "/protected/me",
      {
        method: "GET",
        headers: { Authorization: authHeader },
      },
      TEST_ENV,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.tier).toBe("enterprise");
  });

  it("does not affect unprotected routes", async () => {
    const app = createTestApp();
    // No auth header, but route is unprotected
    const res = await app.request("/public/health", { method: "GET" }, TEST_ENV);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toBe("healthy");
  });
});

// ---------------------------------------------------------------------------
// Error envelope format
// ---------------------------------------------------------------------------

describe("authMiddleware: error envelope format", () => {
  it("error response matches canonical shared.ts envelope format", async () => {
    const app = createTestApp();
    const res = await app.request(
      "/protected/me",
      { method: "GET" },
      TEST_ENV,
    );

    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const body = await res.json();
    // Canonical format: { ok, error (string), error_code (string), meta: { request_id, timestamp } }
    expect(body).toHaveProperty("ok", false);
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("error_code");
    expect(body).toHaveProperty("meta");
    expect(typeof body.error).toBe("string");
    expect(typeof body.error_code).toBe("string");
    expect(body.error_code).toBe("AUTH_REQUIRED");
    expect(body.meta).toHaveProperty("request_id");
    expect(body.meta).toHaveProperty("timestamp");
    expect(body.meta.request_id).toMatch(/^req_/);
  });
});

// ---------------------------------------------------------------------------
// Mock DB helper for API key tests
// ---------------------------------------------------------------------------

function createMockDB(config?: {
  keyRow?: {
    key_id: string;
    key_hash: string;
    user_id: string;
    email: string;
  } | null;
}): AuthDB & { updateCalls: Array<{ sql: string; params: unknown[] }> } {
  const updateCalls: Array<{ sql: string; params: unknown[] }> = [];

  return {
    updateCalls,
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            first<T>(): Promise<T | null> {
              return Promise.resolve((config?.keyRow ?? null) as T | null);
            },
            run(): Promise<unknown> {
              updateCalls.push({ sql, params });
              return Promise.resolve({});
            },
          };
        },
      };
    },
  };
}

/** Create a Hono app with API key support via the auth middleware. */
function createApiKeyTestApp(db: AuthDB) {
  const app = new Hono<{ Bindings: { JWT_SECRET: string } } & AuthEnv>();

  app.use(
    "/protected/*",
    authMiddleware(
      (c) => c.env.JWT_SECRET,
      () => db,
    ),
  );

  app.get("/protected/me", (c) => {
    const user = c.get("user");
    return c.json({ ok: true, data: user });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Auth middleware: API key routing
// ---------------------------------------------------------------------------

describe("authMiddleware: API key routing", () => {
  it("routes tmk_ tokens to API key validation path", async () => {
    const { rawKey, keyHash } = await generateApiKey();
    const db = createMockDB({
      keyRow: {
        key_id: "key_01TEST",
        key_hash: keyHash,
        user_id: "usr_01HXYZ00000000000000000001",
        email: "apikey-user@example.com",
      },
    });

    const app = createApiKeyTestApp(db);
    const res = await app.request(
      "/protected/me",
      {
        method: "GET",
        headers: { Authorization: `Bearer ${rawKey}` },
      },
      TEST_ENV,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.user_id).toBe("usr_01HXYZ00000000000000000001");
    expect(body.data.email).toBe("apikey-user@example.com");
  });

  it("returns 401 for tmk_ token when DB is not configured", async () => {
    // Use the JWT-only app (no getDB provided)
    const app = createTestApp();
    const { rawKey } = await generateApiKey();

    const res = await app.request(
      "/protected/me",
      {
        method: "GET",
        headers: { Authorization: `Bearer ${rawKey}` },
      },
      TEST_ENV,
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("not configured");
  });

  it("returns 401 for tmk_ token with bad format", async () => {
    const db = createMockDB();
    const app = createApiKeyTestApp(db);

    const res = await app.request(
      "/protected/me",
      {
        method: "GET",
        headers: { Authorization: "Bearer tmk_bad_format" },
      },
      TEST_ENV,
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("Invalid API key format");
  });

  it("returns 401 when API key is not found in DB", async () => {
    const db = createMockDB({ keyRow: null });
    const app = createApiKeyTestApp(db);
    const { rawKey } = await generateApiKey();

    const res = await app.request(
      "/protected/me",
      {
        method: "GET",
        headers: { Authorization: `Bearer ${rawKey}` },
      },
      TEST_ENV,
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("Invalid or revoked");
  });

  it("returns 401 when API key hash does not match", async () => {
    const { rawKey } = await generateApiKey();
    // Use a different hash than what the key produces
    const db = createMockDB({
      keyRow: {
        key_id: "key_01TEST",
        key_hash: "0000000000000000000000000000000000000000000000000000000000000000",
        user_id: "usr_01HXYZ00000000000000000001",
        email: "user@example.com",
      },
    });

    const app = createApiKeyTestApp(db);
    const res = await app.request(
      "/protected/me",
      {
        method: "GET",
        headers: { Authorization: `Bearer ${rawKey}` },
      },
      TEST_ENV,
    );

    expect(res.status).toBe(401);
  });

  it("JWT auth still works when API key support is enabled", async () => {
    const db = createMockDB();
    const app = createApiKeyTestApp(db);
    const authHeader = await makeAuthHeader();

    const res = await app.request(
      "/protected/me",
      {
        method: "GET",
        headers: { Authorization: authHeader },
      },
      TEST_ENV,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.user_id).toBe(TEST_USER.sub);
  });
});
