/**
 * Unit tests for legal pages (privacy policy and terms of service).
 *
 * Covers:
 * - Privacy policy content accuracy (BR-1: reflects actual data handling)
 * - Terms of service content completeness
 * - HTML rendering correctness
 * - Route handlers return proper responses
 * - GDPR/CCPA compliance mentions (BR-2: right to erasure documented)
 * - Minimal scope documentation (BR-3: calendar scopes only)
 *
 * These are public pages served by the OAuth worker at:
 *   GET /legal/privacy
 *   GET /legal/terms
 */

import { describe, it, expect, vi } from "vitest";
import {
  PRIVACY_POLICY,
  TERMS_OF_SERVICE,
  renderLegalPage,
  handlePrivacyPolicy,
  handleTermsOfService,
} from "./legal";
import { createHandler } from "./index";

// ---------------------------------------------------------------------------
// Privacy Policy content tests
// ---------------------------------------------------------------------------

describe("PRIVACY_POLICY", () => {
  it("has correct title", () => {
    expect(PRIVACY_POLICY.title).toBe("T-Minus Privacy Policy");
  });

  it("has a last-updated date", () => {
    expect(PRIVACY_POLICY.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("documents data collected (calendar metadata, events, attendees)", () => {
    const collected = PRIVACY_POLICY.sections.find(
      (s) => s.heading === "What Data We Collect",
    );
    expect(collected).toBeDefined();
    const text = collected!.content.join(" ");
    expect(text).toContain("Calendar metadata");
    expect(text).toContain("Event titles");
    expect(text).toContain("attendee");
    expect(text).toContain("email address");
  });

  it("documents data NOT collected (event content, attachments, non-calendar)", () => {
    const notCollected = PRIVACY_POLICY.sections.find(
      (s) => s.heading === "What Data We Do NOT Collect",
    );
    expect(notCollected).toBeDefined();
    const text = notCollected!.content.join(" ");
    expect(text).toContain("descriptions");
    expect(text).toContain("attachments");
    expect(text).toContain("Non-calendar");
  });

  it("documents encrypted storage on Cloudflare infrastructure (BR-1)", () => {
    const storage = PRIVACY_POLICY.sections.find(
      (s) => s.heading === "How We Store Your Data",
    );
    expect(storage).toBeDefined();
    const text = storage!.content.join(" ");
    expect(text).toContain("AES-256-GCM");
    expect(text).toContain("Cloudflare");
    expect(text).toContain("per-user isolation");
    expect(text).toContain("not share");
  });

  it("documents GDPR right to erasure with 72-hour grace period (BR-2)", () => {
    const deletion = PRIVACY_POLICY.sections.find(
      (s) => s.heading === "Data Retention and Deletion",
    );
    expect(deletion).toBeDefined();
    const text = deletion!.content.join(" ");
    expect(text).toContain("GDPR Article 17");
    expect(text).toContain("Right to Erasure");
    expect(text).toContain("72-hour");
    expect(text).toContain("permanently removed");
  });

  it("documents GDPR and CCPA rights", () => {
    const rights = PRIVACY_POLICY.sections.find(
      (s) => s.heading === "Your Rights (GDPR / CCPA)",
    );
    expect(rights).toBeDefined();
    const text = rights!.content.join(" ");
    expect(text).toContain("Right to access");
    expect(text).toContain("Right to erasure");
    expect(text).toContain("CCPA");
    expect(text).toContain("California");
  });

  it("documents OAuth scopes as minimal calendar-only (BR-3)", () => {
    const scopes = PRIVACY_POLICY.sections.find(
      (s) => s.heading === "OAuth Scopes",
    );
    expect(scopes).toBeDefined();
    const text = scopes!.content.join(" ");
    expect(text).toContain("minimum");
    expect(text).toContain("calendar");
    expect(text).toContain("openid");
    expect(text).toContain("not request access to any other Google services");
  });

  it("includes contact information", () => {
    const contact = PRIVACY_POLICY.sections.find(
      (s) => s.heading === "Contact",
    );
    expect(contact).toBeDefined();
    expect(contact!.content.join(" ")).toContain("privacy@tminus.app");
  });
});

// ---------------------------------------------------------------------------
// Terms of Service content tests
// ---------------------------------------------------------------------------

describe("TERMS_OF_SERVICE", () => {
  it("has correct title", () => {
    expect(TERMS_OF_SERVICE.title).toBe("T-Minus Terms of Service");
  });

  it("has a last-updated date", () => {
    expect(TERMS_OF_SERVICE.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("includes acceptance of terms section", () => {
    const acceptance = TERMS_OF_SERVICE.sections.find(
      (s) => s.heading === "Acceptance of Terms",
    );
    expect(acceptance).toBeDefined();
  });

  it("describes the service", () => {
    const desc = TERMS_OF_SERVICE.sections.find(
      (s) => s.heading === "Service Description",
    );
    expect(desc).toBeDefined();
    const text = desc!.content.join(" ");
    expect(text).toContain("calendar federation");
    expect(text).toContain("Google");
    expect(text).toContain("Microsoft");
    expect(text).toContain("Apple");
  });

  it("includes acceptable use section", () => {
    const use = TERMS_OF_SERVICE.sections.find(
      (s) => s.heading === "Acceptable Use",
    );
    expect(use).toBeDefined();
    const text = use!.content.join(" ");
    expect(text).toContain("unlawful");
    expect(text).toContain("unauthorized access");
  });

  it("references privacy policy", () => {
    const data = TERMS_OF_SERVICE.sections.find(
      (s) => s.heading === "Data and Privacy",
    );
    expect(data).toBeDefined();
    expect(data!.content.join(" ")).toContain("Privacy Policy");
  });

  it("documents account deletion with 72-hour grace period", () => {
    const termination = TERMS_OF_SERVICE.sections.find(
      (s) => s.heading === "Account Termination",
    );
    expect(termination).toBeDefined();
    const text = termination!.content.join(" ");
    expect(text).toContain("delete your account");
    expect(text).toContain("72-hour");
  });

  it("includes limitation of liability", () => {
    const liability = TERMS_OF_SERVICE.sections.find(
      (s) => s.heading === "Limitation of Liability",
    );
    expect(liability).toBeDefined();
    expect(liability!.content.join(" ")).toContain("as is");
  });

  it("includes contact information", () => {
    const contact = TERMS_OF_SERVICE.sections.find(
      (s) => s.heading === "Contact",
    );
    expect(contact).toBeDefined();
    expect(contact!.content.join(" ")).toContain("legal@tminus.app");
  });
});

// ---------------------------------------------------------------------------
// HTML rendering tests
// ---------------------------------------------------------------------------

describe("renderLegalPage", () => {
  it("produces valid HTML with DOCTYPE and lang attribute", () => {
    const html = renderLegalPage(PRIVACY_POLICY);
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("</html>");
  });

  it("includes the page title in <title> and <h1>", () => {
    const html = renderLegalPage(PRIVACY_POLICY);
    expect(html).toContain("<title>T-Minus Privacy Policy</title>");
    expect(html).toContain("<h1>T-Minus Privacy Policy</h1>");
  });

  it("includes the last-updated date", () => {
    const html = renderLegalPage(PRIVACY_POLICY);
    expect(html).toContain("Last updated:");
    expect(html).toContain(PRIVACY_POLICY.lastUpdated);
  });

  it("renders all section headings as <h2>", () => {
    const html = renderLegalPage(PRIVACY_POLICY);
    for (const section of PRIVACY_POLICY.sections) {
      expect(html).toContain(`<h2>${section.heading}</h2>`);
    }
  });

  it("renders section content as paragraphs", () => {
    const html = renderLegalPage(TERMS_OF_SERVICE);
    // The first section's first content line should be a <p>
    expect(html).toContain("<p>");
  });

  it("renders list items (lines starting with '- ') as <li> in <ul>", () => {
    const html = renderLegalPage(PRIVACY_POLICY);
    // The OAuth Scopes section has "- " prefixed items
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>");
    expect(html).toContain("calendar");
  });

  it("escapes HTML special characters to prevent XSS", () => {
    // The terms include "as is" in quotes which should be escaped
    const html = renderLegalPage(TERMS_OF_SERVICE);
    expect(html).toContain("&quot;as is&quot;");
    expect(html).not.toContain('\"as is\"');
  });

  it("includes responsive meta viewport tag", () => {
    const html = renderLegalPage(PRIVACY_POLICY);
    expect(html).toContain('name="viewport"');
    expect(html).toContain("width=device-width");
  });

  it("includes inline CSS (no external stylesheet dependency)", () => {
    const html = renderLegalPage(PRIVACY_POLICY);
    expect(html).toContain("<style>");
    expect(html).toContain("font-family");
  });
});

// ---------------------------------------------------------------------------
// Route handler tests
// ---------------------------------------------------------------------------

describe("handlePrivacyPolicy", () => {
  it("returns 200 with HTML content type", () => {
    const response = handlePrivacyPolicy();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("returns cacheable response", () => {
    const response = handlePrivacyPolicy();
    expect(response.headers.get("Cache-Control")).toContain("public");
    expect(response.headers.get("Cache-Control")).toContain("max-age=86400");
  });

  it("returns privacy policy HTML content", async () => {
    const response = handlePrivacyPolicy();
    const body = await response.text();
    expect(body).toContain("T-Minus Privacy Policy");
    expect(body).toContain("AES-256-GCM");
    expect(body).toContain("GDPR");
  });
});

describe("handleTermsOfService", () => {
  it("returns 200 with HTML content type", () => {
    const response = handleTermsOfService();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("returns cacheable response", () => {
    const response = handleTermsOfService();
    expect(response.headers.get("Cache-Control")).toContain("public");
    expect(response.headers.get("Cache-Control")).toContain("max-age=86400");
  });

  it("returns terms of service HTML content", async () => {
    const response = handleTermsOfService();
    const body = await response.text();
    expect(body).toContain("T-Minus Terms of Service");
    expect(body).toContain("calendar federation");
  });
});

// ---------------------------------------------------------------------------
// Worker routing integration tests (through createHandler)
// ---------------------------------------------------------------------------

describe("legal page routing (through worker handler)", () => {
  const mockCtx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;

  // Minimal env -- legal pages don't need any bindings
  const mockEnv = {
    DB: {},
    USER_GRAPH: {},
    ACCOUNT: {},
    ONBOARDING_WORKFLOW: {},
    GOOGLE_CLIENT_ID: "unused",
    GOOGLE_CLIENT_SECRET: "unused",
    MS_CLIENT_ID: "unused",
    MS_CLIENT_SECRET: "unused",
    JWT_SECRET: "unused",
  } as unknown as Env;

  it("GET /legal/privacy returns 200 with privacy policy HTML", async () => {
    const handler = createHandler();
    const request = new Request("https://oauth.tminus.dev/legal/privacy");
    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const body = await response.text();
    expect(body).toContain("T-Minus Privacy Policy");
    expect(body).toContain("AES-256-GCM");
    expect(body).toContain("GDPR");
    expect(body).toContain("72-hour");
  });

  it("GET /legal/terms returns 200 with terms of service HTML", async () => {
    const handler = createHandler();
    const request = new Request("https://oauth.tminus.dev/legal/terms");
    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const body = await response.text();
    expect(body).toContain("T-Minus Terms of Service");
    expect(body).toContain("calendar federation");
  });

  it("privacy policy page includes T-Minus branding in consent screen context", async () => {
    const handler = createHandler();
    const request = new Request("https://oauth.tminus.dev/legal/privacy");
    const response = await handler.fetch(request, mockEnv, mockCtx);
    const body = await response.text();

    // Consent screen verification: page must contain app name, data handling, encryption
    expect(body).toContain("T-Minus");
    expect(body).toContain("Cloudflare");
    expect(body).toContain("AES-256-GCM");
    expect(body).toContain("calendar");
  });

  it("terms of service page includes T-Minus branding in consent screen context", async () => {
    const handler = createHandler();
    const request = new Request("https://oauth.tminus.dev/legal/terms");
    const response = await handler.fetch(request, mockEnv, mockCtx);
    const body = await response.text();

    // Consent screen verification: page must contain app name and service description
    expect(body).toContain("T-Minus");
    expect(body).toContain("calendar");
  });
});
