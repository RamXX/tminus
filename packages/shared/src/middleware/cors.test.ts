/**
 * Unit tests for the CORS middleware.
 *
 * Tests cover:
 * - isAllowedOrigin: production origins (app.tminus.ink, tminus.ink)
 * - isAllowedOrigin: rejects unauthorized origins in production
 * - isAllowedOrigin: allows localhost in dev mode
 * - isAllowedOrigin: rejects localhost in production mode
 * - isAllowedOrigin: null/empty origin handling
 * - buildCorsHeaders: returns correct headers for allowed origins
 * - buildCorsHeaders: returns empty record for unauthorized origins
 * - buildPreflightResponse: returns 204 with correct headers for allowed origin
 * - buildPreflightResponse: returns 204 without CORS headers for unauthorized origin
 * - addCorsHeaders: applies CORS headers to a Response for allowed origins
 * - addCorsHeaders: leaves Response unchanged for unauthorized origins
 * - Constants: CORS_ALLOWED_METHODS includes GET/POST/PUT/PATCH/DELETE
 * - Constants: PRODUCTION_ORIGINS contains the correct domains
 */

import { describe, it, expect } from "vitest";
import {
  isAllowedOrigin,
  buildCorsHeaders,
  buildPreflightResponse,
  addCorsHeaders,
  PRODUCTION_ORIGINS,
  CORS_ALLOWED_METHODS,
  CORS_ALLOWED_HEADERS,
  CORS_EXPOSED_HEADERS,
  CORS_MAX_AGE,
} from "./cors";

// ---------------------------------------------------------------------------
// isAllowedOrigin -- production origins
// ---------------------------------------------------------------------------

describe("isAllowedOrigin: production origins", () => {
  it("allows https://app.tminus.ink in production", () => {
    expect(isAllowedOrigin("https://app.tminus.ink", "production")).toBe(true);
  });

  it("allows https://tminus.ink in production", () => {
    expect(isAllowedOrigin("https://tminus.ink", "production")).toBe(true);
  });

  it("allows production origins in dev mode too", () => {
    expect(isAllowedOrigin("https://app.tminus.ink", "development")).toBe(true);
    expect(isAllowedOrigin("https://tminus.ink", "development")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isAllowedOrigin -- rejects unauthorized origins
// ---------------------------------------------------------------------------

describe("isAllowedOrigin: rejects unauthorized origins", () => {
  it("rejects http://evil.com in production", () => {
    expect(isAllowedOrigin("http://evil.com", "production")).toBe(false);
  });

  it("rejects http://evil.com in development", () => {
    expect(isAllowedOrigin("http://evil.com", "development")).toBe(false);
  });

  it("rejects http://tminus.ink (wrong scheme) in production", () => {
    expect(isAllowedOrigin("http://tminus.ink", "production")).toBe(false);
  });

  it("rejects https://app.tminus.ink.evil.com (subdomain attack)", () => {
    expect(isAllowedOrigin("https://app.tminus.ink.evil.com", "production")).toBe(false);
  });

  it("rejects https://fake-tminus.ink", () => {
    expect(isAllowedOrigin("https://fake-tminus.ink", "production")).toBe(false);
  });

  it("rejects null origin", () => {
    expect(isAllowedOrigin(null, "production")).toBe(false);
  });

  it("rejects empty string origin", () => {
    expect(isAllowedOrigin("", "production")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isAllowedOrigin -- localhost in dev mode
// ---------------------------------------------------------------------------

describe("isAllowedOrigin: localhost in dev mode", () => {
  it("allows http://localhost:3000 in development", () => {
    expect(isAllowedOrigin("http://localhost:3000", "development")).toBe(true);
  });

  it("allows http://localhost:8787 in development", () => {
    expect(isAllowedOrigin("http://localhost:8787", "development")).toBe(true);
  });

  it("allows http://localhost:5173 (Vite default) in development", () => {
    expect(isAllowedOrigin("http://localhost:5173", "development")).toBe(true);
  });

  it("allows http://localhost (no port) in development", () => {
    expect(isAllowedOrigin("http://localhost", "development")).toBe(true);
  });

  it("allows http://127.0.0.1:3000 in development", () => {
    expect(isAllowedOrigin("http://127.0.0.1:3000", "development")).toBe(true);
  });

  it("allows http://127.0.0.1 (no port) in development", () => {
    expect(isAllowedOrigin("http://127.0.0.1", "development")).toBe(true);
  });

  it("rejects https://localhost:3000 (wrong scheme for dev)", () => {
    // Localhost dev servers typically run over HTTP
    expect(isAllowedOrigin("https://localhost:3000", "development")).toBe(false);
  });

  it("rejects http://localhost:3000 in production", () => {
    expect(isAllowedOrigin("http://localhost:3000", "production")).toBe(false);
  });

  it("rejects http://127.0.0.1:3000 in production", () => {
    expect(isAllowedOrigin("http://127.0.0.1:3000", "production")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildCorsHeaders -- correct headers for allowed origins
// ---------------------------------------------------------------------------

describe("buildCorsHeaders", () => {
  it("returns complete CORS headers for allowed production origin", () => {
    const headers = buildCorsHeaders("https://app.tminus.ink", "production");
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://app.tminus.ink");
    expect(headers["Access-Control-Allow-Methods"]).toBe(CORS_ALLOWED_METHODS);
    expect(headers["Access-Control-Allow-Headers"]).toBe(CORS_ALLOWED_HEADERS);
    expect(headers["Access-Control-Expose-Headers"]).toBe(CORS_EXPOSED_HEADERS);
    expect(headers["Access-Control-Max-Age"]).toBe(CORS_MAX_AGE);
    expect(headers["Vary"]).toBe("Origin");
  });

  it("sets Access-Control-Allow-Origin to the specific requesting origin", () => {
    const headers = buildCorsHeaders("https://tminus.ink", "production");
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://tminus.ink");
  });

  it("returns empty record for unauthorized origin", () => {
    const headers = buildCorsHeaders("http://evil.com", "production");
    expect(Object.keys(headers)).toHaveLength(0);
  });

  it("returns empty record for null origin", () => {
    const headers = buildCorsHeaders(null, "production");
    expect(Object.keys(headers)).toHaveLength(0);
  });

  it("returns CORS headers for localhost in dev mode", () => {
    const headers = buildCorsHeaders("http://localhost:3000", "development");
    expect(headers["Access-Control-Allow-Origin"]).toBe("http://localhost:3000");
    expect(headers["Access-Control-Allow-Methods"]).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// buildPreflightResponse -- OPTIONS handling
// ---------------------------------------------------------------------------

describe("buildPreflightResponse", () => {
  it("returns 204 status for allowed origin", () => {
    const response = buildPreflightResponse("https://app.tminus.ink", "production");
    expect(response.status).toBe(204);
  });

  it("includes CORS headers for allowed origin", () => {
    const response = buildPreflightResponse("https://app.tminus.ink", "production");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.tminus.ink",
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      CORS_ALLOWED_METHODS,
    );
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
      CORS_ALLOWED_HEADERS,
    );
    expect(response.headers.get("Access-Control-Max-Age")).toBe(CORS_MAX_AGE);
  });

  it("returns 204 without CORS headers for unauthorized origin", () => {
    const response = buildPreflightResponse("http://evil.com", "production");
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("has null body", async () => {
    const response = buildPreflightResponse("https://app.tminus.ink", "production");
    expect(response.body).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// addCorsHeaders -- apply CORS to existing Response
// ---------------------------------------------------------------------------

describe("addCorsHeaders", () => {
  it("adds CORS headers to a response for allowed origin", () => {
    const original = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const corsified = addCorsHeaders(original, "https://app.tminus.ink", "production");

    expect(corsified.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.tminus.ink",
    );
    expect(corsified.headers.get("Content-Type")).toBe("application/json");
    expect(corsified.status).toBe(200);
  });

  it("preserves original response body", async () => {
    const body = JSON.stringify({ ok: true, data: "test" });
    const original = new Response(body, { status: 200 });
    const corsified = addCorsHeaders(original, "https://app.tminus.ink", "production");
    const text = await corsified.text();
    expect(text).toBe(body);
  });

  it("returns original response (no new object) for unauthorized origin", () => {
    const original = new Response("ok", { status: 200 });
    const result = addCorsHeaders(original, "http://evil.com", "production");
    // Should be the SAME object since no CORS headers were added
    expect(result).toBe(original);
    expect(result.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("returns original response for null origin", () => {
    const original = new Response("ok", { status: 200 });
    const result = addCorsHeaders(original, null, "production");
    expect(result).toBe(original);
  });

  it("preserves Vary header alongside CORS headers", () => {
    const original = new Response("ok", { status: 200 });
    const corsified = addCorsHeaders(original, "https://tminus.ink", "production");
    expect(corsified.headers.get("Vary")).toBe("Origin");
  });
});

// ---------------------------------------------------------------------------
// Constants validation
// ---------------------------------------------------------------------------

describe("CORS constants", () => {
  it("PRODUCTION_ORIGINS includes app.tminus.ink and tminus.ink", () => {
    expect(PRODUCTION_ORIGINS).toContain("https://app.tminus.ink");
    expect(PRODUCTION_ORIGINS).toContain("https://tminus.ink");
  });

  it("PRODUCTION_ORIGINS has exactly 2 entries", () => {
    expect(PRODUCTION_ORIGINS).toHaveLength(2);
  });

  it("CORS_ALLOWED_METHODS includes all required methods", () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(CORS_ALLOWED_METHODS).toContain(method);
    }
  });

  it("CORS_ALLOWED_HEADERS includes Authorization and Content-Type", () => {
    expect(CORS_ALLOWED_HEADERS).toContain("Authorization");
    expect(CORS_ALLOWED_HEADERS).toContain("Content-Type");
  });

  it("CORS_MAX_AGE is 86400 (24 hours)", () => {
    expect(CORS_MAX_AGE).toBe("86400");
  });
});
