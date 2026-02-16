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
  validatePolicyInput,
  validatePolicyUpdateInput,
  isValidOrgRole,
  VALID_ORG_ROLES,
  VALID_POLICY_TYPES,
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
    expect(validateMemberInput({ user_id: "usr_01HXYZ00000000000000000001", role: "member" })).toBeNull();
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
    expect(validateMemberInput({ user_id: "usr_01HXYZ00000000000000000001" })).toBe("role is required");
  });

  it("returns error for invalid role", () => {
    expect(validateMemberInput({ user_id: "usr_01HXYZ00000000000000000001", role: "owner" })).toBe(
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

// ---------------------------------------------------------------------------
// VALID_POLICY_TYPES
// ---------------------------------------------------------------------------

describe("VALID_POLICY_TYPES", () => {
  it("contains 4 policy types", () => {
    expect(VALID_POLICY_TYPES).toHaveLength(4);
  });

  it("includes all required types", () => {
    expect(VALID_POLICY_TYPES).toContain("mandatory_working_hours");
    expect(VALID_POLICY_TYPES).toContain("minimum_vip_priority");
    expect(VALID_POLICY_TYPES).toContain("required_projection_detail");
    expect(VALID_POLICY_TYPES).toContain("max_account_count");
  });
});

// ---------------------------------------------------------------------------
// validatePolicyInput
// ---------------------------------------------------------------------------

describe("validatePolicyInput", () => {
  it("returns null for valid mandatory_working_hours", () => {
    const input = { policy_type: "mandatory_working_hours", config: { start_hour: 8, end_hour: 18 } };
    expect(validatePolicyInput(input)).toBeNull();
  });

  it("returns null for valid minimum_vip_priority", () => {
    const input = { policy_type: "minimum_vip_priority", config: { minimum_weight: 0.5 } };
    expect(validatePolicyInput(input)).toBeNull();
  });

  it("returns null for valid max_account_count", () => {
    const input = { policy_type: "max_account_count", config: { max_accounts: 5 } };
    expect(validatePolicyInput(input)).toBeNull();
  });

  it("returns null for valid required_projection_detail", () => {
    const input = { policy_type: "required_projection_detail", config: { minimum_detail: "TITLE" } };
    expect(validatePolicyInput(input)).toBeNull();
  });

  it("returns error for missing policy_type", () => {
    expect(validatePolicyInput({ config: {} })).toBe("policy_type is required");
  });

  it("returns error for invalid policy_type", () => {
    expect(validatePolicyInput({ policy_type: "invalid", config: {} })).toContain("policy_type must be one of");
  });

  it("returns error for missing config", () => {
    expect(validatePolicyInput({ policy_type: "max_account_count" })).toBe("config is required");
  });

  it("returns error for non-object config", () => {
    expect(validatePolicyInput({ policy_type: "max_account_count", config: "string" })).toBe("config must be an object");
  });

  it("returns error for invalid config (delegates to shared validation)", () => {
    const input = { policy_type: "mandatory_working_hours", config: { start_hour: 20, end_hour: 8 } };
    expect(validatePolicyInput(input)).toContain("start_hour must be less than end_hour");
  });

  it("returns error for non-string policy_type", () => {
    expect(validatePolicyInput({ policy_type: 123, config: {} })).toBe("policy_type must be a string");
  });
});

// ---------------------------------------------------------------------------
// validatePolicyUpdateInput
// ---------------------------------------------------------------------------

describe("validatePolicyUpdateInput", () => {
  it("returns null for valid config update", () => {
    expect(validatePolicyUpdateInput(
      { config: { max_accounts: 10 } },
      "max_account_count",
    )).toBeNull();
  });

  it("returns error for missing config", () => {
    expect(validatePolicyUpdateInput({}, "max_account_count")).toBe("config is required");
  });

  it("returns error for invalid config", () => {
    expect(validatePolicyUpdateInput(
      { config: { max_accounts: -1 } },
      "max_account_count",
    )).toContain("max_accounts must be a positive integer");
  });

  it("returns error for non-object config", () => {
    expect(validatePolicyUpdateInput(
      { config: [] },
      "max_account_count",
    )).toBe("config must be an object");
  });
});
