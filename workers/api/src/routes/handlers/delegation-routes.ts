/**
 * Route group: Domain-wide delegation (Phase 6D: TM-9iu.1, TM-9iu.4, TM-9iu.5).
 *
 * Handler implementations are in routes/org-delegation.ts and
 * routes/org-delegation-admin.ts.
 * This module provides the route group dispatcher and admin helpers.
 */

import { DelegationService, DiscoveryService, checkOrgRateLimit, buildOrgRateLimitResponse, DEFAULT_ORG_RATE_LIMITS, getQuotaReport } from "@tminus/shared";
import type { ComplianceAuditInput } from "@tminus/shared";
import { generateId } from "@tminus/shared";
import {
  handleOrgRegister,
  handleDelegationCalendars,
} from "../org-delegation";
import {
  handleOrgDashboard,
  handleListDiscoveredUsers,
  handleGetDiscoveredUser,
  handleUpdateDiscoveredUser,
  handleGetDiscoveryConfig,
  handleUpdateDiscoveryConfig,
  handleDelegationHealth,
  handleDelegationRotate,
  handleAuditLog,
  handleAuditLogExport,
} from "../org-delegation-admin";
import type { AdminDeps } from "../org-delegation-admin";
import {
  D1DelegationStore,
  D1DiscoveryStore,
  D1OrgRateLimitStore,
  D1OrgQuotaStore,
  D1ComplianceAuditStore,
  queryAuditLogFromD1,
  getDelegationFromD1,
} from "../d1-delegation-stores";
import { appendAuditEntry as appendComplianceAuditEntry } from "@tminus/shared";
import {
  type RouteGroupHandler,
  type AuthContext,
  matchRoute,
  jsonResponse,
  errorEnvelope,
  ErrorCode,
} from "../shared";

// ---------------------------------------------------------------------------
// Admin route helpers -- DRY up delegation admin routes (TM-8xt4, TM-i6ao)
// ---------------------------------------------------------------------------

/**
 * Look up the caller's org membership and return an AdminAuthContext.
 * Admin status is determined by the `role` column in `org_members`.
 */
async function buildAdminAuth(
  db: D1Database,
  orgId: string,
  userId: string,
): Promise<{ userId: string; isAdmin: boolean }> {
  const memberRow = await db
    .prepare("SELECT role FROM org_members WHERE org_id = ?1 AND user_id = ?2")
    .bind(orgId, userId)
    .first<{ role: string }>();
  return { userId, isAdmin: memberRow?.role === "admin" };
}

/**
 * Construct the standard AdminDeps for delegation admin handlers.
 *
 * Options:
 * - `includeQuotaReport`: when true, attaches `getQuotaReport` (used by the
 *   dashboard endpoint only).
 */
function buildAdminDeps(
  env: Env,
  options?: { includeQuotaReport?: boolean },
): AdminDeps {
  const masterKey = env.MASTER_KEY ?? "";
  const delegationStore = new D1DelegationStore(env.DB);
  const discoveryStore = new D1DiscoveryStore(env.DB);
  const delegationSvc = new DelegationService(delegationStore, masterKey);
  const discoverySvc = new DiscoveryService(discoveryStore, {
    getDirectoryToken: async () => "",
  });
  const deps: AdminDeps = {
    delegationService: delegationSvc,
    discoveryService: discoverySvc,
    queryAuditLog: (did, opts) => queryAuditLogFromD1(env.DB, did, opts),
    getDelegation: (did) => getDelegationFromD1(env.DB, did),
  };
  if (options?.includeQuotaReport) {
    const quotaStore = new D1OrgQuotaStore(env.DB);
    deps.getQuotaReport = (oid) => getQuotaReport(quotaStore, oid);
  }
  return deps;
}

/** Context provided to delegation admin route handlers by withDelegationAdmin. */
interface DelegationAdminContext {
  request: Request;
  adminAuth: { userId: string; isAdmin: boolean };
  orgId: string;
  env: Env;
}

/**
 * Higher-order helper that wraps the common delegation admin route boilerplate:
 * 1. Rate-limit check (returns 429 if blocked)
 * 2. Admin auth context construction (org membership lookup)
 *
 * The handler callback receives a DelegationAdminContext and returns a Response.
 * This eliminates the repeated checkDelegationRateLimit/buildAdminAuth pattern
 * across all delegation admin routes.
 */
async function withDelegationAdmin(
  request: Request,
  env: Env,
  auth: { userId: string },
  orgId: string,
  handler: (ctx: DelegationAdminContext) => Promise<Response>,
): Promise<Response> {
  const rlBlock = await checkDelegationRateLimit(env.DB, orgId);
  if (rlBlock) return rlBlock;
  const adminAuth = await buildAdminAuth(env.DB, orgId, auth.userId);
  return handler({ request, adminAuth, orgId, env });
}

// ---------------------------------------------------------------------------
// Route group: Domain-wide delegation (Phase 6D: TM-9iu.1, TM-9iu.4, TM-9iu.5)
// ---------------------------------------------------------------------------

/**
 * Rate limit check for org delegation endpoints (TM-9iu.5).
 * Applies sliding-window rate limiting per-org on the "api" bucket.
 * Returns a 429 Response if rate limited, null if allowed.
 */
async function checkDelegationRateLimit(db: D1Database, orgId: string): Promise<Response | null> {
  const rlStore = new D1OrgRateLimitStore(db);
  const rlConfig = (await rlStore.getOrgConfig(orgId)) ?? DEFAULT_ORG_RATE_LIMITS;
  const rlResult = await checkOrgRateLimit(rlStore, orgId, "api", rlConfig);
  if (!rlResult.allowed) {
    return buildOrgRateLimitResponse(rlResult);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Route group: Delegation
// ---------------------------------------------------------------------------

export const routeDelegationRoutes: RouteGroupHandler = async (request, method, pathname, auth, env) => {
  if (method === "POST" && pathname === "/v1/orgs/register") {
    const delegationStore = new D1DelegationStore(env.DB);
    return handleOrgRegister(request, auth, { store: delegationStore, MASTER_KEY: env.MASTER_KEY });
  }

  let match = matchRoute(pathname, "/v1/orgs/delegation/calendars/:email");
  if (match && method === "GET") {
    const targetEmail = match.params[0];
    const delegationStore = new D1DelegationStore(env.DB);
    const response = await handleDelegationCalendars(
      request,
      auth,
      { store: delegationStore, MASTER_KEY: env.MASTER_KEY },
      targetEmail,
    );

    // AC#4: Log impersonation to compliance audit log (hash chain)
    // Fire-and-forget: audit logging must not block the response
    try {
      const emailDomain = targetEmail.includes("@") ? targetEmail.split("@")[1]?.toLowerCase() : null;
      if (emailDomain) {
        const delegation = await delegationStore.getDelegation(emailDomain);
        if (delegation) {
          const complianceStore = new D1ComplianceAuditStore(env.DB);
          const auditInput: ComplianceAuditInput = {
            entryId: generateId("audit"),
            orgId: delegation.delegationId,
            timestamp: new Date().toISOString(),
            actor: auth.userId,
            action: "token_issued",
            target: targetEmail,
            result: response.ok ? "success" : "failure",
            ipAddress: request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For") ?? "unknown",
            userAgent: request.headers.get("User-Agent") ?? "unknown",
            details: JSON.stringify({
              service: "delegation_calendars",
              http_status: response.status,
            }),
          };
          await appendComplianceAuditEntry(complianceStore, auditInput);
        }
      }
    } catch {
      // Audit log failure must not affect the user-facing response
    }

    return response;
  }

  // -- Delegation admin dashboard routes (Phase 6D: TM-9iu.4) --
  // All routes below use withDelegationAdmin to handle rate limiting + auth (TM-i6ao).

  // PUT/GET /v1/orgs/:id/discovery/config (must match before shorter patterns)
  match = matchRoute(pathname, "/v1/orgs/:id/discovery/config");
  if (match && (method === "PUT" || method === "GET")) {
    return withDelegationAdmin(request, env, auth, match.params[0], (ctx) => {
      const deps = buildAdminDeps(ctx.env);
      if (method === "GET") {
        return handleGetDiscoveryConfig(ctx.request, ctx.adminAuth, ctx.orgId, deps);
      }
      return handleUpdateDiscoveryConfig(ctx.request, ctx.adminAuth, ctx.orgId, deps);
    });
  }

  // GET /v1/orgs/:id/delegation/health
  match = matchRoute(pathname, "/v1/orgs/:id/delegation/health");
  if (match && method === "GET") {
    return withDelegationAdmin(request, env, auth, match.params[0], (ctx) => {
      const deps = buildAdminDeps(ctx.env);
      return handleDelegationHealth(ctx.request, ctx.adminAuth, ctx.orgId, deps);
    });
  }

  // POST /v1/orgs/:id/delegation/rotate
  match = matchRoute(pathname, "/v1/orgs/:id/delegation/rotate");
  if (match && method === "POST") {
    return withDelegationAdmin(request, env, auth, match.params[0], (ctx) => {
      const deps = buildAdminDeps(ctx.env);
      return handleDelegationRotate(ctx.request, ctx.adminAuth, ctx.orgId, deps);
    });
  }

  // GET /v1/orgs/:id/dashboard
  match = matchRoute(pathname, "/v1/orgs/:id/dashboard");
  if (match && method === "GET") {
    return withDelegationAdmin(request, env, auth, match.params[0], (ctx) => {
      const deps = buildAdminDeps(ctx.env, { includeQuotaReport: true });
      return handleOrgDashboard(ctx.request, ctx.adminAuth, ctx.orgId, deps);
    });
  }

  // POST /v1/orgs/:id/audit-log/export (AC#6: audit log export)
  match = matchRoute(pathname, "/v1/orgs/:id/audit-log/export");
  if (match && method === "POST") {
    return withDelegationAdmin(request, env, auth, match.params[0], (ctx) => {
      const complianceStore = new D1ComplianceAuditStore(ctx.env.DB);
      return handleAuditLogExport(ctx.request, ctx.adminAuth, ctx.orgId, complianceStore);
    });
  }

  // GET /v1/orgs/:id/audit
  match = matchRoute(pathname, "/v1/orgs/:id/audit");
  if (match && method === "GET") {
    return withDelegationAdmin(request, env, auth, match.params[0], (ctx) => {
      const deps = buildAdminDeps(ctx.env);
      return handleAuditLog(ctx.request, ctx.adminAuth, ctx.orgId, deps);
    });
  }

  // PATCH/GET /v1/orgs/:id/users/:uid
  match = matchRoute(pathname, "/v1/orgs/:id/users/:uid");
  if (match && (method === "PATCH" || method === "GET")) {
    const userId = match.params[1];
    return withDelegationAdmin(request, env, auth, match.params[0], (ctx) => {
      const deps = buildAdminDeps(ctx.env);
      if (method === "PATCH") {
        return handleUpdateDiscoveredUser(ctx.request, ctx.adminAuth, ctx.orgId, userId, deps);
      }
      return handleGetDiscoveredUser(ctx.request, ctx.adminAuth, ctx.orgId, userId, deps);
    });
  }

  // GET /v1/orgs/:id/users (list discovered users)
  match = matchRoute(pathname, "/v1/orgs/:id/users");
  if (match && method === "GET") {
    return withDelegationAdmin(request, env, auth, match.params[0], (ctx) => {
      const deps = buildAdminDeps(ctx.env);
      return handleListDiscoveredUsers(ctx.request, ctx.adminAuth, ctx.orgId, deps);
    });
  }

  return null;
};

