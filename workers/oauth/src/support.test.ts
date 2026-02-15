/**
 * Unit tests for the support page handler.
 *
 * The support page is a required component of the Google Workspace Marketplace
 * listing. It provides users with support contact information and links.
 *
 * URL: GET /support
 *
 * Tests cover:
 * - Support page content (contact info, docs links)
 * - HTML rendering correctness
 * - Route handler returns proper response
 * - Worker routing integration
 */

import { describe, it, expect, vi } from "vitest";
import {
  SUPPORT_PAGE,
  renderSupportPage,
  handleSupportPage,
} from "./support";
import { createHandler } from "./index";

// ---------------------------------------------------------------------------
// Support page content tests
// ---------------------------------------------------------------------------

describe("SUPPORT_PAGE", () => {
  it("has correct title", () => {
    expect(SUPPORT_PAGE.title).toBe("T-Minus Support");
  });

  it("includes contact email", () => {
    expect(SUPPORT_PAGE.contactEmail).toContain("@tminus.app");
  });

  it("has at least one FAQ section", () => {
    expect(SUPPORT_PAGE.faq.length).toBeGreaterThan(0);
  });

  it("each FAQ has a question and answer", () => {
    for (const item of SUPPORT_PAGE.faq) {
      expect(item.question.length).toBeGreaterThan(0);
      expect(item.answer.length).toBeGreaterThan(0);
    }
  });

  it("includes FAQ about connecting calendars", () => {
    const calendarFaq = SUPPORT_PAGE.faq.find((f) =>
      f.question.toLowerCase().includes("calendar") ||
      f.question.toLowerCase().includes("connect"),
    );
    expect(calendarFaq).toBeDefined();
  });

  it("includes FAQ about data privacy or security", () => {
    const privacyFaq = SUPPORT_PAGE.faq.find((f) =>
      f.question.toLowerCase().includes("privacy") ||
      f.question.toLowerCase().includes("data") ||
      f.question.toLowerCase().includes("secure"),
    );
    expect(privacyFaq).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// HTML rendering tests
// ---------------------------------------------------------------------------

describe("renderSupportPage", () => {
  it("produces valid HTML with DOCTYPE", () => {
    const html = renderSupportPage();
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("</html>");
  });

  it("includes the page title in <title> and <h1>", () => {
    const html = renderSupportPage();
    expect(html).toContain("<title>T-Minus Support</title>");
    expect(html).toContain("T-Minus Support");
  });

  it("includes contact email", () => {
    const html = renderSupportPage();
    expect(html).toContain(SUPPORT_PAGE.contactEmail);
  });

  it("renders FAQ questions and answers", () => {
    const html = renderSupportPage();
    for (const faq of SUPPORT_PAGE.faq) {
      expect(html).toContain(faq.question);
    }
  });

  it("includes responsive meta viewport tag", () => {
    const html = renderSupportPage();
    expect(html).toContain('name="viewport"');
  });

  it("includes inline CSS", () => {
    const html = renderSupportPage();
    expect(html).toContain("<style>");
  });
});

// ---------------------------------------------------------------------------
// Route handler tests
// ---------------------------------------------------------------------------

describe("handleSupportPage", () => {
  it("returns 200 with HTML content type", () => {
    const response = handleSupportPage();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  it("returns cacheable response", () => {
    const response = handleSupportPage();
    expect(response.headers.get("Cache-Control")).toContain("public");
    expect(response.headers.get("Cache-Control")).toContain("max-age=86400");
  });

  it("returns support page HTML content", async () => {
    const response = handleSupportPage();
    const body = await response.text();
    expect(body).toContain("T-Minus Support");
    expect(body).toContain("@tminus.app");
  });
});

// ---------------------------------------------------------------------------
// Worker routing tests (through createHandler)
// ---------------------------------------------------------------------------

describe("support page routing (through worker handler)", () => {
  const mockCtx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;

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

  it("GET /support returns 200 with support page HTML", async () => {
    const handler = createHandler();
    const request = new Request("https://oauth.tminus.dev/support");
    const response = await handler.fetch(request, mockEnv, mockCtx);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const body = await response.text();
    expect(body).toContain("T-Minus Support");
  });

  it("existing routes still work after adding /support", async () => {
    const handler = createHandler();

    // Health check
    const healthResp = await handler.fetch(
      new Request("https://oauth.tminus.dev/health"),
      mockEnv,
      mockCtx,
    );
    expect(healthResp.status).toBe(200);

    // Legal pages
    const privacyResp = await handler.fetch(
      new Request("https://oauth.tminus.dev/legal/privacy"),
      mockEnv,
      mockCtx,
    );
    expect(privacyResp.status).toBe(200);

    const termsResp = await handler.fetch(
      new Request("https://oauth.tminus.dev/legal/terms"),
      mockEnv,
      mockCtx,
    );
    expect(termsResp.status).toBe(200);
  });
});
