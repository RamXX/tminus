/**
 * Unit tests for per-org rate limiting (TM-9iu.5).
 *
 * Tests cover:
 * - Fixed-window key computation per org/bucket
 * - Window reset timing
 * - Rate limit checking and counter increment
 * - Per-bucket configuration (api, directory, impersonation)
 * - Impersonation per-user tracking
 * - 429 response with proper headers
 * - Rate limit header construction
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  checkOrgRateLimit,
  computeOrgWindowKey,
  computeOrgWindowReset,
  getBucketConfig,
  buildOrgRateLimitHeaders,
  buildOrgRateLimitResponse,
  DEFAULT_ORG_RATE_LIMITS,
  ORG_RATE_LIMIT_PREFIX,
} from "./org-rate-limit";
import type { OrgRateLimitStore, OrgRateLimitConfig, OrgRateLimitResult } from "./org-rate-limit";

// ---------------------------------------------------------------------------
// In-memory store for unit tests
// ---------------------------------------------------------------------------

function createMockStore(): OrgRateLimitStore & { counters: Map<string, number> } {
  const counters = new Map<string, number>();
  return {
    counters,
    async getCount(key: string): Promise<number> {
      return counters.get(key) ?? 0;
    },
    async incrementCount(key: string, _ttlSeconds: number): Promise<number> {
      const current = counters.get(key) ?? 0;
      const newCount = current + 1;
      counters.set(key, newCount);
      return newCount;
    },
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("DEFAULT_ORG_RATE_LIMITS", () => {
  it("defines sensible defaults for all buckets", () => {
    expect(DEFAULT_ORG_RATE_LIMITS.apiMaxRequests).toBe(1000);
    expect(DEFAULT_ORG_RATE_LIMITS.apiWindowSeconds).toBe(60);
    expect(DEFAULT_ORG_RATE_LIMITS.directoryMaxRequests).toBe(100);
    expect(DEFAULT_ORG_RATE_LIMITS.directoryWindowSeconds).toBe(60);
    expect(DEFAULT_ORG_RATE_LIMITS.impersonationMaxRequests).toBe(60);
    expect(DEFAULT_ORG_RATE_LIMITS.impersonationWindowSeconds).toBe(60);
  });
});

describe("ORG_RATE_LIMIT_PREFIX", () => {
  it("uses correct prefix", () => {
    expect(ORG_RATE_LIMIT_PREFIX).toBe("org_rl:");
  });
});

// ---------------------------------------------------------------------------
// computeOrgWindowKey
// ---------------------------------------------------------------------------

describe("computeOrgWindowKey", () => {
  it("produces key with org ID, bucket, and window start", () => {
    // 1700000000000ms => epoch 1700000000s, window=60: floor(1700000000/60)*60 = 1699999980
    const key = computeOrgWindowKey("org_123", "api", 60, 1700000000000);
    expect(key).toBe("org_rl:org_123:api:1699999980");
  });

  it("produces different keys for different buckets", () => {
    const now = 1700000000000;
    const apiKey = computeOrgWindowKey("org_123", "api", 60, now);
    const dirKey = computeOrgWindowKey("org_123", "directory", 60, now);
    expect(apiKey).not.toBe(dirKey);
    expect(apiKey).toContain(":api:");
    expect(dirKey).toContain(":directory:");
  });

  it("includes user email for impersonation bucket", () => {
    const key = computeOrgWindowKey("org_123", "impersonation", 60, 1700000000000, "user@example.com");
    expect(key).toBe("org_rl:org_123:impersonation:user@example.com:1699999980");
  });

  it("same window produces same key", () => {
    const key1 = computeOrgWindowKey("org_123", "api", 60, 1699999980000);
    const key2 = computeOrgWindowKey("org_123", "api", 60, 1699999980000 + 30000);
    expect(key1).toBe(key2);
  });

  it("different windows produce different keys", () => {
    const key1 = computeOrgWindowKey("org_123", "api", 60, 1700000000000);
    const key2 = computeOrgWindowKey("org_123", "api", 60, 1700000060000);
    expect(key1).not.toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// computeOrgWindowReset
// ---------------------------------------------------------------------------

describe("computeOrgWindowReset", () => {
  it("returns end of current window", () => {
    // floor(1700000000/60)*60 = 1699999980; reset = 1699999980 + 60 = 1700000040
    const reset = computeOrgWindowReset(60, 1700000000000);
    expect(reset).toBe(1700000040);
  });

  it("reset is always in the future", () => {
    const nowMs = 1700000010000;
    const reset = computeOrgWindowReset(60, nowMs);
    expect(reset).toBeGreaterThan(Math.floor(nowMs / 1000));
  });
});

// ---------------------------------------------------------------------------
// getBucketConfig
// ---------------------------------------------------------------------------

describe("getBucketConfig", () => {
  it("returns api bucket config", () => {
    const cfg = getBucketConfig(DEFAULT_ORG_RATE_LIMITS, "api");
    expect(cfg).toEqual({ maxRequests: 1000, windowSeconds: 60 });
  });

  it("returns directory bucket config", () => {
    const cfg = getBucketConfig(DEFAULT_ORG_RATE_LIMITS, "directory");
    expect(cfg).toEqual({ maxRequests: 100, windowSeconds: 60 });
  });

  it("returns impersonation bucket config", () => {
    const cfg = getBucketConfig(DEFAULT_ORG_RATE_LIMITS, "impersonation");
    expect(cfg).toEqual({ maxRequests: 60, windowSeconds: 60 });
  });
});

// ---------------------------------------------------------------------------
// checkOrgRateLimit
// ---------------------------------------------------------------------------

describe("checkOrgRateLimit", () => {
  let store: OrgRateLimitStore & { counters: Map<string, number> };

  beforeEach(() => {
    store = createMockStore();
  });

  it("allows first request", async () => {
    const result = await checkOrgRateLimit(store, "org_123", "api", DEFAULT_ORG_RATE_LIMITS, 1700000000000);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(1000);
    expect(result.remaining).toBe(999);
    expect(result.bucket).toBe("api");
  });

  it("decrements remaining across requests", async () => {
    const config: OrgRateLimitConfig = {
      ...DEFAULT_ORG_RATE_LIMITS,
      apiMaxRequests: 3,
    };
    const now = 1700000000000;

    const r1 = await checkOrgRateLimit(store, "org_123", "api", config, now);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = await checkOrgRateLimit(store, "org_123", "api", config, now + 1000);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = await checkOrgRateLimit(store, "org_123", "api", config, now + 2000);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it("blocks when limit exceeded", async () => {
    const config: OrgRateLimitConfig = {
      ...DEFAULT_ORG_RATE_LIMITS,
      apiMaxRequests: 2,
    };
    const now = 1700000000000;

    await checkOrgRateLimit(store, "org_123", "api", config, now);
    await checkOrgRateLimit(store, "org_123", "api", config, now + 500);
    const r3 = await checkOrgRateLimit(store, "org_123", "api", config, now + 1000);

    expect(r3.allowed).toBe(false);
    expect(r3.remaining).toBe(0);
    expect(r3.retryAfter).toBeGreaterThan(0);
  });

  it("resets count when window rolls over", async () => {
    const config: OrgRateLimitConfig = {
      ...DEFAULT_ORG_RATE_LIMITS,
      apiMaxRequests: 1,
    };
    const now = 1700000000000;

    await checkOrgRateLimit(store, "org_123", "api", config, now);
    const blocked = await checkOrgRateLimit(store, "org_123", "api", config, now + 1000);
    expect(blocked.allowed).toBe(false);

    // 61 seconds later -- new window
    const fresh = await checkOrgRateLimit(store, "org_123", "api", config, now + 61000);
    expect(fresh.allowed).toBe(true);
  });

  it("different orgs have independent counters", async () => {
    const config: OrgRateLimitConfig = {
      ...DEFAULT_ORG_RATE_LIMITS,
      apiMaxRequests: 1,
    };
    const now = 1700000000000;

    await checkOrgRateLimit(store, "org_AAA", "api", config, now);
    const r2 = await checkOrgRateLimit(store, "org_BBB", "api", config, now);
    expect(r2.allowed).toBe(true);
  });

  it("tracks directory bucket separately from api bucket", async () => {
    const config: OrgRateLimitConfig = {
      ...DEFAULT_ORG_RATE_LIMITS,
      apiMaxRequests: 1,
      directoryMaxRequests: 1,
    };
    const now = 1700000000000;

    await checkOrgRateLimit(store, "org_123", "api", config, now);
    const blocked = await checkOrgRateLimit(store, "org_123", "api", config, now + 500);
    expect(blocked.allowed).toBe(false);

    // Directory bucket is independent
    const dirResult = await checkOrgRateLimit(store, "org_123", "directory", config, now + 500);
    expect(dirResult.allowed).toBe(true);
    expect(dirResult.bucket).toBe("directory");
  });

  it("tracks impersonation per-user within org", async () => {
    const config: OrgRateLimitConfig = {
      ...DEFAULT_ORG_RATE_LIMITS,
      impersonationMaxRequests: 1,
    };
    const now = 1700000000000;

    await checkOrgRateLimit(store, "org_123", "impersonation", config, now, "user1@example.com");
    const blockedUser1 = await checkOrgRateLimit(store, "org_123", "impersonation", config, now + 500, "user1@example.com");
    expect(blockedUser1.allowed).toBe(false);

    // Different user in same org is allowed
    const user2 = await checkOrgRateLimit(store, "org_123", "impersonation", config, now + 500, "user2@example.com");
    expect(user2.allowed).toBe(true);
  });

  it("uses default config when none provided", async () => {
    const result = await checkOrgRateLimit(store, "org_123", "api");
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(DEFAULT_ORG_RATE_LIMITS.apiMaxRequests);
  });
});

// ---------------------------------------------------------------------------
// buildOrgRateLimitHeaders
// ---------------------------------------------------------------------------

describe("buildOrgRateLimitHeaders", () => {
  it("includes standard rate limit headers for allowed request", () => {
    const result: OrgRateLimitResult = {
      allowed: true,
      limit: 1000,
      remaining: 999,
      resetAt: 1700000060,
      retryAfter: 55,
      bucket: "api",
    };

    const headers = buildOrgRateLimitHeaders(result);
    expect(headers["X-RateLimit-Limit"]).toBe("1000");
    expect(headers["X-RateLimit-Remaining"]).toBe("999");
    expect(headers["X-RateLimit-Reset"]).toBe("1700000060");
    expect(headers["Retry-After"]).toBeUndefined();
  });

  it("includes Retry-After when rate-limited", () => {
    const result: OrgRateLimitResult = {
      allowed: false,
      limit: 100,
      remaining: 0,
      resetAt: 1700000060,
      retryAfter: 42,
      bucket: "directory",
    };

    const headers = buildOrgRateLimitHeaders(result);
    expect(headers["Retry-After"]).toBe("42");
  });
});

// ---------------------------------------------------------------------------
// buildOrgRateLimitResponse
// ---------------------------------------------------------------------------

describe("buildOrgRateLimitResponse", () => {
  it("returns 429 status with rate limit headers", async () => {
    const result: OrgRateLimitResult = {
      allowed: false,
      limit: 100,
      remaining: 0,
      resetAt: 1700000060,
      retryAfter: 30,
      bucket: "api",
    };

    const response = buildOrgRateLimitResponse(result);
    expect(response.status).toBe(429);
    expect(response.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  it("body includes RATE_LIMITED error code and bucket info", async () => {
    const result: OrgRateLimitResult = {
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAt: 1700000060,
      retryAfter: 25,
      bucket: "impersonation",
    };

    const response = buildOrgRateLimitResponse(result);
    const body = await response.json();

    expect(body).toMatchObject({
      ok: false,
      error: {
        code: "RATE_LIMITED",
      },
    });
    expect(body.error.message).toContain("impersonation");
    expect(body.meta.bucket).toBe("impersonation");
    expect(body.meta.retry_after).toBe(25);
  });
});
