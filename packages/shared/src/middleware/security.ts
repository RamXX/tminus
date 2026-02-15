/**
 * Security headers middleware for T-Minus workers.
 *
 * Adds standard security response headers to protect against common
 * web vulnerabilities:
 *
 * - X-Frame-Options: DENY -- prevent clickjacking via iframes
 * - X-Content-Type-Options: nosniff -- prevent MIME type sniffing
 * - Strict-Transport-Security: max-age=31536000; includeSubDomains -- enforce HTTPS for 1 year
 * - Content-Security-Policy: default-src 'none'; frame-ancestors 'none' -- strict CSP for API
 * - Permissions-Policy: camera=(), microphone=(), geolocation=() -- disable sensitive browser APIs
 * - Referrer-Policy: strict-origin-when-cross-origin -- limit referrer leakage
 * - X-DNS-Prefetch-Control: off -- prevent DNS prefetching
 *
 * Design decisions:
 * - Returns a flat record of header name -> value for maximum reusability.
 *   Callers (Hono middleware, raw fetch handlers, etc.) apply them however they wish.
 * - CSP is intentionally strict ("default-src 'none'") because these are API workers,
 *   not HTML-serving applications. If a future worker serves HTML, it should use
 *   a more permissive CSP.
 * - HSTS max-age is 31536000 (1 year), matching industry best practice and
 *   the requirement in the story.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** HSTS max-age in seconds (1 year). */
export const HSTS_MAX_AGE = 31536000 as const;

/** The complete set of security headers applied to every response. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Strict-Transport-Security": `max-age=${HSTS_MAX_AGE}; includeSubDomains`,
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-DNS-Prefetch-Control": "off",
});

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Return the security headers record.
 *
 * This is a trivial wrapper around the constant, provided for symmetry
 * with other middleware functions and to allow future parameterization
 * (e.g. per-worker CSP overrides) without breaking callers.
 *
 * @returns A record of header name -> value strings.
 */
export function getSecurityHeaders(): Record<string, string> {
  return { ...SECURITY_HEADERS };
}

/**
 * Apply security headers to an existing Response.
 *
 * Creates a new Response with the same body and status but with
 * security headers added. Existing headers on the response are preserved.
 *
 * @param response - The original response
 * @returns A new Response with security headers added
 */
export function addSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
