/**
 * Per-org rate limiting for domain-wide delegation API (TM-9iu.5).
 *
 * Extends the existing per-user rate limiting with org-level controls:
 * 1. Per-org API rate limits (configurable per org)
 * 2. Google Directory API rate limit tracking (separate bucket)
 * 3. Token impersonation rate limits per user within an org
 * 4. Standard rate limit headers in responses
 *
 * Design decisions:
 * - Fixed-window counters stored in a pluggable OrgRateLimitStore
 * - Three separate rate limit buckets per org: api, directory, impersonation
 * - Configurable limits with sensible defaults
 * - Uses the same RateLimitResult/header pattern from middleware/rate-limit.ts
 *
 * Business rules:
 * - BR-1: Rate limits are per-org, configurable by admin
 * - BR-4: Quota exceeded does not break existing functionality (graceful degradation)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Rate limit bucket types for per-org tracking. */
export type OrgRateLimitBucket = "api" | "directory" | "impersonation";

/** Per-org rate limit configuration. */
export interface OrgRateLimitConfig {
  /** Max API calls per window. */
  apiMaxRequests: number;
  /** API rate limit window in seconds. */
  apiWindowSeconds: number;
  /** Max Google Directory API calls per window. */
  directoryMaxRequests: number;
  /** Directory API rate limit window in seconds. */
  directoryWindowSeconds: number;
  /** Max impersonation token requests per user per window. */
  impersonationMaxRequests: number;
  /** Impersonation rate limit window in seconds. */
  impersonationWindowSeconds: number;
}

/** Result of an org-level rate limit check. */
export interface OrgRateLimitResult {
  /** Whether the request is allowed. */
  allowed: boolean;
  /** Maximum requests allowed in the window. */
  limit: number;
  /** Remaining requests in the current window. */
  remaining: number;
  /** Unix timestamp (seconds) when the current window resets. */
  resetAt: number;
  /** Seconds until the window resets (for Retry-After header). */
  retryAfter: number;
  /** Which bucket was checked. */
  bucket: OrgRateLimitBucket;
}

/** Interface for rate limit counter storage. */
export interface OrgRateLimitStore {
  /** Get the current count for a rate limit key. Returns 0 if not found. */
  getCount(key: string): Promise<number>;
  /** Increment and set the counter with a TTL. Returns the new count. */
  incrementCount(key: string, ttlSeconds: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default per-org rate limit configuration. */
export const DEFAULT_ORG_RATE_LIMITS: OrgRateLimitConfig = {
  apiMaxRequests: 1000,
  apiWindowSeconds: 60,
  directoryMaxRequests: 100,
  directoryWindowSeconds: 60,
  impersonationMaxRequests: 60,
  impersonationWindowSeconds: 60,
} as const;

/** Key prefix for org rate limit counters. */
export const ORG_RATE_LIMIT_PREFIX = "org_rl:" as const;

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Compute the fixed-window bucket key for an org rate limit.
 *
 * Key format: org_rl:<orgId>:<bucket>:<window_start_epoch_seconds>
 * For impersonation bucket: org_rl:<orgId>:impersonation:<userEmail>:<window_start>
 */
export function computeOrgWindowKey(
  orgId: string,
  bucket: OrgRateLimitBucket,
  windowSeconds: number,
  nowMs: number = Date.now(),
  userEmail?: string,
): string {
  const windowStart = Math.floor(nowMs / 1000 / windowSeconds) * windowSeconds;
  if (bucket === "impersonation" && userEmail) {
    return `${ORG_RATE_LIMIT_PREFIX}${orgId}:${bucket}:${userEmail}:${windowStart}`;
  }
  return `${ORG_RATE_LIMIT_PREFIX}${orgId}:${bucket}:${windowStart}`;
}

/**
 * Compute the Unix timestamp (in seconds) when the current window resets.
 */
export function computeOrgWindowReset(
  windowSeconds: number,
  nowMs: number = Date.now(),
): number {
  const windowStart = Math.floor(nowMs / 1000 / windowSeconds) * windowSeconds;
  return windowStart + windowSeconds;
}

/**
 * Get the rate limit parameters for a specific bucket from org config.
 */
export function getBucketConfig(
  config: OrgRateLimitConfig,
  bucket: OrgRateLimitBucket,
): { maxRequests: number; windowSeconds: number } {
  switch (bucket) {
    case "api":
      return { maxRequests: config.apiMaxRequests, windowSeconds: config.apiWindowSeconds };
    case "directory":
      return { maxRequests: config.directoryMaxRequests, windowSeconds: config.directoryWindowSeconds };
    case "impersonation":
      return { maxRequests: config.impersonationMaxRequests, windowSeconds: config.impersonationWindowSeconds };
  }
}

/**
 * Check and increment the org-level rate limit counter.
 *
 * @param store - Rate limit counter storage
 * @param orgId - Organization identifier
 * @param bucket - Which rate limit bucket to check
 * @param config - Per-org rate limit configuration
 * @param nowMs - Current time in milliseconds (for testing)
 * @param userEmail - Required for impersonation bucket (per-user tracking)
 * @returns OrgRateLimitResult indicating whether the request is allowed
 */
export async function checkOrgRateLimit(
  store: OrgRateLimitStore,
  orgId: string,
  bucket: OrgRateLimitBucket,
  config: OrgRateLimitConfig = DEFAULT_ORG_RATE_LIMITS,
  nowMs: number = Date.now(),
  userEmail?: string,
): Promise<OrgRateLimitResult> {
  const { maxRequests, windowSeconds } = getBucketConfig(config, bucket);
  const key = computeOrgWindowKey(orgId, bucket, windowSeconds, nowMs, userEmail);
  const resetAt = computeOrgWindowReset(windowSeconds, nowMs);
  const retryAfter = Math.max(0, resetAt - Math.floor(nowMs / 1000));

  // Read current count
  const currentCount = await store.getCount(key);

  if (currentCount >= maxRequests) {
    return {
      allowed: false,
      limit: maxRequests,
      remaining: 0,
      resetAt,
      retryAfter,
      bucket,
    };
  }

  // Increment counter with TTL slightly longer than window
  const newCount = await store.incrementCount(key, windowSeconds + 10);

  return {
    allowed: true,
    limit: maxRequests,
    remaining: Math.max(0, maxRequests - newCount),
    resetAt,
    retryAfter,
    bucket,
  };
}

/**
 * Build standard rate limit headers for org-level responses.
 *
 * Headers:
 * - X-RateLimit-Limit: Maximum requests allowed in the window
 * - X-RateLimit-Remaining: Requests remaining in the current window
 * - X-RateLimit-Reset: Unix timestamp when the window resets
 * - Retry-After: Seconds until reset (only when rate-limited)
 */
export function buildOrgRateLimitHeaders(
  result: OrgRateLimitResult,
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(result.resetAt),
  };

  if (!result.allowed) {
    headers["Retry-After"] = String(result.retryAfter);
  }

  return headers;
}

/**
 * Build a 429 Too Many Requests response for org rate limiting.
 */
export function buildOrgRateLimitResponse(result: OrgRateLimitResult): Response {
  const headers = buildOrgRateLimitHeaders(result);

  const body = JSON.stringify({
    ok: false,
    error: {
      code: "RATE_LIMITED",
      message: `Rate limit exceeded for ${result.bucket} bucket. Please try again later.`,
    },
    meta: {
      request_id: `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      retry_after: result.retryAfter,
      bucket: result.bucket,
    },
  });

  return new Response(body, {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}
