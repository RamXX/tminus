/**
 * Route group: Privacy / deletion request.
 *
 * Handler implementations are in routes/privacy.ts.
 */

import {
  handleCreateDeletionRequest,
  handleGetDeletionRequest,
  handleCancelDeletionRequest,
} from "../privacy";
import { type RouteGroupHandler } from "../shared";

// ---------------------------------------------------------------------------
// Route group: Privacy
// ---------------------------------------------------------------------------

export const routePrivacyRoutes: RouteGroupHandler = async (request, method, pathname, auth, env) => {
  if (pathname === "/v1/account/delete-request") {
    if (method === "POST") {
      return handleCreateDeletionRequest(request, auth, env);
    }
    if (method === "GET") {
      return handleGetDeletionRequest(request, auth, env);
    }
    if (method === "DELETE") {
      return handleCancelDeletionRequest(request, auth, env);
    }
  }
  return null;
};

