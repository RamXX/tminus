/**
 * Unit tests for the auth middleware.
 *
 * Tests:
 * - Missing Authorization header returns 401
 * - Non-Bearer scheme returns 401
 * - Invalid/expired JWT returns 401
 * - Valid JWT attaches user context
 * - Error response matches envelope format {ok, error: {code, message}}
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { generateJWT } from "@tminus/shared";
import { authMiddleware } from "./auth";
import type { AuthEnv } from "./auth";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const JWT_SECRET = "test-jwt-secret-must-be-at-least-this-long-for-testing";
const TEST_USER = {
  sub: "usr_01HXYZ000000000000000001",
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
    expect(body.error.code).toBe("AUTH_REQUIRED");
    expect(body.error.message).toContain("Missing");
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
    expect(body.error.code).toBe("AUTH_REQUIRED");
    expect(body.error.message).toContain("Invalid");
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
    expect(body.error.code).toBe("AUTH_REQUIRED");
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
    expect(body.error.code).toBe("AUTH_REQUIRED");
    expect(body.error.message).toContain("Invalid or expired");
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
    expect(body.error.code).toBe("AUTH_REQUIRED");
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
  it("error response has {ok: false, error: {code, message}} structure", async () => {
    const app = createTestApp();
    const res = await app.request(
      "/protected/me",
      { method: "GET" },
      TEST_ENV,
    );

    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const body = await res.json();
    expect(body).toHaveProperty("ok", false);
    expect(body).toHaveProperty("error");
    expect(body.error).toHaveProperty("code");
    expect(body.error).toHaveProperty("message");
    expect(typeof body.error.code).toBe("string");
    expect(typeof body.error.message).toBe("string");
  });
});
