/**
 * Google Workspace Marketplace listing configuration.
 *
 * This is the minimum viable manifest for submitting T-Minus to the
 * Google Workspace Marketplace. It defines the app metadata, OAuth
 * configuration, install/uninstall URLs, and required scopes.
 *
 * The actual submission is done via the Google Cloud Console Marketplace
 * SDK, but this TypeScript representation serves as the source of truth
 * and is validated by tests.
 *
 * Reference: https://developers.google.com/workspace/marketplace/configure-app
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Marketplace listing configuration. */
export interface MarketplaceManifest {
  /** Application name as shown in the Marketplace. */
  readonly app_name: string;
  /** Short description (max 80 chars) for search results. */
  readonly short_description: string;
  /** Detailed description for the listing page. */
  readonly long_description: string;
  /** OAuth2 client ID used for Marketplace installs. */
  readonly oauth_client_id: string;
  /** OAuth scopes requested during installation. */
  readonly scopes: readonly string[];
  /** URL Google redirects to after a user clicks "Install". */
  readonly install_url: string;
  /** URL Google sends uninstall notifications to (webhook). */
  readonly uninstall_url: string;
  /** Privacy policy URL (required by Google). */
  readonly privacy_policy_url: string;
  /** Terms of service URL (required by Google). */
  readonly terms_of_service_url: string;
  /** Support URL for users. */
  readonly support_url: string;
  /** Application category in the Marketplace. */
  readonly category: string;
  /** Whether the app supports individual install. */
  readonly individual_install: boolean;
  /** Whether the app supports admin/org-wide install. */
  readonly admin_install: boolean;
}

// ---------------------------------------------------------------------------
// Manifest factory
// ---------------------------------------------------------------------------

/**
 * Create the Marketplace manifest for a given deployment.
 *
 * @param baseUrl - The base URL of the oauth worker (e.g., "https://oauth.tminus.ink")
 * @param clientId - The Google OAuth2 client ID
 * @returns The complete manifest configuration
 */
export function createMarketplaceManifest(
  baseUrl: string,
  clientId: string,
): MarketplaceManifest {
  return {
    app_name: "T-Minus",
    short_description: "Unify all your calendars. Google, Microsoft, Apple -- one view, zero friction.",
    long_description: [
      "T-Minus is a calendar federation engine for professionals who manage",
      "multiple calendars across Google Workspace, Microsoft 365, and Apple",
      "iCloud. It provides a unified view of all your calendars with intelligent",
      "scheduling, relationship awareness, and zero-friction onboarding.",
      "",
      "Key features:",
      "- One-click calendar federation across all major providers",
      "- Smart scheduling that respects all your calendars simultaneously",
      "- Relationship-aware meeting intelligence",
      "- Privacy-first: your data stays encrypted on Cloudflare's edge network",
      "",
      "Perfect for fractional CXOs, independent consultants, and anyone who",
      "juggles multiple calendar accounts across organizations.",
    ].join("\n"),
    oauth_client_id: clientId,
    scopes: [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/calendar.events",
      "openid",
      "email",
      "profile",
    ],
    install_url: `${baseUrl}/marketplace/install`,
    uninstall_url: `${baseUrl}/marketplace/uninstall`,
    privacy_policy_url: `${baseUrl}/legal/privacy`,
    terms_of_service_url: `${baseUrl}/legal/terms`,
    support_url: `${baseUrl}/support`,
    category: "Productivity",
    individual_install: true,
    admin_install: true, // Enabled in TM-ga8.4: org-level admin install
  };
}
