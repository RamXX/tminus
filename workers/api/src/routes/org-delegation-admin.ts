/**
 * Organization delegation admin dashboard route handlers (TM-9iu.4).
 *
 * Provides admin endpoints for managing domain-wide delegation:
 *   GET    /api/orgs/:orgId/dashboard          - Org overview
 *   GET    /api/orgs/:orgId/users              - List discovered users
 *   GET    /api/orgs/:orgId/users/:userId      - Get user details
 *   PATCH  /api/orgs/:orgId/users/:userId      - Update user status
 *   GET    /api/orgs/:orgId/discovery/config    - Get discovery config
 *   PUT    /api/orgs/:orgId/discovery/config    - Update discovery config
 *   GET    /api/orgs/:orgId/delegation/health   - Check delegation health
 *   POST   /api/orgs/:orgId/delegation/rotate   - Trigger credential rotation
 *   GET    /api/orgs/:orgId/audit               - Paginated audit log
 *
 * Business rules:
 * - BR-1: Only org admins can access these endpoints
 * - BR-2: Credential rotation must be audited (DelegationService handles this)
 * - BR-3: Discovery config changes take effect on next sync cycle
 * - BR-4: User exclusions are immediate (next query excludes them)
 *
 * Design:
 * - Pure function handlers that receive dependencies (DI for testability)
 * - Auth enforced via AdminAuthContext.isAdmin flag (caller determines admin status)
 * - Follows the same response envelope pattern as org-delegation.ts
 */

import type {
  DelegationService,
  DelegationRecord,
  AuditLogEntry,
  ServiceAccountKey,
  DiscoveryService,
  DiscoveredUser,
  DiscoveryConfig,
} from "@tminus/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Auth context for admin endpoints.
 * The caller is responsible for determining isAdmin (e.g., via org_members table).
 */
export interface AdminAuthContext {
  userId: string;
  isAdmin: boolean;
}

/**
 * Dependencies injected into each handler for testability.
 * The caller constructs these from the Worker environment.
 */
export interface AdminDeps {
  delegationService: DelegationService;
  discoveryService: DiscoveryService;
  /** Query audit log entries from the store (not on DelegationService). */
  queryAuditLog: (
    delegationId: string,
    options: AuditQueryOptions,
  ) => Promise<AuditPage>;
  /** Get the delegation record by its ID. */
  getDelegation: (delegationId: string) => Promise<DelegationRecord | null>;
}

export interface AuditQueryOptions {
  limit: number;
  offset: number;
  action?: string;
}

export interface AuditPage {
  entries: AuditLogEntry[];
  total: number;
  limit: number;
  offset: number;
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
// Response helpers (same pattern as org-delegation.ts)
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
// Auth guard (BR-1: only org admins can access)
// ---------------------------------------------------------------------------

/**
 * Returns a 403 Response if the caller is not an admin, or null if authorized.
 * Exported for unit testing.
 */
export function checkAdminAuth(auth: AdminAuthContext): Response | null {
  if (!auth.isAdmin) {
    return jsonResponse(
      errorEnvelope("Forbidden: org admin access required"),
      403,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Input validation helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Validate discovery config update input.
 * Returns error string or null if valid.
 */
export function validateDiscoveryConfigUpdate(
  body: Record<string, unknown>,
): string | null {
  if (body.sync_mode !== undefined) {
    if (body.sync_mode !== "proactive" && body.sync_mode !== "lazy") {
      return "sync_mode must be 'proactive' or 'lazy'";
    }
  }

  if (body.ou_filter !== undefined && body.ou_filter !== null) {
    if (!Array.isArray(body.ou_filter)) {
      return "ou_filter must be an array of strings";
    }
    for (const item of body.ou_filter) {
      if (typeof item !== "string" || item.length === 0) {
        return "ou_filter entries must be non-empty strings";
      }
    }
  }

  if (body.excluded_emails !== undefined && body.excluded_emails !== null) {
    if (!Array.isArray(body.excluded_emails)) {
      return "excluded_emails must be an array of strings";
    }
    for (const item of body.excluded_emails) {
      if (typeof item !== "string" || !item.includes("@")) {
        return "excluded_emails entries must be valid email addresses";
      }
    }
  }

  if (body.retention_days !== undefined) {
    if (
      typeof body.retention_days !== "number" ||
      !Number.isInteger(body.retention_days) ||
      body.retention_days < 1 ||
      body.retention_days > 365
    ) {
      return "retention_days must be an integer between 1 and 365";
    }
  }

  return null;
}

/**
 * Validate user status update input.
 * Returns error string or null if valid.
 */
export function validateUserStatusUpdate(
  body: Record<string, unknown>,
): string | null {
  if (!body.status || typeof body.status !== "string") {
    return "status is required and must be a string";
  }

  const validStatuses = ["active", "suspended", "removed"];
  if (!validStatuses.includes(body.status)) {
    return `status must be one of: ${validStatuses.join(", ")}`;
  }

  return null;
}

/**
 * Parse pagination parameters from URL search params.
 * Default: limit=50, offset=0. Max limit: 200.
 */
export function parsePagination(url: URL): { limit: number; offset: number } {
  const limitStr = url.searchParams.get("limit");
  const offsetStr = url.searchParams.get("offset");

  let limit = 50;
  let offset = 0;

  if (limitStr) {
    const parsed = parseInt(limitStr, 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= 200) {
      limit = parsed;
    }
  }

  if (offsetStr) {
    const parsed = parseInt(offsetStr, 10);
    if (!isNaN(parsed) && parsed >= 0) {
      offset = parsed;
    }
  }

  return { limit, offset };
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
// Route handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/orgs/:orgId/dashboard
 *
 * Returns organization overview:
 * - Delegation status (active/inactive/needs-rotation)
 * - User discovery stats (total, active, suspended, removed)
 * - Recent audit log entries (last 10)
 * - Discovery configuration summary
 */
export async function handleOrgDashboard(
  _request: Request,
  auth: AdminAuthContext,
  orgId: string,
  deps: AdminDeps,
): Promise<Response> {
  const authErr = checkAdminAuth(auth);
  if (authErr) return authErr;

  const delegation = await deps.getDelegation(orgId);
  if (!delegation) {
    return jsonResponse(errorEnvelope("Organization not found"), 404);
  }

  // Gather user discovery stats
  const allUsers = await deps.discoveryService.getDiscoveredUsers(orgId);
  const activeCount = allUsers.filter((u) => u.status === "active").length;
  const suspendedCount = allUsers.filter(
    (u) => u.status === "suspended",
  ).length;
  const removedCount = allUsers.filter((u) => u.status === "removed").length;

  // Determine delegation display status (enriched beyond raw DB status)
  let delegationDisplayStatus: string = delegation.delegationStatus;
  if (
    delegation.delegationStatus === "active" &&
    delegation.saKeyRotationDueAt
  ) {
    const rotationDue = new Date(delegation.saKeyRotationDueAt);
    if (rotationDue <= new Date()) {
      delegationDisplayStatus = "needs-rotation";
    }
  }

  // Recent audit entries (last 10)
  const auditPage = await deps.queryAuditLog(orgId, { limit: 10, offset: 0 });

  // Discovery config
  const discoveryConfig = await deps.discoveryService.getConfig(orgId);

  return jsonResponse(
    successEnvelope({
      delegation: {
        delegation_id: delegation.delegationId,
        domain: delegation.domain,
        admin_email: delegation.adminEmail,
        status: delegationDisplayStatus,
        delegation_status: delegation.delegationStatus,
        health_check_status: delegation.healthCheckStatus,
        last_health_check_at: delegation.lastHealthCheckAt,
        sa_client_email: delegation.saClientEmail,
        sa_key_created_at: delegation.saKeyCreatedAt,
        sa_key_rotation_due_at: delegation.saKeyRotationDueAt,
        registration_date: delegation.registrationDate,
      },
      user_stats: {
        total: allUsers.length,
        active: activeCount,
        suspended: suspendedCount,
        removed: removedCount,
      },
      recent_audit: auditPage.entries.map(sanitizeAuditEntry),
      discovery_config: discoveryConfig
        ? {
            sync_mode: discoveryConfig.syncMode,
            ou_filter: discoveryConfig.ouFilter ?? null,
            excluded_emails: discoveryConfig.excludedEmails ?? null,
            retention_days: discoveryConfig.retentionDays,
          }
        : null,
    }),
    200,
  );
}

/**
 * GET /api/orgs/:orgId/users
 *
 * Returns discovered users with optional status filtering and pagination.
 * Query params: ?status=active&limit=50&offset=0
 */
export async function handleListDiscoveredUsers(
  request: Request,
  auth: AdminAuthContext,
  orgId: string,
  deps: AdminDeps,
): Promise<Response> {
  const authErr = checkAdminAuth(auth);
  if (authErr) return authErr;

  const delegation = await deps.getDelegation(orgId);
  if (!delegation) {
    return jsonResponse(errorEnvelope("Organization not found"), 404);
  }

  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status") as
    | "active"
    | "suspended"
    | "removed"
    | null;
  const { limit, offset } = parsePagination(url);

  // Validate status filter if provided
  const validStatuses = ["active", "suspended", "removed"];
  const filterStatus =
    statusFilter && validStatuses.includes(statusFilter)
      ? (statusFilter as "active" | "suspended" | "removed")
      : undefined;

  const allUsers = await deps.discoveryService.getDiscoveredUsers(
    orgId,
    filterStatus,
  );

  // Manual pagination over the full set
  const total = allUsers.length;
  const paged = allUsers.slice(offset, offset + limit);

  return jsonResponse(
    successEnvelope({
      users: paged.map(sanitizeDiscoveredUser),
      pagination: { total, limit, offset },
    }),
    200,
  );
}

/**
 * GET /api/orgs/:orgId/users/:userId
 *
 * Returns detailed info for a single discovered user.
 * userId parameter is the discovery_id.
 */
export async function handleGetDiscoveredUser(
  _request: Request,
  auth: AdminAuthContext,
  orgId: string,
  userId: string,
  deps: AdminDeps,
): Promise<Response> {
  const authErr = checkAdminAuth(auth);
  if (authErr) return authErr;

  const delegation = await deps.getDelegation(orgId);
  if (!delegation) {
    return jsonResponse(errorEnvelope("Organization not found"), 404);
  }

  const allUsers = await deps.discoveryService.getDiscoveredUsers(orgId);
  const user = allUsers.find((u) => u.discoveryId === userId);

  if (!user) {
    return jsonResponse(errorEnvelope("User not found"), 404);
  }

  return jsonResponse(successEnvelope(sanitizeDiscoveredUser(user)), 200);
}

/**
 * PATCH /api/orgs/:orgId/users/:userId
 *
 * Update user status (e.g., exclude from discovery by marking as removed).
 * Body: { status: "active" | "suspended" | "removed" }
 *
 * BR-4: User exclusions are immediate.
 */
export async function handleUpdateDiscoveredUser(
  request: Request,
  auth: AdminAuthContext,
  orgId: string,
  userId: string,
  deps: AdminDeps,
): Promise<Response> {
  const authErr = checkAdminAuth(auth);
  if (authErr) return authErr;

  const delegation = await deps.getDelegation(orgId);
  if (!delegation) {
    return jsonResponse(errorEnvelope("Organization not found"), 404);
  }

  const body = await parseJsonBody<Record<string, unknown>>(request);
  if (!body) {
    return jsonResponse(errorEnvelope("Request body must be valid JSON"), 400);
  }

  const validationErr = validateUserStatusUpdate(body);
  if (validationErr) {
    return jsonResponse(errorEnvelope(validationErr), 400);
  }

  const newStatus = body.status as "active" | "suspended" | "removed";

  try {
    const updated = await deps.discoveryService.transitionUserStatus(
      userId,
      newStatus,
      orgId,
    );
    return jsonResponse(successEnvelope(sanitizeDiscoveredUser(updated)), 200);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);

    if (errMsg.includes("not found")) {
      return jsonResponse(errorEnvelope("User not found"), 404);
    }
    if (errMsg.includes("Invalid transition")) {
      return jsonResponse(errorEnvelope(errMsg), 422);
    }

    return jsonResponse(errorEnvelope(`Failed to update user: ${errMsg}`), 500);
  }
}

/**
 * GET /api/orgs/:orgId/discovery/config
 *
 * Returns the current discovery configuration for the org.
 */
export async function handleGetDiscoveryConfig(
  _request: Request,
  auth: AdminAuthContext,
  orgId: string,
  deps: AdminDeps,
): Promise<Response> {
  const authErr = checkAdminAuth(auth);
  if (authErr) return authErr;

  const delegation = await deps.getDelegation(orgId);
  if (!delegation) {
    return jsonResponse(errorEnvelope("Organization not found"), 404);
  }

  const config = await deps.discoveryService.getConfig(orgId);

  if (!config) {
    // Return defaults when no explicit config exists
    return jsonResponse(
      successEnvelope({
        delegation_id: orgId,
        sync_mode: "lazy",
        ou_filter: null,
        excluded_emails: null,
        retention_days: 30,
      }),
      200,
    );
  }

  return jsonResponse(
    successEnvelope({
      delegation_id: config.delegationId,
      sync_mode: config.syncMode,
      ou_filter: config.ouFilter ?? null,
      excluded_emails: config.excludedEmails ?? null,
      retention_days: config.retentionDays,
    }),
    200,
  );
}

/**
 * PUT /api/orgs/:orgId/discovery/config
 *
 * Update discovery configuration. Merges with existing config.
 * BR-3: Changes take effect on next sync cycle.
 * BR-4: Excluded email changes are immediate in queries.
 *
 * Body: {
 *   sync_mode?: "proactive" | "lazy",
 *   ou_filter?: string[] | null,
 *   excluded_emails?: string[] | null,
 *   retention_days?: number
 * }
 */
export async function handleUpdateDiscoveryConfig(
  request: Request,
  auth: AdminAuthContext,
  orgId: string,
  deps: AdminDeps,
): Promise<Response> {
  const authErr = checkAdminAuth(auth);
  if (authErr) return authErr;

  const delegation = await deps.getDelegation(orgId);
  if (!delegation) {
    return jsonResponse(errorEnvelope("Organization not found"), 404);
  }

  const body = await parseJsonBody<Record<string, unknown>>(request);
  if (!body) {
    return jsonResponse(errorEnvelope("Request body must be valid JSON"), 400);
  }

  const validationErr = validateDiscoveryConfigUpdate(body);
  if (validationErr) {
    return jsonResponse(errorEnvelope(validationErr), 400);
  }

  // Merge with existing config (or defaults)
  const existing = await deps.discoveryService.getConfig(orgId);

  const updatedConfig: DiscoveryConfig = {
    delegationId: orgId,
    syncMode:
      (body.sync_mode as "proactive" | "lazy") ??
      existing?.syncMode ??
      "lazy",
    ouFilter:
      body.ou_filter !== undefined
        ? (body.ou_filter as string[] | undefined) ?? undefined
        : existing?.ouFilter,
    excludedEmails:
      body.excluded_emails !== undefined
        ? (body.excluded_emails as string[] | undefined) ?? undefined
        : existing?.excludedEmails,
    retentionDays:
      (body.retention_days as number) ?? existing?.retentionDays ?? 30,
  };

  try {
    await deps.discoveryService.upsertConfig(updatedConfig);

    return jsonResponse(
      successEnvelope({
        delegation_id: orgId,
        sync_mode: updatedConfig.syncMode,
        ou_filter: updatedConfig.ouFilter ?? null,
        excluded_emails: updatedConfig.excludedEmails ?? null,
        retention_days: updatedConfig.retentionDays,
      }),
      200,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return jsonResponse(
      errorEnvelope(`Failed to update discovery config: ${errMsg}`),
      500,
    );
  }
}

/**
 * GET /api/orgs/:orgId/delegation/health
 *
 * Check delegation health (validates service account still works).
 * The health check is recorded in the audit log by DelegationService.
 */
export async function handleDelegationHealth(
  _request: Request,
  auth: AdminAuthContext,
  orgId: string,
  deps: AdminDeps,
): Promise<Response> {
  const authErr = checkAdminAuth(auth);
  if (authErr) return authErr;

  const delegation = await deps.getDelegation(orgId);
  if (!delegation) {
    return jsonResponse(errorEnvelope("Organization not found"), 404);
  }

  try {
    const result = await deps.delegationService.checkDelegationHealth(orgId);

    return jsonResponse(
      successEnvelope({
        delegation_id: result.delegationId,
        domain: result.domain,
        status: result.status,
        checked_at: result.checkedAt,
        can_impersonate_admin: result.canImpersonateAdmin,
        scopes_valid: result.scopesValid,
        error: result.error,
      }),
      200,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return jsonResponse(
      errorEnvelope(`Health check failed: ${errMsg}`),
      500,
    );
  }
}

/**
 * POST /api/orgs/:orgId/delegation/rotate
 *
 * Trigger credential rotation with a new service account key.
 * BR-2: Rotation is audited (DelegationService logs the event).
 *
 * Body: { service_account_key: ServiceAccountKey }
 */
export async function handleDelegationRotate(
  request: Request,
  auth: AdminAuthContext,
  orgId: string,
  deps: AdminDeps,
): Promise<Response> {
  const authErr = checkAdminAuth(auth);
  if (authErr) return authErr;

  const delegation = await deps.getDelegation(orgId);
  if (!delegation) {
    return jsonResponse(errorEnvelope("Organization not found"), 404);
  }

  const body = await parseJsonBody<Record<string, unknown>>(request);
  if (!body) {
    return jsonResponse(errorEnvelope("Request body must be valid JSON"), 400);
  }

  if (!body.service_account_key) {
    return jsonResponse(
      errorEnvelope("service_account_key is required"),
      400,
    );
  }

  try {
    const result = await deps.delegationService.rotateCredential(
      orgId,
      body.service_account_key as ServiceAccountKey,
    );

    return jsonResponse(
      successEnvelope({
        success: result.success,
        new_key_id: result.newKeyId,
        old_key_id: result.oldKeyId,
        rotated_at: result.rotatedAt,
      }),
      200,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return jsonResponse(
      errorEnvelope(`Credential rotation failed: ${errMsg}`),
      500,
    );
  }
}

/**
 * GET /api/orgs/:orgId/audit
 *
 * Paginated audit log with optional action filter.
 * Query params: ?action=key_rotated&limit=50&offset=0
 */
export async function handleAuditLog(
  request: Request,
  auth: AdminAuthContext,
  orgId: string,
  deps: AdminDeps,
): Promise<Response> {
  const authErr = checkAdminAuth(auth);
  if (authErr) return authErr;

  const delegation = await deps.getDelegation(orgId);
  if (!delegation) {
    return jsonResponse(errorEnvelope("Organization not found"), 404);
  }

  const url = new URL(request.url);
  const { limit, offset } = parsePagination(url);
  const actionFilter = url.searchParams.get("action") ?? undefined;

  try {
    const page = await deps.queryAuditLog(orgId, {
      limit,
      offset,
      action: actionFilter,
    });

    return jsonResponse(
      successEnvelope({
        entries: page.entries.map(sanitizeAuditEntry),
        pagination: {
          total: page.total,
          limit: page.limit,
          offset: page.offset,
        },
      }),
      200,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return jsonResponse(
      errorEnvelope(`Failed to query audit log: ${errMsg}`),
      500,
    );
  }
}

// ---------------------------------------------------------------------------
// Sanitization helpers (security: never expose sensitive fields)
// ---------------------------------------------------------------------------

function sanitizeDiscoveredUser(user: DiscoveredUser): Record<string, unknown> {
  return {
    discovery_id: user.discoveryId,
    delegation_id: user.delegationId,
    google_user_id: user.googleUserId,
    email: user.email,
    display_name: user.displayName,
    org_unit_path: user.orgUnitPath,
    status: user.status,
    account_id: user.accountId,
    last_synced_at: user.lastSyncedAt,
    discovered_at: user.discoveredAt,
    status_changed_at: user.statusChangedAt,
    removed_at: user.removedAt,
  };
}

function sanitizeAuditEntry(entry: AuditLogEntry): Record<string, unknown> {
  return {
    audit_id: entry.auditId,
    delegation_id: entry.delegationId,
    domain: entry.domain,
    user_email: entry.userEmail,
    action: entry.action,
    details: entry.details ? safeParseJson(entry.details) : null,
    created_at: entry.createdAt,
  };
}

function safeParseJson(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}
