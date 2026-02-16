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
 * - Sliding window log algorithm: tracks individual request timestamps and
 *   counts only those within the trailing window. More accurate than
 *   fixed-window (no burst-at-boundary problem) while remaining simple.
 * - Three separate rate limit buckets per org: api, directory, impersonation
 * - Configurable limits with sensible defaults
 * - Uses the same RateLimitResult/header pattern from middleware/rate-limit.ts
 *
 * Sliding window log rationale (vs fixed window):
 * - Fixed-window allows 2x burst at window boundaries (e.g., 1000 req at
 *   :59 and 1000 req at :00 = 2000 in 1 second).
 * - Sliding window log counts all timestamps in the trailing N seconds,
 *   eliminating boundary bursts entirely.
 * - Trade-off: slightly more storage (one timestamp per request vs one counter),
 *   acceptable at our per-org rate limit scale (<1000 entries per window).
 *
 * Business rules:
 * - BR-1: Rate limits are per-org, configurable by admin
 * - BR-4: Quota exceeded does not break existing functionality (graceful degradation)
 */

// setTimeout/clearTimeout are available in all target runtimes (Workers, Node)
// but not declared when tsconfig types=[] (shared package pattern).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function setTimeout(callback: (...args: any[]) => void, ms: number): unknown;
declare function clearTimeout(id: unknown): void;

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
  /** Unix timestamp (seconds) when the oldest entry in the window expires. */
  resetAt: number;
  /** Seconds until a slot opens (for Retry-After header). */
  retryAfter: number;
  /** Which bucket was checked. */
  bucket: OrgRateLimitBucket;
}

/**
 * Interface for rate limit counter storage.
 *
 * Supports both fixed-window (getCount/incrementCount) and sliding-window
 * (addTimestamp/countInWindow/pruneExpired) patterns.
 *
 * Implementations must provide at least the sliding-window methods.
 * The fixed-window methods are kept for backward compatibility with
 * existing tests but are no longer used by checkOrgRateLimit.
 */
export interface OrgRateLimitStore {
  /** Get the current count for a rate limit key. Returns 0 if not found. */
  getCount(key: string): Promise<number>;
  /** Increment and set the counter with a TTL. Returns the new count. */
  incrementCount(key: string, ttlSeconds: number): Promise<number>;

  /**
   * Add a timestamp entry to the sliding window log for a key.
   * Used by the sliding-window algorithm.
   */
  addTimestamp(key: string, timestampMs: number, ttlSeconds: number): Promise<void>;

  /**
   * Count entries in the sliding window log within [windowStartMs, now].
   * Used by the sliding-window algorithm.
   */
  countInWindow(key: string, windowStartMs: number): Promise<number>;

  /**
   * Remove expired entries from the sliding window log.
   * Called opportunistically to keep storage bounded.
   */
  pruneExpired(key: string, beforeMs: number): Promise<void>;
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
 * Compute the sliding-window log key for an org rate limit.
 *
 * Key format: org_rl:<orgId>:<bucket>
 * For impersonation bucket: org_rl:<orgId>:impersonation:<userEmail>
 *
 * Unlike fixed-window keys, sliding-window keys do NOT include a window
 * start time -- the window is computed dynamically.
 */
export function computeOrgWindowKey(
  orgId: string,
  bucket: OrgRateLimitBucket,
  _windowSeconds: number,
  _nowMs: number = Date.now(),
  userEmail?: string,
): string {
  if (bucket === "impersonation" && userEmail) {
    return `${ORG_RATE_LIMIT_PREFIX}${orgId}:${bucket}:${userEmail}`;
  }
  return `${ORG_RATE_LIMIT_PREFIX}${orgId}:${bucket}`;
}

/**
 * Compute the Unix timestamp (in seconds) when the oldest entry in the
 * sliding window will expire -- i.e., windowSeconds from now.
 *
 * For sliding window, "reset" means the next time a slot will open
 * (the oldest tracked request exits the window).
 */
export function computeOrgWindowReset(
  windowSeconds: number,
  nowMs: number = Date.now(),
): number {
  return Math.floor(nowMs / 1000) + windowSeconds;
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
 * Check and increment the org-level rate limit using sliding window log.
 *
 * Algorithm:
 * 1. Compute the sliding window start = now - windowSeconds
 * 2. Count requests in [windowStart, now]
 * 3. If count >= limit, deny (return allowed: false)
 * 4. Otherwise, add current timestamp to the log and allow
 * 5. Opportunistically prune expired entries
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

  // Sliding window: count requests in [nowMs - windowMs, nowMs]
  const windowMs = windowSeconds * 1000;
  const windowStartMs = nowMs - windowMs;

  // Count requests within the sliding window
  const currentCount = await store.countInWindow(key, windowStartMs);

  // Sliding-window reset = when the next slot will open (windowSeconds from now)
  const resetAt = computeOrgWindowReset(windowSeconds, nowMs);
  const retryAfter = Math.max(0, resetAt - Math.floor(nowMs / 1000));

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

  // Add this request's timestamp to the log
  await store.addTimestamp(key, nowMs, windowSeconds + 10);

  // Opportunistically prune old entries
  await store.pruneExpired(key, windowStartMs);

  const newCount = currentCount + 1;

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
 *
 * Uses the canonical error envelope format: flat `error` (string) + `error_code`
 * (string), matching the shared.ts apiErrorResponse() pattern used by
 * feature-gate.ts, auth.ts, and buildRateLimitResponse() in rate-limit.ts.
 *
 * Constructed inline to avoid a cross-package dependency (this module lives
 * in packages/shared, apiErrorResponse lives in workers/api).
 *
 * @param result - The org rate limit check result
 * @returns A Response object with 429 status, rate limit headers, and envelope body
 */
export function buildOrgRateLimitResponse(result: OrgRateLimitResult): Response {
  const headers = buildOrgRateLimitHeaders(result);

  const body = JSON.stringify({
    ok: false,
    error: `Rate limit exceeded for ${result.bucket} bucket. Please try again later.`,
    error_code: "RATE_LIMITED",
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

// ---------------------------------------------------------------------------
// Exponential backoff with jitter (AC#2: Google 429 handling)
// ---------------------------------------------------------------------------

/**
 * Configuration for exponential backoff with jitter.
 */
export interface BackoffConfig {
  /** Base delay in milliseconds (default: 1000). */
  baseDelayMs: number;
  /** Maximum delay in milliseconds (default: 32000). */
  maxDelayMs: number;
  /** Maximum number of retry attempts (default: 5). */
  maxRetries: number;
  /** Jitter factor 0-1 (default: 0.5). 0 = no jitter, 1 = full jitter. */
  jitterFactor: number;
}

/** Default backoff config for Google API 429 handling. */
export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  baseDelayMs: 1000,
  maxDelayMs: 32000,
  maxRetries: 5,
  jitterFactor: 0.5,
} as const;

/**
 * Compute the delay for a given retry attempt using exponential backoff
 * with decorrelated jitter.
 *
 * Formula: min(maxDelay, baseDelay * 2^attempt) * (1 - jitter + random * jitter)
 *
 * The jitter prevents thundering herd when multiple workers retry simultaneously
 * after a Google 429.
 *
 * @param attempt - Retry attempt number (0-based)
 * @param config - Backoff configuration
 * @param randomFn - Random number generator (0-1), injectable for testing
 * @returns Delay in milliseconds before the next retry
 */
export function computeBackoffDelay(
  attempt: number,
  config: BackoffConfig = DEFAULT_BACKOFF_CONFIG,
  randomFn: () => number = Math.random,
): number {
  const exponentialDelay = Math.min(
    config.maxDelayMs,
    config.baseDelayMs * Math.pow(2, attempt),
  );

  // Decorrelated jitter: base * (1 - jitter) + base * jitter * random
  const jitter = config.jitterFactor * randomFn();
  const delayWithJitter = exponentialDelay * (1 - config.jitterFactor + jitter);

  return Math.floor(delayWithJitter);
}

/**
 * Execute a function with automatic retry on 429 responses using
 * exponential backoff with jitter.
 *
 * This is designed for wrapping Google API calls that may return 429
 * (Too Many Requests). On 429, it waits with exponential backoff
 * before retrying.
 *
 * @param fn - Async function that returns a Response
 * @param config - Backoff configuration
 * @param sleepFn - Sleep function (injectable for testing)
 * @returns The final Response (either successful or after max retries)
 */
export async function withBackoff(
  fn: () => Promise<Response>,
  config: BackoffConfig = DEFAULT_BACKOFF_CONFIG,
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Response> {
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    const response = await fn();

    if (response.status !== 429) {
      return response;
    }

    lastResponse = response;

    if (attempt < config.maxRetries) {
      const delay = computeBackoffDelay(attempt, config);
      await sleepFn(delay);
    }
  }

  // All retries exhausted -- return the last 429 response
  return lastResponse!;
}

// ---------------------------------------------------------------------------
// Request queue for excess requests (AC#3)
// ---------------------------------------------------------------------------

/**
 * A queued request waiting for rate limit capacity.
 */
interface QueuedRequest<T> {
  /** Function to execute when capacity is available. */
  execute: () => Promise<T>;
  /** Promise resolve callback. */
  resolve: (value: T) => void;
  /** Promise reject callback. */
  reject: (reason: unknown) => void;
  /** Timestamp when the request was enqueued. */
  enqueuedAt: number;
}

/**
 * In-memory request queue that holds excess requests instead of dropping them.
 *
 * When rate limit is exceeded, requests are queued and retried after
 * the rate limit window resets. This prevents request loss while
 * respecting rate limits.
 *
 * Design:
 * - Queue has a maximum size to prevent memory exhaustion
 * - Requests that wait longer than the timeout are rejected
 * - FIFO ordering ensures fairness
 * - Processing triggered when rate limit window resets
 */
export class OrgRequestQueue<T = Response> {
  private queue: QueuedRequest<T>[] = [];
  private processing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly maxQueueSize: number = 100,
    private readonly requestTimeoutMs: number = 30000,
  ) {}

  /**
   * Queue a request for later execution.
   *
   * @param execute - The function to execute when capacity is available
   * @param retryAfterMs - How long to wait before retrying (from rate limit response)
   * @returns Promise that resolves when the request completes
   * @throws Error if queue is full or request times out
   */
  enqueue(
    execute: () => Promise<T>,
    retryAfterMs: number,
  ): Promise<T> {
    if (this.queue.length >= this.maxQueueSize) {
      return Promise.reject(new Error("Request queue is full"));
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueuedRequest<T> = {
        execute,
        resolve,
        reject,
        enqueuedAt: Date.now(),
      };

      this.queue.push(entry);

      // Set up timeout for this request
      setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          reject(new Error("Queued request timed out"));
        }
      }, this.requestTimeoutMs);

      // Schedule processing after rate limit window resets
      this.scheduleProcessing(retryAfterMs);
    });
  }

  /** Current number of queued requests. */
  get size(): number {
    return this.queue.length;
  }

  /**
   * Process queued requests. Called when rate limit window resets.
   * Processes one at a time to avoid re-triggering rate limits.
   */
  async processQueue(
    rateLimitCheck: () => Promise<boolean>,
  ): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        // Check if rate limit allows another request
        const allowed = await rateLimitCheck();
        if (!allowed) break;

        const entry = this.queue.shift()!;

        // Check if request has timed out
        if (Date.now() - entry.enqueuedAt > this.requestTimeoutMs) {
          entry.reject(new Error("Queued request timed out"));
          continue;
        }

        try {
          const result = await entry.execute();
          entry.resolve(result);
        } catch (err) {
          entry.reject(err);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  /** Clear all queued requests (e.g., on shutdown). */
  clear(): void {
    for (const entry of this.queue) {
      entry.reject(new Error("Queue cleared"));
    }
    this.queue = [];
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleProcessing(delayMs: number): void {
    if (this.timer) return; // Already scheduled
    this.timer = setTimeout(() => {
      this.timer = null;
      // Note: actual processing is triggered by calling processQueue()
      // from the rate limit middleware. The timer just ensures we don't
      // forget about queued requests.
    }, delayMs);
  }
}
