/**
 * Google OAuth consent screen configuration (source of truth).
 *
 * This module defines the consent screen settings that must be configured
 * in the Google Cloud Console for OAuth verification. It serves as
 * a code-level source of truth validated by tests.
 *
 * Google Cloud Console path:
 *   APIs & Services -> OAuth consent screen -> Edit App
 *
 * Reference: https://developers.google.com/identity/protocols/oauth2/scopes
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** OAuth consent screen configuration for Google Cloud Console. */
export interface ConsentScreenConfig {
  /** Application name displayed on the consent screen. */
  readonly appName: string;
  /** User support email shown on consent screen. */
  readonly supportEmail: string;
  /** App logo URL (must be publicly accessible, <= 1MB, 120x120px recommended). */
  readonly appLogoUrl: string;
  /** Application homepage URL. */
  readonly appHomepageUrl: string;
  /** Privacy policy URL (required for verification). */
  readonly privacyPolicyUrl: string;
  /** Terms of service URL (required for verification). */
  readonly termsOfServiceUrl: string;
  /** Authorized domains (Google verifies domain ownership). */
  readonly authorizedDomains: readonly string[];
  /** OAuth scopes requested by the application. */
  readonly scopes: readonly string[];
  /** Human-readable justification for each scope (required by Google verification). */
  readonly scopeJustifications: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// Configuration factory
// ---------------------------------------------------------------------------

/**
 * Create the consent screen configuration for a given deployment.
 *
 * @param domain - The production domain (e.g., "tminus.app")
 * @param oauthBaseUrl - The OAuth worker base URL (e.g., "https://oauth.tminus.app")
 * @returns Complete consent screen configuration
 */
export function createConsentScreenConfig(
  domain: string,
  oauthBaseUrl: string,
): ConsentScreenConfig {
  return {
    appName: "T-Minus",
    supportEmail: "support@tminus.app",
    appLogoUrl: `https://${domain}/logo.png`,
    appHomepageUrl: `https://${domain}`,
    privacyPolicyUrl: `${oauthBaseUrl}/legal/privacy`,
    termsOfServiceUrl: `${oauthBaseUrl}/legal/terms`,
    authorizedDomains: [domain],
    scopes: [
      // Calendar scopes (sensitive -- requires verification + CASA)
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/calendar.events",
      // Identity scopes (non-sensitive)
      "openid",
      "email",
      "profile",
    ],
    scopeJustifications: new Map([
      [
        "https://www.googleapis.com/auth/calendar",
        "T-Minus federates multiple calendar accounts into a unified view. " +
        "Calendar read/write access is required for bidirectional sync: reading events " +
        "from Google Calendar and writing busy-overlay events back when the user " +
        "connects multiple providers (Google + Microsoft + Apple).",
      ],
      [
        "https://www.googleapis.com/auth/calendar.events",
        "Event-level access is required to read individual event details (title, time, " +
        "attendees) for conflict detection and to create/update events during " +
        "bidirectional synchronization.",
      ],
      [
        "openid",
        "Required for OpenID Connect identity verification during sign-in.",
      ],
      [
        "email",
        "Required to identify the user's Google account and match it to their " +
        "T-Minus profile for multi-account federation.",
      ],
      [
        "profile",
        "Required to display the user's name in the T-Minus interface.",
      ],
    ]),
  };
}

// ---------------------------------------------------------------------------
// Scope analysis helpers
// ---------------------------------------------------------------------------

/** Scopes that Google classifies as "sensitive" and require verification. */
export const SENSITIVE_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
] as const;

/** Scopes that Google classifies as "non-sensitive" (no extra verification). */
export const NON_SENSITIVE_SCOPES = [
  "openid",
  "email",
  "profile",
] as const;

/**
 * Check whether the configuration requests any "restricted" scopes.
 * Restricted scopes require a CASA assessment in addition to verification.
 *
 * Calendar scopes are classified as "sensitive" by Google, NOT "restricted".
 * Restricted scopes include things like Gmail full access, Drive full access, etc.
 *
 * @returns true if any restricted scope is present
 */
export function hasRestrictedScopes(config: ConsentScreenConfig): boolean {
  const restrictedPrefixes = [
    "https://mail.google.com/",
    "https://www.googleapis.com/auth/gmail",
    "https://www.googleapis.com/auth/drive",
  ];
  return config.scopes.some((scope) =>
    restrictedPrefixes.some((prefix) => scope.startsWith(prefix)),
  );
}

/**
 * Check whether the configuration requests any sensitive scopes.
 * Sensitive scopes require OAuth verification (consent screen review).
 *
 * @returns true if any sensitive scope is present
 */
export function hasSensitiveScopes(config: ConsentScreenConfig): boolean {
  return config.scopes.some((scope) =>
    SENSITIVE_SCOPES.includes(scope as typeof SENSITIVE_SCOPES[number]),
  );
}

/**
 * Verify that every requested scope has a justification.
 * Google requires justification text for each scope during verification.
 *
 * @returns Array of scopes missing justification (empty = all good)
 */
export function getMissingScopeJustifications(
  config: ConsentScreenConfig,
): string[] {
  return config.scopes.filter(
    (scope) => !config.scopeJustifications.has(scope),
  );
}
