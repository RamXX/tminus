/**
 * Route group: Scheduling (individual + group sessions).
 */

import { enforceFeatureGate } from "../../middleware/feature-gate";
import {
  handleCreateSchedulingSession,
  handleListSchedulingSessions,
  handleGetSchedulingSession,
  handleGetSchedulingCandidates,
  handleCommitSchedulingCandidate,
  handleCancelSchedulingSession,
  handleExtendHold,
} from "../scheduling";
import {
  handleCreateGroupSession,
  handleGetGroupSession,
  handleCommitGroupSession,
} from "../group-scheduling";
import {
  type RouteGroupHandler,
  type AuthContext,
  matchRoute,
  callDO,
  parseJsonBody,
  jsonResponse,
  successEnvelope,
  errorEnvelope,
  ErrorCode,
} from "../shared";

async function handleCreateSchedulingOverride(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const body = await parseJsonBody<{
    reason?: string;
    slot_start?: string;
    slot_end?: string;
    timezone?: string;
  }>(request);

  if (!body) {
    return jsonResponse(
      errorEnvelope("Request body must be valid JSON", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Validate required fields
  if (!body.reason || typeof body.reason !== "string" || body.reason.trim().length === 0) {
    return jsonResponse(
      errorEnvelope("reason is required and must be a non-empty string", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!body.slot_start || typeof body.slot_start !== "string") {
    return jsonResponse(
      errorEnvelope("slot_start is required (ISO 8601 datetime)", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }
  if (isNaN(Date.parse(body.slot_start))) {
    return jsonResponse(
      errorEnvelope("slot_start must be a valid ISO 8601 date string", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!body.slot_end || typeof body.slot_end !== "string") {
    return jsonResponse(
      errorEnvelope("slot_end is required (ISO 8601 datetime)", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }
  if (isNaN(Date.parse(body.slot_end))) {
    return jsonResponse(
      errorEnvelope("slot_end must be a valid ISO 8601 date string", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (new Date(body.slot_start) >= new Date(body.slot_end)) {
    return jsonResponse(
      errorEnvelope("slot_start must be before slot_end", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Validate timezone if provided
  const timezone = body.timezone ?? "UTC";
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    return jsonResponse(
      errorEnvelope(`timezone "${timezone}" is not a valid IANA timezone`, "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Create an override constraint via the existing constraint pipeline
  const configJson = {
    reason: body.reason.trim(),
    slot_start: body.slot_start,
    slot_end: body.slot_end,
    timezone,
  };

  try {
    const result = await callDO<{
      constraint_id: string;
      kind: string;
      config_json: Record<string, unknown>;
      active_from: string | null;
      active_to: string | null;
      created_at: string;
    }>(env.USER_GRAPH, auth.userId, "/addConstraint", {
      kind: "override",
      config_json: configJson,
      active_from: body.slot_start,
      active_to: body.slot_end,
    });

    if (!result.ok) {
      const errData = result.data as unknown as { error?: string };
      const errMsg = errData?.error ?? "Failed to create scheduling override";
      return jsonResponse(
        errorEnvelope(errMsg, "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 201);
  } catch (err) {
    console.error("Failed to create scheduling override", err);
    return jsonResponse(
      errorEnvelope("Failed to create scheduling override", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}


export const routeSchedulingRoutes: RouteGroupHandler = async (request, method, pathname, auth, env) => {
  if (method === "POST" && pathname === "/v1/scheduling/override") {
    const overrideGate = await enforceFeatureGate(auth.userId, "premium", env.DB);
    if (overrideGate) return overrideGate;
    return handleCreateSchedulingOverride(request, auth, env);
  }

  if (method === "POST" && pathname === "/v1/scheduling/sessions") {
    return handleCreateSchedulingSession(request, auth, env);
  }

  if (method === "GET" && pathname === "/v1/scheduling/sessions") {
    return handleListSchedulingSessions(request, auth, env);
  }

  let match = matchRoute(pathname, "/v1/scheduling/sessions/:id/candidates");
  if (match && method === "GET") {
    return handleGetSchedulingCandidates(request, auth, env, match.params[0]);
  }

  match = matchRoute(pathname, "/v1/scheduling/sessions/:id/commit");
  if (match && method === "POST") {
    return handleCommitSchedulingCandidate(request, auth, env, match.params[0]);
  }

  // TM-82s.4: Hold extension route
  match = matchRoute(pathname, "/v1/scheduling/sessions/:id/extend-hold");
  if (match && method === "POST") {
    return handleExtendHold(request, auth, env, match.params[0]);
  }

  match = matchRoute(pathname, "/v1/scheduling/sessions/:id");
  if (match) {
    if (method === "GET") {
      return handleGetSchedulingSession(request, auth, env, match.params[0]);
    }
    if (method === "DELETE") {
      return handleCancelSchedulingSession(request, auth, env, match.params[0]);
    }
  }

  // -- Group scheduling routes (Phase 4D) --

  if (method === "POST" && pathname === "/v1/scheduling/group-sessions") {
    return handleCreateGroupSession(request, auth, env);
  }

  match = matchRoute(pathname, "/v1/scheduling/group-sessions/:id/commit");
  if (match && method === "POST") {
    return handleCommitGroupSession(request, auth, env, match.params[0]);
  }

  match = matchRoute(pathname, "/v1/scheduling/group-sessions/:id");
  if (match && method === "GET") {
    return handleGetGroupSession(request, auth, env, match.params[0]);
  }

  return null;
};

