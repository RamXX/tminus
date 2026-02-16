/**
 * Route group: Organizations (Enterprise CRUD, members, policies, admin controls).
 *
 * Handler implementations are in routes/orgs.ts, routes/org-admin.ts,
 * and routes/enterprise-billing.ts.
 */

import { enforceFeatureGate } from "../../middleware/feature-gate";
import {
  handleCreateOrg,
  handleGetOrg,
  handleAddMember,
  handleListMembers,
  handleRemoveMember,
  handleChangeRole,
  handleCreateOrgPolicy,
  handleListOrgPolicies,
  handleUpdateOrgPolicy,
  handleDeleteOrgPolicy,
} from "../orgs";
import {
  handleListOrgUsers,
  handleDeactivateOrg,
  handleGetOrgInstallStatus,
} from "../org-admin";
import {
  handleUpdateSeats,
  enforceSeatLimit,
} from "../enterprise-billing";
import {
  type RouteGroupHandler,
  type AuthContext,
  matchRoute,
  jsonResponse,
  errorEnvelope,
  ErrorCode,
} from "../shared";

// ---------------------------------------------------------------------------
// Route group: Organizations
// ---------------------------------------------------------------------------

export const routeOrgRoutes: RouteGroupHandler = async (request, method, pathname, auth, env) => {
  if (method === "POST" && pathname === "/v1/orgs") {
    const orgGate = await enforceFeatureGate(auth.userId, "enterprise", env.DB);
    if (orgGate) return orgGate;
    return handleCreateOrg(request, auth, env.DB);
  }

  // -- Org billing: seat management (must match before /v1/orgs/:id/members) --
  let match = matchRoute(pathname, "/v1/orgs/:id/billing/seats");
  if (match && method === "POST") {
    if (!env.STRIPE_SECRET_KEY) {
      return jsonResponse(
        errorEnvelope("Billing not configured", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }
    const seatGate = await enforceFeatureGate(auth.userId, "enterprise", env.DB);
    if (seatGate) return seatGate;
    return handleUpdateSeats(request, auth.userId, env.DB, match.params[0], env.STRIPE_SECRET_KEY);
  }

  match = matchRoute(pathname, "/v1/orgs/:id/members/:uid/role");
  if (match && method === "PUT") {
    return handleChangeRole(request, auth, env.DB, match.params[0], match.params[1]);
  }

  match = matchRoute(pathname, "/v1/orgs/:id/members/:uid");
  if (match && method === "DELETE") {
    return handleRemoveMember(request, auth, env.DB, match.params[0], match.params[1]);
  }

  match = matchRoute(pathname, "/v1/orgs/:id/members");
  if (match) {
    if (method === "POST") {
      // Enforce seat limit before adding member (AC#3)
      const seatDenied = await enforceSeatLimit(match.params[0], env.DB);
      if (seatDenied) return seatDenied;
      return handleAddMember(request, auth, env.DB, match.params[0]);
    }
    if (method === "GET") {
      return handleListMembers(request, auth, env.DB, match.params[0]);
    }
  }

  // -- Org policy routes (Enterprise, admin for write, member for read) --

  match = matchRoute(pathname, "/v1/orgs/:id/policies/:pid");
  if (match) {
    const pOrgId = match.params[0];
    const pPolicyId = match.params[1];
    const policyGate = await enforceFeatureGate(auth.userId, "enterprise", env.DB);
    if (policyGate) return policyGate;
    if (method === "PUT") {
      return handleUpdateOrgPolicy(request, auth, env.DB, pOrgId, pPolicyId);
    }
    if (method === "DELETE") {
      return handleDeleteOrgPolicy(request, auth, env.DB, pOrgId, pPolicyId);
    }
  }

  match = matchRoute(pathname, "/v1/orgs/:id/policies");
  if (match) {
    const pOrgId = match.params[0];
    const policyGate = await enforceFeatureGate(auth.userId, "enterprise", env.DB);
    if (policyGate) return policyGate;
    if (method === "POST") {
      return handleCreateOrgPolicy(request, auth, env.DB, pOrgId);
    }
    if (method === "GET") {
      return handleListOrgPolicies(request, auth, env.DB, pOrgId);
    }
  }

  // -- Org admin controls (TM-ga8.4): Marketplace org-level install --
  match = matchRoute(pathname, "/v1/orgs/:id/install-users");
  if (match && method === "GET") {
    return handleListOrgUsers(request, auth, env.DB, match.params[0]);
  }

  match = matchRoute(pathname, "/v1/orgs/:id/deactivate");
  if (match && method === "POST") {
    return handleDeactivateOrg(request, auth, env.DB, match.params[0]);
  }

  match = matchRoute(pathname, "/v1/orgs/:id/install-status");
  if (match && method === "GET") {
    return handleGetOrgInstallStatus(request, auth, env.DB, match.params[0]);
  }

  match = matchRoute(pathname, "/v1/orgs/:id");
  if (match && method === "GET") {
    return handleGetOrg(request, auth, env.DB, match.params[0]);
  }

  return null;
};

