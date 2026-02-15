/**
 * Integration tests for the app-gateway worker.
 *
 * These tests verify the full request flow through the Hono app
 * with realistic mock bindings, testing the interaction between
 * routing, proxy logic, SPA fallback, and security headers together.
 */

import { describe, it, expect, vi } from "vitest";
import { createApp } from "./index";
import type { AppGatewayEnv } from "./index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simulate a realistic ASSETS binding with multiple files. */
function createRealisticAssets(): Fetcher {
  const files: Record<string, { body: string; contentType: string }> = {
    "/index.html": {
      body: `<!DOCTYPE html><html><head><title>T-Minus</title></head><body><div id="root"></div><script type="module" src="/assets/index.js"></script></body></html>`,
      contentType: "text/html; charset=utf-8",
    },
    "/assets/index.js": {
      body: `import{createRoot}from"react-dom/client";console.log("app loaded");`,
      contentType: "application/javascript",
    },
    "/assets/index.css": {
      body: `body{margin:0;font-family:sans-serif}`,
      contentType: "text/css",
    },
  };

  return {
    fetch: vi.fn(async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const pathname = new URL(url).pathname;
      const file = files[pathname];
      if (file) {
        return new Response(file.body, {
          status: 200,
          headers: { "Content-Type": file.contentType },
        });
      }
      return new Response("Not Found", { status: 404 });
    }),
    connect: vi.fn(),
  } as unknown as Fetcher;
}

/** Simulate a realistic API service binding that echoes requests. */
function createRealisticApi(): Fetcher {
  return {
    fetch: vi.fn(async (input: RequestInfo) => {
      const req = input as Request;
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      // Simulate health check
      if (path === "/health" && method === "GET") {
        return new Response(
          JSON.stringify({ ok: true, data: { status: "healthy" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Simulate auth/login
      if (path === "/v1/auth/login" && method === "POST") {
        const body = await req.text();
        const parsed = JSON.parse(body);
        if (parsed.email === "test@test.com" && parsed.password === "password123") {
          return new Response(
            JSON.stringify({
              ok: true,
              data: {
                user: { id: "usr_123", email: "test@test.com", tier: "free" },
                access_token: "jwt-token-abc",
                refresh_token: "refresh-xyz",
              },
              meta: { request_id: "req_test", timestamp: new Date().toISOString() },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ ok: false, error: { code: "AUTH_FAILED", message: "Invalid credentials" } }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }

      // Simulate events list
      if (path === "/v1/events" && method === "GET") {
        const auth = req.headers.get("Authorization");
        if (!auth || !auth.startsWith("Bearer ")) {
          return new Response(
            JSON.stringify({ ok: false, error: "Authentication required" }),
            { status: 401, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            ok: true,
            data: [
              {
                canonical_event_id: "evt_001",
                summary: "Team Standup",
                start: "2025-03-01T09:00:00Z",
                end: "2025-03-01T09:30:00Z",
              },
            ],
            meta: { request_id: "req_test2", timestamp: new Date().toISOString() },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ ok: false, error: "Not Found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }),
    connect: vi.fn(),
  } as unknown as Fetcher;
}

function makeIntegrationEnv(overrides?: Partial<AppGatewayEnv>): AppGatewayEnv {
  return {
    ASSETS: createRealisticAssets(),
    ENVIRONMENT: "development",
    API: createRealisticApi(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("app-gateway integration", () => {
  describe("health endpoint", () => {
    it("returns 200 OK with json body and security headers", async () => {
      const app = createApp();
      const env = makeIntegrationEnv();
      const res = await app.fetch(
        new Request("https://app.tminus.ink/health"),
        env,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.status).toBe("ok");

      // Security headers present
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      expect(res.headers.get("Strict-Transport-Security")).toContain("31536000");
    });
  });

  describe("API proxy end-to-end flow", () => {
    it("proxies login request to API and returns auth tokens", async () => {
      const app = createApp();
      const env = makeIntegrationEnv();

      const res = await app.fetch(
        new Request("https://app.tminus.ink/api/v1/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "test@test.com", password: "password123" }),
        }),
        env,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; data: { access_token: string; user: { email: string } } };
      expect(body.ok).toBe(true);
      expect(body.data.access_token).toBe("jwt-token-abc");
      expect(body.data.user.email).toBe("test@test.com");
    });

    it("proxies failed login and returns 401", async () => {
      const app = createApp();
      const env = makeIntegrationEnv();

      const res = await app.fetch(
        new Request("https://app.tminus.ink/api/v1/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "wrong@test.com", password: "badpassword" }),
        }),
        env,
      );

      expect(res.status).toBe(401);
    });

    it("proxies authenticated events request with JWT", async () => {
      const app = createApp();
      const env = makeIntegrationEnv();

      const res = await app.fetch(
        new Request("https://app.tminus.ink/api/v1/events?start=2025-03-01", {
          headers: { Authorization: "Bearer jwt-token-abc" },
        }),
        env,
      );

      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; data: Array<{ summary: string }> };
      expect(body.ok).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].summary).toBe("Team Standup");
    });

    it("returns 401 for unauthenticated events request", async () => {
      const app = createApp();
      const env = makeIntegrationEnv();

      const res = await app.fetch(
        new Request("https://app.tminus.ink/api/v1/events"),
        env,
      );

      expect(res.status).toBe(401);
    });

    it("correctly strips /api prefix in proxy path", async () => {
      const app = createApp();
      const api = createRealisticApi();
      const env = makeIntegrationEnv({ API: api });

      await app.fetch(
        new Request("https://app.tminus.ink/api/v1/events"),
        env,
      );

      // Verify the API binding was called with correct path
      const fetchFn = api.fetch as ReturnType<typeof vi.fn>;
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const calledRequest = fetchFn.mock.calls[0][0] as Request;
      const calledUrl = new URL(calledRequest.url);
      expect(calledUrl.pathname).toBe("/v1/events");
    });
  });

  describe("SPA asset serving", () => {
    it("serves index.html for root path", async () => {
      const app = createApp();
      const env = makeIntegrationEnv();

      const res = await app.fetch(
        new Request("https://app.tminus.ink/"),
        env,
      );

      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("T-Minus");
      expect(body).toContain("<div id=\"root\">");
    });

    it("serves JS asset files directly", async () => {
      const app = createApp();
      const env = makeIntegrationEnv();

      const res = await app.fetch(
        new Request("https://app.tminus.ink/assets/index.js"),
        env,
      );

      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("createRoot");
    });

    it("serves CSS asset files directly", async () => {
      const app = createApp();
      const env = makeIntegrationEnv();

      const res = await app.fetch(
        new Request("https://app.tminus.ink/assets/index.css"),
        env,
      );

      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("font-family");
    });

    it("falls back to index.html for SPA routes like /calendar", async () => {
      const app = createApp();
      const env = makeIntegrationEnv();

      const res = await app.fetch(
        new Request("https://app.tminus.ink/calendar"),
        env,
      );

      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("<div id=\"root\">");

      // Verify no-cache headers for SPA fallback
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    });

    it("falls back to index.html for nested SPA routes", async () => {
      const app = createApp();
      const env = makeIntegrationEnv();

      const res = await app.fetch(
        new Request("https://app.tminus.ink/settings/account"),
        env,
      );

      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("<div id=\"root\">");
    });
  });

  describe("security headers on all responses", () => {
    it("applies security headers to health responses", async () => {
      const app = createApp();
      const env = makeIntegrationEnv();
      const res = await app.fetch(new Request("https://app.tminus.ink/health"), env);

      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
      expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
      expect(res.headers.get("X-DNS-Prefetch-Control")).toBe("off");
    });

    it("applies security headers to API proxy responses", async () => {
      const app = createApp();
      const env = makeIntegrationEnv();
      const res = await app.fetch(
        new Request("https://app.tminus.ink/api/v1/events", {
          headers: { Authorization: "Bearer test" },
        }),
        env,
      );

      // API responses get security headers from the middleware
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    });

    it("applies security headers to SPA fallback responses", async () => {
      const app = createApp();
      const env = makeIntegrationEnv();
      const res = await app.fetch(
        new Request("https://app.tminus.ink/login"),
        env,
      );

      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=31536000");
    });
  });
});
