/**
 * Unit tests for delegation admin dashboard route handlers (TM-9iu.4).
 *
 * Tests:
 * - checkAdminAuth: admin auth guard (BR-1)
 * - validateDiscoveryConfigUpdate: discovery config input validation
 * - validateUserStatusUpdate: user status update validation
 * - parsePagination: pagination parameter parsing
 * - Module export correctness
 */

import { describe, it, expect } from "vitest";
import {
  checkAdminAuth,
  validateDiscoveryConfigUpdate,
  validateUserStatusUpdate,
  parsePagination,
  handleOrgDashboard,
  handleListDiscoveredUsers,
  handleGetDiscoveredUser,
  handleUpdateDiscoveredUser,
  handleGetDiscoveryConfig,
  handleUpdateDiscoveryConfig,
  handleDelegationHealth,
  handleDelegationRotate,
  handleAuditLog,
} from "./org-delegation-admin";

// ---------------------------------------------------------------------------
// checkAdminAuth (BR-1)
// ---------------------------------------------------------------------------

describe("checkAdminAuth", () => {
  it("returns null for admin user (authorized)", () => {
    const result = checkAdminAuth({ userId: "usr_admin", isAdmin: true });
    expect(result).toBeNull();
  });

  it("returns 403 Response for non-admin user", async () => {
    const result = checkAdminAuth({ userId: "usr_member", isAdmin: false });
    expect(result).toBeInstanceOf(Response);
    expect(result!.status).toBe(403);

    const body = (await result!.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Forbidden");
    expect(body.error).toContain("org admin");
  });
});

// ---------------------------------------------------------------------------
// validateDiscoveryConfigUpdate
// ---------------------------------------------------------------------------

describe("validateDiscoveryConfigUpdate", () => {
  it("accepts valid full config", () => {
    expect(
      validateDiscoveryConfigUpdate({
        sync_mode: "proactive",
        ou_filter: ["/Engineering", "/Sales"],
        excluded_emails: ["noreply@acme.com"],
        retention_days: 60,
      }),
    ).toBeNull();
  });

  it("accepts empty object (no updates)", () => {
    expect(validateDiscoveryConfigUpdate({})).toBeNull();
  });

  it("accepts null ou_filter (clear filter)", () => {
    expect(validateDiscoveryConfigUpdate({ ou_filter: null })).toBeNull();
  });

  it("accepts null excluded_emails (clear exclusions)", () => {
    expect(
      validateDiscoveryConfigUpdate({ excluded_emails: null }),
    ).toBeNull();
  });

  it("rejects invalid sync_mode", () => {
    expect(validateDiscoveryConfigUpdate({ sync_mode: "fast" })).toBe(
      "sync_mode must be 'proactive' or 'lazy'",
    );
  });

  it("rejects non-array ou_filter", () => {
    expect(validateDiscoveryConfigUpdate({ ou_filter: "/Engineering" })).toBe(
      "ou_filter must be an array of strings",
    );
  });

  it("rejects ou_filter with empty string entry", () => {
    expect(
      validateDiscoveryConfigUpdate({ ou_filter: ["", "/Sales"] }),
    ).toBe("ou_filter entries must be non-empty strings");
  });

  it("rejects non-array excluded_emails", () => {
    expect(
      validateDiscoveryConfigUpdate({ excluded_emails: "user@acme.com" }),
    ).toBe("excluded_emails must be an array of strings");
  });

  it("rejects excluded_emails with invalid email", () => {
    expect(
      validateDiscoveryConfigUpdate({
        excluded_emails: ["not-an-email"],
      }),
    ).toBe("excluded_emails entries must be valid email addresses");
  });

  it("rejects non-integer retention_days", () => {
    expect(validateDiscoveryConfigUpdate({ retention_days: 30.5 })).toBe(
      "retention_days must be an integer between 1 and 365",
    );
  });

  it("rejects retention_days below 1", () => {
    expect(validateDiscoveryConfigUpdate({ retention_days: 0 })).toBe(
      "retention_days must be an integer between 1 and 365",
    );
  });

  it("rejects retention_days above 365", () => {
    expect(validateDiscoveryConfigUpdate({ retention_days: 400 })).toBe(
      "retention_days must be an integer between 1 and 365",
    );
  });

  it("rejects string retention_days", () => {
    expect(validateDiscoveryConfigUpdate({ retention_days: "30" })).toBe(
      "retention_days must be an integer between 1 and 365",
    );
  });
});

// ---------------------------------------------------------------------------
// validateUserStatusUpdate
// ---------------------------------------------------------------------------

describe("validateUserStatusUpdate", () => {
  it("accepts status: active", () => {
    expect(validateUserStatusUpdate({ status: "active" })).toBeNull();
  });

  it("accepts status: suspended", () => {
    expect(validateUserStatusUpdate({ status: "suspended" })).toBeNull();
  });

  it("accepts status: removed", () => {
    expect(validateUserStatusUpdate({ status: "removed" })).toBeNull();
  });

  it("rejects missing status", () => {
    expect(validateUserStatusUpdate({})).toBe(
      "status is required and must be a string",
    );
  });

  it("rejects non-string status", () => {
    expect(validateUserStatusUpdate({ status: 42 })).toBe(
      "status is required and must be a string",
    );
  });

  it("rejects invalid status value", () => {
    const err = validateUserStatusUpdate({ status: "deleted" });
    expect(err).toContain("status must be one of");
    expect(err).toContain("active");
    expect(err).toContain("suspended");
    expect(err).toContain("removed");
  });
});

// ---------------------------------------------------------------------------
// parsePagination
// ---------------------------------------------------------------------------

describe("parsePagination", () => {
  it("returns defaults when no params", () => {
    const url = new URL("https://api.test.com/orgs/123/users");
    expect(parsePagination(url)).toEqual({ limit: 50, offset: 0 });
  });

  it("parses valid limit and offset", () => {
    const url = new URL(
      "https://api.test.com/orgs/123/users?limit=20&offset=40",
    );
    expect(parsePagination(url)).toEqual({ limit: 20, offset: 40 });
  });

  it("caps limit at 200", () => {
    const url = new URL("https://api.test.com/orgs/123/users?limit=500");
    // Should fall back to default (50) since 500 > 200
    expect(parsePagination(url).limit).toBe(50);
  });

  it("ignores negative offset", () => {
    const url = new URL("https://api.test.com/orgs/123/users?offset=-5");
    expect(parsePagination(url).offset).toBe(0);
  });

  it("ignores non-numeric params", () => {
    const url = new URL(
      "https://api.test.com/orgs/123/users?limit=abc&offset=xyz",
    );
    expect(parsePagination(url)).toEqual({ limit: 50, offset: 0 });
  });

  it("allows limit of 1 (minimum)", () => {
    const url = new URL("https://api.test.com/orgs/123/users?limit=1");
    expect(parsePagination(url).limit).toBe(1);
  });

  it("allows limit of 200 (maximum)", () => {
    const url = new URL("https://api.test.com/orgs/123/users?limit=200");
    expect(parsePagination(url).limit).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

describe("org-delegation-admin module exports", () => {
  it("exports all handler functions", () => {
    expect(typeof handleOrgDashboard).toBe("function");
    expect(typeof handleListDiscoveredUsers).toBe("function");
    expect(typeof handleGetDiscoveredUser).toBe("function");
    expect(typeof handleUpdateDiscoveredUser).toBe("function");
    expect(typeof handleGetDiscoveryConfig).toBe("function");
    expect(typeof handleUpdateDiscoveryConfig).toBe("function");
    expect(typeof handleDelegationHealth).toBe("function");
    expect(typeof handleDelegationRotate).toBe("function");
    expect(typeof handleAuditLog).toBe("function");
  });

  it("exports validation helpers", () => {
    expect(typeof checkAdminAuth).toBe("function");
    expect(typeof validateDiscoveryConfigUpdate).toBe("function");
    expect(typeof validateUserStatusUpdate).toBe("function");
    expect(typeof parsePagination).toBe("function");
  });
});
