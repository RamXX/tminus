/**
 * Rate limiting middleware for the T-Minus API.
 *
 * Uses Cloudflare KV with fixed-window counters for per-user/IP rate limiting.
 * Each window gets its own KV key (e.g., "rl:usr_123:1700000000"), and KV's
 * expirationTtl auto-cleans expired windows.
 *
 * Design decisions:
 * - Fixed window (not sliding) to stay within KV's 1-write-per-second-per-key
 *   limit under load. A 60-second window means at most 1 write per request
 *   to that user's current-window key.
 * - Per-user rate limiting for authenticated requests (by user_id from JWT/API key).
 * - Per-IP rate limiting for unauthenticated requests.
 * - Separate, stricter limits for auth endpoints (register, login).
 * - Standard rate limit headers: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset.
 * - 429 Too Many Requests with Retry-After header when exceeded.
 *
 * Tier limits (requests per minute):
 *   unauth:     10/min per IP
 *   free:      100/min per user
 *   premium:   500/min per user
 *   enterprise: 2000/min per user
 *
 * Auth endpoint limits:
 *   register: 5/hr per IP (window = 3600s)
 *   login:   10/min per IP (window = 60s)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Subscription tier for rate limit selection. */
export type RateLimitTier = "free" | "premium" | "enterprise";

/** Result of a rate limit check. */
export interface RateLimitResult {
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
}

/** Configuration for a rate limit rule. */
export interface RateLimitConfig {
  /** Maximum number of requests allowed in the window. */
  maxRequests: number;
  /** Window duration in seconds. */
  windowSeconds: number;
}

/** Interface for KV operations needed by rate limiting. */
export interface RateLimitKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rate limit configurations by tier (requests per minute). */
export const TIER_LIMITS: Record<"unauth" | RateLimitTier, RateLimitConfig> = {
  unauth: { maxRequests: 10, windowSeconds: 60 },
  free: { maxRequests: 100, windowSeconds: 60 },
  premium: { maxRequests: 500, windowSeconds: 60 },
  enterprise: { maxRequests: 2000, windowSeconds: 60 },
} as const;

/** Rate limit configurations for auth endpoints. */
export const AUTH_ENDPOINT_LIMITS: Record<"register" | "login", RateLimitConfig> = {
  register: { maxRequests: 5, windowSeconds: 3600 }, // 5 per hour
  login: { maxRequests: 10, windowSeconds: 60 },     // 10 per minute
} as const;

/** KV key prefix for rate limit counters. */
export const RATE_LIMIT_KEY_PREFIX = "rl:" as const;

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Compute the fixed-window bucket key for a given identity and timestamp.
 *
 * Key format: rl:<identity>:<window_start_epoch_seconds>
 *
 * @param identity - User ID or IP address
 * @param windowSeconds - Window duration in seconds
 * @param nowMs - Current time in milliseconds (default: Date.now())
 * @returns The KV key string
 */
export function computeWindowKey(
  identity: string,
  windowSeconds: number,
  nowMs: number = Date.now(),
): string {
  const windowStart = Math.floor(nowMs / 1000 / windowSeconds) * windowSeconds;
  return `${RATE_LIMIT_KEY_PREFIX}${identity}:${windowStart}`;
}

/**
 * Compute the Unix timestamp (in seconds) when the current window resets.
 *
 * @param windowSeconds - Window duration in seconds
 * @param nowMs - Current time in milliseconds (default: Date.now())
 * @returns Unix timestamp in seconds
 */
export function computeWindowReset(
  windowSeconds: number,
  nowMs: number = Date.now(),
): number {
  const windowStart = Math.floor(nowMs / 1000 / windowSeconds) * windowSeconds;
  return windowStart + windowSeconds;
}

/**
 * Check and increment the rate limit counter for a given identity.
 *
 * This is the core rate limiting function. It:
 * 1. Computes the current window key
 * 2. Reads the current count from KV
 * 3. If under limit, increments and writes back
 * 4. Returns the rate limit result with headers info
 *
 * @param kv - KV namespace for rate limit counters
 * @param identity - User ID (for authenticated) or IP address (for unauthenticated)
 * @param config - Rate limit configuration (maxRequests, windowSeconds)
 * @param nowMs - Current time in milliseconds (for testing; default: Date.now())
 * @returns RateLimitResult indicating whether the request is allowed
 */
export async function checkRateLimit(
  kv: RateLimitKV,
  identity: string,
  config: RateLimitConfig,
  nowMs: number = Date.now(),
): Promise<RateLimitResult> {
  const key = computeWindowKey(identity, config.windowSeconds, nowMs);
  const resetAt = computeWindowReset(config.windowSeconds, nowMs);
  const retryAfter = Math.max(0, resetAt - Math.floor(nowMs / 1000));

  // Read current count
  const raw = await kv.get(key);
  const currentCount = raw !== null ? parseInt(raw, 10) : 0;

  if (currentCount >= config.maxRequests) {
    // Rate limit exceeded
    return {
      allowed: false,
      limit: config.maxRequests,
      remaining: 0,
      resetAt,
      retryAfter,
    };
  }

  // Increment counter
  const newCount = currentCount + 1;

  // Write with TTL slightly longer than window to handle clock edge cases.
  // Add 10 seconds buffer to ensure the key outlives the window.
  await kv.put(key, String(newCount), {
    expirationTtl: config.windowSeconds + 10,
  });

  return {
    allowed: true,
    limit: config.maxRequests,
    remaining: config.maxRequests - newCount,
    resetAt,
    retryAfter,
  };
}

/**
 * Select the appropriate rate limit configuration based on context.
 *
 * @param tier - User's subscription tier (null for unauthenticated)
 * @param authEndpoint - Auth endpoint name if applicable ("register" or "login")
 * @returns The rate limit configuration to apply
 */
export function selectRateLimitConfig(
  tier: RateLimitTier | null,
  authEndpoint?: "register" | "login",
): RateLimitConfig {
  // Auth endpoints have their own stricter limits
  if (authEndpoint) {
    return AUTH_ENDPOINT_LIMITS[authEndpoint];
  }

  // Authenticated users get tier-based limits
  if (tier) {
    return TIER_LIMITS[tier];
  }

  // Unauthenticated users get the lowest limits
  return TIER_LIMITS.unauth;
}

/**
 * Determine the rate limit identity key for a request.
 *
 * For authenticated requests: uses user_id
 * For unauthenticated requests: uses IP address
 * For auth endpoints: always uses IP (since user isn't authenticated yet)
 *
 * @param userId - Authenticated user's ID (null if unauthenticated)
 * @param clientIp - Client's IP address
 * @param authEndpoint - Auth endpoint name if applicable
 * @returns Identity string for rate limiting
 */
export function getRateLimitIdentity(
  userId: string | null,
  clientIp: string,
  authEndpoint?: "register" | "login",
): string {
  // Auth endpoints always rate-limit by IP (user isn't authenticated yet)
  if (authEndpoint) {
    return `auth_${authEndpoint}:${clientIp}`;
  }

  // Authenticated users are identified by user_id
  if (userId) {
    return `user:${userId}`;
  }

  // Unauthenticated requests are identified by IP
  return `ip:${clientIp}`;
}

/**
 * Build standard rate limit headers for the response.
 *
 * Headers:
 * - X-RateLimit-Limit: Maximum requests allowed in the window
 * - X-RateLimit-Remaining: Requests remaining in the current window
 * - X-RateLimit-Reset: Unix timestamp when the window resets
 *
 * When rate-limited (429), also includes:
 * - Retry-After: Seconds until the window resets
 *
 * @param result - The rate limit check result
 * @returns Record of header name -> value pairs
 */
export function buildRateLimitHeaders(
  result: RateLimitResult,
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
 * Build a 429 Too Many Requests response in the T-Minus envelope format.
 *
 * @param result - The rate limit check result
 * @returns A Response object with 429 status, rate limit headers, and envelope body
 */
export function buildRateLimitResponse(result: RateLimitResult): Response {
  const headers = buildRateLimitHeaders(result);

  const body = JSON.stringify({
    ok: false,
    error: {
      code: "RATE_LIMITED",
      message: "Too many requests. Please try again later.",
    },
    meta: {
      request_id: `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      retry_after: result.retryAfter,
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

/**
 * Detect the auth endpoint type from a request path.
 *
 * @param pathname - The URL pathname
 * @returns "register", "login", or undefined if not an auth endpoint
 */
export function detectAuthEndpoint(
  pathname: string,
): "register" | "login" | undefined {
  if (pathname === "/v1/auth/register" || pathname === "/register") {
    return "register";
  }
  if (pathname === "/v1/auth/login" || pathname === "/login") {
    return "login";
  }
  return undefined;
}

/**
 * Extract the client IP address from a request.
 *
 * Tries CF-Connecting-IP header first (Cloudflare edge), then
 * X-Forwarded-For, then falls back to "unknown".
 *
 * @param request - The incoming Request
 * @returns The client IP address string
 */
export function extractClientIp(request: Request): string {
  // Cloudflare always sets CF-Connecting-IP at the edge
  const cfIp = request.headers.get("CF-Connecting-IP");
  if (cfIp) return cfIp;

  // Fallback: X-Forwarded-For (first entry)
  const xff = request.headers.get("X-Forwarded-For");
  if (xff) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }

  return "unknown";
}

/**
 * Apply rate limit headers to an existing Response.
 *
 * Creates a new Response with the same body and status but with
 * rate limit headers added.
 *
 * @param response - The original response
 * @param result - The rate limit check result
 * @returns A new Response with rate limit headers
 */
export async function applyRateLimitHeaders(
  response: Response,
  result: RateLimitResult,
): Promise<Response> {
  const rlHeaders = buildRateLimitHeaders(result);
  const newHeaders = new Headers(response.headers);

  for (const [name, value] of Object.entries(rlHeaders)) {
    newHeaders.set(name, value);
  }

  // Read body as text to create a new Response, avoiding TS issues with
  // response.body across different type environments (Workers vs standard).
  const bodyText = await response.text();

  return new Response(bodyText, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}
