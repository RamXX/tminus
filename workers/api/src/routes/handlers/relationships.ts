/**
 * Route group: Relationships.
 *
 * Handler logic is decomposed into sub-modules:
 * - relationships/crud.ts       -- Relationship CRUD (create, get, list, update, delete)
 * - relationships/milestones.ts -- Milestone CRUD + upcoming milestones
 * - relationships/outcomes.ts   -- Interaction ledger (mark/list outcomes)
 * - relationships/reputation.ts -- Reputation scoring, drift, reconnection suggestions
 *
 * This file contains the route dispatcher that delegates to sub-module handlers.
 */

import {
  type RouteGroupHandler,
  matchRoute,
} from "../shared";

// Sub-module imports
import {
  handleCreateRelationship,
  handleGetRelationship,
  handleListRelationships,
  handleUpdateRelationship,
  handleDeleteRelationship,
} from "./relationships/crud";

import {
  handleCreateMilestone,
  handleListMilestones,
  handleDeleteMilestone,
  handleListUpcomingMilestones,
} from "./relationships/milestones";

import {
  handleMarkOutcome,
  handleListOutcomes,
} from "./relationships/outcomes";

import {
  handleGetReputation,
  handleListRelationshipsWithReputation,
  handleGetDriftReport,
  handleGetDriftAlerts,
  handleGetTripReconnections,
  handleGetReconnectionSuggestions,
} from "./relationships/reputation";

// ---------------------------------------------------------------------------
// Route group: Relationships
// ---------------------------------------------------------------------------

export const routeRelationshipRoutes: RouteGroupHandler = async (request, method, pathname, auth, env) => {
  if (method === "POST" && pathname === "/v1/relationships") {
    return handleCreateRelationship(request, auth, env);
  }

  if (method === "GET" && pathname === "/v1/relationships") {
    // Check for ?sort=reliability_desc to return relationships with reputation
    const urlCheck = new URL(request.url);
    if (urlCheck.searchParams.get("sort") === "reliability_desc") {
      return handleListRelationshipsWithReputation(request, auth, env);
    }
    return handleListRelationships(request, auth, env);
  }

  if (method === "GET" && pathname === "/v1/drift-report") {
    return handleGetDriftReport(request, auth, env);
  }

  if (method === "GET" && pathname === "/v1/drift-alerts") {
    return handleGetDriftAlerts(request, auth, env);
  }

  if (method === "GET" && pathname === "/v1/reconnection-suggestions") {
    return handleGetReconnectionSuggestions(request, auth, env);
  }

  let match = matchRoute(pathname, "/v1/trips/:id/reconnections");
  if (match && method === "GET") {
    return handleGetTripReconnections(request, auth, env, match.params[0]);
  }

  // -- Interaction ledger (outcomes) --
  // Must match before /v1/relationships/:id since it has more segments
  match = matchRoute(pathname, "/v1/relationships/:id/outcomes");
  if (match) {
    const relId = match.params[0];
    if (method === "POST") {
      return handleMarkOutcome(request, auth, env, relId);
    }
    if (method === "GET") {
      return handleListOutcomes(request, auth, env, relId);
    }
  }

  // -- Milestone routes --
  // Must match before /v1/relationships/:id since they have more segments

  // DELETE /v1/relationships/:id/milestones/:mid
  match = matchRoute(pathname, "/v1/relationships/:id/milestones/:mid");
  if (match && method === "DELETE") {
    return handleDeleteMilestone(request, auth, env, match.params[0], match.params[1]);
  }

  // POST/GET /v1/relationships/:id/milestones
  match = matchRoute(pathname, "/v1/relationships/:id/milestones");
  if (match) {
    const relId = match.params[0];
    if (method === "POST") {
      return handleCreateMilestone(request, auth, env, relId);
    }
    if (method === "GET") {
      return handleListMilestones(request, auth, env, relId);
    }
  }

  // GET /v1/milestones/upcoming?days=30
  if (method === "GET" && pathname === "/v1/milestones/upcoming") {
    return handleListUpcomingMilestones(request, auth, env);
  }

  // -- Reputation scoring --
  // Must match before /v1/relationships/:id since it has more segments
  match = matchRoute(pathname, "/v1/relationships/:id/reputation");
  if (match && method === "GET") {
    return handleGetReputation(request, auth, env, match.params[0]);
  }

  match = matchRoute(pathname, "/v1/relationships/:id");
  if (match) {
    const relId = match.params[0];
    if (method === "GET") {
      return handleGetRelationship(request, auth, env, relId);
    }
    if (method === "PUT") {
      return handleUpdateRelationship(request, auth, env, relId);
    }
    if (method === "DELETE") {
      return handleDeleteRelationship(request, auth, env, relId);
    }
  }

  return null;
};
