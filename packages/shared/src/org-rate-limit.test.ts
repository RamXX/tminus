/**
 * Unit tests for per-org rate limiting (TM-9iu.5).
 *
 * Tests cover:
 * - Sliding-window key computation per org/bucket
 * - Window reset timing
 * - Rate limit checking with sliding window log
 * - Per-bucket configuration (api, directory, impersonation)
 * - Impersonation per-user tracking
 * - 429 response with proper headers
 * - Rate limit header construction
 * - Exponential backoff with jitter (AC#2)
 * - Request queue for excess requests (AC#3)
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
  computeBackoffDelay,
  withBackoff,
  DEFAULT_BACKOFF_CONFIG,
  OrgRequestQueue,
} from "./org-rate-limit";
import type { OrgRateLimitStore, OrgRateLimitConfig, OrgRateLimitResult, BackoffConfig } from "./org-rate-limit";

// ---------------------------------------------------------------------------
// In-memory store for unit tests (sliding window log implementation)
// ---------------------------------------------------------------------------

function createMockStore(): OrgRateLimitStore & {
  timestamps: Map<string, number[]>;
  counters: Map<string, number>;
} {
  const timestamps = new Map<string, number[]>();
  const counters = new Map<string, number>();
  return {
    timestamps,
    counters,
    // Legacy fixed-window methods (kept for backward compatibility)
    async getCount(key: string): Promise<number> {
      return counters.get(key) ?? 0;
    },
    async incrementCount(key: string, _ttlSeconds: number): Promise<number> {
      const current = counters.get(key) ?? 0;
      const newCount = current + 1;
      counters.set(key, newCount);
      return newCount;
    },
    // Sliding-window methods
    async addTimestamp(key: string, timestampMs: number, _ttlSeconds: number): Promise<void> {
      const existing = timestamps.get(key) ?? [];
      existing.push(timestampMs);
      timestamps.set(key, existing);
    },
    async countInWindow(key: string, windowStartMs: number): Promise<number> {
      const existing = timestamps.get(key) ?? [];
      return existing.filter((ts) => ts >= windowStartMs).length;
    },
    async pruneExpired(key: string, beforeMs: number): Promise<void> {
      const existing = timestamps.get(key) ?? [];
      timestamps.set(key, existing.filter((ts) => ts >= beforeMs));
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
// computeOrgWindowKey (sliding window -- no window start in key)
// ---------------------------------------------------------------------------

describe("computeOrgWindowKey", () => {
  it("produces key with org ID and bucket (no window start for sliding)", () => {
    const key = computeOrgWindowKey("org_123", "api", 60, 1700000000000);
    expect(key).toBe("org_rl:org_123:api");
  });

  it("produces different keys for different buckets", () => {
    const now = 1700000000000;
    const apiKey = computeOrgWindowKey("org_123", "api", 60, now);
    const dirKey = computeOrgWindowKey("org_123", "directory", 60, now);
    expect(apiKey).not.toBe(dirKey);
    expect(apiKey).toContain(":api");
    expect(dirKey).toContain(":directory");
  });

  it("includes user email for impersonation bucket", () => {
    const key = computeOrgWindowKey("org_123", "impersonation", 60, 1700000000000, "user@example.com");
    expect(key).toBe("org_rl:org_123:impersonation:user@example.com");
  });

  it("same key regardless of time (sliding window)", () => {
    const key1 = computeOrgWindowKey("org_123", "api", 60, 1699999980000);
    const key2 = computeOrgWindowKey("org_123", "api", 60, 1699999980000 + 30000);
    expect(key1).toBe(key2);
  });

  it("different orgs produce different keys", () => {
    const key1 = computeOrgWindowKey("org_123", "api", 60, 1700000000000);
    const key2 = computeOrgWindowKey("org_456", "api", 60, 1700000000000);
    expect(key1).not.toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// computeOrgWindowReset
// ---------------------------------------------------------------------------

describe("computeOrgWindowReset", () => {
  it("returns now + windowSeconds for sliding window", () => {
    // floor(1700000000000 / 1000) + 60 = 1700000060
    const reset = computeOrgWindowReset(60, 1700000000000);
    expect(reset).toBe(1700000060);
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
// checkOrgRateLimit (sliding window)
// ---------------------------------------------------------------------------

describe("checkOrgRateLimit", () => {
  let store: ReturnType<typeof createMockStore>;

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

  it("allows again after window slides past old requests", async () => {
    const config: OrgRateLimitConfig = {
      ...DEFAULT_ORG_RATE_LIMITS,
      apiMaxRequests: 1,
      apiWindowSeconds: 60,
    };
    const now = 1700000000000;

    await checkOrgRateLimit(store, "org_123", "api", config, now);
    const blocked = await checkOrgRateLimit(store, "org_123", "api", config, now + 1000);
    expect(blocked.allowed).toBe(false);

    // 61 seconds later -- old request slides out of the 60s window
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

  it("sliding window prevents boundary burst (unlike fixed window)", async () => {
    // With a 10-second window and limit of 2:
    // Requests at t=9s and t=10s should both be in window at t=10s
    const config: OrgRateLimitConfig = {
      ...DEFAULT_ORG_RATE_LIMITS,
      apiMaxRequests: 2,
      apiWindowSeconds: 10,
    };
    const base = 1700000000000; // Start time

    // Request at t=9s (within window)
    await checkOrgRateLimit(store, "org_123", "api", config, base + 9000);
    // Request at t=10s (within window -- both 9s and 10s are within [0s, 10s])
    await checkOrgRateLimit(store, "org_123", "api", config, base + 10000);

    // At t=10.5s, both requests at 9s and 10s are within the 10s trailing window
    // So the count is 2, which equals the limit -- next request should be blocked
    const r3 = await checkOrgRateLimit(store, "org_123", "api", config, base + 10500);
    expect(r3.allowed).toBe(false);
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

  it("body follows canonical envelope format (flat error + error_code strings)", async () => {
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
      error: "Rate limit exceeded for impersonation bucket. Please try again later.",
      error_code: "RATE_LIMITED",
    });
    // Verify canonical format: error is a string, not a nested object
    expect(typeof body.error).toBe("string");
    expect(typeof body.error_code).toBe("string");
    expect(body.error).toContain("impersonation");
    expect(body.meta.bucket).toBe("impersonation");
    expect(body.meta.retry_after).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// computeBackoffDelay (AC#2)
// ---------------------------------------------------------------------------

describe("computeBackoffDelay", () => {
  it("uses exponential base delay", () => {
    // With zero jitter (randomFn returns 1 to make jitter = jitterFactor * 1 = 0.5)
    // delay = min(32000, 1000 * 2^0) * (1 - 0.5 + 0.5) = 1000
    const delay0 = computeBackoffDelay(0, DEFAULT_BACKOFF_CONFIG, () => 1);
    expect(delay0).toBe(1000);

    const delay1 = computeBackoffDelay(1, DEFAULT_BACKOFF_CONFIG, () => 1);
    expect(delay1).toBe(2000);

    const delay2 = computeBackoffDelay(2, DEFAULT_BACKOFF_CONFIG, () => 1);
    expect(delay2).toBe(4000);
  });

  it("caps at maxDelayMs", () => {
    // 1000 * 2^10 = 1024000, capped to 32000
    const delay = computeBackoffDelay(10, DEFAULT_BACKOFF_CONFIG, () => 1);
    expect(delay).toBe(32000);
  });

  it("applies jitter to reduce thundering herd", () => {
    // With random=0, jitter = 0.5 * 0 = 0
    // delay = 1000 * (1 - 0.5 + 0) = 500
    const minDelay = computeBackoffDelay(0, DEFAULT_BACKOFF_CONFIG, () => 0);
    expect(minDelay).toBe(500);

    // With random=1, jitter = 0.5 * 1 = 0.5
    // delay = 1000 * (1 - 0.5 + 0.5) = 1000
    const maxDelay = computeBackoffDelay(0, DEFAULT_BACKOFF_CONFIG, () => 1);
    expect(maxDelay).toBe(1000);
  });

  it("returns integer values", () => {
    const delay = computeBackoffDelay(0, DEFAULT_BACKOFF_CONFIG, () => 0.3);
    expect(Number.isInteger(delay)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// withBackoff (AC#2)
// ---------------------------------------------------------------------------

describe("withBackoff", () => {
  it("returns immediately on non-429 response", async () => {
    const fn = async () => new Response("ok", { status: 200 });
    const sleepCalls: number[] = [];
    const sleepFn = async (ms: number) => { sleepCalls.push(ms); };

    const response = await withBackoff(fn, DEFAULT_BACKOFF_CONFIG, sleepFn);
    expect(response.status).toBe(200);
    expect(sleepCalls.length).toBe(0);
  });

  it("retries on 429 with exponential backoff", async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      if (callCount < 3) return new Response("too many", { status: 429 });
      return new Response("ok", { status: 200 });
    };
    const sleepCalls: number[] = [];
    const sleepFn = async (ms: number) => { sleepCalls.push(ms); };

    const response = await withBackoff(fn, DEFAULT_BACKOFF_CONFIG, sleepFn);
    expect(response.status).toBe(200);
    expect(callCount).toBe(3);
    expect(sleepCalls.length).toBe(2); // Slept before retry 2 and 3
  });

  it("returns last 429 after max retries exhausted", async () => {
    const fn = async () => new Response("rate limited", { status: 429 });
    const config: BackoffConfig = { ...DEFAULT_BACKOFF_CONFIG, maxRetries: 2 };
    const sleepCalls: number[] = [];
    const sleepFn = async (ms: number) => { sleepCalls.push(ms); };

    const response = await withBackoff(fn, config, sleepFn);
    expect(response.status).toBe(429);
    expect(sleepCalls.length).toBe(2); // Slept before retries 2 and 3
  });
});

// ---------------------------------------------------------------------------
// OrgRequestQueue (AC#3)
// ---------------------------------------------------------------------------

describe("OrgRequestQueue", () => {
  it("reports correct size", () => {
    const queue = new OrgRequestQueue<string>(10, 5000);
    expect(queue.size).toBe(0);
  });

  it("rejects when queue is full", async () => {
    const queue = new OrgRequestQueue<string>(1, 5000);
    // First enqueue succeeds (queued)
    const p1 = queue.enqueue(async () => "first", 1000);
    // Second should reject immediately -- queue is full
    await expect(queue.enqueue(async () => "second", 1000)).rejects.toThrow("queue is full");
    // Clean up
    queue.clear();
    // p1 was rejected by clear()
    await expect(p1).rejects.toThrow("Queue cleared");
  });

  it("processes queued requests when processQueue is called", async () => {
    const queue = new OrgRequestQueue<string>(10, 5000);
    const promise = queue.enqueue(async () => "result", 100);

    expect(queue.size).toBe(1);

    // Process the queue (rate limit now allows it)
    await queue.processQueue(async () => true);

    const result = await promise;
    expect(result).toBe("result");
    expect(queue.size).toBe(0);
  });

  it("stops processing when rate limit check returns false", async () => {
    const queue = new OrgRequestQueue<string>(10, 5000);
    const p1 = queue.enqueue(async () => "first", 100);
    const p2 = queue.enqueue(async () => "second", 100);

    let checkCount = 0;
    await queue.processQueue(async () => {
      checkCount++;
      return checkCount <= 1; // Only allow first
    });

    const result = await p1;
    expect(result).toBe("first");
    expect(queue.size).toBe(1); // Second still queued
    queue.clear();
    // Catch the rejection from clearing p2
    await expect(p2).rejects.toThrow("Queue cleared");
  });

  it("clear rejects all queued requests", async () => {
    const queue = new OrgRequestQueue<string>(10, 5000);
    const p1 = queue.enqueue(async () => "first", 1000);
    const p2 = queue.enqueue(async () => "second", 1000);

    queue.clear();

    await expect(p1).rejects.toThrow("Queue cleared");
    await expect(p2).rejects.toThrow("Queue cleared");
    expect(queue.size).toBe(0);
  });
});
