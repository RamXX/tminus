/**
 * Admin console types and API client functions.
 *
 * Provides typed access to org member management, org policy CRUD,
 * and member usage statistics for the admin console UI.
 *
 * API endpoints consumed:
 *   GET    /v1/orgs/:id                      - Get org details
 *   GET    /v1/orgs/:id/members              - List members
 *   POST   /v1/orgs/:id/members              - Add member
 *   DELETE /v1/orgs/:id/members/:uid         - Remove member
 *   PUT    /v1/orgs/:id/members/:uid/role    - Change role
 *   GET    /v1/orgs/:id/policies             - List policies
 *   POST   /v1/orgs/:id/policies             - Create policy
 *   PUT    /v1/orgs/:id/policies/:pid        - Update policy
 *   DELETE /v1/orgs/:id/policies/:pid        - Delete policy
 */

import { apiFetch } from "./api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Organization member roles. */
export type OrgRole = "admin" | "member";

/** Organization member as returned by the API. */
export interface OrgMember {
  user_id: string;
  email: string;
  role: OrgRole;
  joined_at: string;
}

/** Organization details. */
export interface OrgDetails {
  org_id: string;
  name: string;
  owner_user_id: string;
  settings_json: string;
  created_at: string;
}

/** Valid org policy types. */
export type OrgPolicyType =
  | "mandatory_working_hours"
  | "minimum_vip_priority"
  | "required_projection_detail"
  | "max_account_count";

/** Org-level policy as returned by the API. */
export interface OrgPolicy {
  policy_id: string;
  org_id: string;
  policy_type: OrgPolicyType;
  config_json: string;
  created_at: string;
  created_by: string;
}

/** Parsed policy config for display. */
export interface ParsedPolicyConfig {
  [key: string]: unknown;
}

/** Per-member usage stats for the usage dashboard. */
export interface MemberUsage {
  user_id: string;
  email: string;
  role: OrgRole;
  accounts_used: number;
  features_active: string[];
  last_sync: string | null;
}

/** Payload for adding a member. */
export interface AddMemberPayload {
  user_id: string;
  role: OrgRole;
}

/** Payload for creating a policy. */
export interface CreatePolicyPayload {
  policy_type: OrgPolicyType;
  config: Record<string, unknown>;
}

/** Payload for updating a policy. */
export interface UpdatePolicyPayload {
  config: Record<string, unknown>;
}

/** Payload for changing a member's role. */
export interface ChangeRolePayload {
  role: OrgRole;
}

// ---------------------------------------------------------------------------
// Validation helpers (pure functions, exported for testing)
// ---------------------------------------------------------------------------

/** All valid policy types for form validation. */
export const VALID_POLICY_TYPES: OrgPolicyType[] = [
  "mandatory_working_hours",
  "minimum_vip_priority",
  "required_projection_detail",
  "max_account_count",
];

/** Human-readable labels for policy types. */
export const POLICY_TYPE_LABELS: Record<OrgPolicyType, string> = {
  mandatory_working_hours: "Mandatory Working Hours",
  minimum_vip_priority: "Minimum VIP Priority",
  required_projection_detail: "Required Projection Detail",
  max_account_count: "Max Account Count",
};

/**
 * Validate a policy config object for a given policy type.
 * Returns error message or null if valid.
 */
export function validatePolicyConfig(
  policyType: OrgPolicyType,
  config: Record<string, unknown>,
): string | null {
  if (!policyType || !VALID_POLICY_TYPES.includes(policyType)) {
    return "Invalid policy type";
  }

  if (!config || typeof config !== "object") {
    return "Config must be an object";
  }

  switch (policyType) {
    case "mandatory_working_hours": {
      if (typeof config.start_hour !== "number" || typeof config.end_hour !== "number") {
        return "start_hour and end_hour are required numbers";
      }
      if (config.start_hour < 0 || config.start_hour > 23) {
        return "start_hour must be between 0 and 23";
      }
      if (config.end_hour < 0 || config.end_hour > 23) {
        return "end_hour must be between 0 and 23";
      }
      if (config.start_hour >= config.end_hour) {
        return "start_hour must be before end_hour";
      }
      return null;
    }
    case "minimum_vip_priority": {
      if (typeof config.min_weight !== "number") {
        return "min_weight is a required number";
      }
      if (config.min_weight < 0 || config.min_weight > 100) {
        return "min_weight must be between 0 and 100";
      }
      return null;
    }
    case "required_projection_detail": {
      const validLevels = ["BUSY", "TITLE", "FULL"];
      if (typeof config.detail_level !== "string" || !validLevels.includes(config.detail_level)) {
        return "detail_level must be one of: BUSY, TITLE, FULL";
      }
      return null;
    }
    case "max_account_count": {
      if (typeof config.max_accounts !== "number") {
        return "max_accounts is a required number";
      }
      if (!Number.isInteger(config.max_accounts) || config.max_accounts < 1) {
        return "max_accounts must be a positive integer";
      }
      return null;
    }
    default:
      return "Unknown policy type";
  }
}

/**
 * Parse a config_json string into a typed object.
 * Returns empty object on parse failure (defensive).
 */
export function parsePolicyConfig(configJson: string): ParsedPolicyConfig {
  try {
    return JSON.parse(configJson);
  } catch {
    return {};
  }
}

/**
 * Format a date string for display in the usage dashboard.
 * Returns "Never" for null/empty values.
 */
export function formatLastSync(dateStr: string | null): string {
  if (!dateStr) return "Never";
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return "Never";
    return date.toLocaleString();
  } catch {
    return "Never";
  }
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** GET /api/v1/orgs/:id -- Get org details. */
export async function fetchOrgDetails(
  token: string,
  orgId: string,
): Promise<OrgDetails> {
  return apiFetch<OrgDetails>(`/v1/orgs/${encodeURIComponent(orgId)}`, { token });
}

/** GET /api/v1/orgs/:id/members -- List org members. */
export async function fetchOrgMembers(
  token: string,
  orgId: string,
): Promise<OrgMember[]> {
  return apiFetch<OrgMember[]>(
    `/v1/orgs/${encodeURIComponent(orgId)}/members`,
    { token },
  );
}

/** POST /api/v1/orgs/:id/members -- Add a member. */
export async function addOrgMember(
  token: string,
  orgId: string,
  payload: AddMemberPayload,
): Promise<OrgMember> {
  return apiFetch<OrgMember>(
    `/v1/orgs/${encodeURIComponent(orgId)}/members`,
    { method: "POST", body: payload, token },
  );
}

/** DELETE /api/v1/orgs/:id/members/:uid -- Remove a member. */
export async function removeOrgMember(
  token: string,
  orgId: string,
  userId: string,
): Promise<void> {
  return apiFetch<void>(
    `/v1/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE", token },
  );
}

/** PUT /api/v1/orgs/:id/members/:uid/role -- Change member role. */
export async function changeOrgMemberRole(
  token: string,
  orgId: string,
  userId: string,
  payload: ChangeRolePayload,
): Promise<void> {
  return apiFetch<void>(
    `/v1/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}/role`,
    { method: "PUT", body: payload, token },
  );
}

/** GET /api/v1/orgs/:id/policies -- List org policies. */
export async function fetchOrgPolicies(
  token: string,
  orgId: string,
): Promise<OrgPolicy[]> {
  return apiFetch<OrgPolicy[]>(
    `/v1/orgs/${encodeURIComponent(orgId)}/policies`,
    { token },
  );
}

/** POST /api/v1/orgs/:id/policies -- Create a policy. */
export async function createOrgPolicy(
  token: string,
  orgId: string,
  payload: CreatePolicyPayload,
): Promise<OrgPolicy> {
  return apiFetch<OrgPolicy>(
    `/v1/orgs/${encodeURIComponent(orgId)}/policies`,
    { method: "POST", body: payload, token },
  );
}

/** PUT /api/v1/orgs/:id/policies/:pid -- Update a policy config. */
export async function updateOrgPolicy(
  token: string,
  orgId: string,
  policyId: string,
  payload: UpdatePolicyPayload,
): Promise<OrgPolicy> {
  return apiFetch<OrgPolicy>(
    `/v1/orgs/${encodeURIComponent(orgId)}/policies/${encodeURIComponent(policyId)}`,
    { method: "PUT", body: payload, token },
  );
}

/** DELETE /api/v1/orgs/:id/policies/:pid -- Delete a policy. */
export async function deleteOrgPolicy(
  token: string,
  orgId: string,
  policyId: string,
): Promise<void> {
  return apiFetch<void>(
    `/v1/orgs/${encodeURIComponent(orgId)}/policies/${encodeURIComponent(policyId)}`,
    { method: "DELETE", token },
  );
}

/** GET /api/v1/orgs/:id/usage -- Get per-member usage stats. */
export async function fetchOrgUsage(
  token: string,
  orgId: string,
): Promise<MemberUsage[]> {
  return apiFetch<MemberUsage[]>(
    `/v1/orgs/${encodeURIComponent(orgId)}/usage`,
    { token },
  );
}
