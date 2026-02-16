/**
 * Integration tests for auth middleware with Hono router.
 *
 * Tests the FULL flow: Hono app with multiple routes, some protected
 * by auth middleware, others not. Verifies that:
 * - Unauthenticated requests to protected routes get 401
 * - Authenticated requests pass through with user context
 * - Multiple protected routes all enforce auth
 * - User context is available in downstream handlers
 * - Unprotected routes are not affected
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { generateJWT } from "@tminus/shared";
import { authMiddleware } from "./auth";
import type { AuthEnv } from "./auth";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const JWT_SECRET = "integration-test-jwt-secret-long-enough-for-hmac-256";
const TEST_USER_A = {
  sub: "usr_01HXYZ00000000000000000001",
  email: "alice@example.com",
  tier: "premium" as const,
  pwd_ver: 2,
};
const TEST_USER_B = {
  sub: "usr_01HXYZ00000000000000000002",
  email: "bob@example.com",
  tier: "free" as const,
  pwd_ver: 1,
};

// ---------------------------------------------------------------------------
// Full integration app: mimics real API structure
// ---------------------------------------------------------------------------

function createIntegrationApp() {
  const app = new Hono<{ Bindings: { JWT_SECRET: string } } & AuthEnv>();

  // Health check -- no auth
  app.get("/health", (c) => c.json({ ok: true, data: "healthy" }));

  // Auth middleware on all /v1/* routes
  app.use("/v1/*", authMiddleware((c) => c.env.JWT_SECRET));

  // Protected: get current user
  app.get("/v1/me", (c) => {
    const user = c.get("user");
    return c.json({ ok: true, data: { user } });
  });

  // Protected: list accounts (simulated)
  app.get("/v1/accounts", (c) => {
    const user = c.get("user");
    return c.json({
      ok: true,
      data: {
        accounts: [],
        owner: user.user_id,
      },
    });
  });

  // Protected: create event (simulated)
  app.post("/v1/events", async (c) => {
    const user = c.get("user");
    const body = await c.req.json();
    return c.json(
      {
        ok: true,
        data: {
          event_id: "evt_01TEST00000000000000000001",
          created_by: user.user_id,
          title: body.title,
        },
      },
      201,
    );
  });

  return app;
}

const TEST_ENV = { JWT_SECRET };

// ---------------------------------------------------------------------------
// Integration: unauthenticated requests rejected
// ---------------------------------------------------------------------------

describe("integration: unauthenticated requests", () => {
  it("GET /v1/me without auth returns 401", async () => {
    const app = createIntegrationApp();
    const res = await app.request("/v1/me", { method: "GET" }, TEST_ENV);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("AUTH_REQUIRED");
  });

  it("GET /v1/accounts without auth returns 401", async () => {
    const app = createIntegrationApp();
    const res = await app.request("/v1/accounts", { method: "GET" }, TEST_ENV);
    expect(res.status).toBe(401);
  });

  it("POST /v1/events without auth returns 401", async () => {
    const app = createIntegrationApp();
    const res = await app.request(
      "/v1/events",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Test" }),
      },
      TEST_ENV,
    );
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Integration: authenticated requests pass through
// ---------------------------------------------------------------------------

describe("integration: authenticated requests", () => {
  it("GET /v1/me with valid token returns 200 and user context", async () => {
    const app = createIntegrationApp();
    const token = await generateJWT(TEST_USER_A, JWT_SECRET);

    const res = await app.request(
      "/v1/me",
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
      TEST_ENV,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.user.user_id).toBe(TEST_USER_A.sub);
    expect(body.data.user.email).toBe(TEST_USER_A.email);
    expect(body.data.user.tier).toBe(TEST_USER_A.tier);
  });

  it("GET /v1/accounts with valid token returns owner in response", async () => {
    const app = createIntegrationApp();
    const token = await generateJWT(TEST_USER_B, JWT_SECRET);

    const res = await app.request(
      "/v1/accounts",
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
      TEST_ENV,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.owner).toBe(TEST_USER_B.sub);
  });

  it("POST /v1/events with valid token returns 201 and created_by user", async () => {
    const app = createIntegrationApp();
    const token = await generateJWT(TEST_USER_A, JWT_SECRET);

    const res = await app.request(
      "/v1/events",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Team Meeting" }),
      },
      TEST_ENV,
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.created_by).toBe(TEST_USER_A.sub);
    expect(body.data.title).toBe("Team Meeting");
  });
});

// ---------------------------------------------------------------------------
// Integration: unprotected routes not affected
// ---------------------------------------------------------------------------

describe("integration: unprotected routes", () => {
  it("GET /health works without auth", async () => {
    const app = createIntegrationApp();
    const res = await app.request("/health", { method: "GET" }, TEST_ENV);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toBe("healthy");
  });
});

// ---------------------------------------------------------------------------
// Integration: different users get different contexts
// ---------------------------------------------------------------------------

describe("integration: multi-user isolation", () => {
  it("different tokens yield different user contexts", async () => {
    const app = createIntegrationApp();

    const tokenA = await generateJWT(TEST_USER_A, JWT_SECRET);
    const tokenB = await generateJWT(TEST_USER_B, JWT_SECRET);

    const resA = await app.request(
      "/v1/me",
      {
        method: "GET",
        headers: { Authorization: `Bearer ${tokenA}` },
      },
      TEST_ENV,
    );

    const resB = await app.request(
      "/v1/me",
      {
        method: "GET",
        headers: { Authorization: `Bearer ${tokenB}` },
      },
      TEST_ENV,
    );

    const bodyA = await resA.json();
    const bodyB = await resB.json();

    expect(bodyA.data.user.user_id).toBe(TEST_USER_A.sub);
    expect(bodyA.data.user.email).toBe(TEST_USER_A.email);
    expect(bodyB.data.user.user_id).toBe(TEST_USER_B.sub);
    expect(bodyB.data.user.email).toBe(TEST_USER_B.email);
    expect(bodyA.data.user.user_id).not.toBe(bodyB.data.user.user_id);
  });
});
