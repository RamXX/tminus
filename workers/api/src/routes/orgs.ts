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

import { generateId, isValidId } from "@tminus/shared";

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
