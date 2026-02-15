/**
 * Unit tests for Google OAuth consent screen configuration.
 *
 * Covers:
 * - Consent screen config factory (all fields)
 * - Scopes match what the OAuth worker actually requests (GOOGLE_SCOPES)
 * - Scope classification (sensitive vs restricted)
 * - Scope justification completeness
 * - Privacy policy and terms URLs match legal page routes
 * - Branding configuration
 *
 * AC1: Consent screen displays T-Minus logo, name, privacy policy, and terms URLs
 * AC4: Scopes are minimal (no Gmail, Drive, or other non-calendar access)
 */

import { describe, it, expect } from "vitest";
import {
  createConsentScreenConfig,
  hasSensitiveScopes,
  hasRestrictedScopes,
  getMissingScopeJustifications,
  SENSITIVE_SCOPES,
  NON_SENSITIVE_SCOPES,
} from "./consent-screen";
import { GOOGLE_SCOPES } from "./google";
import { createMarketplaceManifest } from "./marketplace-manifest";

// ---------------------------------------------------------------------------
// Config factory tests
// ---------------------------------------------------------------------------

describe("createConsentScreenConfig", () => {
  const config = createConsentScreenConfig("tminus.app", "https://oauth.tminus.app");

  it("sets app name to T-Minus", () => {
    expect(config.appName).toBe("T-Minus");
  });

  it("sets support email", () => {
    expect(config.supportEmail).toContain("@tminus.app");
  });

  it("sets app logo URL on the production domain", () => {
    expect(config.appLogoUrl).toBe("https://tminus.app/logo.png");
  });

  it("sets homepage URL to production domain", () => {
    expect(config.appHomepageUrl).toBe("https://tminus.app");
  });

  it("sets privacy policy URL to /legal/privacy on OAuth worker", () => {
    expect(config.privacyPolicyUrl).toBe("https://oauth.tminus.app/legal/privacy");
  });

  it("sets terms of service URL to /legal/terms on OAuth worker", () => {
    expect(config.termsOfServiceUrl).toBe("https://oauth.tminus.app/legal/terms");
  });

  it("includes the production domain in authorized domains", () => {
    expect(config.authorizedDomains).toContain("tminus.app");
  });

  it("works with different domain configurations", () => {
    const staging = createConsentScreenConfig(
      "staging.tminus.dev",
      "https://oauth.staging.tminus.dev",
    );
    expect(staging.appHomepageUrl).toBe("https://staging.tminus.dev");
    expect(staging.privacyPolicyUrl).toBe("https://oauth.staging.tminus.dev/legal/privacy");
    expect(staging.authorizedDomains).toContain("staging.tminus.dev");
  });
});

// ---------------------------------------------------------------------------
// Scope tests (AC4: minimal scopes)
// ---------------------------------------------------------------------------

describe("consent screen scopes", () => {
  const config = createConsentScreenConfig("tminus.app", "https://oauth.tminus.app");

  it("requests exactly 5 scopes", () => {
    expect(config.scopes).toHaveLength(5);
  });

  it("includes calendar scope for bidirectional sync", () => {
    expect(config.scopes).toContain("https://www.googleapis.com/auth/calendar");
  });

  it("includes calendar.events scope for event management", () => {
    expect(config.scopes).toContain("https://www.googleapis.com/auth/calendar.events");
  });

  it("includes openid, email, and profile for identity", () => {
    expect(config.scopes).toContain("openid");
    expect(config.scopes).toContain("email");
    expect(config.scopes).toContain("profile");
  });

  it("does NOT include Gmail scopes", () => {
    const gmailScopes = config.scopes.filter((s) => s.includes("gmail"));
    expect(gmailScopes).toHaveLength(0);
  });

  it("does NOT include Drive scopes", () => {
    const driveScopes = config.scopes.filter((s) => s.includes("drive"));
    expect(driveScopes).toHaveLength(0);
  });

  it("does NOT include Contacts scopes", () => {
    const contactScopes = config.scopes.filter((s) => s.includes("contacts"));
    expect(contactScopes).toHaveLength(0);
  });

  it("matches the scopes used by GOOGLE_SCOPES in the OAuth flow", () => {
    // GOOGLE_SCOPES is a space-separated string; consent config is an array.
    // They should contain the same scopes.
    const oauthScopes = GOOGLE_SCOPES.split(" ");
    for (const scope of config.scopes) {
      expect(oauthScopes).toContain(scope);
    }
    for (const scope of oauthScopes) {
      expect(config.scopes).toContain(scope);
    }
  });

  it("matches the scopes in the Marketplace manifest", () => {
    const manifest = createMarketplaceManifest("https://oauth.tminus.app", "test-client");
    for (const scope of config.scopes) {
      expect(manifest.scopes).toContain(scope);
    }
    for (const scope of manifest.scopes) {
      expect(config.scopes).toContain(scope);
    }
  });
});

// ---------------------------------------------------------------------------
// Scope classification tests
// ---------------------------------------------------------------------------

describe("scope classification", () => {
  const config = createConsentScreenConfig("tminus.app", "https://oauth.tminus.app");

  it("identifies calendar scopes as sensitive", () => {
    expect(hasSensitiveScopes(config)).toBe(true);
  });

  it("does NOT have restricted scopes (Gmail, Drive, etc.)", () => {
    expect(hasRestrictedScopes(config)).toBe(false);
  });

  it("SENSITIVE_SCOPES lists calendar scopes", () => {
    expect(SENSITIVE_SCOPES).toContain("https://www.googleapis.com/auth/calendar");
    expect(SENSITIVE_SCOPES).toContain("https://www.googleapis.com/auth/calendar.events");
  });

  it("NON_SENSITIVE_SCOPES lists identity scopes", () => {
    expect(NON_SENSITIVE_SCOPES).toContain("openid");
    expect(NON_SENSITIVE_SCOPES).toContain("email");
    expect(NON_SENSITIVE_SCOPES).toContain("profile");
  });
});

// ---------------------------------------------------------------------------
// Scope justification tests
// ---------------------------------------------------------------------------

describe("scope justifications", () => {
  const config = createConsentScreenConfig("tminus.app", "https://oauth.tminus.app");

  it("provides justification for every requested scope", () => {
    const missing = getMissingScopeJustifications(config);
    expect(missing).toHaveLength(0);
  });

  it("calendar scope justification mentions bidirectional sync", () => {
    const justification = config.scopeJustifications.get(
      "https://www.googleapis.com/auth/calendar",
    );
    expect(justification).toBeDefined();
    expect(justification).toContain("bidirectional sync");
  });

  it("calendar.events scope justification mentions event details", () => {
    const justification = config.scopeJustifications.get(
      "https://www.googleapis.com/auth/calendar.events",
    );
    expect(justification).toBeDefined();
    expect(justification).toContain("event details");
  });

  it("identity scope justifications are concise and accurate", () => {
    const openid = config.scopeJustifications.get("openid");
    const email = config.scopeJustifications.get("email");
    const profile = config.scopeJustifications.get("profile");

    expect(openid).toBeDefined();
    expect(email).toBeDefined();
    expect(profile).toBeDefined();
    expect(email).toContain("identify");
    expect(profile).toContain("name");
  });
});

// ---------------------------------------------------------------------------
// URL consistency tests
// ---------------------------------------------------------------------------

describe("URL consistency", () => {
  it("consent screen legal URLs match marketplace manifest legal URLs", () => {
    const consentConfig = createConsentScreenConfig("tminus.app", "https://oauth.tminus.app");
    const manifest = createMarketplaceManifest("https://oauth.tminus.app", "test-client");

    expect(consentConfig.privacyPolicyUrl).toBe(manifest.privacy_policy_url);
    expect(consentConfig.termsOfServiceUrl).toBe(manifest.terms_of_service_url);
  });
});
