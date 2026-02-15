/**
 * Unit tests for org-delegation route validation helpers.
 *
 * Tests:
 * - validateOrgRegistration: domain, admin_email, service_account_key validation
 * - extractEmailDomain: email domain extraction
 */

import { describe, it, expect } from "vitest";
import { validateOrgRegistration, extractEmailDomain } from "./org-delegation";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const VALID_SA_KEY = {
  type: "service_account",
  project_id: "test-project",
  private_key_id: "key-123",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----",
  client_email: "sa@test-project.iam.gserviceaccount.com",
  client_id: "123456789",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
};

const VALID_BODY = {
  domain: "acme.com",
  admin_email: "admin@acme.com",
  service_account_key: VALID_SA_KEY,
};

// ---------------------------------------------------------------------------
// validateOrgRegistration
// ---------------------------------------------------------------------------

describe("validateOrgRegistration", () => {
  it("accepts valid input", () => {
    expect(validateOrgRegistration(VALID_BODY)).toBeNull();
  });

  it("rejects missing domain", () => {
    expect(validateOrgRegistration({ ...VALID_BODY, domain: undefined })).toBe(
      "domain is required and must be a string",
    );
  });

  it("rejects non-string domain", () => {
    expect(validateOrgRegistration({ ...VALID_BODY, domain: 123 })).toBe(
      "domain is required and must be a string",
    );
  });

  it("rejects domain without dot", () => {
    expect(validateOrgRegistration({ ...VALID_BODY, domain: "acme" })).toBe(
      "domain must be a valid domain name (e.g., example.com)",
    );
  });

  it("rejects too-short domain", () => {
    expect(validateOrgRegistration({ ...VALID_BODY, domain: "a.b" })).toBe(
      "domain must be a valid domain name (e.g., example.com)",
    );
  });

  it("rejects missing admin_email", () => {
    expect(validateOrgRegistration({ ...VALID_BODY, admin_email: undefined })).toBe(
      "admin_email is required and must be a string",
    );
  });

  it("rejects admin_email without @", () => {
    expect(validateOrgRegistration({ ...VALID_BODY, admin_email: "admin" })).toBe(
      "admin_email must be a valid email address",
    );
  });

  it("rejects admin_email from different domain", () => {
    expect(
      validateOrgRegistration({ ...VALID_BODY, admin_email: "admin@other.com" }),
    ).toBe("admin_email must be in the same domain as the organization");
  });

  it("rejects missing service_account_key", () => {
    expect(
      validateOrgRegistration({ ...VALID_BODY, service_account_key: undefined }),
    ).toBe("service_account_key is required (Google service account JSON key)");
  });

  it("rejects invalid service_account_key type", () => {
    expect(
      validateOrgRegistration({
        ...VALID_BODY,
        service_account_key: { ...VALID_SA_KEY, type: "user" },
      }),
    ).toBe("Service account key must have type 'service_account'");
  });

  it("rejects service_account_key missing required fields", () => {
    const { private_key, ...rest } = VALID_SA_KEY;
    expect(
      validateOrgRegistration({
        ...VALID_BODY,
        service_account_key: rest,
      }),
    ).toBe("Service account key missing required field: private_key");
  });
});

// ---------------------------------------------------------------------------
// extractEmailDomain
// ---------------------------------------------------------------------------

describe("extractEmailDomain", () => {
  it("extracts domain from valid email", () => {
    expect(extractEmailDomain("user@example.com")).toBe("example.com");
  });

  it("lowercases the domain", () => {
    expect(extractEmailDomain("user@EXAMPLE.COM")).toBe("example.com");
  });

  it("returns null for empty string", () => {
    expect(extractEmailDomain("")).toBeNull();
  });

  it("returns null for email without @", () => {
    expect(extractEmailDomain("noatsign")).toBeNull();
  });

  it("handles subdomain emails", () => {
    expect(extractEmailDomain("user@sub.example.com")).toBe("sub.example.com");
  });
});
