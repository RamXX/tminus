/**
 * Unit tests for the security headers middleware.
 *
 * Tests cover:
 * - getSecurityHeaders() returns all required security headers
 * - Each individual header has the correct value
 * - addSecurityHeaders() applies all headers to a Response
 * - addSecurityHeaders() preserves the original response body, status, and existing headers
 * - HSTS_MAX_AGE constant is 31536000 (1 year)
 * - SECURITY_HEADERS is frozen / not accidentally mutated
 */

import { describe, it, expect } from "vitest";
import {
  getSecurityHeaders,
  addSecurityHeaders,
  SECURITY_HEADERS,
  HSTS_MAX_AGE,
} from "./security";

// ---------------------------------------------------------------------------
// getSecurityHeaders() -- returns all required headers
// ---------------------------------------------------------------------------

describe("getSecurityHeaders", () => {
  it("returns X-Frame-Options: DENY", () => {
    const headers = getSecurityHeaders();
    expect(headers["X-Frame-Options"]).toBe("DENY");
  });

  it("returns X-Content-Type-Options: nosniff", () => {
    const headers = getSecurityHeaders();
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("returns HSTS with max-age=31536000 and includeSubDomains", () => {
    const headers = getSecurityHeaders();
    expect(headers["Strict-Transport-Security"]).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });

  it("returns Content-Security-Policy with strict defaults for API", () => {
    const headers = getSecurityHeaders();
    expect(headers["Content-Security-Policy"]).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
  });

  it("returns Permissions-Policy disabling camera, microphone, geolocation", () => {
    const headers = getSecurityHeaders();
    expect(headers["Permissions-Policy"]).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
  });

  it("returns Referrer-Policy: strict-origin-when-cross-origin", () => {
    const headers = getSecurityHeaders();
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("returns X-DNS-Prefetch-Control: off", () => {
    const headers = getSecurityHeaders();
    expect(headers["X-DNS-Prefetch-Control"]).toBe("off");
  });

  it("returns a fresh object on each call (not a shared reference)", () => {
    const a = getSecurityHeaders();
    const b = getSecurityHeaders();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// HSTS_MAX_AGE constant
// ---------------------------------------------------------------------------

describe("HSTS_MAX_AGE", () => {
  it("equals 31536000 (1 year in seconds)", () => {
    expect(HSTS_MAX_AGE).toBe(31536000);
    // Verify it really is 365 * 24 * 60 * 60
    expect(HSTS_MAX_AGE).toBe(365 * 24 * 60 * 60);
  });
});

// ---------------------------------------------------------------------------
// SECURITY_HEADERS constant
// ---------------------------------------------------------------------------

describe("SECURITY_HEADERS constant", () => {
  it("contains exactly 7 headers", () => {
    expect(Object.keys(SECURITY_HEADERS)).toHaveLength(7);
  });

  it("is frozen (immutable)", () => {
    expect(Object.isFrozen(SECURITY_HEADERS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// addSecurityHeaders() -- applies headers to Response
// ---------------------------------------------------------------------------

describe("addSecurityHeaders", () => {
  it("adds all security headers to a plain response", () => {
    const original = new Response("hello", { status: 200 });
    const secured = addSecurityHeaders(original);

    expect(secured.headers.get("X-Frame-Options")).toBe("DENY");
    expect(secured.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(secured.headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(secured.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(secured.headers.get("Permissions-Policy")).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
    expect(secured.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(secured.headers.get("X-DNS-Prefetch-Control")).toBe("off");
  });

  it("preserves the original response status", () => {
    const original = new Response("not found", { status: 404 });
    const secured = addSecurityHeaders(original);
    expect(secured.status).toBe(404);
  });

  it("preserves the original response body", async () => {
    const body = JSON.stringify({ ok: true, data: "test" });
    const original = new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const secured = addSecurityHeaders(original);
    const text = await secured.text();
    expect(text).toBe(body);
  });

  it("preserves existing headers from the original response", () => {
    const original = new Response("ok", {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-Custom-Header": "custom-value",
      },
    });
    const secured = addSecurityHeaders(original);
    expect(secured.headers.get("Content-Type")).toBe("application/json");
    expect(secured.headers.get("X-Custom-Header")).toBe("custom-value");
    // Also has security headers
    expect(secured.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("returns a new Response (does not mutate the original)", () => {
    const original = new Response("ok", { status: 200 });
    const secured = addSecurityHeaders(original);
    expect(secured).not.toBe(original);
    // Original should NOT have security headers
    expect(original.headers.get("X-Frame-Options")).toBeNull();
  });
});
