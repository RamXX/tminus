/**
 * @tminus/shared -- Org-level policy merge engine.
 *
 * Merges organization-level policies with user-level policies.
 * Org policies act as a floor (minimum requirements):
 * - Users can be stricter (narrower working hours, higher VIP priority, etc.)
 * - Users cannot be more lenient than the org policy
 *
 * Pure functions, no side effects, no I/O.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid org policy types (mirrors the D1 CHECK constraint). */
export const VALID_ORG_POLICY_TYPES = [
  "mandatory_working_hours",
  "minimum_vip_priority",
  "required_projection_detail",
  "max_account_count",
] as const;

export type OrgPolicyType = (typeof VALID_ORG_POLICY_TYPES)[number];

/**
 * Validate that a string is a valid org policy type.
 */
export function isValidOrgPolicyType(value: string): value is OrgPolicyType {
  return VALID_ORG_POLICY_TYPES.includes(value as OrgPolicyType);
}

/** Working hours window: start and end hour (0-23 inclusive). */
export interface WorkingHoursPolicy {
  start_hour: number;
  end_hour: number;
}

/** VIP priority floor: minimum weight for any VIP entry. */
export interface VipPriorityPolicy {
  minimum_weight: number;
}

/** Account limit: maximum number of linked accounts per member. */
export interface AccountLimitPolicy {
  max_accounts: number;
}

/** Projection detail floor: minimum detail level for projections. */
export interface ProjectionDetailPolicy {
  minimum_detail: "BUSY" | "TITLE" | "FULL";
}

/** A VIP entry with contact email and weight. */
export interface VipEntry {
  contact_email: string;
  weight: number;
}

/** An org policy with its type and parsed config. */
export interface OrgPolicy {
  policy_type: OrgPolicyType;
  config: WorkingHoursPolicy | VipPriorityPolicy | AccountLimitPolicy | ProjectionDetailPolicy;
}

/** User-side policies to merge against org policies. */
export interface UserPolicies {
  working_hours?: WorkingHoursPolicy;
  vip_list?: VipEntry[];
  account_count: number;
  projection_detail?: "BUSY" | "TITLE" | "FULL";
}

/** Result of account limit merge. */
export interface AccountLimitResult {
  allowed: boolean;
  effective_max: number;
}

/** Result of merging all org and user policies. */
export interface MergedPolicies {
  working_hours: WorkingHoursPolicy;
  vip_list: VipEntry[];
  account_limit: AccountLimitResult;
  projection_detail: "BUSY" | "TITLE" | "FULL";
}

// ---------------------------------------------------------------------------
// Detail level ranking (for comparison)
// ---------------------------------------------------------------------------

/**
 * Rank ordering of detail levels.
 * Higher rank = more information shared = stricter.
 * BUSY (least info) < TITLE < FULL (most info).
 */
export const DETAIL_LEVEL_RANK: Record<string, number> = {
  BUSY: 0,
  TITLE: 1,
  FULL: 2,
};

// ---------------------------------------------------------------------------
// Individual merge functions
// ---------------------------------------------------------------------------

/**
 * Merge org working hours policy with user working hours policy.
 *
 * Org defines a working hours window [start, end]. The user can be
 * narrower (start later, end earlier) but NOT wider. If the user
 * tries to extend beyond the org window, they are clamped.
 *
 * If user has no policy, org policy is used as default.
 */
export function mergeWorkingHours(
  orgPolicy: WorkingHoursPolicy,
  userPolicy: WorkingHoursPolicy | undefined,
): WorkingHoursPolicy {
  if (!userPolicy) {
    return { ...orgPolicy };
  }

  return {
    // User start must be >= org start (can't start earlier)
    start_hour: Math.max(orgPolicy.start_hour, userPolicy.start_hour),
    // User end must be <= org end (can't end later)
    end_hour: Math.min(orgPolicy.end_hour, userPolicy.end_hour),
  };
}

/**
 * Merge org VIP priority policy with user VIP entries.
 *
 * Org defines a minimum priority weight. Any user VIP entry with a
 * weight below the org minimum is raised to the org floor. Entries
 * above the floor are left unchanged. Users can add more VIPs freely.
 *
 * Returns a new array (does not mutate the input).
 */
export function mergeVipPriority(
  orgPolicy: VipPriorityPolicy,
  userVips: VipEntry[] | undefined,
): VipEntry[] {
  if (!userVips) {
    return [];
  }

  return userVips.map((vip) => ({
    ...vip,
    weight: Math.max(orgPolicy.minimum_weight, vip.weight),
  }));
}

/**
 * Check user account count against org account limit.
 *
 * Returns whether the user's current account count is within the
 * org's maximum and the effective maximum.
 */
export function mergeAccountLimit(
  orgPolicy: AccountLimitPolicy,
  userCount: number,
): AccountLimitResult {
  return {
    allowed: userCount <= orgPolicy.max_accounts,
    effective_max: orgPolicy.max_accounts,
  };
}

/**
 * Merge org projection detail policy with user preference.
 *
 * Org defines a minimum detail level. If the user's preference is
 * less detailed (lower rank), it is raised to the org minimum.
 * If the user's preference is more detailed, it is preserved.
 *
 * If user has no preference, org minimum is used.
 */
export function mergeProjectionDetail(
  orgPolicy: ProjectionDetailPolicy,
  userDetail: "BUSY" | "TITLE" | "FULL" | undefined,
): "BUSY" | "TITLE" | "FULL" {
  if (!userDetail) {
    return orgPolicy.minimum_detail;
  }

  const orgRank = DETAIL_LEVEL_RANK[orgPolicy.minimum_detail] ?? 0;
  const userRank = DETAIL_LEVEL_RANK[userDetail] ?? 0;

  // If user is more lenient (lower rank), raise to org minimum
  if (userRank < orgRank) {
    return orgPolicy.minimum_detail;
  }

  return userDetail;
}

// ---------------------------------------------------------------------------
// Composite merge
// ---------------------------------------------------------------------------

/**
 * Apply all org policies to user policies, enforcing org as floor.
 *
 * For each policy type present in orgPolicies, the corresponding
 * merge function is applied. Policy types not present in orgPolicies
 * pass through the user's values unchanged.
 */
export function mergeOrgAndUserPolicies(
  orgPolicies: OrgPolicy[],
  userPolicies: UserPolicies,
): MergedPolicies {
  // Build a lookup map by policy type
  const orgMap = new Map<OrgPolicyType, OrgPolicy>();
  for (const policy of orgPolicies) {
    orgMap.set(policy.policy_type, policy);
  }

  // Merge working hours
  const whPolicy = orgMap.get("mandatory_working_hours");
  const mergedWorkingHours = whPolicy
    ? mergeWorkingHours(whPolicy.config as WorkingHoursPolicy, userPolicies.working_hours)
    : userPolicies.working_hours ?? { start_hour: 0, end_hour: 23 };

  // Merge VIP priority
  const vipPolicy = orgMap.get("minimum_vip_priority");
  const mergedVipList = vipPolicy
    ? mergeVipPriority(vipPolicy.config as VipPriorityPolicy, userPolicies.vip_list)
    : (userPolicies.vip_list ?? []);

  // Merge account limit
  const alPolicy = orgMap.get("max_account_count");
  const mergedAccountLimit: AccountLimitResult = alPolicy
    ? mergeAccountLimit(alPolicy.config as AccountLimitPolicy, userPolicies.account_count)
    : { allowed: true, effective_max: Infinity };

  // Merge projection detail
  const pdPolicy = orgMap.get("required_projection_detail");
  const mergedDetail = pdPolicy
    ? mergeProjectionDetail(pdPolicy.config as ProjectionDetailPolicy, userPolicies.projection_detail)
    : (userPolicies.projection_detail ?? "BUSY");

  return {
    working_hours: mergedWorkingHours,
    vip_list: mergedVipList,
    account_limit: mergedAccountLimit,
    projection_detail: mergedDetail,
  };
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

/**
 * Validate an org policy configuration object for a given policy type.
 *
 * Returns null if valid, or an error message string if invalid.
 */
export function validateOrgPolicyConfig(
  policyType: OrgPolicyType,
  config: Record<string, unknown>,
): string | null {
  switch (policyType) {
    case "mandatory_working_hours": {
      if (config.start_hour === undefined || config.start_hour === null) {
        return "start_hour is required";
      }
      if (config.end_hour === undefined || config.end_hour === null) {
        return "end_hour is required";
      }
      const start = config.start_hour as number;
      const end = config.end_hour as number;
      if (typeof start !== "number" || start < 0 || start > 23) {
        return "start_hour must be between 0 and 23";
      }
      if (typeof end !== "number" || end < 0 || end > 23) {
        return "end_hour must be between 0 and 23";
      }
      if (start >= end) {
        return "start_hour must be less than end_hour";
      }
      return null;
    }

    case "minimum_vip_priority": {
      if (config.minimum_weight === undefined || config.minimum_weight === null) {
        return "minimum_weight is required";
      }
      const weight = config.minimum_weight as number;
      if (typeof weight !== "number" || weight < 0 || weight > 1) {
        return "minimum_weight must be between 0 and 1";
      }
      return null;
    }

    case "max_account_count": {
      if (config.max_accounts === undefined || config.max_accounts === null) {
        return "max_accounts is required";
      }
      const max = config.max_accounts as number;
      if (typeof max !== "number" || !Number.isInteger(max) || max < 1) {
        return "max_accounts must be a positive integer";
      }
      return null;
    }

    case "required_projection_detail": {
      if (config.minimum_detail === undefined || config.minimum_detail === null) {
        return "minimum_detail is required";
      }
      const detail = config.minimum_detail as string;
      if (!["BUSY", "TITLE", "FULL"].includes(detail)) {
        return "minimum_detail must be one of: BUSY, TITLE, FULL";
      }
      return null;
    }

    default:
      return `Unknown policy type: ${policyType}`;
  }
}
