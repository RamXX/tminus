/**
 * Route group: Events (CRUD + allocation + briefing + excuse).
 *
 * Handler logic is decomposed into sub-modules:
 * - events/crud.ts         -- Event CRUD (list, get, create, update, delete)
 * - events/allocation.ts   -- Time allocation CRUD (set, get, update, delete)
 * - events/intelligence.ts -- Pre-meeting briefing + excuse generation
 *
 * This file contains the route dispatcher that delegates to sub-module handlers.
 */

import {
  type RouteGroupHandler,
  matchRoute,
} from "../shared";

// Sub-module imports
import {
  handleListEvents,
  handleGetEvent,
  handleCreateEvent,
  handleUpdateEvent,
  handleDeleteEvent,
} from "./events/crud";

import {
  handleSetAllocation,
  handleGetAllocation,
  handleUpdateAllocation,
  handleDeleteAllocation,
} from "./events/allocation";

import {
  handleGetEventBriefing,
  handleGenerateExcuse,
} from "./events/intelligence";

// ---------------------------------------------------------------------------
// Route group: Events
// ---------------------------------------------------------------------------

export const routeEventRoutes: RouteGroupHandler = async (request, method, pathname, auth, env) => {
  if (method === "GET" && pathname === "/v1/events") {
    return handleListEvents(request, auth, env);
  }

  if (method === "POST" && pathname === "/v1/events") {
    return handleCreateEvent(request, auth, env);
  }

  // Time allocation routes -- must match before generic /v1/events/:id
  let match = matchRoute(pathname, "/v1/events/:id/allocation");
  if (match) {
    const allocEventId = match.params[0];
    if (method === "POST") {
      return handleSetAllocation(request, auth, env, allocEventId);
    }
    if (method === "GET") {
      return handleGetAllocation(request, auth, env, allocEventId);
    }
    if (method === "PUT") {
      return handleUpdateAllocation(request, auth, env, allocEventId);
    }
    if (method === "DELETE") {
      return handleDeleteAllocation(request, auth, env, allocEventId);
    }
  }

  // Pre-meeting context briefing
  match = matchRoute(pathname, "/v1/events/:id/briefing");
  if (match && method === "GET") {
    return handleGetEventBriefing(request, auth, env, match.params[0]);
  }

  // Excuse generator (BR-17: draft only, never auto-send)
  match = matchRoute(pathname, "/v1/events/:id/excuse");
  if (match && method === "POST") {
    return handleGenerateExcuse(request, auth, env, match.params[0]);
  }

  match = matchRoute(pathname, "/v1/events/:id");
  if (match) {
    if (method === "GET") {
      return handleGetEvent(request, auth, env, match.params[0]);
    }
    if (method === "PATCH") {
      return handleUpdateEvent(request, auth, env, match.params[0]);
    }
    if (method === "DELETE") {
      return handleDeleteEvent(request, auth, env, match.params[0]);
    }
  }

  return null;
};
