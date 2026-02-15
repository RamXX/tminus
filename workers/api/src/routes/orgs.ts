/**
 * Organization management route handlers for the T-Minus API.
 *
 * Provides multi-tenant organization CRUD and membership management:
 *   POST   /v1/orgs                         - Create org (enterprise, caller becomes admin)
 *   GET    /v1/orgs/:id                     - Get org details
 *   POST   /v1/orgs/:id/members             - Add member (admin only)
 *   GET    /v1/orgs/:id/members             - List members
 *   DELETE /v1/orgs/:id/members/:user_id    - Remove member (admin only)
 *   PUT    /v1/orgs/:id/members/:user_id/role - Change role (admin only)
 *
 * Design:
 * - Enterprise tier required for org creation (checked by feature-gate middleware)
 * - RBAC: checkOrgAdmin verifies the authenticated user is an admin of the org
 * - All data in D1 registry (organizations + org_members tables)
 * - Standard API envelope format: {ok, data, error, meta}
 */

import { generateId, isValidId, validateOrgPolicyConfig, isValidOrgPolicyType } from "@tminus/shared";
import type { OrgMergePolicyType } from "@tminus/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuthContext {
  userId: string;
}

interface ApiEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  meta: {
    request_id: string;
    timestamp: string;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valid organization member roles. */
export const VALID_ORG_ROLES = ["admin", "member"] as const;

export type OrgRole = (typeof VALID_ORG_ROLES)[number];

// ---------------------------------------------------------------------------
// Org policy types (re-exported from shared for convenience)
// ---------------------------------------------------------------------------

/** Valid org policy types for the org_policies table. */
export const VALID_POLICY_TYPES = [
  "mandatory_working_hours",
  "minimum_vip_priority",
  "required_projection_detail",
  "max_account_count",
] as const;

export type PolicyType = (typeof VALID_POLICY_TYPES)[number];

// ---------------------------------------------------------------------------
// Pure validation helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Validate that a value is a valid org role.
 */
export function isValidOrgRole(value: string): value is OrgRole {
  return VALID_ORG_ROLES.includes(value as OrgRole);
}

/**
 * Validate organization name input.
 * Returns error string or null if valid.
 */
export function validateOrgName(name: unknown): string | null {
  if (name === undefined || name === null) {
    return "Organization name is required";
  }
  if (typeof name !== "string") {
    return "Organization name must be a string";
  }
  if (name.trim().length === 0) {
    return "Organization name cannot be empty";
  }
  if (name.length > 200) {
    return "Organization name must be 200 characters or fewer";
  }
  return null;
}

/**
 * Validate member addition input.
 * Returns error string or null if valid.
 */
export function validateMemberInput(body: Record<string, unknown>): string | null {
  if (!("user_id" in body) || body.user_id === undefined) {
    return "user_id is required";
  }
  if (typeof body.user_id !== "string") {
    return "user_id must be a string";
  }
  if (body.user_id.length === 0) {
    return "user_id cannot be empty";
  }
  if (!("role" in body) || body.role === undefined) {
    return "role is required";
  }
  if (typeof body.role !== "string") {
    return "role must be a string";
  }
  if (!isValidOrgRole(body.role)) {
    return `role must be one of: ${VALID_ORG_ROLES.join(", ")}`;
  }
  return null;
}

/**
 * Validate role update input.
 * Returns error string or null if valid.
 */
export function validateRoleInput(body: Record<string, unknown>): string | null {
  if (!("role" in body) || body.role === undefined) {
    return "role is required";
  }
  if (typeof body.role !== "string") {
    return "role must be a string";
  }
  if (!isValidOrgRole(body.role)) {
    return `role must be one of: ${VALID_ORG_ROLES.join(", ")}`;
  }
  return null;
}

/**
 * Validate org policy creation/update input.
 * Returns error string or null if valid.
 */
export function validatePolicyInput(body: Record<string, unknown>): string | null {
  if (!("policy_type" in body) || body.policy_type === undefined) {
    return "policy_type is required";
  }
  if (typeof body.policy_type !== "string") {
    return "policy_type must be a string";
  }
  if (!isValidOrgPolicyType(body.policy_type)) {
    return `policy_type must be one of: ${VALID_POLICY_TYPES.join(", ")}`;
  }
  if (!("config" in body) || body.config === undefined) {
    return "config is required";
  }
  if (typeof body.config !== "object" || body.config === null || Array.isArray(body.config)) {
    return "config must be an object";
  }
  // Delegate to shared validation
  const configError = validateOrgPolicyConfig(
    body.policy_type as OrgMergePolicyType,
    body.config as Record<string, unknown>,
  );
  if (configError) {
    return configError;
  }
  return null;
}

/**
 * Validate org policy update input (config only, no policy_type change).
 * Returns error string or null if valid.
 */
export function validatePolicyUpdateInput(
  body: Record<string, unknown>,
  existingPolicyType: string,
): string | null {
  if (!("config" in body) || body.config === undefined) {
    return "config is required";
  }
  if (typeof body.config !== "object" || body.config === null || Array.isArray(body.config)) {
    return "config must be an object";
  }
  const configError = validateOrgPolicyConfig(
    existingPolicyType as OrgMergePolicyType,
    body.config as Record<string, unknown>,
  );
  if (configError) {
    return configError;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Response helpers (replicates envelope pattern from index.ts)
// ---------------------------------------------------------------------------

function generateRequestId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `req_${ts}_${rand}`;
}

function successEnvelope<T>(data: T): ApiEnvelope<T> {
  return {
    ok: true,
    data,
    meta: {
      request_id: generateRequestId(),
      timestamp: new Date().toISOString(),
    },
  };
}

function errorEnvelope(error: string): ApiEnvelope {
  return {
    ok: false,
    error,
    meta: {
      request_id: generateRequestId(),
      timestamp: new Date().toISOString(),
    },
  };
}

function jsonResponse(envelope: ApiEnvelope, status: number): Response {
  return new Response(JSON.stringify(envelope), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Request body parsing
// ---------------------------------------------------------------------------

async function parseJsonBody<T>(request: Request): Promise<T | null> {
  try {
    const text = await request.text();
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// RBAC: checkOrgAdmin
// ---------------------------------------------------------------------------

/**
 * Check if the authenticated user is an admin of the given organization.
 *
 * Returns null if the user is an admin (access granted), or a 403 Response
 * if they are not. Callers use:
 *
 *   const denied = await checkOrgAdmin(auth.userId, orgId, db);
 *   if (denied) return denied;
 *
 * @param userId - The authenticated user's ID.
 * @param orgId - The organization ID to check membership for.
 * @param db - D1 database binding.
 * @returns null if admin, or 403 Response if not.
 */
export async function checkOrgAdmin(
  userId: string,
  orgId: string,
  db: D1Database,
): Promise<Response | null> {
  const row = await db
    .prepare(
      "SELECT role FROM org_members WHERE org_id = ?1 AND user_id = ?2",
    )
    .bind(orgId, userId)
    .first<{ role: string }>();

  if (!row || row.role !== "admin") {
    return jsonResponse(
      errorEnvelope("Admin access required for this organization"),
      403,
    );
  }

  return null;
}

/**
 * Check if the authenticated user is a member of the given organization
 * (any role). Returns null if member, or 403 Response if not.
 */
async function checkOrgMember(
  userId: string,
  orgId: string,
  db: D1Database,
): Promise<Response | null> {
  const row = await db
    .prepare(
      "SELECT role FROM org_members WHERE org_id = ?1 AND user_id = ?2",
    )
    .bind(orgId, userId)
    .first<{ role: string }>();

  if (!row) {
    return jsonResponse(
      errorEnvelope("You are not a member of this organization"),
      403,
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /v1/orgs -- Create a new organization.
 *
 * The caller automatically becomes the admin of the new org.
 * Enterprise tier is enforced by the caller (feature-gate middleware).
 */
export async function handleCreateOrg(
  request: Request,
  auth: AuthContext,
  db: D1Database,
): Promise<Response> {
  const body = await parseJsonBody<Record<string, unknown>>(request);
  if (!body) {
    return jsonResponse(
      errorEnvelope("Request body must be valid JSON"),
      400,
    );
  }

  const nameError = validateOrgName(body.name);
  if (nameError) {
    return jsonResponse(errorEnvelope(nameError), 400);
  }

  const name = (body.name as string).trim();
  const settingsJson = body.settings_json !== undefined
    ? JSON.stringify(body.settings_json)
    : "{}";

  const orgId = generateId("org");

  try {
    // Insert org and creator as admin in a batch
    await db.batch([
      db
        .prepare(
          "INSERT INTO organizations (org_id, name, settings_json) VALUES (?1, ?2, ?3)",
        )
        .bind(orgId, name, settingsJson),
      db
        .prepare(
          "INSERT INTO org_members (org_id, user_id, role) VALUES (?1, ?2, 'admin')",
        )
        .bind(orgId, auth.userId),
    ]);

    return jsonResponse(
      successEnvelope({
        org_id: orgId,
        name,
        settings_json: settingsJson,
        created_at: new Date().toISOString(),
      }),
      201,
    );
  } catch (err) {
    console.error("Failed to create organization", err);
    return jsonResponse(
      errorEnvelope("Failed to create organization"),
      500,
    );
  }
}

/**
 * GET /v1/orgs/:id -- Get organization details.
 *
 * Only accessible to org members.
 */
export async function handleGetOrg(
  _request: Request,
  auth: AuthContext,
  db: D1Database,
  orgId: string,
): Promise<Response> {
  if (!isValidId(orgId, "org")) {
    return jsonResponse(
      errorEnvelope("Invalid organization ID format"),
      400,
    );
  }

  // Check membership (any role can view)
  const denied = await checkOrgMember(auth.userId, orgId, db);
  if (denied) return denied;

  try {
    const org = await db
      .prepare(
        "SELECT org_id, name, created_at, settings_json FROM organizations WHERE org_id = ?1",
      )
      .bind(orgId)
      .first<{
        org_id: string;
        name: string;
        created_at: string;
        settings_json: string;
      }>();

    if (!org) {
      return jsonResponse(errorEnvelope("Organization not found"), 404);
    }

    return jsonResponse(successEnvelope(org), 200);
  } catch (err) {
    console.error("Failed to get organization", err);
    return jsonResponse(
      errorEnvelope("Failed to get organization"),
      500,
    );
  }
}

/**
 * POST /v1/orgs/:id/members -- Add a member to the organization.
 *
 * Admin only. Body: { user_id, role }.
 */
export async function handleAddMember(
  request: Request,
  auth: AuthContext,
  db: D1Database,
  orgId: string,
): Promise<Response> {
  if (!isValidId(orgId, "org")) {
    return jsonResponse(
      errorEnvelope("Invalid organization ID format"),
      400,
    );
  }

  // Admin check
  const denied = await checkOrgAdmin(auth.userId, orgId, db);
  if (denied) return denied;

  const body = await parseJsonBody<Record<string, unknown>>(request);
  if (!body) {
    return jsonResponse(
      errorEnvelope("Request body must be valid JSON"),
      400,
    );
  }

  const inputError = validateMemberInput(body);
  if (inputError) {
    return jsonResponse(errorEnvelope(inputError), 400);
  }

  const userId = body.user_id as string;
  const role = body.role as OrgRole;

  try {
    await db
      .prepare(
        "INSERT INTO org_members (org_id, user_id, role) VALUES (?1, ?2, ?3)",
      )
      .bind(orgId, userId, role)
      .run();

    return jsonResponse(
      successEnvelope({
        org_id: orgId,
        user_id: userId,
        role,
        joined_at: new Date().toISOString(),
      }),
      201,
    );
  } catch (err: unknown) {
    // D1 returns UNIQUE constraint violation if member already exists
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes("UNIQUE") || errMsg.includes("PRIMARY KEY")) {
      return jsonResponse(
        errorEnvelope("User is already a member of this organization"),
        409,
      );
    }
    console.error("Failed to add member", err);
    return jsonResponse(errorEnvelope("Failed to add member"), 500);
  }
}

/**
 * GET /v1/orgs/:id/members -- List organization members.
 *
 * Accessible to any org member.
 */
export async function handleListMembers(
  _request: Request,
  auth: AuthContext,
  db: D1Database,
  orgId: string,
): Promise<Response> {
  if (!isValidId(orgId, "org")) {
    return jsonResponse(
      errorEnvelope("Invalid organization ID format"),
      400,
    );
  }

  // Any member can list
  const denied = await checkOrgMember(auth.userId, orgId, db);
  if (denied) return denied;

  try {
    const result = await db
      .prepare(
        "SELECT org_id, user_id, role, joined_at FROM org_members WHERE org_id = ?1 ORDER BY joined_at ASC",
      )
      .bind(orgId)
      .all<{
        org_id: string;
        user_id: string;
        role: string;
        joined_at: string;
      }>();

    return jsonResponse(successEnvelope(result.results ?? []), 200);
  } catch (err) {
    console.error("Failed to list members", err);
    return jsonResponse(errorEnvelope("Failed to list members"), 500);
  }
}

/**
 * DELETE /v1/orgs/:id/members/:user_id -- Remove a member.
 *
 * Admin only. Cannot remove yourself if you are the last admin.
 */
export async function handleRemoveMember(
  _request: Request,
  auth: AuthContext,
  db: D1Database,
  orgId: string,
  targetUserId: string,
): Promise<Response> {
  if (!isValidId(orgId, "org")) {
    return jsonResponse(
      errorEnvelope("Invalid organization ID format"),
      400,
    );
  }

  // Admin check
  const denied = await checkOrgAdmin(auth.userId, orgId, db);
  if (denied) return denied;

  // Prevent removing last admin
  if (targetUserId === auth.userId) {
    const adminCount = await db
      .prepare(
        "SELECT COUNT(*) as count FROM org_members WHERE org_id = ?1 AND role = 'admin'",
      )
      .bind(orgId)
      .first<{ count: number }>();

    if (adminCount && adminCount.count <= 1) {
      return jsonResponse(
        errorEnvelope("Cannot remove the last admin of the organization"),
        400,
      );
    }
  }

  try {
    const result = await db
      .prepare(
        "DELETE FROM org_members WHERE org_id = ?1 AND user_id = ?2",
      )
      .bind(orgId, targetUserId)
      .run();

    // D1 run() returns meta.changes for rows affected
    const changes = (result as unknown as { meta?: { changes?: number } })?.meta?.changes ?? 0;
    if (changes === 0) {
      return jsonResponse(
        errorEnvelope("Member not found in this organization"),
        404,
      );
    }

    return jsonResponse(
      successEnvelope({ removed: true, org_id: orgId, user_id: targetUserId }),
      200,
    );
  } catch (err) {
    console.error("Failed to remove member", err);
    return jsonResponse(errorEnvelope("Failed to remove member"), 500);
  }
}

/**
 * PUT /v1/orgs/:id/members/:user_id/role -- Change member role.
 *
 * Admin only. Cannot demote yourself if you are the last admin.
 * Body: { role }.
 */
export async function handleChangeRole(
  request: Request,
  auth: AuthContext,
  db: D1Database,
  orgId: string,
  targetUserId: string,
): Promise<Response> {
  if (!isValidId(orgId, "org")) {
    return jsonResponse(
      errorEnvelope("Invalid organization ID format"),
      400,
    );
  }

  // Admin check
  const denied = await checkOrgAdmin(auth.userId, orgId, db);
  if (denied) return denied;

  const body = await parseJsonBody<Record<string, unknown>>(request);
  if (!body) {
    return jsonResponse(
      errorEnvelope("Request body must be valid JSON"),
      400,
    );
  }

  const roleError = validateRoleInput(body);
  if (roleError) {
    return jsonResponse(errorEnvelope(roleError), 400);
  }

  const newRole = body.role as OrgRole;

  // Prevent demoting last admin
  if (targetUserId === auth.userId && newRole !== "admin") {
    const adminCount = await db
      .prepare(
        "SELECT COUNT(*) as count FROM org_members WHERE org_id = ?1 AND role = 'admin'",
      )
      .bind(orgId)
      .first<{ count: number }>();

    if (adminCount && adminCount.count <= 1) {
      return jsonResponse(
        errorEnvelope("Cannot demote the last admin of the organization"),
        400,
      );
    }
  }

  try {
    const result = await db
      .prepare(
        "UPDATE org_members SET role = ?1 WHERE org_id = ?2 AND user_id = ?3",
      )
      .bind(newRole, orgId, targetUserId)
      .run();

    const changes = (result as unknown as { meta?: { changes?: number } })?.meta?.changes ?? 0;
    if (changes === 0) {
      return jsonResponse(
        errorEnvelope("Member not found in this organization"),
        404,
      );
    }

    return jsonResponse(
      successEnvelope({ org_id: orgId, user_id: targetUserId, role: newRole }),
      200,
    );
  } catch (err) {
    console.error("Failed to change role", err);
    return jsonResponse(errorEnvelope("Failed to change role"), 500);
  }
}

// ---------------------------------------------------------------------------
// Org Policy Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /v1/orgs/:id/policies -- Create an org-level policy.
 *
 * Admin only. Body: { policy_type, config }.
 * Only one policy per type per org (UNIQUE constraint on org_id + policy_type).
 */
export async function handleCreateOrgPolicy(
  request: Request,
  auth: AuthContext,
  db: D1Database,
  orgId: string,
): Promise<Response> {
  if (!isValidId(orgId, "org")) {
    return jsonResponse(
      errorEnvelope("Invalid organization ID format"),
      400,
    );
  }

  // Admin check
  const denied = await checkOrgAdmin(auth.userId, orgId, db);
  if (denied) return denied;

  const body = await parseJsonBody<Record<string, unknown>>(request);
  if (!body) {
    return jsonResponse(
      errorEnvelope("Request body must be valid JSON"),
      400,
    );
  }

  const inputError = validatePolicyInput(body);
  if (inputError) {
    return jsonResponse(errorEnvelope(inputError), 400);
  }

  const policyType = body.policy_type as string;
  const configJson = JSON.stringify(body.config);
  const policyId = generateId("policy");

  try {
    await db
      .prepare(
        "INSERT INTO org_policies (policy_id, org_id, policy_type, config_json, created_by) VALUES (?1, ?2, ?3, ?4, ?5)",
      )
      .bind(policyId, orgId, policyType, configJson, auth.userId)
      .run();

    return jsonResponse(
      successEnvelope({
        policy_id: policyId,
        org_id: orgId,
        policy_type: policyType,
        config_json: configJson,
        created_by: auth.userId,
        created_at: new Date().toISOString(),
      }),
      201,
    );
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes("UNIQUE") || errMsg.includes("idx_org_policies_org_type")) {
      return jsonResponse(
        errorEnvelope(`A policy of type '${policyType}' already exists for this organization`),
        409,
      );
    }
    console.error("Failed to create org policy", err);
    return jsonResponse(
      errorEnvelope("Failed to create org policy"),
      500,
    );
  }
}

/**
 * GET /v1/orgs/:id/policies -- List org-level policies.
 *
 * Accessible to any org member.
 */
export async function handleListOrgPolicies(
  _request: Request,
  auth: AuthContext,
  db: D1Database,
  orgId: string,
): Promise<Response> {
  if (!isValidId(orgId, "org")) {
    return jsonResponse(
      errorEnvelope("Invalid organization ID format"),
      400,
    );
  }

  // Any member can list
  const denied = await checkOrgMember(auth.userId, orgId, db);
  if (denied) return denied;

  try {
    const result = await db
      .prepare(
        "SELECT policy_id, org_id, policy_type, config_json, created_at, created_by FROM org_policies WHERE org_id = ?1 ORDER BY created_at ASC",
      )
      .bind(orgId)
      .all<{
        policy_id: string;
        org_id: string;
        policy_type: string;
        config_json: string;
        created_at: string;
        created_by: string;
      }>();

    return jsonResponse(successEnvelope(result.results ?? []), 200);
  } catch (err) {
    console.error("Failed to list org policies", err);
    return jsonResponse(errorEnvelope("Failed to list org policies"), 500);
  }
}

/**
 * PUT /v1/orgs/:id/policies/:pid -- Update an org-level policy config.
 *
 * Admin only. Body: { config }. Policy type cannot be changed.
 */
export async function handleUpdateOrgPolicy(
  request: Request,
  auth: AuthContext,
  db: D1Database,
  orgId: string,
  policyId: string,
): Promise<Response> {
  if (!isValidId(orgId, "org")) {
    return jsonResponse(
      errorEnvelope("Invalid organization ID format"),
      400,
    );
  }

  if (!isValidId(policyId, "policy")) {
    return jsonResponse(
      errorEnvelope("Invalid policy ID format"),
      400,
    );
  }

  // Admin check
  const denied = await checkOrgAdmin(auth.userId, orgId, db);
  if (denied) return denied;

  // Fetch existing policy to get its type
  const existing = await db
    .prepare(
      "SELECT policy_id, policy_type FROM org_policies WHERE policy_id = ?1 AND org_id = ?2",
    )
    .bind(policyId, orgId)
    .first<{ policy_id: string; policy_type: string }>();

  if (!existing) {
    return jsonResponse(errorEnvelope("Policy not found"), 404);
  }

  const body = await parseJsonBody<Record<string, unknown>>(request);
  if (!body) {
    return jsonResponse(
      errorEnvelope("Request body must be valid JSON"),
      400,
    );
  }

  const inputError = validatePolicyUpdateInput(body, existing.policy_type);
  if (inputError) {
    return jsonResponse(errorEnvelope(inputError), 400);
  }

  const configJson = JSON.stringify(body.config);

  try {
    await db
      .prepare(
        "UPDATE org_policies SET config_json = ?1 WHERE policy_id = ?2 AND org_id = ?3",
      )
      .bind(configJson, policyId, orgId)
      .run();

    return jsonResponse(
      successEnvelope({
        policy_id: policyId,
        org_id: orgId,
        policy_type: existing.policy_type,
        config_json: configJson,
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to update org policy", err);
    return jsonResponse(
      errorEnvelope("Failed to update org policy"),
      500,
    );
  }
}

/**
 * DELETE /v1/orgs/:id/policies/:pid -- Delete an org-level policy.
 *
 * Admin only.
 */
export async function handleDeleteOrgPolicy(
  _request: Request,
  auth: AuthContext,
  db: D1Database,
  orgId: string,
  policyId: string,
): Promise<Response> {
  if (!isValidId(orgId, "org")) {
    return jsonResponse(
      errorEnvelope("Invalid organization ID format"),
      400,
    );
  }

  if (!isValidId(policyId, "policy")) {
    return jsonResponse(
      errorEnvelope("Invalid policy ID format"),
      400,
    );
  }

  // Admin check
  const denied = await checkOrgAdmin(auth.userId, orgId, db);
  if (denied) return denied;

  try {
    const result = await db
      .prepare(
        "DELETE FROM org_policies WHERE policy_id = ?1 AND org_id = ?2",
      )
      .bind(policyId, orgId)
      .run();

    const changes = (result as unknown as { meta?: { changes?: number } })?.meta?.changes ?? 0;
    if (changes === 0) {
      return jsonResponse(
        errorEnvelope("Policy not found"),
        404,
      );
    }

    return jsonResponse(
      successEnvelope({ deleted: true, policy_id: policyId, org_id: orgId }),
      200,
    );
  } catch (err) {
    console.error("Failed to delete org policy", err);
    return jsonResponse(
      errorEnvelope("Failed to delete org policy"),
      500,
    );
  }
}
