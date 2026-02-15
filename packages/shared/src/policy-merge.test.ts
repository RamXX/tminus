/**
 * Unit tests for the org-level policy merge engine.
 *
 * The merge engine enforces org policies as a floor:
 * - Users can be stricter (narrower hours, higher priority, etc.)
 * - Users cannot be more lenient than the org policy
 *
 * Tests cover:
 * - mergeWorkingHours: org window vs user window, user cannot widen
 * - mergeVipPriority: org minimum priority floor, user can add VIPs
 * - mergeAccountLimit: org max accounts, user cannot exceed
 * - mergeOrgAndUserPolicies: applies all merge rules together
 * - validateOrgPolicyConfig: input validation for policy configs
 *
 * Pattern: TDD RED/GREEN/REFACTOR
 */

import { describe, it, expect } from "vitest";
import {
  mergeWorkingHours,
  mergeVipPriority,
  mergeAccountLimit,
  mergeProjectionDetail,
  mergeOrgAndUserPolicies,
  validateOrgPolicyConfig,
  VALID_ORG_POLICY_TYPES,
  DETAIL_LEVEL_RANK,
} from "./policy-merge";
import type {
  WorkingHoursPolicy,
  VipPriorityPolicy,
  AccountLimitPolicy,
  ProjectionDetailPolicy,
  OrgPolicy,
  UserPolicies,
} from "./policy-merge";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("VALID_ORG_POLICY_TYPES", () => {
  it("contains the four required policy types", () => {
    expect(VALID_ORG_POLICY_TYPES).toContain("mandatory_working_hours");
    expect(VALID_ORG_POLICY_TYPES).toContain("minimum_vip_priority");
    expect(VALID_ORG_POLICY_TYPES).toContain("required_projection_detail");
    expect(VALID_ORG_POLICY_TYPES).toContain("max_account_count");
  });

  it("has exactly 4 types", () => {
    expect(VALID_ORG_POLICY_TYPES).toHaveLength(4);
  });
});

describe("DETAIL_LEVEL_RANK", () => {
  it("BUSY < TITLE < FULL", () => {
    expect(DETAIL_LEVEL_RANK.BUSY).toBeLessThan(DETAIL_LEVEL_RANK.TITLE);
    expect(DETAIL_LEVEL_RANK.TITLE).toBeLessThan(DETAIL_LEVEL_RANK.FULL);
  });
});

// ---------------------------------------------------------------------------
// mergeWorkingHours
// ---------------------------------------------------------------------------

describe("mergeWorkingHours", () => {
  const orgPolicy: WorkingHoursPolicy = {
    start_hour: 8,
    end_hour: 18,
  };

  it("user within org window -- user policy preserved", () => {
    const userPolicy: WorkingHoursPolicy = { start_hour: 9, end_hour: 17 };
    const merged = mergeWorkingHours(orgPolicy, userPolicy);
    // User is stricter (9-17 fits within 8-18), so user's preference is kept
    expect(merged.start_hour).toBe(9);
    expect(merged.end_hour).toBe(17);
  });

  it("user tries to start earlier than org -- clamped to org start", () => {
    const userPolicy: WorkingHoursPolicy = { start_hour: 7, end_hour: 17 };
    const merged = mergeWorkingHours(orgPolicy, userPolicy);
    // User tried to start at 7, but org floor is 8
    expect(merged.start_hour).toBe(8);
    expect(merged.end_hour).toBe(17);
  });

  it("user tries to end later than org -- clamped to org end", () => {
    const userPolicy: WorkingHoursPolicy = { start_hour: 9, end_hour: 20 };
    const merged = mergeWorkingHours(orgPolicy, userPolicy);
    expect(merged.start_hour).toBe(9);
    expect(merged.end_hour).toBe(18);
  });

  it("user tries to widen both directions -- clamped to org window", () => {
    const userPolicy: WorkingHoursPolicy = { start_hour: 6, end_hour: 22 };
    const merged = mergeWorkingHours(orgPolicy, userPolicy);
    expect(merged.start_hour).toBe(8);
    expect(merged.end_hour).toBe(18);
  });

  it("user has no policy -- org policy used as default", () => {
    const merged = mergeWorkingHours(orgPolicy, undefined);
    expect(merged.start_hour).toBe(8);
    expect(merged.end_hour).toBe(18);
  });

  it("user matches org exactly -- preserved", () => {
    const userPolicy: WorkingHoursPolicy = { start_hour: 8, end_hour: 18 };
    const merged = mergeWorkingHours(orgPolicy, userPolicy);
    expect(merged.start_hour).toBe(8);
    expect(merged.end_hour).toBe(18);
  });
});

// ---------------------------------------------------------------------------
// mergeVipPriority
// ---------------------------------------------------------------------------

describe("mergeVipPriority", () => {
  const orgPolicy: VipPriorityPolicy = {
    minimum_weight: 0.5,
  };

  it("user VIPs above org minimum -- all kept", () => {
    const userVips = [
      { contact_email: "ceo@corp.com", weight: 0.8 },
      { contact_email: "vp@corp.com", weight: 0.6 },
    ];
    const merged = mergeVipPriority(orgPolicy, userVips);
    expect(merged).toHaveLength(2);
    expect(merged[0].weight).toBe(0.8);
    expect(merged[1].weight).toBe(0.6);
  });

  it("user VIP below org minimum -- weight raised to floor", () => {
    const userVips = [
      { contact_email: "intern@corp.com", weight: 0.2 },
    ];
    const merged = mergeVipPriority(orgPolicy, userVips);
    expect(merged).toHaveLength(1);
    expect(merged[0].weight).toBe(0.5);
    expect(merged[0].contact_email).toBe("intern@corp.com");
  });

  it("mixed VIPs -- only those below floor are raised", () => {
    const userVips = [
      { contact_email: "ceo@corp.com", weight: 0.9 },
      { contact_email: "intern@corp.com", weight: 0.1 },
      { contact_email: "manager@corp.com", weight: 0.5 },
    ];
    const merged = mergeVipPriority(orgPolicy, userVips);
    expect(merged).toHaveLength(3);
    expect(merged.find(v => v.contact_email === "ceo@corp.com")?.weight).toBe(0.9);
    expect(merged.find(v => v.contact_email === "intern@corp.com")?.weight).toBe(0.5);
    expect(merged.find(v => v.contact_email === "manager@corp.com")?.weight).toBe(0.5);
  });

  it("empty user VIPs -- returns empty array", () => {
    const merged = mergeVipPriority(orgPolicy, []);
    expect(merged).toEqual([]);
  });

  it("undefined user VIPs -- returns empty array", () => {
    const merged = mergeVipPriority(orgPolicy, undefined);
    expect(merged).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mergeAccountLimit
// ---------------------------------------------------------------------------

describe("mergeAccountLimit", () => {
  const orgPolicy: AccountLimitPolicy = {
    max_accounts: 5,
  };

  it("user count within limit -- returns allowed:true", () => {
    const result = mergeAccountLimit(orgPolicy, 3);
    expect(result.allowed).toBe(true);
    expect(result.effective_max).toBe(5);
  });

  it("user count at limit -- returns allowed:true (at boundary)", () => {
    const result = mergeAccountLimit(orgPolicy, 5);
    expect(result.allowed).toBe(true);
    expect(result.effective_max).toBe(5);
  });

  it("user count exceeds limit -- returns allowed:false", () => {
    const result = mergeAccountLimit(orgPolicy, 6);
    expect(result.allowed).toBe(false);
    expect(result.effective_max).toBe(5);
  });

  it("zero accounts -- returns allowed:true", () => {
    const result = mergeAccountLimit(orgPolicy, 0);
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mergeProjectionDetail
// ---------------------------------------------------------------------------

describe("mergeProjectionDetail", () => {
  it("org requires TITLE, user has FULL -- user is stricter, FULL kept", () => {
    const orgPolicy: ProjectionDetailPolicy = { minimum_detail: "TITLE" };
    const result = mergeProjectionDetail(orgPolicy, "FULL");
    expect(result).toBe("FULL");
  });

  it("org requires TITLE, user has BUSY -- user is more lenient, raised to TITLE", () => {
    const orgPolicy: ProjectionDetailPolicy = { minimum_detail: "TITLE" };
    const result = mergeProjectionDetail(orgPolicy, "BUSY");
    expect(result).toBe("TITLE");
  });

  it("org requires FULL, user has BUSY -- raised to FULL", () => {
    const orgPolicy: ProjectionDetailPolicy = { minimum_detail: "FULL" };
    const result = mergeProjectionDetail(orgPolicy, "BUSY");
    expect(result).toBe("FULL");
  });

  it("org requires BUSY, user has TITLE -- user is stricter, TITLE kept", () => {
    const orgPolicy: ProjectionDetailPolicy = { minimum_detail: "BUSY" };
    const result = mergeProjectionDetail(orgPolicy, "TITLE");
    expect(result).toBe("TITLE");
  });

  it("user has no preference -- org minimum used", () => {
    const orgPolicy: ProjectionDetailPolicy = { minimum_detail: "TITLE" };
    const result = mergeProjectionDetail(orgPolicy, undefined);
    expect(result).toBe("TITLE");
  });

  it("same level -- preserved", () => {
    const orgPolicy: ProjectionDetailPolicy = { minimum_detail: "TITLE" };
    const result = mergeProjectionDetail(orgPolicy, "TITLE");
    expect(result).toBe("TITLE");
  });
});

// ---------------------------------------------------------------------------
// mergeOrgAndUserPolicies (composite)
// ---------------------------------------------------------------------------

describe("mergeOrgAndUserPolicies", () => {
  it("applies all merge rules together", () => {
    const orgPolicies: OrgPolicy[] = [
      {
        policy_type: "mandatory_working_hours",
        config: { start_hour: 8, end_hour: 18 },
      },
      {
        policy_type: "minimum_vip_priority",
        config: { minimum_weight: 0.5 },
      },
      {
        policy_type: "max_account_count",
        config: { max_accounts: 5 },
      },
      {
        policy_type: "required_projection_detail",
        config: { minimum_detail: "TITLE" },
      },
    ];

    const userPolicies: UserPolicies = {
      working_hours: { start_hour: 7, end_hour: 20 },
      vip_list: [
        { contact_email: "ceo@corp.com", weight: 0.9 },
        { contact_email: "intern@corp.com", weight: 0.1 },
      ],
      account_count: 3,
      projection_detail: "BUSY",
    };

    const merged = mergeOrgAndUserPolicies(orgPolicies, userPolicies);

    // Working hours clamped
    expect(merged.working_hours.start_hour).toBe(8);
    expect(merged.working_hours.end_hour).toBe(18);

    // VIP floor enforced
    expect(merged.vip_list.find(v => v.contact_email === "intern@corp.com")?.weight).toBe(0.5);
    expect(merged.vip_list.find(v => v.contact_email === "ceo@corp.com")?.weight).toBe(0.9);

    // Account limit
    expect(merged.account_limit.allowed).toBe(true);
    expect(merged.account_limit.effective_max).toBe(5);

    // Projection detail raised
    expect(merged.projection_detail).toBe("TITLE");
  });

  it("handles empty org policies (no restrictions)", () => {
    const userPolicies: UserPolicies = {
      working_hours: { start_hour: 7, end_hour: 20 },
      vip_list: [{ contact_email: "a@b.com", weight: 0.1 }],
      account_count: 10,
      projection_detail: "BUSY",
    };

    const merged = mergeOrgAndUserPolicies([], userPolicies);

    // User policies preserved without org restrictions
    expect(merged.working_hours.start_hour).toBe(7);
    expect(merged.working_hours.end_hour).toBe(20);
    expect(merged.vip_list[0].weight).toBe(0.1);
    expect(merged.account_limit.allowed).toBe(true);
    expect(merged.account_limit.effective_max).toBe(Infinity);
    expect(merged.projection_detail).toBe("BUSY");
  });

  it("handles partial org policies", () => {
    const orgPolicies: OrgPolicy[] = [
      {
        policy_type: "mandatory_working_hours",
        config: { start_hour: 9, end_hour: 17 },
      },
    ];

    const userPolicies: UserPolicies = {
      working_hours: { start_hour: 10, end_hour: 16 },
      vip_list: [{ contact_email: "a@b.com", weight: 0.1 }],
      account_count: 3,
      projection_detail: "BUSY",
    };

    const merged = mergeOrgAndUserPolicies(orgPolicies, userPolicies);

    // Working hours: user is stricter (10-16 within 9-17)
    expect(merged.working_hours.start_hour).toBe(10);
    expect(merged.working_hours.end_hour).toBe(16);

    // Other policies pass through unchanged since no org policy
    expect(merged.vip_list[0].weight).toBe(0.1);
    expect(merged.account_limit.effective_max).toBe(Infinity);
    expect(merged.projection_detail).toBe("BUSY");
  });
});

// ---------------------------------------------------------------------------
// validateOrgPolicyConfig
// ---------------------------------------------------------------------------

describe("validateOrgPolicyConfig", () => {
  it("validates mandatory_working_hours correctly", () => {
    expect(validateOrgPolicyConfig("mandatory_working_hours", { start_hour: 8, end_hour: 18 })).toBeNull();
  });

  it("rejects working hours with missing fields", () => {
    expect(validateOrgPolicyConfig("mandatory_working_hours", { start_hour: 8 })).toContain("end_hour");
  });

  it("rejects working hours with invalid range", () => {
    expect(validateOrgPolicyConfig("mandatory_working_hours", { start_hour: 18, end_hour: 8 }))
      .toContain("start_hour must be less than end_hour");
  });

  it("rejects working hours out of 0-23 range", () => {
    expect(validateOrgPolicyConfig("mandatory_working_hours", { start_hour: -1, end_hour: 18 }))
      .toContain("start_hour must be between 0 and 23");
  });

  it("rejects working hours with end_hour out of range", () => {
    expect(validateOrgPolicyConfig("mandatory_working_hours", { start_hour: 8, end_hour: 25 }))
      .toContain("end_hour must be between 0 and 23");
  });

  it("validates minimum_vip_priority correctly", () => {
    expect(validateOrgPolicyConfig("minimum_vip_priority", { minimum_weight: 0.5 })).toBeNull();
  });

  it("rejects VIP priority with missing weight", () => {
    expect(validateOrgPolicyConfig("minimum_vip_priority", {})).toContain("minimum_weight");
  });

  it("rejects VIP priority with out-of-range weight", () => {
    expect(validateOrgPolicyConfig("minimum_vip_priority", { minimum_weight: 1.5 }))
      .toContain("minimum_weight must be between 0 and 1");
  });

  it("validates max_account_count correctly", () => {
    expect(validateOrgPolicyConfig("max_account_count", { max_accounts: 5 })).toBeNull();
  });

  it("rejects max_account_count with missing field", () => {
    expect(validateOrgPolicyConfig("max_account_count", {})).toContain("max_accounts");
  });

  it("rejects max_account_count with non-positive value", () => {
    expect(validateOrgPolicyConfig("max_account_count", { max_accounts: 0 }))
      .toContain("max_accounts must be a positive integer");
  });

  it("validates required_projection_detail correctly", () => {
    expect(validateOrgPolicyConfig("required_projection_detail", { minimum_detail: "TITLE" })).toBeNull();
  });

  it("rejects invalid projection detail level", () => {
    expect(validateOrgPolicyConfig("required_projection_detail", { minimum_detail: "INVALID" }))
      .toContain("minimum_detail must be one of: BUSY, TITLE, FULL");
  });

  it("rejects unknown policy type", () => {
    expect(validateOrgPolicyConfig("unknown_type" as never, {})).toContain("Unknown policy type");
  });
});
