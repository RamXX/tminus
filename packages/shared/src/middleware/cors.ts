/**
 * CORS middleware for T-Minus workers.
 *
 * Handles Cross-Origin Resource Sharing headers for all API responses.
 *
 * Allowed origins:
 * - Production: https://app.tminus.ink, https://tminus.ink
 * - Development: http://localhost:* (any port), http://127.0.0.1:* (any port)
 *
 * Dev mode is determined by the `environment` parameter: any value other than
 * "production" enables localhost origins. This maps to the ENVIRONMENT binding
 * in wrangler.toml or the Workers environment variable.
 *
 * Allowed methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
 * Allowed headers: Authorization, Content-Type
 * Max preflight cache: 86400 seconds (24 hours)
 *
 * Design decisions:
 * - Origin checking is done against an explicit allowlist, NOT wildcard "*",
 *   because our API uses Bearer tokens and CORS with credentials requires
 *   explicit origin matching.
 * - Preflight (OPTIONS) responses return 204 No Content with appropriate headers.
 * - Non-matching origins receive NO Access-Control-Allow-Origin header,
 *   which causes the browser to reject the request (CORS enforcement).
 * - Dev localhost origins use a regex to match any port number, since
 *   different dev setups use different ports.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Production allowed origins. */
export const PRODUCTION_ORIGINS: readonly string[] = [
  "https://app.tminus.ink",
  "https://tminus.ink",
] as const;

/** Methods allowed in CORS preflight and actual requests. */
export const CORS_ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS" as const;

/** Headers allowed in CORS requests. */
export const CORS_ALLOWED_HEADERS = "Authorization, Content-Type" as const;

/** Headers exposed to the client. */
export const CORS_EXPOSED_HEADERS = "X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After" as const;

/** Max age for preflight cache (24 hours). */
export const CORS_MAX_AGE = "86400" as const;

/**
 * Regex for dev localhost origins: http://localhost:<port> or http://127.0.0.1:<port>
 * Also matches without a port (http://localhost).
 */
const DEV_ORIGIN_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Check whether a request origin is allowed.
 *
 * @param origin - The Origin header value from the request
 * @param environment - The deployment environment ("production" or other)
 * @returns true if the origin is allowed, false otherwise
 */
export function isAllowedOrigin(
  origin: string | null,
  environment: string = "production",
): boolean {
  if (!origin) return false;

  // Always check production origins
  if (PRODUCTION_ORIGINS.includes(origin)) {
    return true;
  }

  // In non-production environments, also allow localhost
  if (environment !== "production") {
    return DEV_ORIGIN_PATTERN.test(origin);
  }

  return false;
}

/**
 * Build CORS headers for a response based on the request origin.
 *
 * If the origin is not allowed, returns an empty record (no CORS headers),
 * which causes the browser to block the cross-origin request.
 *
 * @param origin - The Origin header value from the request
 * @param environment - The deployment environment
 * @returns Record of CORS header name -> value pairs (may be empty)
 */
export function buildCorsHeaders(
  origin: string | null,
  environment: string = "production",
): Record<string, string> {
  if (!isAllowedOrigin(origin, environment)) {
    return {};
  }

  return {
    "Access-Control-Allow-Origin": origin!,
    "Access-Control-Allow-Methods": CORS_ALLOWED_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
    "Access-Control-Expose-Headers": CORS_EXPOSED_HEADERS,
    "Access-Control-Max-Age": CORS_MAX_AGE,
    "Vary": "Origin",
  };
}

/**
 * Build a preflight (OPTIONS) response with CORS headers.
 *
 * Returns 204 No Content with the appropriate CORS headers if the origin
 * is allowed, or a 204 with no CORS headers if the origin is not allowed
 * (the browser will then block the actual request).
 *
 * @param origin - The Origin header value from the request
 * @param environment - The deployment environment
 * @returns A Response suitable for OPTIONS requests
 */
export function buildPreflightResponse(
  origin: string | null,
  environment: string = "production",
): Response {
  const corsHeaders = buildCorsHeaders(origin, environment);
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

/**
 * Apply CORS headers to an existing Response.
 *
 * Creates a new Response with the same body and status but with
 * CORS headers added (if the origin is allowed).
 *
 * @param response - The original response
 * @param origin - The Origin header value from the request
 * @param environment - The deployment environment
 * @returns A new Response with CORS headers added (if origin is allowed)
 */
export function addCorsHeaders(
  response: Response,
  origin: string | null,
  environment: string = "production",
): Response {
  const corsHeaders = buildCorsHeaders(origin, environment);

  // If no CORS headers to add (unauthorized origin), return original
  if (Object.keys(corsHeaders).length === 0) {
    return response;
  }

  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders)) {
    headers.set(name, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
