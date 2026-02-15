/**
 * Organization-level admin controls for Marketplace installs (TM-ga8.4).
 *
 * Provides:
 *   GET    /v1/org/:id/users       -- List users with T-Minus in the org
 *   POST   /v1/org/:id/deactivate  -- Admin deactivates T-Minus for the org
 *   GET    /v1/org/:id/install-status -- Admin views org install health
 *
 * Design:
 * - RBAC: Only org admins (via checkOrgAdmin) can access these endpoints
 * - Deactivation disconnects ALL org users and removes their credentials (BR-2)
 * - Individual users can still disconnect their own account (BR-3, handled elsewhere)
 */

import { isValidId } from "@tminus/shared";
import { checkOrgAdmin } from "./orgs";

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
// Response helpers (same pattern as orgs.ts)
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
// GET /v1/org/:id/users -- List users with T-Minus in the org
// ---------------------------------------------------------------------------

/**
 * List all users who have activated T-Minus within an org-level installation.
 *
 * Returns users with their account status. Only accessible to org admins.
 */
export async function handleListOrgUsers(
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

  // Admin check
  const denied = await checkOrgAdmin(auth.userId, orgId, db);
  if (denied) return denied;

  try {
    // Find the org installation
    const install = await db
      .prepare("SELECT install_id, status FROM org_installations WHERE org_id = ?")
      .bind(orgId)
      .first<{ install_id: string; status: string }>();

    if (!install) {
      return jsonResponse(
        errorEnvelope("No Marketplace installation found for this organization"),
        404,
      );
    }

    // List all users who belong to this org with their account info
    const result = await db
      .prepare(
        `SELECT u.user_id, u.email, u.display_name, u.created_at,
                a.account_id, a.status as account_status, a.provider
         FROM users u
         LEFT JOIN accounts a ON a.user_id = u.user_id AND a.provider = 'google'
         WHERE u.org_id = ?
         ORDER BY u.created_at ASC`,
      )
      .bind(orgId)
      .all<{
        user_id: string;
        email: string;
        display_name: string | null;
        created_at: string;
        account_id: string | null;
        account_status: string | null;
        provider: string | null;
      }>();

    return jsonResponse(
      successEnvelope({
        install_id: install.install_id,
        install_status: install.status,
        users: result.results ?? [],
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to list org users", err);
    return jsonResponse(errorEnvelope("Failed to list organization users"), 500);
  }
}

// ---------------------------------------------------------------------------
// POST /v1/org/:id/deactivate -- Deactivate T-Minus for the org
// ---------------------------------------------------------------------------

/**
 * Admin deactivates T-Minus for the entire organization.
 *
 * This operation:
 * 1. Marks the org_installation as inactive
 * 2. Revokes all Google accounts for users in the org (BR-2)
 * 3. Returns the count of affected users
 *
 * BR-2: Admin deactivation disconnects all users and removes credentials.
 */
export async function handleDeactivateOrg(
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

  // Admin check
  const denied = await checkOrgAdmin(auth.userId, orgId, db);
  if (denied) return denied;

  try {
    // Find the org installation
    const install = await db
      .prepare("SELECT install_id, status FROM org_installations WHERE org_id = ?")
      .bind(orgId)
      .first<{ install_id: string; status: string }>();

    if (!install) {
      return jsonResponse(
        errorEnvelope("No Marketplace installation found for this organization"),
        404,
      );
    }

    if (install.status === "inactive") {
      return jsonResponse(
        errorEnvelope("Organization installation is already deactivated"),
        409,
      );
    }

    // Mark installation as inactive
    await db
      .prepare(
        "UPDATE org_installations SET status = 'inactive', deactivated_at = datetime('now') WHERE install_id = ?",
      )
      .bind(install.install_id)
      .run();

    // Revoke all Google accounts for users in this org (BR-2)
    const revokeResult = await db
      .prepare(
        `UPDATE accounts SET status = 'revoked'
         WHERE provider = 'google' AND status = 'active'
         AND user_id IN (SELECT user_id FROM users WHERE org_id = ?)`,
      )
      .bind(orgId)
      .run();

    const affectedUsers = (revokeResult as unknown as { meta?: { changes?: number } })?.meta?.changes ?? 0;

    return jsonResponse(
      successEnvelope({
        deactivated: true,
        install_id: install.install_id,
        org_id: orgId,
        affected_users: affectedUsers,
        deactivated_at: new Date().toISOString(),
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to deactivate org installation", err);
    return jsonResponse(errorEnvelope("Failed to deactivate organization"), 500);
  }
}

// ---------------------------------------------------------------------------
// GET /v1/org/:id/install-status -- Org installation health
// ---------------------------------------------------------------------------

/**
 * Get the installation status and health for an org-level Marketplace install.
 *
 * Returns installation metadata, active user count, and sync health summary.
 */
export async function handleGetOrgInstallStatus(
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

  // Admin check
  const denied = await checkOrgAdmin(auth.userId, orgId, db);
  if (denied) return denied;

  try {
    const install = await db
      .prepare(
        "SELECT install_id, google_customer_id, admin_email, scopes_granted, status, installed_at, deactivated_at FROM org_installations WHERE org_id = ?",
      )
      .bind(orgId)
      .first<{
        install_id: string;
        google_customer_id: string;
        admin_email: string;
        scopes_granted: string | null;
        status: string;
        installed_at: string;
        deactivated_at: string | null;
      }>();

    if (!install) {
      return jsonResponse(
        errorEnvelope("No Marketplace installation found for this organization"),
        404,
      );
    }

    // Count active and total users
    const userCount = await db
      .prepare("SELECT COUNT(*) as count FROM users WHERE org_id = ?")
      .bind(orgId)
      .first<{ count: number }>();

    const activeAccountCount = await db
      .prepare(
        `SELECT COUNT(*) as count FROM accounts
         WHERE status = 'active' AND provider = 'google'
         AND user_id IN (SELECT user_id FROM users WHERE org_id = ?)`,
      )
      .bind(orgId)
      .first<{ count: number }>();

    return jsonResponse(
      successEnvelope({
        ...install,
        total_users: userCount?.count ?? 0,
        active_accounts: activeAccountCount?.count ?? 0,
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to get org install status", err);
    return jsonResponse(errorEnvelope("Failed to get installation status"), 500);
  }
}
