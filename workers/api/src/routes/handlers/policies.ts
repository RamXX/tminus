/**
 * Route group: Policies + Constraints.
 */

import { isValidId } from "@tminus/shared";
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
// Policy handlers
// ---------------------------------------------------------------------------

async function handleListPolicies(
  _request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    const result = await callDO<{
      items: unknown[];
      cursor: string | null;
      has_more: boolean;
    }>(env.USER_GRAPH, auth.userId, "/listPolicies");

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to list policies", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(
      successEnvelope(result.data.items ?? result.data, {
        next_cursor: result.data.cursor ?? undefined,
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to list policies", err);
    return jsonResponse(
      errorEnvelope("Failed to list policies", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleGetPolicy(
  _request: Request,
  auth: AuthContext,
  env: Env,
  policyId: string,
): Promise<Response> {
  if (!isValidId(policyId, "policy")) {
    return jsonResponse(
      errorEnvelope("Invalid policy ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<unknown>(
      env.USER_GRAPH,
      auth.userId,
      "/getPolicy",
      { policy_id: policyId },
    );

    if (!result.ok || result.data === null) {
      return jsonResponse(
        errorEnvelope("Policy not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to get policy", err);
    return jsonResponse(
      errorEnvelope("Failed to get policy", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleCreatePolicy(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const body = await parseJsonBody<Record<string, unknown>>(request);
  if (!body) {
    return jsonResponse(
      errorEnvelope("Request body must be valid JSON", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!body.name || typeof body.name !== "string") {
    return jsonResponse(
      errorEnvelope("Policy must have a name", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<unknown>(
      env.USER_GRAPH,
      auth.userId,
      "/createPolicy",
      body,
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to create policy", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 201);
  } catch (err) {
    console.error("Failed to create policy", err);
    return jsonResponse(
      errorEnvelope("Failed to create policy", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleSetPolicyEdges(
  request: Request,
  auth: AuthContext,
  env: Env,
  policyId: string,
): Promise<Response> {
  if (!isValidId(policyId, "policy")) {
    return jsonResponse(
      errorEnvelope("Invalid policy ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const body = await parseJsonBody<{ edges: unknown[] }>(request);
  if (!body || !Array.isArray(body.edges)) {
    return jsonResponse(
      errorEnvelope("Request body must include an edges array", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    // Set edges and trigger recomputeProjections
    const result = await callDO<unknown>(
      env.USER_GRAPH,
      auth.userId,
      "/setPolicyEdges",
      { policy_id: policyId, edges: body.edges },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to set policy edges", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to set policy edges", err);
    return jsonResponse(
      errorEnvelope("Failed to set policy edges", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ---------------------------------------------------------------------------
// Constraint validation and handlers
// ---------------------------------------------------------------------------

// -- Constraint config validation (API-level, before DO call) -----------------

/** Valid constraint kinds. Must stay in sync with UserGraphDO.VALID_CONSTRAINT_KINDS. */
export const VALID_CONSTRAINT_KINDS = new Set(["trip", "working_hours", "buffer", "no_meetings_after", "override"]);

/**
 * Validate constraint kind and config_json at the API level.
 * Returns an error message string if validation fails, or null if valid.
 *
 * This provides fast feedback before hitting the DO. The DO also validates,
 * so this is a defense-in-depth measure, not the sole validation point.
 */
export function validateConstraintKindAndConfig(
  kind: string,
  configJson: Record<string, unknown>,
  activeFrom?: string | null,
  activeTo?: string | null,
): string | null {
  if (!VALID_CONSTRAINT_KINDS.has(kind)) {
    return `Invalid constraint kind "${kind}". Must be one of: ${[...VALID_CONSTRAINT_KINDS].join(", ")}`;
  }

  const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

  switch (kind) {
    case "trip": {
      if (!configJson.name || typeof configJson.name !== "string") {
        return "Trip config_json must include a 'name' string";
      }
      if (!configJson.timezone || typeof configJson.timezone !== "string") {
        return "Trip config_json must include a 'timezone' string";
      }
      const validPolicies = ["BUSY", "TITLE"];
      if (!configJson.block_policy || !validPolicies.includes(configJson.block_policy as string)) {
        return `Trip config_json.block_policy must be one of: ${validPolicies.join(", ")}`;
      }
      if (!activeFrom || !activeTo) {
        return "Trip constraint must have active_from and active_to";
      }
      break;
    }
    case "working_hours": {
      if (!Array.isArray(configJson.days) || configJson.days.length === 0) {
        return "Working hours config_json must include a non-empty 'days' array";
      }
      for (const day of configJson.days) {
        if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) {
          return `Working hours config_json.days values must be integers 0-6, got ${JSON.stringify(day)}`;
        }
      }
      if (typeof configJson.start_time !== "string" || !timeRegex.test(configJson.start_time)) {
        return "Working hours config_json must include 'start_time' in HH:MM 24-hour format";
      }
      if (typeof configJson.end_time !== "string" || !timeRegex.test(configJson.end_time)) {
        return "Working hours config_json must include 'end_time' in HH:MM 24-hour format";
      }
      if (configJson.end_time <= configJson.start_time) {
        return "Working hours config_json.end_time must be after start_time";
      }
      if (typeof configJson.timezone !== "string" || configJson.timezone.length === 0) {
        return "Working hours config_json must include a 'timezone' string";
      }
      break;
    }
    case "buffer": {
      const validTypes = ["travel", "prep", "cooldown"];
      if (typeof configJson.type !== "string" || !validTypes.includes(configJson.type)) {
        return `Buffer config_json.type must be one of: ${validTypes.join(", ")}`;
      }
      if (typeof configJson.minutes !== "number" || !Number.isInteger(configJson.minutes) || configJson.minutes <= 0) {
        return "Buffer config_json.minutes must be a positive integer";
      }
      const validAppliesTo = ["all", "external"];
      if (typeof configJson.applies_to !== "string" || !validAppliesTo.includes(configJson.applies_to)) {
        return `Buffer config_json.applies_to must be one of: ${validAppliesTo.join(", ")}`;
      }
      break;
    }
    case "no_meetings_after": {
      if (typeof configJson.time !== "string" || !timeRegex.test(configJson.time)) {
        return "no_meetings_after config_json must include 'time' in HH:MM 24-hour format";
      }
      if (typeof configJson.timezone !== "string" || configJson.timezone.length === 0) {
        return "no_meetings_after config_json must include a 'timezone' string";
      }
      break;
    }
    case "override": {
      if (typeof configJson.reason !== "string" || configJson.reason.trim().length === 0) {
        return "override config_json must include a non-empty 'reason' string";
      }
      // slot_start and slot_end are required for working hours bypass (TM-yke.2)
      if (configJson.slot_start !== undefined) {
        if (typeof configJson.slot_start !== "string" || isNaN(Date.parse(configJson.slot_start))) {
          return "override config_json.slot_start must be a valid ISO 8601 date string";
        }
      }
      if (configJson.slot_end !== undefined) {
        if (typeof configJson.slot_end !== "string" || isNaN(Date.parse(configJson.slot_end))) {
          return "override config_json.slot_end must be a valid ISO 8601 date string";
        }
      }
      if (configJson.slot_start && configJson.slot_end) {
        if (new Date(configJson.slot_start as string) >= new Date(configJson.slot_end as string)) {
          return "override config_json.slot_start must be before slot_end";
        }
      }
      if (configJson.timezone !== undefined) {
        if (typeof configJson.timezone !== "string" || configJson.timezone.length === 0) {
          return "override config_json.timezone must be a non-empty string";
        }
        try {
          Intl.DateTimeFormat(undefined, { timeZone: configJson.timezone as string });
        } catch {
          return `override config_json.timezone "${configJson.timezone}" is not a valid IANA timezone`;
        }
      }
      break;
    }
  }

  return null;
}

// -- Constraints (Trips, Working Hours, etc.) --------------------------------

async function handleCreateConstraint(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const body = await parseJsonBody<{
    kind?: string;
    config_json?: Record<string, unknown>;
    active_from?: string;
    active_to?: string;
  }>(request);

  if (!body) {
    return jsonResponse(
      errorEnvelope("Request body must be valid JSON", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Validate required fields
  if (!body.kind || typeof body.kind !== "string") {
    return jsonResponse(
      errorEnvelope("Constraint must have a 'kind' field", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!body.config_json || typeof body.config_json !== "object") {
    return jsonResponse(
      errorEnvelope("Constraint must have a 'config_json' object", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Validate ISO 8601 date strings when provided
  if (body.active_from && isNaN(Date.parse(body.active_from))) {
    return jsonResponse(
      errorEnvelope("active_from must be a valid ISO 8601 date string", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }
  if (body.active_to && isNaN(Date.parse(body.active_to))) {
    return jsonResponse(
      errorEnvelope("active_to must be a valid ISO 8601 date string", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Kind-specific config validation (API-level, fast feedback)
  const kindError = validateConstraintKindAndConfig(
    body.kind,
    body.config_json,
    body.active_from,
    body.active_to,
  );
  if (kindError) {
    return jsonResponse(
      errorEnvelope(kindError, "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{
      constraint_id: string;
      kind: string;
      config_json: Record<string, unknown>;
      active_from: string | null;
      active_to: string | null;
      created_at: string;
    }>(env.USER_GRAPH, auth.userId, "/addConstraint", {
      kind: body.kind,
      config_json: body.config_json,
      active_from: body.active_from ?? null,
      active_to: body.active_to ?? null,
    });

    if (!result.ok) {
      // Check if it's a validation error from the DO
      const errData = result.data as unknown as { error?: string };
      const errMsg = errData?.error ?? "Failed to create constraint";
      return jsonResponse(
        errorEnvelope(errMsg, "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 201);
  } catch (err) {
    console.error("Failed to create constraint", err);
    return jsonResponse(
      errorEnvelope("Failed to create constraint", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleListConstraints(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const kindFilter = url.searchParams.get("kind");

  try {
    const result = await callDO<{
      items: unknown[];
    }>(env.USER_GRAPH, auth.userId, "/listConstraints", {
      kind: kindFilter ?? undefined,
    });

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to list constraints", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data.items ?? result.data), 200);
  } catch (err) {
    console.error("Failed to list constraints", err);
    return jsonResponse(
      errorEnvelope("Failed to list constraints", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleDeleteConstraint(
  _request: Request,
  auth: AuthContext,
  env: Env,
  constraintId: string,
): Promise<Response> {
  if (!isValidId(constraintId, "constraint")) {
    return jsonResponse(
      errorEnvelope("Invalid constraint ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{ deleted: boolean }>(
      env.USER_GRAPH,
      auth.userId,
      "/deleteConstraint",
      { constraint_id: constraintId },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to delete constraint", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    if (!result.data.deleted) {
      return jsonResponse(
        errorEnvelope("Constraint not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope({ deleted: true }), 200);
  } catch (err) {
    console.error("Failed to delete constraint", err);
    return jsonResponse(
      errorEnvelope("Failed to delete constraint", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleGetConstraint(
  _request: Request,
  auth: AuthContext,
  env: Env,
  constraintId: string,
): Promise<Response> {
  if (!isValidId(constraintId, "constraint")) {
    return jsonResponse(
      errorEnvelope("Invalid constraint ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{
      constraint_id: string;
      kind: string;
      config_json: Record<string, unknown>;
      active_from: string | null;
      active_to: string | null;
      created_at: string;
    } | null>(env.USER_GRAPH, auth.userId, "/getConstraint", {
      constraint_id: constraintId,
    });

    if (!result.ok || result.data === null) {
      return jsonResponse(
        errorEnvelope("Constraint not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to get constraint", err);
    return jsonResponse(
      errorEnvelope("Failed to get constraint", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleUpdateConstraint(
  request: Request,
  auth: AuthContext,
  env: Env,
  constraintId: string,
): Promise<Response> {
  if (!isValidId(constraintId, "constraint")) {
    return jsonResponse(
      errorEnvelope("Invalid constraint ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const body = await parseJsonBody<{
    config_json?: Record<string, unknown>;
    active_from?: string | null;
    active_to?: string | null;
  }>(request);

  if (!body) {
    return jsonResponse(
      errorEnvelope("Request body must be valid JSON", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!body.config_json || typeof body.config_json !== "object") {
    return jsonResponse(
      errorEnvelope("Constraint update must include a 'config_json' object", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Validate ISO 8601 date strings when provided
  if (body.active_from && typeof body.active_from === "string" && isNaN(Date.parse(body.active_from))) {
    return jsonResponse(
      errorEnvelope("active_from must be a valid ISO 8601 date string", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }
  if (body.active_to && typeof body.active_to === "string" && isNaN(Date.parse(body.active_to))) {
    return jsonResponse(
      errorEnvelope("active_to must be a valid ISO 8601 date string", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Note: kind-specific validation cannot be done at API level for updates
  // because we don't know the kind until we fetch from the DO. The DO handles this.

  try {
    const result = await callDO<{
      constraint_id: string;
      kind: string;
      config_json: Record<string, unknown>;
      active_from: string | null;
      active_to: string | null;
      created_at: string;
    } | null>(env.USER_GRAPH, auth.userId, "/updateConstraint", {
      constraint_id: constraintId,
      config_json: body.config_json,
      active_from: body.active_from ?? null,
      active_to: body.active_to ?? null,
    });

    if (!result.ok || result.data === null) {
      return jsonResponse(
        errorEnvelope("Constraint not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to update constraint", err);
    return jsonResponse(
      errorEnvelope("Failed to update constraint", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ---------------------------------------------------------------------------
// Route group: Policies + Constraints
// ---------------------------------------------------------------------------

export const routePolicyRoutes: RouteGroupHandler = async (request, method, pathname, auth, env) => {
  if (method === "GET" && pathname === "/v1/policies") {
    return handleListPolicies(request, auth, env);
  }

  if (method === "POST" && pathname === "/v1/policies") {
    return handleCreatePolicy(request, auth, env);
  }

  let match = matchRoute(pathname, "/v1/policies/:id/edges");
  if (match && method === "PUT") {
    return handleSetPolicyEdges(request, auth, env, match.params[0]);
  }

  match = matchRoute(pathname, "/v1/policies/:id");
  if (match && method === "GET") {
    return handleGetPolicy(request, auth, env, match.params[0]);
  }

  // -- Constraint routes (Premium+) --

  if (method === "POST" && pathname === "/v1/constraints") {
    const constraintGate = await enforceFeatureGate(auth.userId, "premium", env.DB);
    if (constraintGate) return constraintGate;
    return handleCreateConstraint(request, auth, env);
  }

  if (method === "GET" && pathname === "/v1/constraints") {
    // Listing constraints is read-only, allowed for all tiers
    return handleListConstraints(request, auth, env);
  }

  match = matchRoute(pathname, "/v1/constraints/:id");
  if (match) {
    if (method === "GET") {
      // Reading a single constraint is read-only, allowed for all tiers
      return handleGetConstraint(request, auth, env, match.params[0]);
    }
    if (method === "PUT") {
      const updateGate = await enforceFeatureGate(auth.userId, "premium", env.DB);
      if (updateGate) return updateGate;
      return handleUpdateConstraint(request, auth, env, match.params[0]);
    }
    if (method === "DELETE") {
      const deleteGate = await enforceFeatureGate(auth.userId, "premium", env.DB);
      if (deleteGate) return deleteGate;
      return handleDeleteConstraint(request, auth, env, match.params[0]);
    }
  }

  return null;
};

