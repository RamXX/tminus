/**
 * Unit tests for the app-gateway worker.
 *
 * Tests proxy routing, SPA fallback, health endpoint, and security headers.
 * Uses mock ASSETS and API bindings.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApp, resolveApiOrigin, APP_SECURITY_HEADERS } from "./index";
import type { AppGatewayEnv } from "./index";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Create a mock ASSETS fetcher that returns known responses. */
function createMockAssets(
  responses: Record<string, { status: number; body: string; headers?: Record<string, string> }>,
): Fetcher {
  return {
    fetch: vi.fn(async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const pathname = new URL(url).pathname;
      const match = responses[pathname];
      if (match) {
        return new Response(match.body, {
          status: match.status,
          headers: match.headers ?? {},
        });
      }
      return new Response("Not Found", { status: 404 });
    }),
    connect: vi.fn(),
  } as unknown as Fetcher;
}

/** Create a mock API fetcher (service binding). */
function createMockApi(): Fetcher {
  return {
    fetch: vi.fn(async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const parsed = new URL(url);
      return new Response(
        JSON.stringify({ proxied: true, path: parsed.pathname, search: parsed.search }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
    connect: vi.fn(),
  } as unknown as Fetcher;
}

function makeEnv(overrides?: Partial<AppGatewayEnv>): AppGatewayEnv {
  return {
    ASSETS: createMockAssets({
      "/index.html": {
        status: 200,
        body: "<html><body>SPA</body></html>",
        headers: { "Content-Type": "text/html" },
      },
      "/assets/app.js": {
        status: 200,
        body: "console.log('app')",
        headers: { "Content-Type": "application/javascript" },
      },
    }),
    ENVIRONMENT: "development",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("app-gateway worker", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp();
    vi.restoreAllMocks();
  });

  describe("GET /health", () => {
    it("returns 200 with enriched health data", async () => {
      const mockApi = createMockApi();
      const env = makeEnv({ API: mockApi });
      const req = new Request("https://app.tminus.ink/health");
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);
      const data = body.data as Record<string, unknown>;
      expect(data.status).toBe("healthy");
      expect(data.version).toBe("0.0.1");
      expect(data.environment).toBe("development");
      expect(data.worker).toBe("tminus-app-gateway");
      expect(Array.isArray(data.bindings)).toBe(true);
      expect(body.meta).toBeTruthy();
    });

    it("reports ASSETS binding availability", async () => {
      const mockApi = createMockApi();
      const env = makeEnv({ API: mockApi });
      const req = new Request("https://app.tminus.ink/health");
      const res = await app.fetch(req, env);

      const body = await res.json() as Record<string, unknown>;
      const data = body.data as Record<string, unknown>;
      const bindings = data.bindings as Array<{ name: string; available: boolean }>;
      const assetsBinding = bindings.find((b) => b.name === "ASSETS");
      expect(assetsBinding?.available).toBe(true);
    });

    it("reports degraded when API service binding is missing", async () => {
      const env = makeEnv({ API: undefined });
      const req = new Request("https://app.tminus.ink/health");
      const res = await app.fetch(req, env);

      const body = await res.json() as Record<string, unknown>;
      const data = body.data as Record<string, unknown>;
      // API binding is optional and undefined by default in dev, so degraded
      expect(data.status).toBe("degraded");
    });

    it("sets Cache-Control no-store", async () => {
      const env = makeEnv();
      const req = new Request("https://app.tminus.ink/health");
      const res = await app.fetch(req, env);

      expect(res.headers.get("Cache-Control")).toBe("no-store");
    });

    it("includes security headers", async () => {
      const env = makeEnv();
      const req = new Request("https://app.tminus.ink/health");
      const res = await app.fetch(req, env);

      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=31536000");
    });
  });

  describe("API proxy (/api/*)", () => {
    it("proxies /api/v1/events to API via service binding", async () => {
      const mockApi = createMockApi();
      const env = makeEnv({ API: mockApi });
      const req = new Request("https://app.tminus.ink/api/v1/events?start=2025-01-01");
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      const body = await res.json() as { proxied: boolean; path: string; search: string };
      expect(body.proxied).toBe(true);
      expect(body.path).toBe("/v1/events");
      expect(body.search).toBe("?start=2025-01-01");
    });

    it("proxies POST /api/v1/auth/login to API", async () => {
      const mockApi = createMockApi();
      const env = makeEnv({ API: mockApi });
      const req = new Request("https://app.tminus.ink/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "test@test.com", password: "password123" }),
      });
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      const body = await res.json() as { proxied: boolean; path: string };
      expect(body.path).toBe("/v1/auth/login");
    });

    it("strips /api prefix when proxying", async () => {
      const mockApi = createMockApi();
      const env = makeEnv({ API: mockApi });
      const req = new Request("https://app.tminus.ink/api/v1/accounts");
      const res = await app.fetch(req, env);

      const body = await res.json() as { path: string };
      expect(body.path).toBe("/v1/accounts");
    });

    it("forwards Authorization header when proxying", async () => {
      const mockApi = {
        fetch: vi.fn(async (input: RequestInfo) => {
          const request = input as Request;
          const authHeader = request.headers.get("Authorization");
          return new Response(
            JSON.stringify({ auth: authHeader }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }),
        connect: vi.fn(),
      } as unknown as Fetcher;

      const env = makeEnv({ API: mockApi });
      const req = new Request("https://app.tminus.ink/api/v1/events", {
        headers: { Authorization: "Bearer test-token-123" },
      });
      const res = await app.fetch(req, env);

      const body = await res.json() as { auth: string };
      expect(body.auth).toBe("Bearer test-token-123");
    });

    it("removes host header before proxying", async () => {
      const mockApi = {
        fetch: vi.fn(async (input: RequestInfo) => {
          const request = input as Request;
          const hostHeader = request.headers.get("host");
          return new Response(
            JSON.stringify({ host: hostHeader }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }),
        connect: vi.fn(),
      } as unknown as Fetcher;

      const env = makeEnv({ API: mockApi });
      const req = new Request("https://app.tminus.ink/api/v1/events", {
        headers: { Host: "app.tminus.ink" },
      });
      const res = await app.fetch(req, env);

      const body = await res.json() as { host: string | null };
      expect(body.host).toBeNull();
    });
  });

  describe("SPA fallback", () => {
    it("serves exact asset when path matches a file", async () => {
      const env = makeEnv();
      const req = new Request("https://app.tminus.ink/assets/app.js");
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe("console.log('app')");
    });

    it("falls back to index.html for unknown routes (SPA routing)", async () => {
      const env = makeEnv();
      const req = new Request("https://app.tminus.ink/calendar");
      const res = await app.fetch(req, env);

      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("SPA");
    });

    it("sets no-cache headers on index.html fallback", async () => {
      const env = makeEnv();
      const req = new Request("https://app.tminus.ink/calendar");
      const res = await app.fetch(req, env);

      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("Pragma")).toBe("no-cache");
    });

    it("returns 500 when ASSETS binding is not configured", async () => {
      const env = makeEnv({ ASSETS: undefined as unknown as Fetcher });
      const req = new Request("https://app.tminus.ink/some-page");
      const res = await app.fetch(req, env);

      expect(res.status).toBe(500);
      const body = await res.text();
      expect(body).toContain("ASSETS binding not configured");
    });

    it("returns 404 when ASSETS has no index.html", async () => {
      const emptyAssets = createMockAssets({});
      const env = makeEnv({ ASSETS: emptyAssets });
      const req = new Request("https://app.tminus.ink/unknown");
      const res = await app.fetch(req, env);

      expect(res.status).toBe(404);
    });
  });

  describe("security headers", () => {
    it("includes all expected security headers on health response", async () => {
      const env = makeEnv();
      const req = new Request("https://app.tminus.ink/health");
      const res = await app.fetch(req, env);

      for (const [name, value] of Object.entries(APP_SECURITY_HEADERS)) {
        expect(res.headers.get(name)).toBe(value);
      }
    });

    it("includes security headers on SPA fallback response", async () => {
      const env = makeEnv();
      const req = new Request("https://app.tminus.ink/calendar");
      const res = await app.fetch(req, env);

      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    });
  });

  describe("resolveApiOrigin", () => {
    it("returns API_ORIGIN when set", () => {
      expect(
        resolveApiOrigin({ ENVIRONMENT: "production", API_ORIGIN: "https://custom.api.com" } as AppGatewayEnv),
      ).toBe("https://custom.api.com");
    });

    it("returns production URL for production environment", () => {
      expect(
        resolveApiOrigin({ ENVIRONMENT: "production" } as AppGatewayEnv),
      ).toBe("https://api.tminus.ink");
    });

    it("returns staging URL for staging environment", () => {
      expect(
        resolveApiOrigin({ ENVIRONMENT: "staging" } as AppGatewayEnv),
      ).toBe("https://api-staging.tminus.ink");
    });

    it("returns localhost for development environment", () => {
      expect(
        resolveApiOrigin({ ENVIRONMENT: "development" } as AppGatewayEnv),
      ).toBe("http://localhost:8787");
    });
  });
});
