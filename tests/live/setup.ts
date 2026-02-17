/**
 * Live test environment loader.
 *
 * Reads LIVE_BASE_URL and LIVE_JWT_TOKEN from the environment.
 * Returns structured config for LiveTestClient and test suites.
 *
 * Design:
 * - Pure function, no side effects
 * - Returns null for missing optional values (does not throw)
 * - Callers use hasLiveCredentials() to gate test execution
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LiveEnv {
  /** Base URL of the deployed API (e.g., https://api.tminus.ink). */
  baseUrl: string;
  /** JWT token for authenticated requests. Null if not configured. */
  jwtToken: string | null;
  /** Google test refresh token for Account A. Null if not configured. */
  googleRefreshTokenA: string | null;
  /** Google client ID. Null if not configured. */
  googleClientId: string | null;
  /** Google client secret. Null if not configured. */
  googleClientSecret: string | null;
}

// ---------------------------------------------------------------------------
// loadLiveEnv: read live test config from environment
// ---------------------------------------------------------------------------

/**
 * Load live test environment variables.
 *
 * Returns null if LIVE_BASE_URL is not set, signaling that live tests
 * should be skipped entirely.
 */
export function loadLiveEnv(): LiveEnv | null {
  const baseUrl = process.env.LIVE_BASE_URL?.trim();

  if (!baseUrl) {
    return null;
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""), // strip trailing slashes
    jwtToken: process.env.LIVE_JWT_TOKEN?.trim() || null,
    googleRefreshTokenA:
      process.env.GOOGLE_TEST_REFRESH_TOKEN_A?.trim() || null,
    googleClientId: process.env.GOOGLE_CLIENT_ID?.trim() || null,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() || null,
  };
}

// ---------------------------------------------------------------------------
// hasLiveCredentials: check if live tests can run
// ---------------------------------------------------------------------------

/**
 * Returns true if LIVE_BASE_URL is set and non-empty.
 * Use this to gate test execution with it.skipIf(!hasLiveCredentials()).
 */
export function hasLiveCredentials(): boolean {
  return !!process.env.LIVE_BASE_URL?.trim();
}

/**
 * Returns true if live tests can make authenticated API calls.
 * Requires both LIVE_BASE_URL and LIVE_JWT_TOKEN.
 */
export function hasAuthCredentials(): boolean {
  return hasLiveCredentials() && !!process.env.LIVE_JWT_TOKEN?.trim();
}

/**
 * Returns true if Google Calendar live test credentials are available.
 * Requires LIVE_BASE_URL, LIVE_JWT_TOKEN, and GOOGLE_TEST_REFRESH_TOKEN_A.
 */
export function hasGoogleCredentials(): boolean {
  return (
    hasAuthCredentials() &&
    !!process.env.GOOGLE_TEST_REFRESH_TOKEN_A?.trim() &&
    !!process.env.GOOGLE_CLIENT_ID?.trim() &&
    !!process.env.GOOGLE_CLIENT_SECRET?.trim()
  );
}
