/**
 * Route group: VIP policies (Premium+).
 */

import { isValidId, generateId } from "@tminus/shared";
import { enforceFeatureGate } from "../../middleware/feature-gate";
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

// ---------------------------------------------------------------------------
// VIP handlers
// ---------------------------------------------------------------------------

async function handleCreateVipPolicy(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const body = await parseJsonBody<{
    participant_hash?: string;
    display_name?: string;
    priority_weight?: number;
    conditions_json?: Record<string, unknown>;
  }>(request);

  if (!body) {
    return jsonResponse(
      errorEnvelope("Request body must be valid JSON", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!body.participant_hash || typeof body.participant_hash !== "string") {
    return jsonResponse(
      errorEnvelope("participant_hash is required", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!body.conditions_json || typeof body.conditions_json !== "object") {
    return jsonResponse(
      errorEnvelope("conditions_json is required and must be an object", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const priorityWeight = body.priority_weight ?? 1.0;
  if (typeof priorityWeight !== "number" || priorityWeight < 0) {
    return jsonResponse(
      errorEnvelope("priority_weight must be a non-negative number", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const vipId = generateId("vip");
    const result = await callDO<{
      vip_id: string;
      participant_hash: string;
      display_name: string | null;
      priority_weight: number;
      conditions_json: Record<string, unknown>;
      created_at: string;
    }>(env.USER_GRAPH, auth.userId, "/createVipPolicy", {
      vip_id: vipId,
      participant_hash: body.participant_hash,
      display_name: body.display_name ?? null,
      priority_weight: priorityWeight,
      conditions_json: body.conditions_json,
    });

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to create VIP policy", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 201);
  } catch (err) {
    console.error("Failed to create VIP policy", err);
    return jsonResponse(
      errorEnvelope("Failed to create VIP policy", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleListVipPolicies(
  _request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    const result = await callDO<{
      items: unknown[];
    }>(env.USER_GRAPH, auth.userId, "/listVipPolicies");

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to list VIP policies", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data.items ?? result.data), 200);
  } catch (err) {
    console.error("Failed to list VIP policies", err);
    return jsonResponse(
      errorEnvelope("Failed to list VIP policies", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleDeleteVipPolicy(
  _request: Request,
  auth: AuthContext,
  env: Env,
  vipId: string,
): Promise<Response> {
  if (!isValidId(vipId, "vip")) {
    return jsonResponse(
      errorEnvelope("Invalid VIP policy ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{ deleted: boolean }>(
      env.USER_GRAPH,
      auth.userId,
      "/deleteVipPolicy",
      { vip_id: vipId },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to delete VIP policy", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    if (!result.data.deleted) {
      return jsonResponse(
        errorEnvelope("VIP policy not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope({ deleted: true }), 200);
  } catch (err) {
    console.error("Failed to delete VIP policy", err);
    return jsonResponse(
      errorEnvelope("Failed to delete VIP policy", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ---------------------------------------------------------------------------
// Route group: VIP
// ---------------------------------------------------------------------------

export const routeVipRoutes: RouteGroupHandler = async (request, method, pathname, auth, env) => {
  if (method === "POST" && pathname === "/v1/vip-policies") {
    const vipGate = await enforceFeatureGate(auth.userId, "premium", env.DB);
    if (vipGate) return vipGate;
    return handleCreateVipPolicy(request, auth, env);
  }

  if (method === "GET" && pathname === "/v1/vip-policies") {
    return handleListVipPolicies(request, auth, env);
  }

  const match = matchRoute(pathname, "/v1/vip-policies/:id");
  if (match && method === "DELETE") {
    const vipDeleteGate = await enforceFeatureGate(auth.userId, "premium", env.DB);
    if (vipDeleteGate) return vipDeleteGate;
    return handleDeleteVipPolicy(request, auth, env, match.params[0]);
  }

  return null;
};

