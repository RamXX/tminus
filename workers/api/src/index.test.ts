/**
 * Unit tests for tminus-api worker.
 *
 * Tests the core building blocks:
 * - JWT validation logic (create, verify, expiry, bad signature)
 * - Response envelope construction (success, error)
 * - Request validation for each endpoint
 * - Routing logic (method + path matching)
 * - Auth middleware (missing, invalid, valid)
 */

import { describe, it, expect, vi } from "vitest";
import { APP_NAME, SCHEMA_VERSION } from "@tminus/shared";
import {
  createHandler,
  createJwt,
  verifyJwt,
  successEnvelope,
  errorEnvelope,
  ErrorCode,
  API_VERSION,
  validateConstraintKindAndConfig,
  VALID_CONSTRAINT_KINDS,
  computeProofHash,
  generateProofCsv,
  generateProofDocument,
  generateProofHtml,
  computeProofSignature,
  verifyProofSignature,
} from "./index";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const JWT_SECRET = "test-jwt-secret-for-unit-tests-must-be-long-enough";
const TEST_USER_ID = "usr_01HXYZ00000000000000000001";

// ---------------------------------------------------------------------------
// JWT helpers for tests
// ---------------------------------------------------------------------------

async function makeAuthHeader(
  userId?: string,
  extraClaims?: Record<string, unknown>,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await createJwt(
    {
      sub: userId ?? TEST_USER_ID,
      iat: now,
      exp: now + 3600,
      ...extraClaims,
    },
    JWT_SECRET,
  );
  return `Bearer ${token}`;
}

// ---------------------------------------------------------------------------
// Minimal mock Env
// ---------------------------------------------------------------------------

/**
 * Create a minimal mock D1Database that supports prepare().bind().first().
 * The feature-gate middleware queries the subscriptions table to resolve
 * the user tier; this mock returns { tier: "premium" } so that
 * premium-gated routes (e.g. constraints) pass the feature gate.
 */
function createMockD1(): D1Database {
  const mockStatement = {
    bind: (..._args: unknown[]) => mockStatement,
    first: async () => ({ tier: "premium" }),
    run: async () => ({ results: [], success: true, meta: {} }),
    all: async () => ({ results: [], success: true, meta: {} }),
    raw: async () => [],
  };
  return {
    prepare: (_sql: string) => mockStatement,
    dump: async () => new ArrayBuffer(0),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
  } as unknown as D1Database;
}

function createMinimalEnv(): Env {
  return {
    JWT_SECRET,
    DB: createMockD1(),
    USER_GRAPH: {} as DurableObjectNamespace,
    ACCOUNT: {} as DurableObjectNamespace,
    SYNC_QUEUE: {} as Queue,
    WRITE_QUEUE: {} as Queue,
    SESSIONS: {} as KVNamespace,
  };
}

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

// ---------------------------------------------------------------------------
// Workspace dependency resolution
// ---------------------------------------------------------------------------

describe("workspace dependency resolution", () => {
  it("imports APP_NAME from @tminus/shared via workspace link", () => {
    expect(APP_NAME).toBe("tminus");
  });

  it("imports SCHEMA_VERSION from @tminus/shared via workspace link", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// API worker: module shape
// ---------------------------------------------------------------------------

describe("api worker", () => {
  it("default export has a fetch handler", async () => {
    const mod = await import("./index");
    expect(mod.default).toBeDefined();
    expect(typeof mod.default.fetch).toBe("function");
  });

  it("exports createHandler factory", async () => {
    const mod = await import("./index");
    expect(typeof mod.createHandler).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// JWT validation unit tests
// ---------------------------------------------------------------------------

describe("JWT validation", () => {
  it("verifyJwt returns payload for valid token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await createJwt(
      { sub: TEST_USER_ID, iat: now, exp: now + 3600 },
      JWT_SECRET,
    );

    const result = await verifyJwt(token, JWT_SECRET);
    expect(result).not.toBeNull();
    expect(result!.sub).toBe(TEST_USER_ID);
  });

  it("verifyJwt returns null for wrong secret", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await createJwt(
      { sub: TEST_USER_ID, iat: now, exp: now + 3600 },
      JWT_SECRET,
    );

    const result = await verifyJwt(token, "wrong-secret-entirely-different");
    expect(result).toBeNull();
  });

  it("verifyJwt returns null for expired token", async () => {
    const pastTime = Math.floor(Date.now() / 1000) - 7200; // 2 hours ago
    const token = await createJwt(
      { sub: TEST_USER_ID, iat: pastTime, exp: pastTime + 3600 },
      JWT_SECRET,
    );

    const result = await verifyJwt(token, JWT_SECRET);
    expect(result).toBeNull();
  });

  it("verifyJwt returns null for token without sub claim", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await createJwt(
      { user: TEST_USER_ID, iat: now, exp: now + 3600 },
      JWT_SECRET,
    );

    const result = await verifyJwt(token, JWT_SECRET);
    expect(result).toBeNull();
  });

  it("verifyJwt returns null for malformed token string", async () => {
    expect(await verifyJwt("not.a.valid.jwt", JWT_SECRET)).toBeNull();
    expect(await verifyJwt("", JWT_SECRET)).toBeNull();
    expect(await verifyJwt("just-one-part", JWT_SECRET)).toBeNull();
    expect(await verifyJwt("two.parts", JWT_SECRET)).toBeNull();
  });

  it("verifyJwt accepts token without exp (no expiry check)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await createJwt({ sub: TEST_USER_ID, iat: now }, JWT_SECRET);

    const result = await verifyJwt(token, JWT_SECRET);
    expect(result).not.toBeNull();
    expect(result!.sub).toBe(TEST_USER_ID);
  });

  it("createJwt produces a 3-part dot-separated string", async () => {
    const token = await createJwt({ sub: "test" }, JWT_SECRET);
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    // All parts should be non-empty
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
    expect(parts[2].length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Response envelope unit tests
// ---------------------------------------------------------------------------

describe("response envelope", () => {
  it("successEnvelope has ok=true, data, and meta with request_id and timestamp", () => {
    const envelope = successEnvelope({ items: [1, 2, 3] });
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({ items: [1, 2, 3] });
    expect(envelope.error).toBeUndefined();
    expect(envelope.meta.request_id).toMatch(/^req_/);
    expect(typeof envelope.meta.timestamp).toBe("string");
    // Timestamp should be valid ISO
    expect(new Date(envelope.meta.timestamp).getTime()).not.toBeNaN();
  });

  it("successEnvelope includes next_cursor when provided", () => {
    const envelope = successEnvelope([], { next_cursor: "abc123" });
    expect(envelope.meta.next_cursor).toBe("abc123");
  });

  it("successEnvelope omits next_cursor when not provided", () => {
    const envelope = successEnvelope([]);
    expect(envelope.meta.next_cursor).toBeUndefined();
  });

  it("errorEnvelope has ok=false, error string, and meta", () => {
    const envelope = errorEnvelope("Something went wrong", "INTERNAL_ERROR");
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toBe("Something went wrong");
    expect(envelope.data).toBeUndefined();
    expect(envelope.meta.request_id).toMatch(/^req_/);
    expect(typeof envelope.meta.timestamp).toBe("string");
  });

  it("ErrorCode maps error names to HTTP status codes", () => {
    expect(ErrorCode.VALIDATION_ERROR).toBe(400);
    expect(ErrorCode.AUTH_REQUIRED).toBe(401);
    expect(ErrorCode.FORBIDDEN).toBe(403);
    expect(ErrorCode.NOT_FOUND).toBe(404);
    expect(ErrorCode.CONFLICT).toBe(409);
    expect(ErrorCode.INTERNAL_ERROR).toBe(500);
    expect(ErrorCode.PROVIDER_ERROR).toBe(502);
    expect(ErrorCode.PROVIDER_QUOTA).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Routing: Health endpoint (no auth)
// ---------------------------------------------------------------------------

describe("routing: health endpoint", () => {
  it("GET /health returns 200 with JSON envelope without auth", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const request = new Request("https://api.tminus.dev/health", {
      method: "GET",
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");

    const body = await response.json() as {
      ok: boolean;
      data: { status: string; version: string };
      error: null;
      meta: { timestamp: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBeDefined();
    expect(body.data.version).toBe(API_VERSION);
    expect(body.error).toBeNull();
    expect(body.meta.timestamp).toBeTruthy();
    // Timestamp should be valid ISO
    expect(new Date(body.meta.timestamp).getTime()).not.toBeNaN();
  });

  it("GET /health version matches API_VERSION constant", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const request = new Request("https://api.tminus.dev/health", {
      method: "GET",
    });

    const response = await handler.fetch(request, env, mockCtx);
    const body = await response.json() as { data: { version: string } };
    expect(body.data.version).toBe("0.0.1");
  });

  it("GET /health includes enriched fields: worker, environment, bindings", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const request = new Request("https://api.tminus.dev/health", {
      method: "GET",
    });

    const response = await handler.fetch(request, env, mockCtx);
    const body = await response.json() as {
      data: {
        worker: string;
        environment: string;
        bindings: Array<{ name: string; type: string; available: boolean }>;
      };
    };
    expect(body.data.worker).toBe("tminus-api");
    expect(body.data.environment).toBe("development");
    expect(Array.isArray(body.data.bindings)).toBe(true);
    expect(body.data.bindings.length).toBeGreaterThan(0);

    // Verify key bindings are reported
    const bindingNames = body.data.bindings.map((b) => b.name);
    expect(bindingNames).toContain("DB");
    expect(bindingNames).toContain("USER_GRAPH");
    expect(bindingNames).toContain("ACCOUNT");
    expect(bindingNames).toContain("SYNC_QUEUE");
    expect(bindingNames).toContain("WRITE_QUEUE");
    expect(bindingNames).toContain("SESSIONS");
    expect(bindingNames).toContain("RATE_LIMITS");
  });
});

// ---------------------------------------------------------------------------
// Routing: CORS preflight
// ---------------------------------------------------------------------------

describe("routing: CORS preflight", () => {
  it("OPTIONS request returns 204 with CORS headers for allowed origin", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const request = new Request("https://api.tminus.dev/v1/events", {
      method: "OPTIONS",
      headers: { Origin: "https://app.tminus.ink" },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://app.tminus.ink");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });

  it("OPTIONS request returns 204 with CORS headers for localhost in dev mode", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    // Default ENVIRONMENT is undefined which falls back to "development"
    const request = new Request("https://api.tminus.dev/v1/events", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000" },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
  });

  it("OPTIONS request returns 204 without CORS headers for unauthorized origin", async () => {
    const handler = createHandler();
    const env = { ...createMinimalEnv(), ENVIRONMENT: "production" };
    const request = new Request("https://api.tminus.dev/v1/events", {
      method: "OPTIONS",
      headers: { Origin: "http://evil.com" },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("OPTIONS preflight includes security headers", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const request = new Request("https://api.tminus.dev/v1/events", {
      method: "OPTIONS",
      headers: { Origin: "https://app.tminus.ink" },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Strict-Transport-Security")).toContain("max-age=31536000");
  });
});

// ---------------------------------------------------------------------------
// Routing: Auth enforcement
// ---------------------------------------------------------------------------

describe("routing: auth enforcement", () => {
  it("returns 401 for /v1/* routes without Authorization header", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const request = new Request("https://api.tminus.dev/v1/events", {
      method: "GET",
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(401);

    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Authentication required");
  });

  it("returns 401 for invalid Bearer token", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const request = new Request("https://api.tminus.dev/v1/events", {
      method: "GET",
      headers: { Authorization: "Bearer invalid-token-here" },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(401);
  });

  it("returns 401 for non-Bearer auth scheme", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const request = new Request("https://api.tminus.dev/v1/events", {
      method: "GET",
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Routing: Unknown routes
// ---------------------------------------------------------------------------

describe("routing: unknown routes", () => {
  it("non-v1 paths return 404 with envelope", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const request = new Request("https://api.tminus.dev/unknown", {
      method: "GET",
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(404);

    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
  });

  it("unknown v1 path returns 404 with envelope (with valid auth)", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();
    const request = new Request("https://api.tminus.dev/v1/nonexistent", {
      method: "GET",
      headers: { Authorization: authHeader },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(404);

    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Not Found");
  });
});

// ---------------------------------------------------------------------------
// Routing: All defined routes return JSON with envelope structure
// ---------------------------------------------------------------------------

describe("routing: response format", () => {
  it("all error responses have Content-Type application/json", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();

    // 404 response
    const req404 = new Request("https://api.tminus.dev/v1/nonexistent", {
      method: "GET",
      headers: { Authorization: await makeAuthHeader() },
    });
    const res404 = await handler.fetch(req404, env, mockCtx);
    expect(res404.headers.get("Content-Type")).toBe("application/json");

    // 401 response
    const req401 = new Request("https://api.tminus.dev/v1/events", {
      method: "GET",
    });
    const res401 = await handler.fetch(req401, env, mockCtx);
    expect(res401.headers.get("Content-Type")).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// Request validation unit tests
// ---------------------------------------------------------------------------

describe("request validation: events", () => {
  it("POST /v1/events without body returns 400", async () => {
    // We need a mock DO namespace that won't be reached because validation
    // fails before the DO call
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const request = new Request("https://api.tminus.dev/v1/events", {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);

    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("valid JSON");
  });

  it("POST /v1/events without start/end returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const request = new Request("https://api.tminus.dev/v1/events", {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "Test Event" }),
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);

    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("start and end");
  });

  it("GET /v1/events/:id with non-ULID ID returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const request = new Request("https://api.tminus.dev/v1/events/not-a-valid-id", {
      method: "GET",
      headers: { Authorization: authHeader },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);

    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Invalid event ID");
  });

  it("PATCH /v1/events/:id with invalid ID returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const request = new Request("https://api.tminus.dev/v1/events/bad-id", {
      method: "PATCH",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "Updated" }),
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);
  });

  it("DELETE /v1/events/:id with invalid ID returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const request = new Request("https://api.tminus.dev/v1/events/bad-id", {
      method: "DELETE",
      headers: { Authorization: authHeader },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);
  });
});

describe("request validation: accounts", () => {
  it("GET /v1/accounts/:id with invalid ID returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const request = new Request("https://api.tminus.dev/v1/accounts/not-valid", {
      method: "GET",
      headers: { Authorization: authHeader },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);
  });

  it("DELETE /v1/accounts/:id with invalid ID returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const request = new Request("https://api.tminus.dev/v1/accounts/not-valid", {
      method: "DELETE",
      headers: { Authorization: authHeader },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);
  });
});

describe("request validation: policies", () => {
  it("GET /v1/policies/:id with invalid ID returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const request = new Request("https://api.tminus.dev/v1/policies/not-valid", {
      method: "GET",
      headers: { Authorization: authHeader },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);
  });

  it("POST /v1/policies without name returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const request = new Request("https://api.tminus.dev/v1/policies", {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ description: "No name provided" }),
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);

    const body = await response.json() as { ok: boolean; error: string };
    expect(body.error).toContain("name");
  });

  it("PUT /v1/policies/:id/edges without edges array returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    // Use a syntactically valid policy ID to get past ID validation
    // We need a pol_ prefix + 26 Crockford Base32 chars
    const request = new Request(
      "https://api.tminus.dev/v1/policies/pol_01HXYZ00000000000000000001/edges",
      {
        method: "PUT",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ not_edges: [] }),
      },
    );

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);

    const body = await response.json() as { ok: boolean; error: string };
    expect(body.error).toContain("edges array");
  });
});

describe("request validation: sync status", () => {
  it("GET /v1/sync/status/:id with invalid ID returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const request = new Request("https://api.tminus.dev/v1/sync/status/not-valid", {
      method: "GET",
      headers: { Authorization: authHeader },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Constraint endpoint unit tests (TM-gj5.1)
// ---------------------------------------------------------------------------

describe("request validation: constraints", () => {
  it("POST /v1/constraints without auth returns 401", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "trip" }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(401);
  });

  it("POST /v1/constraints with empty body returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints", {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: "",
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
  });

  it("POST /v1/constraints without kind returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints", {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ config_json: {} }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("kind");
  });

  it("POST /v1/constraints without config_json returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints", {
        method: "POST",
        headers: { Authorization: authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "trip" }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("config_json");
  });

  it("DELETE /v1/constraints/:id with invalid ID returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints/not-valid-id", {
        method: "DELETE",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Invalid constraint ID");
  });

  it("GET /v1/constraints/:id with invalid ID returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints/not-valid-id", {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Invalid constraint ID");
  });

  it("GET /v1/constraints without auth returns 401", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints", { method: "GET" }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(401);
  });

  it("PUT /v1/constraints/:id with invalid ID returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints/bad-id", {
        method: "PUT",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ config_json: {} }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Invalid constraint ID");
  });

  it("PUT /v1/constraints/:id without body returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints/cst_01HXY0000000000000000000AA", {
        method: "PUT",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: "",
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
  });

  it("PUT /v1/constraints/:id without config_json returns 400", async () => {
    const handler = createHandler();
    const env = createMinimalEnv();
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/constraints/cst_01HXY0000000000000000000AA", {
        method: "PUT",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ active_from: "2026-03-01T00:00:00Z" }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.error).toContain("config_json");
  });
});

// ---------------------------------------------------------------------------
// Kind-specific config_json validation unit tests (TM-gj5.5)
// ---------------------------------------------------------------------------

describe("constraint kind validation: VALID_CONSTRAINT_KINDS", () => {
  it("contains exactly the 5 expected kinds", () => {
    expect(VALID_CONSTRAINT_KINDS.size).toBe(5);
    expect(VALID_CONSTRAINT_KINDS.has("trip")).toBe(true);
    expect(VALID_CONSTRAINT_KINDS.has("working_hours")).toBe(true);
    expect(VALID_CONSTRAINT_KINDS.has("buffer")).toBe(true);
    expect(VALID_CONSTRAINT_KINDS.has("no_meetings_after")).toBe(true);
    expect(VALID_CONSTRAINT_KINDS.has("override")).toBe(true);
  });
});

describe("constraint kind validation: invalid kind", () => {
  it("rejects unknown kind", () => {
    const result = validateConstraintKindAndConfig("unknown_kind", {});
    expect(result).not.toBeNull();
    expect(result).toContain("Invalid constraint kind");
    expect(result).toContain("unknown_kind");
  });
});

describe("constraint kind validation: trip schema", () => {
  it("accepts valid trip config", () => {
    const result = validateConstraintKindAndConfig(
      "trip",
      { name: "Paris Trip", timezone: "Europe/Paris", block_policy: "BUSY" },
      "2026-03-01T00:00:00Z",
      "2026-03-08T00:00:00Z",
    );
    expect(result).toBeNull();
  });

  it("rejects trip without name", () => {
    const result = validateConstraintKindAndConfig(
      "trip",
      { timezone: "UTC", block_policy: "BUSY" },
      "2026-03-01T00:00:00Z",
      "2026-03-08T00:00:00Z",
    );
    expect(result).toContain("name");
  });

  it("rejects trip without timezone", () => {
    const result = validateConstraintKindAndConfig(
      "trip",
      { name: "Trip", block_policy: "BUSY" },
      "2026-03-01T00:00:00Z",
      "2026-03-08T00:00:00Z",
    );
    expect(result).toContain("timezone");
  });

  it("rejects trip with invalid block_policy", () => {
    const result = validateConstraintKindAndConfig(
      "trip",
      { name: "Trip", timezone: "UTC", block_policy: "INVALID" },
      "2026-03-01T00:00:00Z",
      "2026-03-08T00:00:00Z",
    );
    expect(result).toContain("block_policy");
  });

  it("rejects trip without active_from/active_to", () => {
    const result = validateConstraintKindAndConfig(
      "trip",
      { name: "Trip", timezone: "UTC", block_policy: "BUSY" },
      null,
      null,
    );
    expect(result).toContain("active_from");
  });

  it("accepts trip with TITLE block_policy", () => {
    const result = validateConstraintKindAndConfig(
      "trip",
      { name: "Trip", timezone: "UTC", block_policy: "TITLE" },
      "2026-03-01T00:00:00Z",
      "2026-03-08T00:00:00Z",
    );
    expect(result).toBeNull();
  });
});

describe("constraint kind validation: working_hours schema", () => {
  it("accepts valid working_hours config", () => {
    const result = validateConstraintKindAndConfig("working_hours", {
      days: [1, 2, 3, 4, 5],
      start_time: "09:00",
      end_time: "17:00",
      timezone: "America/New_York",
    });
    expect(result).toBeNull();
  });

  it("rejects working_hours without days", () => {
    const result = validateConstraintKindAndConfig("working_hours", {
      start_time: "09:00",
      end_time: "17:00",
      timezone: "America/New_York",
    });
    expect(result).toContain("days");
  });

  it("rejects working_hours with empty days", () => {
    const result = validateConstraintKindAndConfig("working_hours", {
      days: [],
      start_time: "09:00",
      end_time: "17:00",
      timezone: "America/New_York",
    });
    expect(result).toContain("days");
  });

  it("rejects working_hours with invalid day value", () => {
    const result = validateConstraintKindAndConfig("working_hours", {
      days: [1, 7],
      start_time: "09:00",
      end_time: "17:00",
      timezone: "America/New_York",
    });
    expect(result).toContain("days");
  });

  it("rejects working_hours with invalid start_time format", () => {
    const result = validateConstraintKindAndConfig("working_hours", {
      days: [1, 2, 3],
      start_time: "9:00",
      end_time: "17:00",
      timezone: "UTC",
    });
    expect(result).toContain("start_time");
  });

  it("rejects working_hours with invalid end_time format", () => {
    const result = validateConstraintKindAndConfig("working_hours", {
      days: [1, 2, 3],
      start_time: "09:00",
      end_time: "25:00",
      timezone: "UTC",
    });
    expect(result).toContain("end_time");
  });

  it("rejects working_hours with end_time before start_time", () => {
    const result = validateConstraintKindAndConfig("working_hours", {
      days: [1, 2, 3],
      start_time: "17:00",
      end_time: "09:00",
      timezone: "UTC",
    });
    expect(result).toContain("end_time");
  });

  it("rejects working_hours without timezone", () => {
    const result = validateConstraintKindAndConfig("working_hours", {
      days: [1, 2, 3],
      start_time: "09:00",
      end_time: "17:00",
    });
    expect(result).toContain("timezone");
  });
});

describe("constraint kind validation: buffer schema", () => {
  it("accepts valid buffer config", () => {
    const result = validateConstraintKindAndConfig("buffer", {
      type: "travel",
      minutes: 15,
      applies_to: "all",
    });
    expect(result).toBeNull();
  });

  it("rejects buffer with invalid type", () => {
    const result = validateConstraintKindAndConfig("buffer", {
      type: "invalid",
      minutes: 15,
      applies_to: "all",
    });
    expect(result).toContain("type");
  });

  it("rejects buffer with non-integer minutes", () => {
    const result = validateConstraintKindAndConfig("buffer", {
      type: "prep",
      minutes: 15.5,
      applies_to: "all",
    });
    expect(result).toContain("minutes");
  });

  it("rejects buffer with zero minutes", () => {
    const result = validateConstraintKindAndConfig("buffer", {
      type: "prep",
      minutes: 0,
      applies_to: "all",
    });
    expect(result).toContain("minutes");
  });

  it("rejects buffer with negative minutes", () => {
    const result = validateConstraintKindAndConfig("buffer", {
      type: "prep",
      minutes: -5,
      applies_to: "all",
    });
    expect(result).toContain("minutes");
  });

  it("rejects buffer with invalid applies_to", () => {
    const result = validateConstraintKindAndConfig("buffer", {
      type: "cooldown",
      minutes: 10,
      applies_to: "internal",
    });
    expect(result).toContain("applies_to");
  });

  it("accepts buffer with cooldown type and external applies_to", () => {
    const result = validateConstraintKindAndConfig("buffer", {
      type: "cooldown",
      minutes: 5,
      applies_to: "external",
    });
    expect(result).toBeNull();
  });
});

describe("constraint kind validation: no_meetings_after schema", () => {
  it("accepts valid no_meetings_after config", () => {
    const result = validateConstraintKindAndConfig("no_meetings_after", {
      time: "18:00",
      timezone: "America/New_York",
    });
    expect(result).toBeNull();
  });

  it("rejects no_meetings_after without time", () => {
    const result = validateConstraintKindAndConfig("no_meetings_after", {
      timezone: "UTC",
    });
    expect(result).toContain("time");
  });

  it("rejects no_meetings_after with invalid time format", () => {
    const result = validateConstraintKindAndConfig("no_meetings_after", {
      time: "6pm",
      timezone: "UTC",
    });
    expect(result).toContain("time");
  });

  it("rejects no_meetings_after without timezone", () => {
    const result = validateConstraintKindAndConfig("no_meetings_after", {
      time: "18:00",
    });
    expect(result).toContain("timezone");
  });

  it("rejects no_meetings_after with empty timezone", () => {
    const result = validateConstraintKindAndConfig("no_meetings_after", {
      time: "18:00",
      timezone: "",
    });
    expect(result).toContain("timezone");
  });
});

describe("constraint kind validation: override schema", () => {
  it("accepts valid override config", () => {
    const result = validateConstraintKindAndConfig("override", {
      reason: "Doctor appointment - cannot reschedule",
    });
    expect(result).toBeNull();
  });

  it("rejects override without reason", () => {
    const result = validateConstraintKindAndConfig("override", {});
    expect(result).toContain("reason");
  });

  it("rejects override with empty reason", () => {
    const result = validateConstraintKindAndConfig("override", {
      reason: "",
    });
    expect(result).toContain("reason");
  });

  it("rejects override with whitespace-only reason", () => {
    const result = validateConstraintKindAndConfig("override", {
      reason: "   ",
    });
    expect(result).toContain("reason");
  });
});

// ---------------------------------------------------------------------------
// Commitment Proof Export unit tests
// ---------------------------------------------------------------------------

/**
 * Test fixture: minimal proof data for unit testing proof generation.
 */
function makeTestProofData(overrides?: {
  events?: Array<{
    canonical_event_id: string;
    title: string | null;
    start_ts: string;
    end_ts: string;
    hours: number;
    billing_category: string;
  }>;
  actual_hours?: number;
  status?: string;
}) {
  return {
    commitment: {
      commitment_id: "cmt_01TESTAAAAAAAAAAAAAAAAAA88",
      client_id: "client_acme",
      client_name: "Acme Corp",
      window_type: "WEEKLY",
      target_hours: 10,
      rolling_window_weeks: 4,
      hard_minimum: false,
      proof_required: true,
      created_at: "2026-02-01T00:00:00.000Z",
    },
    window_start: "2026-01-18T00:00:00.000Z",
    window_end: "2026-02-15T00:00:00.000Z",
    actual_hours: overrides?.actual_hours ?? 12.5,
    status: overrides?.status ?? "compliant",
    events: overrides?.events ?? [
      {
        canonical_event_id: "evt_01TEST000EVT00000000000001",
        title: "Sprint Planning",
        start_ts: "2026-02-10T09:00:00.000Z",
        end_ts: "2026-02-10T11:00:00.000Z",
        hours: 2,
        billing_category: "BILLABLE",
      },
      {
        canonical_event_id: "evt_01TEST000EVT00000000000002",
        title: "Code Review",
        start_ts: "2026-02-11T14:00:00.000Z",
        end_ts: "2026-02-11T16:30:00.000Z",
        hours: 2.5,
        billing_category: "BILLABLE",
      },
      {
        canonical_event_id: "evt_01TEST000EVT00000000000003",
        title: "Client Meeting",
        start_ts: "2026-02-12T10:00:00.000Z",
        end_ts: "2026-02-12T18:00:00.000Z",
        hours: 8,
        billing_category: "BILLABLE",
      },
    ],
  };
}

describe("computeProofHash", () => {
  it("returns a 64-character hex string (SHA-256)", async () => {
    const data = makeTestProofData();
    const hash = await computeProofHash(data);

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces deterministic output for same input", async () => {
    const data = makeTestProofData();
    const hash1 = await computeProofHash(data);
    const hash2 = await computeProofHash(data);

    expect(hash1).toBe(hash2);
  });

  it("produces different hash for different data", async () => {
    const data1 = makeTestProofData({ actual_hours: 10 });
    const data2 = makeTestProofData({ actual_hours: 20 });

    const hash1 = await computeProofHash(data1);
    const hash2 = await computeProofHash(data2);

    expect(hash1).not.toBe(hash2);
  });

  it("produces different hash when event list differs", async () => {
    const data1 = makeTestProofData();
    const data2 = makeTestProofData({
      events: [
        {
          canonical_event_id: "evt_different",
          title: "Different Event",
          start_ts: "2026-02-10T09:00:00.000Z",
          end_ts: "2026-02-10T11:00:00.000Z",
          hours: 2,
          billing_category: "BILLABLE",
        },
      ],
    });

    const hash1 = await computeProofHash(data1);
    const hash2 = await computeProofHash(data2);

    expect(hash1).not.toBe(hash2);
  });

  it("handles empty events array", async () => {
    const data = makeTestProofData({ events: [], actual_hours: 0 });
    const hash = await computeProofHash(data);

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("generateProofCsv", () => {
  it("includes metadata header comments", () => {
    const data = makeTestProofData();
    const csv = generateProofCsv(data, "abc123hash");

    expect(csv).toContain("# Commitment Proof Export");
    expect(csv).toContain("# Commitment ID: cmt_01TESTAAAAAAAAAAAAAAAAAA88");
    expect(csv).toContain("# Client: Acme Corp");
    expect(csv).toContain("# Target Hours: 10");
    expect(csv).toContain("# Actual Hours: 12.5");
    expect(csv).toContain("# Status: compliant");
    expect(csv).toContain("# Proof Hash (SHA-256): abc123hash");
  });

  it("includes CSV header row", () => {
    const data = makeTestProofData();
    const csv = generateProofCsv(data, "hash");

    expect(csv).toContain("event_id,title,start,end,hours,billing_category");
  });

  it("includes one row per event", () => {
    const data = makeTestProofData();
    const csv = generateProofCsv(data, "hash");

    expect(csv).toContain("evt_01TEST000EVT00000000000001,Sprint Planning,");
    expect(csv).toContain("evt_01TEST000EVT00000000000002,Code Review,");
    expect(csv).toContain("evt_01TEST000EVT00000000000003,Client Meeting,");
  });

  it("includes total event count and hours summary", () => {
    const data = makeTestProofData();
    const csv = generateProofCsv(data, "hash");

    expect(csv).toContain("# Total Events: 3");
    expect(csv).toContain("# Total Hours: 12.5");
  });

  it("falls back to client_id when client_name is null", () => {
    const data = makeTestProofData();
    data.commitment.client_name = null;
    const csv = generateProofCsv(data, "hash");

    expect(csv).toContain("# Client: client_acme");
  });

  it("escapes commas in event titles", () => {
    const data = makeTestProofData({
      events: [
        {
          canonical_event_id: "evt_comma",
          title: "Meeting, Planning, Review",
          start_ts: "2026-02-10T09:00:00.000Z",
          end_ts: "2026-02-10T10:00:00.000Z",
          hours: 1,
          billing_category: "BILLABLE",
        },
      ],
      actual_hours: 1,
    });

    const csv = generateProofCsv(data, "hash");
    // Title with commas should be quoted
    expect(csv).toContain('"Meeting, Planning, Review"');
  });

  it("handles empty events array", () => {
    const data = makeTestProofData({ events: [], actual_hours: 0 });
    const csv = generateProofCsv(data, "hash");

    expect(csv).toContain("# Total Events: 0");
    expect(csv).toContain("# Total Hours: 0");
    // Should still have header row but no data rows
    expect(csv).toContain("event_id,title,start,end,hours,billing_category");
  });
});

describe("generateProofDocument", () => {
  it("includes document title", () => {
    const data = makeTestProofData();
    const doc = generateProofDocument(data, "abc123hash");

    expect(doc).toContain("COMMITMENT PROOF DOCUMENT");
  });

  it("includes commitment details", () => {
    const data = makeTestProofData();
    const doc = generateProofDocument(data, "hash");

    expect(doc).toContain("cmt_01TESTAAAAAAAAAAAAAAAAAA88");
    expect(doc).toContain("Acme Corp");
    expect(doc).toContain("WEEKLY");
    expect(doc).toContain("4 weeks");
  });

  it("includes compliance summary", () => {
    const data = makeTestProofData();
    const doc = generateProofDocument(data, "hash");

    expect(doc).toContain("Target Hours:     10");
    expect(doc).toContain("Actual Hours:     12.5");
    expect(doc).toContain("COMPLIANT");
  });

  it("includes event-level detail", () => {
    const data = makeTestProofData();
    const doc = generateProofDocument(data, "hash");

    expect(doc).toContain("EVENT DETAIL (3 events)");
    expect(doc).toContain("Sprint Planning");
    expect(doc).toContain("Code Review");
    expect(doc).toContain("Client Meeting");
  });

  it("includes proof hash in verification section", () => {
    const data = makeTestProofData();
    const doc = generateProofDocument(data, "my_proof_hash_value");

    expect(doc).toContain("CRYPTOGRAPHIC VERIFICATION");
    expect(doc).toContain("SHA-256 Proof Hash: my_proof_hash_value");
  });

  it("shows no events message when events array is empty", () => {
    const data = makeTestProofData({ events: [], actual_hours: 0 });
    const doc = generateProofDocument(data, "hash");

    expect(doc).toContain("No events found in this window.");
    expect(doc).toContain("EVENT DETAIL (0 events)");
  });

  it("shows hard minimum and proof required flags", () => {
    const data = makeTestProofData();
    data.commitment.hard_minimum = true;
    const doc = generateProofDocument(data, "hash");

    expect(doc).toContain("Hard Minimum:     Yes");
    expect(doc).toContain("Proof Required:   Yes");
  });
});

describe("commitment proof export routing", () => {
  const handler = createHandler();
  const env = createMinimalEnv();

  it("POST /v1/commitments/:id/export requires auth", async () => {
    const request = new Request("https://api.test/v1/commitments/cmt_01TESTAAAAAAAAAAAAAAAAAA99/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "csv" }),
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(401);
  });

  it("POST /v1/commitments/:id/export rejects invalid commitment ID", async () => {
    const auth = await makeAuthHeader();
    const request = new Request("https://api.test/v1/commitments/bad-id/export", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: JSON.stringify({ format: "csv" }),
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Invalid commitment ID format");
  });

  it("POST /v1/commitments/:id/export returns 500 when PROOF_BUCKET missing", async () => {
    const auth = await makeAuthHeader();
    const request = new Request("https://api.test/v1/commitments/cmt_01TESTAAAAAAAAAAAAAAAAAA99/export", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: JSON.stringify({ format: "csv" }),
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(500);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("R2 bucket missing");
  });

  it("GET /v1/proofs/* requires auth", async () => {
    const request = new Request("https://api.test/v1/proofs/proofs/usr_test/cmt_test/file.csv");

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(401);
  });

  it("GET /v1/proofs/:id/verify requires auth", async () => {
    const request = new Request("https://api.test/v1/proofs/prf_01TESTAAAAAAAAAAAAAAAAAA01/verify");

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(401);
  });

  it("GET /v1/proofs/:id/verify returns 400 for invalid proof ID format", async () => {
    const auth = await makeAuthHeader();
    const request = new Request("https://api.test/v1/proofs/bad-id/verify", {
      headers: { Authorization: auth },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(400);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Invalid proof ID format");
  });

  it("GET /v1/proofs/:id/verify returns 500 when PROOF_BUCKET missing", async () => {
    const auth = await makeAuthHeader();
    const request = new Request("https://api.test/v1/proofs/prf_01TESTAAAAAAAAAAAAAAAAAA01/verify", {
      headers: { Authorization: auth },
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(500);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Proof export not configured");
  });
});

// ---------------------------------------------------------------------------
// generateProofHtml
// ---------------------------------------------------------------------------

describe("generateProofHtml", () => {
  it("returns valid HTML with doctype", () => {
    const data = makeTestProofData();
    const html = generateProofHtml(data, "abc123hash");

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
  });

  it("includes commitment details in HTML", () => {
    const data = makeTestProofData();
    const html = generateProofHtml(data, "abc123hash");

    expect(html).toContain("cmt_01TESTAAAAAAAAAAAAAAAAAA88");
    expect(html).toContain("Acme Corp");
    expect(html).toContain("WEEKLY");
    expect(html).toContain("4 weeks");
  });

  it("includes compliance summary", () => {
    const data = makeTestProofData();
    const html = generateProofHtml(data, "hash");

    expect(html).toContain("Target Hours");
    expect(html).toContain("10");
    expect(html).toContain("Actual Hours");
    expect(html).toContain("12.5");
    expect(html).toContain("COMPLIANT");
  });

  it("includes event detail rows", () => {
    const data = makeTestProofData();
    const html = generateProofHtml(data, "hash");

    expect(html).toContain("Sprint Planning");
    expect(html).toContain("Code Review");
    expect(html).toContain("Client Meeting");
    expect(html).toContain("evt_01TEST000EVT00000000000001");
  });

  it("shows no events message when events array is empty", () => {
    const data = makeTestProofData({ events: [], actual_hours: 0 });
    const html = generateProofHtml(data, "hash");

    expect(html).toContain("No events found in this window");
    expect(html).toContain("Event Detail (0 events)");
  });

  it("includes proof hash in verification section", () => {
    const data = makeTestProofData();
    const html = generateProofHtml(data, "my_proof_hash_value");

    expect(html).toContain("Cryptographic Verification");
    expect(html).toContain("my_proof_hash_value");
  });

  it("includes HMAC signature when provided", () => {
    const data = makeTestProofData();
    const html = generateProofHtml(data, "hash", "my_signature_value");

    expect(html).toContain("HMAC-SHA256 Signature");
    expect(html).toContain("my_signature_value");
  });

  it("omits signature section when signature is not provided", () => {
    const data = makeTestProofData();
    const html = generateProofHtml(data, "hash");

    expect(html).not.toContain("HMAC-SHA256 Signature");
  });

  it("escapes HTML special characters to prevent XSS", () => {
    const data = makeTestProofData({
      events: [
        {
          canonical_event_id: "evt_xss",
          title: '<script>alert("xss")</script>',
          start_ts: "2026-02-10T09:00:00.000Z",
          end_ts: "2026-02-10T10:00:00.000Z",
          hours: 1,
          billing_category: "BILLABLE",
        },
      ],
      actual_hours: 1,
    });

    const html = generateProofHtml(data, "hash");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("falls back to client_id when client_name is null", () => {
    const data = makeTestProofData();
    data.commitment.client_name = null;
    const html = generateProofHtml(data, "hash");

    expect(html).toContain("client_acme");
  });

  it("includes print media query styles", () => {
    const data = makeTestProofData();
    const html = generateProofHtml(data, "hash");

    expect(html).toContain("@media print");
  });
});

// ---------------------------------------------------------------------------
// computeProofSignature
// ---------------------------------------------------------------------------

const TEST_MASTER_KEY = "test-master-key-for-hmac-signing-must-be-long-enough";

describe("computeProofSignature", () => {
  it("returns a 64-character hex string (HMAC-SHA256)", async () => {
    const signature = await computeProofSignature(
      "abc123hash",
      "cmt_01TESTAAAAAAAAAAAAAAAAAA88",
      "2026-01-18T00:00:00.000Z",
      "2026-02-15T00:00:00.000Z",
      TEST_MASTER_KEY,
    );

    expect(signature).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces deterministic output for same inputs", async () => {
    const args = [
      "abc123hash",
      "cmt_01TESTAAAAAAAAAAAAAAAAAA88",
      "2026-01-18T00:00:00.000Z",
      "2026-02-15T00:00:00.000Z",
      TEST_MASTER_KEY,
    ] as const;

    const sig1 = await computeProofSignature(...args);
    const sig2 = await computeProofSignature(...args);

    expect(sig1).toBe(sig2);
  });

  it("produces different signature for different proof hashes", async () => {
    const sig1 = await computeProofSignature(
      "hash_one",
      "cmt_01TESTAAAAAAAAAAAAAAAAAA88",
      "2026-01-18T00:00:00.000Z",
      "2026-02-15T00:00:00.000Z",
      TEST_MASTER_KEY,
    );
    const sig2 = await computeProofSignature(
      "hash_two",
      "cmt_01TESTAAAAAAAAAAAAAAAAAA88",
      "2026-01-18T00:00:00.000Z",
      "2026-02-15T00:00:00.000Z",
      TEST_MASTER_KEY,
    );

    expect(sig1).not.toBe(sig2);
  });

  it("produces different signature for different commitment IDs", async () => {
    const sig1 = await computeProofSignature(
      "abc123hash",
      "cmt_01TESTAAAAAAAAAAAAAAAAAA01",
      "2026-01-18T00:00:00.000Z",
      "2026-02-15T00:00:00.000Z",
      TEST_MASTER_KEY,
    );
    const sig2 = await computeProofSignature(
      "abc123hash",
      "cmt_01TESTAAAAAAAAAAAAAAAAAA02",
      "2026-01-18T00:00:00.000Z",
      "2026-02-15T00:00:00.000Z",
      TEST_MASTER_KEY,
    );

    expect(sig1).not.toBe(sig2);
  });

  it("produces different signature for different windows", async () => {
    const sig1 = await computeProofSignature(
      "abc123hash",
      "cmt_01TESTAAAAAAAAAAAAAAAAAA88",
      "2026-01-01T00:00:00.000Z",
      "2026-01-31T00:00:00.000Z",
      TEST_MASTER_KEY,
    );
    const sig2 = await computeProofSignature(
      "abc123hash",
      "cmt_01TESTAAAAAAAAAAAAAAAAAA88",
      "2026-02-01T00:00:00.000Z",
      "2026-02-28T00:00:00.000Z",
      TEST_MASTER_KEY,
    );

    expect(sig1).not.toBe(sig2);
  });

  it("produces different signature for different keys", async () => {
    const sig1 = await computeProofSignature(
      "abc123hash",
      "cmt_01TESTAAAAAAAAAAAAAAAAAA88",
      "2026-01-18T00:00:00.000Z",
      "2026-02-15T00:00:00.000Z",
      "key-one-aaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    const sig2 = await computeProofSignature(
      "abc123hash",
      "cmt_01TESTAAAAAAAAAAAAAAAAAA88",
      "2026-01-18T00:00:00.000Z",
      "2026-02-15T00:00:00.000Z",
      "key-two-bbbbbbbbbbbbbbbbbbbbbbbbb",
    );

    expect(sig1).not.toBe(sig2);
  });
});

// ---------------------------------------------------------------------------
// verifyProofSignature
// ---------------------------------------------------------------------------

describe("verifyProofSignature", () => {
  it("returns true for valid signature", async () => {
    const proofHash = "abc123hash";
    const commitmentId = "cmt_01TESTAAAAAAAAAAAAAAAAAA88";
    const windowStart = "2026-01-18T00:00:00.000Z";
    const windowEnd = "2026-02-15T00:00:00.000Z";

    const signature = await computeProofSignature(
      proofHash,
      commitmentId,
      windowStart,
      windowEnd,
      TEST_MASTER_KEY,
    );

    const valid = await verifyProofSignature(
      proofHash,
      commitmentId,
      windowStart,
      windowEnd,
      signature,
      TEST_MASTER_KEY,
    );

    expect(valid).toBe(true);
  });

  it("returns false for tampered proof hash", async () => {
    const commitmentId = "cmt_01TESTAAAAAAAAAAAAAAAAAA88";
    const windowStart = "2026-01-18T00:00:00.000Z";
    const windowEnd = "2026-02-15T00:00:00.000Z";

    const signature = await computeProofSignature(
      "original_hash",
      commitmentId,
      windowStart,
      windowEnd,
      TEST_MASTER_KEY,
    );

    const valid = await verifyProofSignature(
      "tampered_hash",
      commitmentId,
      windowStart,
      windowEnd,
      signature,
      TEST_MASTER_KEY,
    );

    expect(valid).toBe(false);
  });

  it("returns false for tampered commitment ID", async () => {
    const proofHash = "abc123hash";
    const windowStart = "2026-01-18T00:00:00.000Z";
    const windowEnd = "2026-02-15T00:00:00.000Z";

    const signature = await computeProofSignature(
      proofHash,
      "cmt_01TESTAAAAAAAAAAAAAAAAAA88",
      windowStart,
      windowEnd,
      TEST_MASTER_KEY,
    );

    const valid = await verifyProofSignature(
      proofHash,
      "cmt_01TESTAAAAAAAAAAAAAAAAAA99",
      windowStart,
      windowEnd,
      signature,
      TEST_MASTER_KEY,
    );

    expect(valid).toBe(false);
  });

  it("returns false for wrong key", async () => {
    const proofHash = "abc123hash";
    const commitmentId = "cmt_01TESTAAAAAAAAAAAAAAAAAA88";
    const windowStart = "2026-01-18T00:00:00.000Z";
    const windowEnd = "2026-02-15T00:00:00.000Z";

    const signature = await computeProofSignature(
      proofHash,
      commitmentId,
      windowStart,
      windowEnd,
      TEST_MASTER_KEY,
    );

    const valid = await verifyProofSignature(
      proofHash,
      commitmentId,
      windowStart,
      windowEnd,
      signature,
      "wrong-key-zzzzzzzzzzzzzzzzzzzzzzz",
    );

    expect(valid).toBe(false);
  });

  it("returns false for garbage signature", async () => {
    const valid = await verifyProofSignature(
      "abc123hash",
      "cmt_01TESTAAAAAAAAAAAAAAAAAA88",
      "2026-01-18T00:00:00.000Z",
      "2026-02-15T00:00:00.000Z",
      "not-a-valid-hex-signature",
      TEST_MASTER_KEY,
    );

    expect(valid).toBe(false);
  });

  it("returns false for empty signature", async () => {
    const valid = await verifyProofSignature(
      "abc123hash",
      "cmt_01TESTAAAAAAAAAAAAAAAAAA88",
      "2026-01-18T00:00:00.000Z",
      "2026-02-15T00:00:00.000Z",
      "",
      TEST_MASTER_KEY,
    );

    expect(valid).toBe(false);
  });

  it("round-trips: sign then verify with different proof data", async () => {
    // Test multiple different inputs all round-trip correctly
    const testCases = [
      { hash: "aaa", id: "cmt_01TESTAAAAAAAAAAAAAAAAAA01", ws: "2026-01-01T00:00:00Z", we: "2026-01-31T00:00:00Z" },
      { hash: "bbb", id: "cmt_01TESTAAAAAAAAAAAAAAAAAA02", ws: "2026-02-01T00:00:00Z", we: "2026-02-28T00:00:00Z" },
      { hash: "ccc", id: "cmt_01TESTAAAAAAAAAAAAAAAAAA03", ws: "2026-03-01T00:00:00Z", we: "2026-03-31T00:00:00Z" },
    ];

    for (const tc of testCases) {
      const sig = await computeProofSignature(tc.hash, tc.id, tc.ws, tc.we, TEST_MASTER_KEY);
      const valid = await verifyProofSignature(tc.hash, tc.id, tc.ws, tc.we, sig, TEST_MASTER_KEY);
      expect(valid).toBe(true);
    }
  });
});
