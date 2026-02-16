/**
 * Unit tests for the rate limiting middleware.
 *
 * Tests cover:
 * - Token bucket / fixed window logic (increment, check, reset on window boundary)
 * - Tier-based limit selection (unauth, free, premium, enterprise)
 * - Auth endpoint limits (register 5/hr, login 10/min)
 * - 429 response format with Retry-After header
 * - Rate limit headers (X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset)
 * - Identity computation (user ID vs IP)
 * - Window key computation and reset timing
 * - Client IP extraction
 * - Auth endpoint detection
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkRateLimit,
  computeWindowKey,
  computeWindowReset,
  selectRateLimitConfig,
  getRateLimitIdentity,
  buildRateLimitHeaders,
  buildRateLimitResponse,
  detectAuthEndpoint,
  extractClientIp,
  applyRateLimitHeaders,
  TIER_LIMITS,
  AUTH_ENDPOINT_LIMITS,
  RATE_LIMIT_KEY_PREFIX,
} from "./rate-limit";
import type { RateLimitKV, RateLimitResult } from "./rate-limit";

// ---------------------------------------------------------------------------
// Mock KV implementation for unit tests
// ---------------------------------------------------------------------------

function createMockKV(): RateLimitKV & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string, _options?: { expirationTtl?: number }): Promise<void> {
      store.set(key, value);
    },
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("TIER_LIMITS", () => {
  it("defines correct limits for unauth tier", () => {
    expect(TIER_LIMITS.unauth).toEqual({ maxRequests: 10, windowSeconds: 60 });
  });

  it("defines correct limits for free tier", () => {
    expect(TIER_LIMITS.free).toEqual({ maxRequests: 100, windowSeconds: 60 });
  });

  it("defines correct limits for premium tier", () => {
    expect(TIER_LIMITS.premium).toEqual({ maxRequests: 500, windowSeconds: 60 });
  });

  it("defines correct limits for enterprise tier", () => {
    expect(TIER_LIMITS.enterprise).toEqual({ maxRequests: 2000, windowSeconds: 60 });
  });
});

describe("AUTH_ENDPOINT_LIMITS", () => {
  it("register: 5 per hour", () => {
    expect(AUTH_ENDPOINT_LIMITS.register).toEqual({
      maxRequests: 5,
      windowSeconds: 3600,
    });
  });

  it("login: 10 per minute", () => {
    expect(AUTH_ENDPOINT_LIMITS.login).toEqual({
      maxRequests: 10,
      windowSeconds: 60,
    });
  });
});

// ---------------------------------------------------------------------------
// computeWindowKey
// ---------------------------------------------------------------------------

describe("computeWindowKey", () => {
  it("produces a key with rate limit prefix, identity, and window start", () => {
    // 1700000000000ms = epoch 1700000000s
    // With a 60s window: floor(1700000000 / 60) * 60 = 1699999980
    const key = computeWindowKey("user:usr_123", 60, 1700000000000);
    expect(key).toBe("rl:user:usr_123:1699999980");
  });

  it("same window produces same key regardless of offset within window", () => {
    // Window start: floor(1699999980 / 60) * 60 = 1699999980
    // Both 1699999980 and 1699999980 + 30 are in the same window [1699999980, 1700000040)
    const key1 = computeWindowKey("ip:1.2.3.4", 60, 1699999980000);
    const key2 = computeWindowKey("ip:1.2.3.4", 60, 1699999980000 + 30000);
    expect(key1).toBe(key2);
  });

  it("different windows produce different keys", () => {
    const key1 = computeWindowKey("ip:1.2.3.4", 60, 1700000000000);
    // 61 seconds later -- next window
    const key2 = computeWindowKey("ip:1.2.3.4", 60, 1700000060000);
    expect(key1).not.toBe(key2);
  });

  it("handles hourly windows (register endpoint)", () => {
    // floor(1700000000 / 3600) * 3600 = 1699999200
    const key = computeWindowKey("auth_register:1.2.3.4", 3600, 1700000000000);
    expect(key).toBe("rl:auth_register:1.2.3.4:1699999200");
  });
});

// ---------------------------------------------------------------------------
// computeWindowReset
// ---------------------------------------------------------------------------

describe("computeWindowReset", () => {
  it("returns the end of the current window", () => {
    // floor(1700000000 / 60) * 60 = 1699999980; reset = 1699999980 + 60 = 1700000040
    const reset = computeWindowReset(60, 1700000000000);
    expect(reset).toBe(1700000040);
  });

  it("reset is always in the future relative to nowMs", () => {
    const nowMs = 1700000010000; // 10s into a window
    const reset = computeWindowReset(60, nowMs);
    expect(reset).toBeGreaterThan(Math.floor(nowMs / 1000));
  });

  it("handles hourly windows", () => {
    // floor(1700000000 / 3600) * 3600 = 1699999200; reset = 1699999200 + 3600 = 1700002800
    const reset = computeWindowReset(3600, 1700000000000);
    expect(reset).toBe(1700002800);
  });
});

// ---------------------------------------------------------------------------
// selectRateLimitConfig
// ---------------------------------------------------------------------------

describe("selectRateLimitConfig", () => {
  it("returns unauth config when tier is null", () => {
    expect(selectRateLimitConfig(null)).toEqual(TIER_LIMITS.unauth);
  });

  it("returns free tier config", () => {
    expect(selectRateLimitConfig("free")).toEqual(TIER_LIMITS.free);
  });

  it("returns premium tier config", () => {
    expect(selectRateLimitConfig("premium")).toEqual(TIER_LIMITS.premium);
  });

  it("returns enterprise tier config", () => {
    expect(selectRateLimitConfig("enterprise")).toEqual(TIER_LIMITS.enterprise);
  });

  it("auth endpoint overrides tier -- register", () => {
    // Even if user is enterprise, register endpoint uses its own limit
    expect(selectRateLimitConfig("enterprise", "register")).toEqual(
      AUTH_ENDPOINT_LIMITS.register,
    );
  });

  it("auth endpoint overrides tier -- login", () => {
    expect(selectRateLimitConfig("free", "login")).toEqual(
      AUTH_ENDPOINT_LIMITS.login,
    );
  });

  it("auth endpoint works with null tier", () => {
    expect(selectRateLimitConfig(null, "register")).toEqual(
      AUTH_ENDPOINT_LIMITS.register,
    );
  });
});

// ---------------------------------------------------------------------------
// getRateLimitIdentity
// ---------------------------------------------------------------------------

describe("getRateLimitIdentity", () => {
  it("uses user_id for authenticated requests", () => {
    expect(getRateLimitIdentity("usr_01ABC", "1.2.3.4")).toBe("user:usr_01ABC");
  });

  it("uses IP for unauthenticated requests", () => {
    expect(getRateLimitIdentity(null, "10.0.0.1")).toBe("ip:10.0.0.1");
  });

  it("uses IP with auth endpoint prefix for register", () => {
    expect(getRateLimitIdentity(null, "10.0.0.1", "register")).toBe(
      "auth_register:10.0.0.1",
    );
  });

  it("uses IP with auth endpoint prefix for login", () => {
    expect(getRateLimitIdentity(null, "10.0.0.1", "login")).toBe(
      "auth_login:10.0.0.1",
    );
  });

  it("auth endpoints always use IP even if userId is provided", () => {
    // This shouldn't normally happen, but the function should prioritize
    // the auth endpoint path
    expect(getRateLimitIdentity("usr_01ABC", "10.0.0.1", "register")).toBe(
      "auth_register:10.0.0.1",
    );
  });
});

// ---------------------------------------------------------------------------
// checkRateLimit
// ---------------------------------------------------------------------------

describe("checkRateLimit", () => {
  let kv: RateLimitKV & { store: Map<string, string> };

  beforeEach(() => {
    kv = createMockKV();
  });

  it("allows first request within window", async () => {
    const result = await checkRateLimit(
      kv,
      "user:usr_123",
      { maxRequests: 10, windowSeconds: 60 },
      1700000000000,
    );

    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(10);
    expect(result.remaining).toBe(9);
    expect(result.resetAt).toBeGreaterThan(0);
  });

  it("decrements remaining correctly across multiple requests", async () => {
    const config = { maxRequests: 3, windowSeconds: 60 };
    const now = 1700000000000;

    const r1 = await checkRateLimit(kv, "user:usr_123", config, now);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = await checkRateLimit(kv, "user:usr_123", config, now + 1000);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = await checkRateLimit(kv, "user:usr_123", config, now + 2000);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it("blocks request when limit is exceeded", async () => {
    const config = { maxRequests: 2, windowSeconds: 60 };
    const now = 1700000000000;

    await checkRateLimit(kv, "user:usr_123", config, now);
    await checkRateLimit(kv, "user:usr_123", config, now + 1000);

    const r3 = await checkRateLimit(kv, "user:usr_123", config, now + 2000);
    expect(r3.allowed).toBe(false);
    expect(r3.remaining).toBe(0);
    expect(r3.retryAfter).toBeGreaterThan(0);
  });

  it("resets count when window rolls over", async () => {
    const config = { maxRequests: 2, windowSeconds: 60 };
    const now = 1700000000000;

    // Fill up the window
    await checkRateLimit(kv, "user:usr_123", config, now);
    await checkRateLimit(kv, "user:usr_123", config, now + 1000);

    const blocked = await checkRateLimit(kv, "user:usr_123", config, now + 2000);
    expect(blocked.allowed).toBe(false);

    // 61 seconds later -- new window
    const fresh = await checkRateLimit(kv, "user:usr_123", config, now + 61000);
    expect(fresh.allowed).toBe(true);
    expect(fresh.remaining).toBe(1);
  });

  it("different users have independent counters", async () => {
    const config = { maxRequests: 1, windowSeconds: 60 };
    const now = 1700000000000;

    const r1 = await checkRateLimit(kv, "user:usr_AAA", config, now);
    expect(r1.allowed).toBe(true);

    const r2 = await checkRateLimit(kv, "user:usr_BBB", config, now);
    expect(r2.allowed).toBe(true);

    // usr_AAA is now blocked
    const r3 = await checkRateLimit(kv, "user:usr_AAA", config, now + 1000);
    expect(r3.allowed).toBe(false);

    // usr_BBB is also now blocked (independent window, same limit)
    const r4 = await checkRateLimit(kv, "user:usr_BBB", config, now + 1000);
    expect(r4.allowed).toBe(false);
  });

  it("stores counter in KV with correct key", async () => {
    const config = { maxRequests: 10, windowSeconds: 60 };
    const now = 1700000000000;

    await checkRateLimit(kv, "user:usr_123", config, now);

    const expectedKey = computeWindowKey("user:usr_123", 60, now);
    expect(kv.store.has(expectedKey)).toBe(true);
    expect(kv.store.get(expectedKey)).toBe("1");
  });

  it("retryAfter is positive when blocked", async () => {
    const config = { maxRequests: 1, windowSeconds: 60 };
    const now = 1700000010000; // 10 seconds into a window

    await checkRateLimit(kv, "ip:1.2.3.4", config, now);
    const blocked = await checkRateLimit(kv, "ip:1.2.3.4", config, now + 500);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    expect(blocked.retryAfter).toBeLessThanOrEqual(60);
  });

  it("handles hourly window for register endpoint", async () => {
    const config = AUTH_ENDPOINT_LIMITS.register; // 5/hr
    const now = 1700000000000;

    for (let i = 0; i < 5; i++) {
      const r = await checkRateLimit(kv, "auth_register:1.2.3.4", config, now + i * 1000);
      expect(r.allowed).toBe(true);
    }

    const blocked = await checkRateLimit(kv, "auth_register:1.2.3.4", config, now + 5000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    expect(blocked.retryAfter).toBeLessThanOrEqual(3600);
  });
});

// ---------------------------------------------------------------------------
// buildRateLimitHeaders
// ---------------------------------------------------------------------------

describe("buildRateLimitHeaders", () => {
  it("includes standard rate limit headers for allowed request", () => {
    const result: RateLimitResult = {
      allowed: true,
      limit: 100,
      remaining: 95,
      resetAt: 1700000060,
      retryAfter: 55,
    };

    const headers = buildRateLimitHeaders(result);
    expect(headers["X-RateLimit-Limit"]).toBe("100");
    expect(headers["X-RateLimit-Remaining"]).toBe("95");
    expect(headers["X-RateLimit-Reset"]).toBe("1700000060");
    expect(headers["Retry-After"]).toBeUndefined();
  });

  it("includes Retry-After header when rate-limited", () => {
    const result: RateLimitResult = {
      allowed: false,
      limit: 10,
      remaining: 0,
      resetAt: 1700000060,
      retryAfter: 42,
    };

    const headers = buildRateLimitHeaders(result);
    expect(headers["X-RateLimit-Limit"]).toBe("10");
    expect(headers["X-RateLimit-Remaining"]).toBe("0");
    expect(headers["X-RateLimit-Reset"]).toBe("1700000060");
    expect(headers["Retry-After"]).toBe("42");
  });
});

// ---------------------------------------------------------------------------
// buildRateLimitResponse
// ---------------------------------------------------------------------------

describe("buildRateLimitResponse", () => {
  it("returns 429 status", async () => {
    const result: RateLimitResult = {
      allowed: false,
      limit: 10,
      remaining: 0,
      resetAt: 1700000060,
      retryAfter: 30,
    };

    const response = buildRateLimitResponse(result);
    expect(response.status).toBe(429);
  });

  it("includes rate limit headers", async () => {
    const result: RateLimitResult = {
      allowed: false,
      limit: 100,
      remaining: 0,
      resetAt: 1700000060,
      retryAfter: 25,
    };

    const response = buildRateLimitResponse(result);
    expect(response.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(response.headers.get("Retry-After")).toBe("25");
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  it("body follows canonical envelope format with error string and error_code", async () => {
    const result: RateLimitResult = {
      allowed: false,
      limit: 10,
      remaining: 0,
      resetAt: 1700000060,
      retryAfter: 30,
    };

    const response = buildRateLimitResponse(result);
    const body = await response.json();

    expect(body).toMatchObject({
      ok: false,
      error: "Too many requests. Please try again later.",
      error_code: "RATE_LIMITED",
    });
    // Verify error is a string, not a nested object
    expect(typeof body.error).toBe("string");
    expect(typeof body.error_code).toBe("string");
    expect(body.meta).toBeDefined();
    expect(body.meta.request_id).toMatch(/^req_/);
    expect(body.meta.timestamp).toBeDefined();
    expect(body.meta.retry_after).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// detectAuthEndpoint
// ---------------------------------------------------------------------------

describe("detectAuthEndpoint", () => {
  it("detects /v1/auth/register", () => {
    expect(detectAuthEndpoint("/v1/auth/register")).toBe("register");
  });

  it("detects /v1/auth/login", () => {
    expect(detectAuthEndpoint("/v1/auth/login")).toBe("login");
  });

  it("detects /register (rewritten path)", () => {
    expect(detectAuthEndpoint("/register")).toBe("register");
  });

  it("detects /login (rewritten path)", () => {
    expect(detectAuthEndpoint("/login")).toBe("login");
  });

  it("returns undefined for non-auth endpoints", () => {
    expect(detectAuthEndpoint("/v1/events")).toBeUndefined();
    expect(detectAuthEndpoint("/v1/accounts")).toBeUndefined();
    expect(detectAuthEndpoint("/health")).toBeUndefined();
  });

  it("returns undefined for /v1/auth/refresh and /v1/auth/logout", () => {
    // These are auth endpoints but don't have special rate limits
    expect(detectAuthEndpoint("/v1/auth/refresh")).toBeUndefined();
    expect(detectAuthEndpoint("/v1/auth/logout")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractClientIp
// ---------------------------------------------------------------------------

describe("extractClientIp", () => {
  it("prefers CF-Connecting-IP header", () => {
    const request = new Request("https://example.com", {
      headers: {
        "CF-Connecting-IP": "1.2.3.4",
        "X-Forwarded-For": "5.6.7.8, 9.10.11.12",
      },
    });
    expect(extractClientIp(request)).toBe("1.2.3.4");
  });

  it("falls back to X-Forwarded-For (first entry)", () => {
    const request = new Request("https://example.com", {
      headers: {
        "X-Forwarded-For": "5.6.7.8, 9.10.11.12",
      },
    });
    expect(extractClientIp(request)).toBe("5.6.7.8");
  });

  it("returns 'unknown' when no IP headers present", () => {
    const request = new Request("https://example.com");
    expect(extractClientIp(request)).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// applyRateLimitHeaders
// ---------------------------------------------------------------------------

describe("applyRateLimitHeaders", () => {
  it("adds rate limit headers to an existing response", async () => {
    const original = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    const result: RateLimitResult = {
      allowed: true,
      limit: 100,
      remaining: 99,
      resetAt: 1700000060,
      retryAfter: 55,
    };

    const modified = await applyRateLimitHeaders(original, result);
    expect(modified.status).toBe(200);
    expect(modified.headers.get("Content-Type")).toBe("application/json");
    expect(modified.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(modified.headers.get("X-RateLimit-Remaining")).toBe("99");
    expect(modified.headers.get("X-RateLimit-Reset")).toBe("1700000060");
  });

  it("preserves original response status", async () => {
    const original = new Response("Created", { status: 201 });

    const result: RateLimitResult = {
      allowed: true,
      limit: 500,
      remaining: 499,
      resetAt: 1700000060,
      retryAfter: 55,
    };

    const modified = await applyRateLimitHeaders(original, result);
    expect(modified.status).toBe(201);
    expect(modified.headers.get("X-RateLimit-Limit")).toBe("500");
  });
});
