/**
 * tminus-app-gateway -- SPA gateway worker.
 *
 * Serves the React SPA via Workers Assets and proxies /api/* requests
 * to the tminus-api worker. Adds security headers to all responses.
 *
 * Routes:
 *   GET  /health    - Health check (200 OK)
 *   ALL  /api/*     - Proxy to api-worker (rewrite URL to api.tminus.ink)
 *   GET  *          - SPA fallback (serve index.html via ASSETS binding)
 *
 * IMPORTANT: Worker entrypoint must NOT export constants/types
 * (workerd restriction from retro learning).
 */

import { Hono } from "hono";

// ---------------------------------------------------------------------------
// Env bindings
// ---------------------------------------------------------------------------

interface AppGatewayEnv {
  /** Workers Assets binding for static file serving. */
  ASSETS: Fetcher;
  /** Deployment environment: "production", "staging", or "development". */
  ENVIRONMENT: string;
  /** Optional: API worker service binding. */
  API?: Fetcher;
  /** Optional: API origin for URL-based proxying when service binding is unavailable. */
  API_ORIGIN?: string;
}

// ---------------------------------------------------------------------------
// Security headers (inlined to avoid exporting from entrypoint)
// ---------------------------------------------------------------------------

/**
 * Security headers for the app gateway.
 *
 * Note: CSP is more permissive than the API worker because we serve HTML/JS.
 * We allow 'self' for scripts, styles, images, and connections back to the
 * same origin (which covers /api/* proxy).
 */
const APP_SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-DNS-Prefetch-Control": "off",
};

function applySecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(APP_SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function createApp(): Hono<{ Bindings: AppGatewayEnv }> {
  const app = new Hono<{ Bindings: AppGatewayEnv }>();

  // Apply security headers to all responses
  app.use("*", async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(APP_SECURITY_HEADERS)) {
      c.header(name, value);
    }
  });

  // Health check
  app.get("/health", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // API proxy: forward /api/* to the api-worker
  app.all("/api/*", async (c) => {
    const method = c.req.method.toUpperCase();
    const incomingUrl = new URL(c.req.url);

    // Strip /api prefix: /api/v1/events -> /v1/events
    const apiPath = incomingUrl.pathname.replace(/^\/api/, "");
    const search = incomingUrl.search;

    const headers = new Headers(c.req.raw.headers);
    // Remove host header so the target worker sees its own host
    headers.delete("host");

    const hasBody = !["GET", "HEAD", "OPTIONS"].includes(method);
    const body = hasBody ? c.req.raw.body : undefined;

    // Prefer service binding (zero-latency in-datacenter call)
    if (c.env.API) {
      const targetUrl = new URL(`${apiPath}${search}`, "https://api.internal");
      const reqInit: RequestInit = { method, headers, body };
      if (hasBody) {
        // duplex is required by Node.js for streaming request bodies
        (reqInit as Record<string, unknown>)["duplex"] = "half";
      }
      return c.env.API.fetch(new Request(targetUrl.toString(), reqInit));
    }

    // Fallback: URL-based proxying
    const apiOrigin = resolveApiOrigin(c.env);
    const targetUrl = new URL(`${apiPath}${search}`, apiOrigin);
    const reqInit: RequestInit = { method, headers, body };
    if (hasBody) {
      (reqInit as Record<string, unknown>)["duplex"] = "half";
    }
    return fetch(new Request(targetUrl.toString(), reqInit));
  });

  // SPA fallback: serve static assets, or index.html for client-side routing
  app.get("*", async (c) => {
    if (!c.env.ASSETS) {
      return c.text("ASSETS binding not configured", 500);
    }

    // First, try to serve the exact requested asset
    const assetResponse = await c.env.ASSETS.fetch(c.req.raw);
    if (assetResponse.status === 200 || assetResponse.status === 304) {
      return assetResponse;
    }

    // If the asset wasn't found, serve index.html for SPA client-side routing
    const url = new URL(c.req.url);
    const indexRequest = new Request(
      new URL("/index.html", url.origin),
      c.req.raw,
    );
    let indexResponse = await c.env.ASSETS.fetch(indexRequest);

    // Handle potential redirects from the ASSETS binding
    if ([301, 302, 307, 308].includes(indexResponse.status)) {
      const location = indexResponse.headers.get("location");
      if (location) {
        const redirectUrl = new URL(location, url.origin);
        indexResponse = await c.env.ASSETS.fetch(
          new Request(redirectUrl, c.req.raw),
        );
      }
    }

    if (indexResponse.status === 200 || indexResponse.status === 304) {
      // Disable caching for index.html so updates propagate immediately
      const response = new Response(indexResponse.body, indexResponse);
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("Pragma", "no-cache");
      return response;
    }

    return c.text("Not Found", 404);
  });

  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveApiOrigin(env: AppGatewayEnv): string {
  if (env.API_ORIGIN) return env.API_ORIGIN;
  if (env.ENVIRONMENT === "staging") return "https://api-staging.tminus.ink";
  if (env.ENVIRONMENT === "production") return "https://api.tminus.ink";
  return "http://localhost:8787";
}

// ---------------------------------------------------------------------------
// Default export (workerd entrypoint)
// ---------------------------------------------------------------------------

const app = createApp();
export default app;

// Export for testing only
export { createApp, resolveApiOrigin, APP_SECURITY_HEADERS, applySecurityHeaders };
export type { AppGatewayEnv };
