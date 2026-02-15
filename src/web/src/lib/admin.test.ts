/**
 * Unit tests for the admin console lib (types + validation helpers).
 *
 * Tests cover:
 * - validatePolicyConfig: valid/invalid configs for each policy type
 * - parsePolicyConfig: JSON parsing with error handling
 * - formatLastSync: date formatting with edge cases
 * - POLICY_TYPE_LABELS: all policy types have labels
 * - VALID_POLICY_TYPES: all 4 policy types present
 */
import { describe, it, expect } from "vitest";
import {
  validatePolicyConfig,
  parsePolicyConfig,
  formatLastSync,
  VALID_POLICY_TYPES,
  POLICY_TYPE_LABELS,
  type OrgPolicyType,
} from "./admin";

// ---------------------------------------------------------------------------
// validatePolicyConfig
// ---------------------------------------------------------------------------

describe("validatePolicyConfig", () => {
  describe("mandatory_working_hours", () => {
    it("accepts valid config", () => {
      expect(
        validatePolicyConfig("mandatory_working_hours", {
          start_hour: 9,
          end_hour: 17,
        }),
      ).toBeNull();
    });

    it("rejects missing start_hour", () => {
      expect(
        validatePolicyConfig("mandatory_working_hours", { end_hour: 17 }),
      ).toBe("start_hour and end_hour are required numbers");
    });

    it("rejects missing end_hour", () => {
      expect(
        validatePolicyConfig("mandatory_working_hours", { start_hour: 9 }),
      ).toBe("start_hour and end_hour are required numbers");
    });

    it("rejects start_hour out of range", () => {
      expect(
        validatePolicyConfig("mandatory_working_hours", {
          start_hour: -1,
          end_hour: 17,
        }),
      ).toBe("start_hour must be between 0 and 23");
    });

    it("rejects end_hour out of range", () => {
      expect(
        validatePolicyConfig("mandatory_working_hours", {
          start_hour: 9,
          end_hour: 25,
        }),
      ).toBe("end_hour must be between 0 and 23");
    });

    it("rejects start_hour >= end_hour", () => {
      expect(
        validatePolicyConfig("mandatory_working_hours", {
          start_hour: 17,
          end_hour: 9,
        }),
      ).toBe("start_hour must be before end_hour");
    });

    it("rejects start_hour equal to end_hour", () => {
      expect(
        validatePolicyConfig("mandatory_working_hours", {
          start_hour: 12,
          end_hour: 12,
        }),
      ).toBe("start_hour must be before end_hour");
    });
  });

  describe("minimum_vip_priority", () => {
    it("accepts valid config", () => {
      expect(
        validatePolicyConfig("minimum_vip_priority", { min_weight: 50 }),
      ).toBeNull();
    });

    it("rejects missing min_weight", () => {
      expect(
        validatePolicyConfig("minimum_vip_priority", {}),
      ).toBe("min_weight is a required number");
    });

    it("rejects min_weight out of range (negative)", () => {
      expect(
        validatePolicyConfig("minimum_vip_priority", { min_weight: -5 }),
      ).toBe("min_weight must be between 0 and 100");
    });

    it("rejects min_weight out of range (too large)", () => {
      expect(
        validatePolicyConfig("minimum_vip_priority", { min_weight: 101 }),
      ).toBe("min_weight must be between 0 and 100");
    });

    it("accepts boundary values", () => {
      expect(
        validatePolicyConfig("minimum_vip_priority", { min_weight: 0 }),
      ).toBeNull();
      expect(
        validatePolicyConfig("minimum_vip_priority", { min_weight: 100 }),
      ).toBeNull();
    });
  });

  describe("required_projection_detail", () => {
    it("accepts BUSY", () => {
      expect(
        validatePolicyConfig("required_projection_detail", {
          detail_level: "BUSY",
        }),
      ).toBeNull();
    });

    it("accepts TITLE", () => {
      expect(
        validatePolicyConfig("required_projection_detail", {
          detail_level: "TITLE",
        }),
      ).toBeNull();
    });

    it("accepts FULL", () => {
      expect(
        validatePolicyConfig("required_projection_detail", {
          detail_level: "FULL",
        }),
      ).toBeNull();
    });

    it("rejects invalid detail_level", () => {
      expect(
        validatePolicyConfig("required_projection_detail", {
          detail_level: "INVALID",
        }),
      ).toBe("detail_level must be one of: BUSY, TITLE, FULL");
    });

    it("rejects missing detail_level", () => {
      expect(
        validatePolicyConfig("required_projection_detail", {}),
      ).toBe("detail_level must be one of: BUSY, TITLE, FULL");
    });
  });

  describe("max_account_count", () => {
    it("accepts valid config", () => {
      expect(
        validatePolicyConfig("max_account_count", { max_accounts: 5 }),
      ).toBeNull();
    });

    it("rejects missing max_accounts", () => {
      expect(
        validatePolicyConfig("max_account_count", {}),
      ).toBe("max_accounts is a required number");
    });

    it("rejects zero", () => {
      expect(
        validatePolicyConfig("max_account_count", { max_accounts: 0 }),
      ).toBe("max_accounts must be a positive integer");
    });

    it("rejects negative", () => {
      expect(
        validatePolicyConfig("max_account_count", { max_accounts: -3 }),
      ).toBe("max_accounts must be a positive integer");
    });

    it("rejects non-integer", () => {
      expect(
        validatePolicyConfig("max_account_count", { max_accounts: 2.5 }),
      ).toBe("max_accounts must be a positive integer");
    });
  });

  describe("edge cases", () => {
    it("rejects invalid policy type", () => {
      expect(
        validatePolicyConfig("invalid_type" as OrgPolicyType, {}),
      ).toBe("Invalid policy type");
    });

    it("rejects null config", () => {
      expect(
        validatePolicyConfig("max_account_count", null as unknown as Record<string, unknown>),
      ).toBe("Config must be an object");
    });
  });
});

// ---------------------------------------------------------------------------
// parsePolicyConfig
// ---------------------------------------------------------------------------

describe("parsePolicyConfig", () => {
  it("parses valid JSON", () => {
    expect(parsePolicyConfig('{"start_hour": 9, "end_hour": 17}')).toEqual({
      start_hour: 9,
      end_hour: 17,
    });
  });

  it("returns empty object for invalid JSON", () => {
    expect(parsePolicyConfig("not json")).toEqual({});
  });

  it("returns empty object for empty string", () => {
    expect(parsePolicyConfig("")).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// formatLastSync
// ---------------------------------------------------------------------------

describe("formatLastSync", () => {
  it("returns 'Never' for null", () => {
    expect(formatLastSync(null)).toBe("Never");
  });

  it("returns 'Never' for empty string", () => {
    expect(formatLastSync("")).toBe("Never");
  });

  it("returns 'Never' for invalid date", () => {
    expect(formatLastSync("not-a-date")).toBe("Never");
  });

  it("formats valid ISO date", () => {
    const result = formatLastSync("2026-02-15T12:30:00Z");
    // Date formatting is locale-dependent, just verify it's not "Never"
    expect(result).not.toBe("Never");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("VALID_POLICY_TYPES", () => {
  it("contains all 4 policy types", () => {
    expect(VALID_POLICY_TYPES).toHaveLength(4);
    expect(VALID_POLICY_TYPES).toContain("mandatory_working_hours");
    expect(VALID_POLICY_TYPES).toContain("minimum_vip_priority");
    expect(VALID_POLICY_TYPES).toContain("required_projection_detail");
    expect(VALID_POLICY_TYPES).toContain("max_account_count");
  });
});

describe("POLICY_TYPE_LABELS", () => {
  it("has a label for each policy type", () => {
    for (const type of VALID_POLICY_TYPES) {
      expect(POLICY_TYPE_LABELS[type]).toBeDefined();
      expect(typeof POLICY_TYPE_LABELS[type]).toBe("string");
      expect(POLICY_TYPE_LABELS[type].length).toBeGreaterThan(0);
    }
  });
});
