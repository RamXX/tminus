/**
 * Google Workspace Marketplace listing configuration.
 *
 * This module provides the complete listing configuration for submitting
 * T-Minus to the Google Workspace Marketplace, including:
 *
 * - Full listing metadata (app name, descriptions, URLs)
 * - Developer information (website, contact email)
 * - Visual asset specifications (icons, screenshots)
 * - Validation against Google's Marketplace schema
 * - Review submission checklist
 *
 * The listing wraps the base MarketplaceManifest (from marketplace-manifest.ts)
 * and adds all the additional metadata required for a complete submission.
 *
 * Reference:
 *   https://developers.google.com/workspace/marketplace/configure-app
 *   https://developers.google.com/workspace/marketplace/publish-overview
 */

import { createMarketplaceManifest, type MarketplaceManifest } from "./marketplace-manifest";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Developer information for the Marketplace listing. */
export interface DeveloperInfo {
  /** Developer/company name displayed on the listing. */
  readonly name: string;
  /** Developer website URL. */
  readonly website: string;
  /** Developer contact email for Marketplace communication. */
  readonly email: string;
}

/** Icon specification for Marketplace listing. */
export interface IconSpec {
  /** Icon dimension (square: size x size). */
  readonly size: number;
  /** Required image format. */
  readonly format: "png";
  /** Human-readable description of this icon's purpose. */
  readonly description: string;
  /** SVG source that can be rendered to PNG at the specified size. */
  readonly svgSource: string;
}

/** Screenshot specification for Marketplace listing. */
export interface ScreenshotSpec {
  /** Screenshot title shown in the listing gallery. */
  readonly title: string;
  /** Screenshot description/alt text. */
  readonly description: string;
  /** Screenshot width in pixels. */
  readonly width: number;
  /** Screenshot height in pixels. */
  readonly height: number;
  /** Required image format. */
  readonly format: "png";
}

/** Review checklist item for Marketplace submission. */
export interface ReviewChecklistItem {
  /** Category grouping (metadata, oauth, visual_assets, legal, testing). */
  readonly category: "metadata" | "oauth" | "visual_assets" | "legal" | "testing";
  /** Description of what needs to be verified. */
  readonly description: string;
}

/** Complete Marketplace listing including all submission metadata. */
export interface MarketplaceListing {
  /** Base manifest (OAuth config, URLs, scopes). */
  readonly manifest: MarketplaceManifest;
  /** Developer/publisher information. */
  readonly developer: DeveloperInfo;
  /** Pricing tier. */
  readonly pricing: "FREE" | "PAID";
  /** Icon specifications with SVG sources. */
  readonly icons: readonly IconSpec[];
  /** Screenshot specifications. */
  readonly screenshots: readonly ScreenshotSpec[];
}

/** Result of listing metadata validation. */
export interface ListingValidationResult {
  /** Whether the listing passes all validation rules. */
  readonly valid: boolean;
  /** List of validation error messages (empty if valid). */
  readonly errors: readonly string[];
}

// ---------------------------------------------------------------------------
// Icon SVG sources
// ---------------------------------------------------------------------------

/**
 * T-Minus app icon as SVG (128x128 version).
 *
 * Design: Dark rounded-rect background with white "T" lettermark
 * and a cyan accent bar, matching the favicon.svg design language.
 */
const ICON_128_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <rect width="128" height="128" rx="24" fill="#0a0a0f"/>
  <text x="20" y="92" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-weight="700" font-size="88" fill="#ffffff" letter-spacing="-4">T</text>
  <rect x="68" y="60" width="40" height="12" rx="6" fill="#00d4ff"/>
</svg>`;

/**
 * T-Minus app icon as SVG (32x32 version).
 *
 * Same design as 128x128 but scaled for small display contexts
 * (browser tabs, notification badges, etc.).
 */
const ICON_32_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="6" fill="#0a0a0f"/>
  <text x="5" y="23" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-weight="700" font-size="22" fill="#ffffff" letter-spacing="-1">T</text>
  <rect x="17" y="15" width="10" height="3" rx="1.5" fill="#00d4ff"/>
</svg>`;

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

/** App icon specifications for Google Marketplace. */
export const ICON_SPECS: readonly IconSpec[] = [
  {
    size: 128,
    format: "png",
    description: "Primary app icon for Marketplace listing and install dialogs (128x128 PNG)",
    svgSource: ICON_128_SVG,
  },
  {
    size: 32,
    format: "png",
    description: "Small app icon for sidebar, toolbar, and notifications (32x32 PNG)",
    svgSource: ICON_32_SVG,
  },
] as const;

/** Screenshot specifications for Google Marketplace listing. */
export const SCREENSHOT_SPECS: readonly ScreenshotSpec[] = [
  {
    title: "One-Click Onboarding",
    description: "Connect all your calendar accounts in under 60 seconds with the guided onboarding flow. Google, Microsoft, and Apple calendars supported.",
    width: 1280,
    height: 800,
    format: "png",
  },
  {
    title: "Unified Calendar View",
    description: "See all your calendars in one unified view. Events from Google Workspace, Microsoft 365, and iCloud are merged with conflict detection.",
    width: 1280,
    height: 800,
    format: "png",
  },
  {
    title: "Provider Health Dashboard",
    description: "Monitor the sync health of all connected providers. Real-time status for each calendar account with sync timestamps and error alerts.",
    width: 1280,
    height: 800,
    format: "png",
  },
  {
    title: "Smart Scheduling",
    description: "Intelligent scheduling that respects all your calendars simultaneously. Find optimal meeting times across organizations.",
    width: 1280,
    height: 800,
    format: "png",
  },
] as const;

/** Review submission checklist for Google Marketplace approval. */
export const REVIEW_CHECKLIST: readonly ReviewChecklistItem[] = [
  // Metadata
  {
    category: "metadata",
    description: "App name (T-Minus) is set and under 50 characters",
  },
  {
    category: "metadata",
    description: "Short description communicates value proposition in under 80 characters",
  },
  {
    category: "metadata",
    description: "Long description targets ICP and is under 4000 characters",
  },
  {
    category: "metadata",
    description: "Category set to Productivity",
  },
  // OAuth
  {
    category: "oauth",
    description: "OAuth client ID is configured and consent screen is verified",
  },
  {
    category: "oauth",
    description: "OAuth scopes are minimal (calendar + identity only, no Gmail/Drive)",
  },
  {
    category: "oauth",
    description: "Install URL and uninstall URL are configured and routable",
  },
  // Visual assets
  {
    category: "visual_assets",
    description: "App icon uploaded at 128x128 PNG with transparent background",
  },
  {
    category: "visual_assets",
    description: "App icon uploaded at 32x32 PNG for small display contexts",
  },
  {
    category: "visual_assets",
    description: "At least 3 screenshots uploaded (1280x800 minimum) showing key user flows",
  },
  // Legal
  {
    category: "legal",
    description: "Privacy policy URL is accessible and contains accurate data handling info",
  },
  {
    category: "legal",
    description: "Terms of service URL is accessible and covers liability and data retention",
  },
  {
    category: "legal",
    description: "Support URL is accessible and provides contact information",
  },
  // Testing
  {
    category: "testing",
    description: "Marketplace install callback works end-to-end (user creation, account linking)",
  },
  {
    category: "testing",
    description: "Redirect to onboarding shows pre-connected Google account",
  },
  {
    category: "testing",
    description: "Existing user re-install flow works without creating duplicate accounts",
  },
] as const;

// ---------------------------------------------------------------------------
// Listing factory
// ---------------------------------------------------------------------------

/**
 * Create the complete Marketplace listing for a given deployment.
 *
 * Wraps the base MarketplaceManifest with additional metadata required
 * for a Marketplace submission: developer info, pricing, visual assets,
 * and screenshot specifications.
 *
 * @param baseUrl - The base URL of the oauth worker (e.g., "https://oauth.tminus.app")
 * @param clientId - The Google OAuth2 client ID
 * @returns The complete listing configuration
 */
export function createMarketplaceListing(
  baseUrl: string,
  clientId: string,
): MarketplaceListing {
  return {
    manifest: createMarketplaceManifest(baseUrl, clientId),
    developer: {
      name: "T-Minus",
      website: "https://tminus.app",
      email: "developer@tminus.app",
    },
    pricing: "FREE",
    icons: ICON_SPECS,
    screenshots: SCREENSHOT_SPECS,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a Marketplace listing against Google's requirements.
 *
 * Checks:
 * - Required string fields are non-empty
 * - Short description <= 80 chars
 * - Long description <= 4000 chars
 * - At least 3 screenshots, at most 5
 * - Developer email is present
 * - Legal URLs are present
 *
 * @param listing - The listing to validate
 * @returns Validation result with errors (if any)
 */
export function validateListingMetadata(
  listing: MarketplaceListing,
): ListingValidationResult {
  const errors: string[] = [];

  // Required manifest fields
  if (!listing.manifest.app_name) {
    errors.push("app_name is required");
  }
  if (!listing.manifest.short_description) {
    errors.push("short_description is required");
  }
  if (listing.manifest.short_description.length > 80) {
    errors.push("short_description must be 80 characters or fewer");
  }
  if (!listing.manifest.long_description) {
    errors.push("long_description is required");
  }
  if (listing.manifest.long_description.length > 4000) {
    errors.push("long_description must be 4000 characters or fewer");
  }
  if (!listing.manifest.privacy_policy_url) {
    errors.push("privacy_policy_url is required");
  }
  if (!listing.manifest.terms_of_service_url) {
    errors.push("terms_of_service_url is required");
  }
  if (!listing.manifest.support_url) {
    errors.push("support_url is required");
  }

  // Developer info
  if (!listing.developer.email) {
    errors.push("developer.email is required");
  }
  if (!listing.developer.website) {
    errors.push("developer.website is required");
  }

  // Screenshots
  if (listing.screenshots.length < 3) {
    errors.push("At least 3 screenshots are required");
  }
  if (listing.screenshots.length > 5) {
    errors.push("At most 5 screenshots are allowed");
  }

  // Icons
  if (listing.icons.length < 1) {
    errors.push("At least one icon is required");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
