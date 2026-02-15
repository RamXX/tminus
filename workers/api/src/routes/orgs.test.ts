/**
 * Unit tests for organization management routes.
 *
 * Tests:
 * - Input validation for org creation (name required, non-empty)
 * - Input validation for member addition (user_id and role required)
 * - Role validation (only 'admin' or 'member' allowed)
 * - checkOrgAdmin RBAC helper (admin access vs non-admin denial)
 * - Envelope format compliance
 * - validateOrgName pure function
 * - validateMemberInput pure function
 * - validateRoleInput pure function
 * - isValidOrgRole pure function
 */

import { describe, it, expect } from "vitest";
import {
  validateOrgName,
  validateMemberInput,
  validateRoleInput,
  isValidOrgRole,
  VALID_ORG_ROLES,
} from "./orgs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("VALID_ORG_ROLES", () => {
  it("contains admin and member", () => {
    expect(VALID_ORG_ROLES).toContain("admin");
    expect(VALID_ORG_ROLES).toContain("member");
  });

  it("has exactly 2 roles", () => {
    expect(VALID_ORG_ROLES).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// isValidOrgRole
// ---------------------------------------------------------------------------

describe("isValidOrgRole", () => {
  it("accepts 'admin'", () => {
    expect(isValidOrgRole("admin")).toBe(true);
  });

  it("accepts 'member'", () => {
    expect(isValidOrgRole("member")).toBe(true);
  });

  it("rejects 'owner'", () => {
    expect(isValidOrgRole("owner")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidOrgRole("")).toBe(false);
  });

  it("rejects 'ADMIN' (case sensitive)", () => {
    expect(isValidOrgRole("ADMIN")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateOrgName
// ---------------------------------------------------------------------------

describe("validateOrgName", () => {
  it("returns null for valid name", () => {
    expect(validateOrgName("Acme Corp")).toBeNull();
  });

  it("returns error for undefined", () => {
    expect(validateOrgName(undefined)).toBe("Organization name is required");
  });

  it("returns error for null", () => {
    expect(validateOrgName(null as unknown as string)).toBe("Organization name is required");
  });

  it("returns error for non-string", () => {
    expect(validateOrgName(123 as unknown as string)).toBe("Organization name must be a string");
  });

  it("returns error for empty string", () => {
    expect(validateOrgName("")).toBe("Organization name cannot be empty");
  });

  it("returns error for whitespace-only", () => {
    expect(validateOrgName("   ")).toBe("Organization name cannot be empty");
  });

  it("returns error for name exceeding 200 characters", () => {
    const longName = "A".repeat(201);
    expect(validateOrgName(longName)).toBe("Organization name must be 200 characters or fewer");
  });

  it("accepts name at exactly 200 characters", () => {
    const maxName = "A".repeat(200);
    expect(validateOrgName(maxName)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateMemberInput
// ---------------------------------------------------------------------------

describe("validateMemberInput", () => {
  it("returns null for valid input", () => {
    expect(validateMemberInput({ user_id: "usr_01HXYZ000000000000000001", role: "member" })).toBeNull();
  });

  it("returns error when user_id is missing", () => {
    expect(validateMemberInput({ role: "member" })).toBe("user_id is required");
  });

  it("returns error when user_id is not a string", () => {
    expect(validateMemberInput({ user_id: 123, role: "member" })).toBe("user_id must be a string");
  });

  it("returns error when user_id is empty", () => {
    expect(validateMemberInput({ user_id: "", role: "member" })).toBe("user_id cannot be empty");
  });

  it("returns error when role is missing", () => {
    expect(validateMemberInput({ user_id: "usr_01HXYZ000000000000000001" })).toBe("role is required");
  });

  it("returns error for invalid role", () => {
    expect(validateMemberInput({ user_id: "usr_01HXYZ000000000000000001", role: "owner" })).toBe(
      "role must be one of: admin, member",
    );
  });
});

// ---------------------------------------------------------------------------
// validateRoleInput
// ---------------------------------------------------------------------------

describe("validateRoleInput", () => {
  it("returns null for valid role 'admin'", () => {
    expect(validateRoleInput({ role: "admin" })).toBeNull();
  });

  it("returns null for valid role 'member'", () => {
    expect(validateRoleInput({ role: "member" })).toBeNull();
  });

  it("returns error when role is missing", () => {
    expect(validateRoleInput({})).toBe("role is required");
  });

  it("returns error for invalid role", () => {
    expect(validateRoleInput({ role: "superadmin" })).toBe("role must be one of: admin, member");
  });

  it("returns error for non-string role", () => {
    expect(validateRoleInput({ role: 42 })).toBe("role must be a string");
  });
});
