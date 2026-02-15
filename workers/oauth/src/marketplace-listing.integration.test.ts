/**
 * Integration tests for Marketplace listing and support page.
 *
 * These tests verify the FULL flow through the worker:
 * 1. Listing validation works end-to-end with real config
 * 2. Support page is accessible through worker routing
 * 3. All Marketplace-required URLs are routable
 * 4. Listing metadata is internally consistent across modules
 *
 * No mocking of internal modules -- real createHandler, real listing factories.
 */

import { describe, it, expect, vi } from "vitest";
import { createHandler } from "./index";
import {
  createMarketplaceListing,
  validateListingMetadata,
  ICON_SPECS,
  SCREENSHOT_SPECS,
  REVIEW_CHECKLIST,
} from "./marketplace-listing";
import { createMarketplaceManifest } from "./marketplace-manifest";
import { createConsentScreenConfig } from "./consent-screen";

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

const mockEnv = {
  DB: {},
  USER_GRAPH: {},
  ACCOUNT: {},
  ONBOARDING_WORKFLOW: {},
  GOOGLE_CLIENT_ID: "real-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "unused",
  MS_CLIENT_ID: "unused",
  MS_CLIENT_SECRET: "unused",
  JWT_SECRET: "unused",
} as unknown as Env;

// ===========================================================================
// Integration Test 1: Full listing validation with production-like config
// ===========================================================================

describe("Integration: Marketplace listing validates with production config", () => {
  it("production listing passes all Google Marketplace validation rules", () => {
    const listing = createMarketplaceListing(
      "https://oauth.tminus.app",
      "real-production-client-id.apps.googleusercontent.com",
    );
    const result = validateListingMetadata(listing);

    // PROOF: listing is valid
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);

    // PROOF: all required metadata fields are populated
    expect(listing.manifest.app_name).toBeTruthy();
    expect(listing.manifest.short_description).toBeTruthy();
    expect(listing.manifest.long_description).toBeTruthy();
    expect(listing.manifest.privacy_policy_url).toBeTruthy();
    expect(listing.manifest.terms_of_service_url).toBeTruthy();
    expect(listing.manifest.support_url).toBeTruthy();
    expect(listing.developer.email).toBeTruthy();
    expect(listing.developer.website).toBeTruthy();

    // PROOF: meets Google's content limits
    expect(listing.manifest.short_description.length).toBeLessThanOrEqual(80);
    expect(listing.manifest.long_description.length).toBeLessThanOrEqual(4000);

    // PROOF: minimum screenshots met
    expect(listing.screenshots.length).toBeGreaterThanOrEqual(3);
    expect(listing.screenshots.length).toBeLessThanOrEqual(5);
  });

  it("listing metadata is consistent across all modules", () => {
    const listing = createMarketplaceListing(
      "https://oauth.tminus.app",
      "real-production-client-id.apps.googleusercontent.com",
    );
    const manifest = createMarketplaceManifest(
      "https://oauth.tminus.app",
      "real-production-client-id.apps.googleusercontent.com",
    );
    const consent = createConsentScreenConfig("tminus.app", "https://oauth.tminus.app");

    // PROOF: app name consistent
    expect(listing.manifest.app_name).toBe(manifest.app_name);
    expect(listing.manifest.app_name).toBe(consent.appName);

    // PROOF: scopes consistent
    expect(listing.manifest.scopes).toEqual(manifest.scopes);
    for (const scope of listing.manifest.scopes) {
      expect(consent.scopes).toContain(scope);
    }

    // PROOF: legal URLs consistent
    expect(listing.manifest.privacy_policy_url).toBe(manifest.privacy_policy_url);
    expect(listing.manifest.terms_of_service_url).toBe(manifest.terms_of_service_url);
    expect(listing.manifest.privacy_policy_url).toBe(consent.privacyPolicyUrl);
    expect(listing.manifest.terms_of_service_url).toBe(consent.termsOfServiceUrl);
  });
});

// ===========================================================================
// Integration Test 2: All Marketplace-required URLs are routable
// ===========================================================================

describe("Integration: All Marketplace-required URLs are accessible through worker", () => {
  it("GET /support returns 200", async () => {
    const handler = createHandler();
    const request = new Request("https://oauth.tminus.app/support");
    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("T-Minus");
    expect(body).toContain("Support");
  });

  it("GET /legal/privacy returns 200", async () => {
    const handler = createHandler();
    const request = new Request("https://oauth.tminus.app/legal/privacy");
    const response = await handler.fetch(request, mockEnv, mockCtx);
    expect(response.status).toBe(200);
  });

  it("GET /legal/terms returns 200", async () => {
    const handler = createHandler();
    const request = new Request("https://oauth.tminus.app/legal/terms");
    const response = await handler.fetch(request, mockEnv, mockCtx);
    expect(response.status).toBe(200);
  });

  it("GET /marketplace/install without code returns 400 (but route exists)", async () => {
    const handler = createHandler();
    const request = new Request("https://oauth.tminus.app/marketplace/install");
    const response = await handler.fetch(request, mockEnv, mockCtx);
    expect(response.status).toBe(400);
  });

  it("all URLs referenced in listing manifest are routable", async () => {
    const listing = createMarketplaceListing(
      "https://oauth.tminus.app",
      "test-client-id.apps.googleusercontent.com",
    );
    const handler = createHandler();

    // Test each URL from the manifest
    const urls = [
      listing.manifest.privacy_policy_url,
      listing.manifest.terms_of_service_url,
      listing.manifest.support_url,
    ];

    for (const url of urls) {
      const request = new Request(url);
      const response = await handler.fetch(request, mockEnv, mockCtx);
      // All should return 200 (these are public pages)
      expect(response.status).toBe(200);
    }
  });
});

// ===========================================================================
// Integration Test 3: Visual assets specifications are complete
// ===========================================================================

describe("Integration: Visual assets meet Google Marketplace requirements", () => {
  it("icon specs cover all required sizes", () => {
    const requiredSizes = [128, 32];
    for (const size of requiredSizes) {
      const spec = ICON_SPECS.find((s) => s.size === size);
      expect(spec).toBeDefined();
      expect(spec!.format).toBe("png");
    }
  });

  it("icon SVGs are well-formed and contain T-Minus branding", () => {
    for (const spec of ICON_SPECS) {
      expect(spec.svgSource).toContain("<svg");
      expect(spec.svgSource).toContain("</svg>");
      // Should contain some branding element (letter T or similar)
      expect(spec.svgSource).toContain("T");
    }
  });

  it("screenshot specs cover the 3 required user flows", () => {
    const titles = SCREENSHOT_SPECS.map((s) => s.title.toLowerCase());
    const descriptions = SCREENSHOT_SPECS.map((s) => s.description.toLowerCase());
    const combined = [...titles, ...descriptions].join(" ");

    // Must show: onboarding, unified view, provider health
    expect(combined).toContain("onboard");
    expect(combined).toMatch(/unified|calendar view/);
    expect(combined).toMatch(/provider|health|dashboard/);
  });
});

// ===========================================================================
// Integration Test 4: Review checklist is actionable
// ===========================================================================

describe("Integration: Review submission checklist covers all requirements", () => {
  it("checklist covers metadata, oauth, visuals, legal, and testing", () => {
    const categories = new Set(REVIEW_CHECKLIST.map((i) => i.category));
    expect(categories.has("metadata")).toBe(true);
    expect(categories.has("oauth")).toBe(true);
    expect(categories.has("visual_assets")).toBe(true);
    expect(categories.has("legal")).toBe(true);
    expect(categories.has("testing")).toBe(true);
  });

  it("has at least 2 items per category", () => {
    const categoryCounts = new Map<string, number>();
    for (const item of REVIEW_CHECKLIST) {
      categoryCounts.set(
        item.category,
        (categoryCounts.get(item.category) || 0) + 1,
      );
    }
    for (const [, count] of categoryCounts) {
      expect(count).toBeGreaterThanOrEqual(2);
    }
  });

  it("total checklist has at least 10 items", () => {
    expect(REVIEW_CHECKLIST.length).toBeGreaterThanOrEqual(10);
  });
});
