/**
 * Unit tests for Google Workspace Marketplace listing configuration.
 *
 * Covers:
 * - Complete listing metadata (all required fields)
 * - App icon specifications (128x128 and 32x32)
 * - Screenshot metadata (minimum 3 screenshots)
 * - Short description under 80 characters
 * - Long description targets ICP (fractional CXOs, multi-calendar users)
 * - Developer info (website, support email)
 * - Listing configuration validates against Google's requirements
 * - Review submission checklist completeness
 *
 * AC1: Marketplace listing includes all required metadata fields
 * AC2: App icon meets Google's size and format requirements
 * AC3: Minimum 3 screenshots showing key user flows
 * AC4: Short description communicates value in under 80 characters
 * AC5: Long description targets ICP (fractional CXOs, multi-calendar users)
 * AC6: Listing submitted for Google Marketplace review (checklist)
 */

import { describe, it, expect } from "vitest";
import {
  createMarketplaceListing,
  validateListingMetadata,
  ICON_SPECS,
  SCREENSHOT_SPECS,
  REVIEW_CHECKLIST,
  type MarketplaceListing,
  type ListingValidationResult,
} from "./marketplace-listing";
import { createMarketplaceManifest } from "./marketplace-manifest";

// ---------------------------------------------------------------------------
// Listing metadata tests (AC1)
// ---------------------------------------------------------------------------

describe("createMarketplaceListing", () => {
  const listing = createMarketplaceListing(
    "https://oauth.tminus.app",
    "test-client-id.apps.googleusercontent.com",
  );

  it("includes the base manifest data", () => {
    expect(listing.manifest.app_name).toBe("T-Minus");
    expect(listing.manifest.category).toBe("Productivity");
    expect(listing.manifest.individual_install).toBe(true);
  });

  it("includes developer information", () => {
    expect(listing.developer.name).toBe("T-Minus");
    expect(listing.developer.website).toMatch(/^https:\/\//);
    expect(listing.developer.email).toContain("@tminus.app");
  });

  it("includes pricing information", () => {
    expect(listing.pricing).toBe("FREE");
  });

  it("includes all required icon specifications", () => {
    expect(listing.icons).toHaveLength(2);
    const sizes = listing.icons.map((i) => i.size);
    expect(sizes).toContain(128);
    expect(sizes).toContain(32);
  });

  it("includes at least 3 screenshots", () => {
    expect(listing.screenshots.length).toBeGreaterThanOrEqual(3);
  });

  it("has consistent app name across manifest and listing", () => {
    expect(listing.manifest.app_name).toBe("T-Minus");
    expect(listing.developer.name).toBe("T-Minus");
  });
});

// ---------------------------------------------------------------------------
// Icon specification tests (AC2)
// ---------------------------------------------------------------------------

describe("ICON_SPECS", () => {
  it("defines 128x128 icon spec", () => {
    const icon128 = ICON_SPECS.find((s) => s.size === 128);
    expect(icon128).toBeDefined();
    expect(icon128!.format).toBe("png");
    expect(icon128!.description).toBeTruthy();
  });

  it("defines 32x32 icon spec", () => {
    const icon32 = ICON_SPECS.find((s) => s.size === 32);
    expect(icon32).toBeDefined();
    expect(icon32!.format).toBe("png");
    expect(icon32!.description).toBeTruthy();
  });

  it("all icons use PNG format (Google requirement)", () => {
    for (const spec of ICON_SPECS) {
      expect(spec.format).toBe("png");
    }
  });

  it("icon SVG source is valid SVG", () => {
    for (const spec of ICON_SPECS) {
      expect(spec.svgSource).toContain("<svg");
      expect(spec.svgSource).toContain("</svg>");
      expect(spec.svgSource).toContain(`viewBox="0 0 ${spec.size} ${spec.size}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// Screenshot specification tests (AC3)
// ---------------------------------------------------------------------------

describe("SCREENSHOT_SPECS", () => {
  it("has at least 3 screenshots (Google minimum)", () => {
    expect(SCREENSHOT_SPECS.length).toBeGreaterThanOrEqual(3);
  });

  it("has at most 5 screenshots (Google maximum)", () => {
    expect(SCREENSHOT_SPECS.length).toBeLessThanOrEqual(5);
  });

  it("each screenshot has title and description", () => {
    for (const spec of SCREENSHOT_SPECS) {
      expect(spec.title.length).toBeGreaterThan(0);
      expect(spec.description.length).toBeGreaterThan(0);
    }
  });

  it("includes screenshot showing onboarding flow", () => {
    const onboarding = SCREENSHOT_SPECS.find((s) =>
      s.title.toLowerCase().includes("onboard") ||
      s.description.toLowerCase().includes("onboard"),
    );
    expect(onboarding).toBeDefined();
  });

  it("includes screenshot showing unified calendar view", () => {
    const unified = SCREENSHOT_SPECS.find((s) =>
      s.title.toLowerCase().includes("unified") ||
      s.title.toLowerCase().includes("calendar") ||
      s.description.toLowerCase().includes("unified"),
    );
    expect(unified).toBeDefined();
  });

  it("includes screenshot showing provider health or multi-provider", () => {
    const health = SCREENSHOT_SPECS.find((s) =>
      s.title.toLowerCase().includes("provider") ||
      s.title.toLowerCase().includes("health") ||
      s.description.toLowerCase().includes("provider"),
    );
    expect(health).toBeDefined();
  });

  it("all screenshots have dimensions >= 1280x800 (Google minimum)", () => {
    for (const spec of SCREENSHOT_SPECS) {
      expect(spec.width).toBeGreaterThanOrEqual(1280);
      expect(spec.height).toBeGreaterThanOrEqual(800);
    }
  });
});

// ---------------------------------------------------------------------------
// Short description tests (AC4)
// ---------------------------------------------------------------------------

describe("short description", () => {
  const listing = createMarketplaceListing(
    "https://oauth.tminus.app",
    "test-client-id.apps.googleusercontent.com",
  );

  it("is under 80 characters", () => {
    expect(listing.manifest.short_description.length).toBeLessThanOrEqual(80);
  });

  it("communicates multi-calendar unification value", () => {
    const desc = listing.manifest.short_description.toLowerCase();
    expect(desc).toContain("calendar");
  });

  it("is not empty", () => {
    expect(listing.manifest.short_description.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// Long description tests (AC5)
// ---------------------------------------------------------------------------

describe("long description", () => {
  const listing = createMarketplaceListing(
    "https://oauth.tminus.app",
    "test-client-id.apps.googleusercontent.com",
  );

  it("is under 4000 characters (Google limit)", () => {
    expect(listing.manifest.long_description.length).toBeLessThanOrEqual(4000);
  });

  it("targets fractional CXOs", () => {
    const desc = listing.manifest.long_description.toLowerCase();
    expect(desc).toContain("fractional");
  });

  it("targets independent consultants", () => {
    const desc = listing.manifest.long_description.toLowerCase();
    expect(desc).toContain("consultant");
  });

  it("mentions multi-calendar federation", () => {
    const desc = listing.manifest.long_description.toLowerCase();
    expect(desc).toContain("calendar");
    expect(desc).toContain("federation") || expect(desc).toContain("unified") || expect(desc).toContain("unif");
  });

  it("mentions key providers (Google, Microsoft, Apple)", () => {
    const desc = listing.manifest.long_description;
    expect(desc).toContain("Google");
    expect(desc).toContain("Microsoft");
    expect(desc).toContain("Apple");
  });

  it("mentions privacy/encryption as a differentiator", () => {
    const desc = listing.manifest.long_description.toLowerCase();
    expect(desc).toContain("encrypt") || expect(desc).toContain("privacy");
  });

  it("mentions zero friction or easy onboarding", () => {
    const desc = listing.manifest.long_description.toLowerCase();
    const hasFriction = desc.includes("friction");
    const hasEasy = desc.includes("one-click") || desc.includes("easy") || desc.includes("simple");
    expect(hasFriction || hasEasy).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Listing validation tests (AC1, AC6)
// ---------------------------------------------------------------------------

describe("validateListingMetadata", () => {
  it("passes validation for a complete listing", () => {
    const listing = createMarketplaceListing(
      "https://oauth.tminus.app",
      "test-client-id.apps.googleusercontent.com",
    );
    const result = validateListingMetadata(listing);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("catches missing app name", () => {
    const listing = createMarketplaceListing(
      "https://oauth.tminus.app",
      "test-client-id.apps.googleusercontent.com",
    );
    const modified = {
      ...listing,
      manifest: { ...listing.manifest, app_name: "" },
    };
    const result = validateListingMetadata(modified);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("app_name"))).toBe(true);
  });

  it("catches short description over 80 chars", () => {
    const listing = createMarketplaceListing(
      "https://oauth.tminus.app",
      "test-client-id.apps.googleusercontent.com",
    );
    const modified = {
      ...listing,
      manifest: { ...listing.manifest, short_description: "x".repeat(81) },
    };
    const result = validateListingMetadata(modified);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("short_description"))).toBe(true);
  });

  it("catches long description over 4000 chars", () => {
    const listing = createMarketplaceListing(
      "https://oauth.tminus.app",
      "test-client-id.apps.googleusercontent.com",
    );
    const modified = {
      ...listing,
      manifest: { ...listing.manifest, long_description: "x".repeat(4001) },
    };
    const result = validateListingMetadata(modified);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("long_description"))).toBe(true);
  });

  it("catches fewer than 3 screenshots", () => {
    const listing = createMarketplaceListing(
      "https://oauth.tminus.app",
      "test-client-id.apps.googleusercontent.com",
    );
    const modified = {
      ...listing,
      screenshots: listing.screenshots.slice(0, 2),
    };
    const result = validateListingMetadata(modified);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("screenshot"))).toBe(true);
  });

  it("catches missing developer email", () => {
    const listing = createMarketplaceListing(
      "https://oauth.tminus.app",
      "test-client-id.apps.googleusercontent.com",
    );
    const modified = {
      ...listing,
      developer: { ...listing.developer, email: "" },
    };
    const result = validateListingMetadata(modified);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("developer.email"))).toBe(true);
  });

  it("catches missing privacy policy URL", () => {
    const listing = createMarketplaceListing(
      "https://oauth.tminus.app",
      "test-client-id.apps.googleusercontent.com",
    );
    const modified = {
      ...listing,
      manifest: { ...listing.manifest, privacy_policy_url: "" },
    };
    const result = validateListingMetadata(modified);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("privacy_policy_url"))).toBe(true);
  });

  it("catches missing terms of service URL", () => {
    const listing = createMarketplaceListing(
      "https://oauth.tminus.app",
      "test-client-id.apps.googleusercontent.com",
    );
    const modified = {
      ...listing,
      manifest: { ...listing.manifest, terms_of_service_url: "" },
    };
    const result = validateListingMetadata(modified);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("terms_of_service_url"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Review checklist tests (AC6, AC7)
// ---------------------------------------------------------------------------

describe("REVIEW_CHECKLIST", () => {
  it("has items covering all required submission areas", () => {
    const categories = REVIEW_CHECKLIST.map((item) => item.category);
    expect(categories).toContain("metadata");
    expect(categories).toContain("oauth");
    expect(categories).toContain("visual_assets");
    expect(categories).toContain("legal");
    expect(categories).toContain("testing");
  });

  it("each checklist item has a description", () => {
    for (const item of REVIEW_CHECKLIST) {
      expect(item.description.length).toBeGreaterThan(0);
    }
  });

  it("includes OAuth client verification step", () => {
    const oauthItems = REVIEW_CHECKLIST.filter((i) => i.category === "oauth");
    expect(oauthItems.length).toBeGreaterThan(0);
    const hasClientCheck = oauthItems.some((i) =>
      i.description.toLowerCase().includes("client") ||
      i.description.toLowerCase().includes("oauth"),
    );
    expect(hasClientCheck).toBe(true);
  });

  it("includes visual assets verification step", () => {
    const visualItems = REVIEW_CHECKLIST.filter((i) => i.category === "visual_assets");
    expect(visualItems.length).toBeGreaterThan(0);
    const hasIconCheck = visualItems.some((i) =>
      i.description.toLowerCase().includes("icon") ||
      i.description.toLowerCase().includes("screenshot"),
    );
    expect(hasIconCheck).toBe(true);
  });

  it("includes legal pages verification step", () => {
    const legalItems = REVIEW_CHECKLIST.filter((i) => i.category === "legal");
    expect(legalItems.length).toBeGreaterThan(0);
    const hasPrivacyCheck = legalItems.some((i) =>
      i.description.toLowerCase().includes("privacy"),
    );
    expect(hasPrivacyCheck).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-module consistency tests
// ---------------------------------------------------------------------------

describe("listing consistency with marketplace-manifest", () => {
  it("listing manifest matches standalone manifest factory", () => {
    const listing = createMarketplaceListing(
      "https://oauth.tminus.app",
      "test-client-id.apps.googleusercontent.com",
    );
    const standalone = createMarketplaceManifest(
      "https://oauth.tminus.app",
      "test-client-id.apps.googleusercontent.com",
    );

    expect(listing.manifest.app_name).toBe(standalone.app_name);
    expect(listing.manifest.short_description).toBe(standalone.short_description);
    expect(listing.manifest.scopes).toEqual(standalone.scopes);
    expect(listing.manifest.install_url).toBe(standalone.install_url);
    expect(listing.manifest.privacy_policy_url).toBe(standalone.privacy_policy_url);
    expect(listing.manifest.terms_of_service_url).toBe(standalone.terms_of_service_url);
  });
});
