/**
 * Route group: Relationships.
 */

import { isValidId, generateId, isValidRelationshipCategory, RELATIONSHIP_CATEGORIES, isValidOutcome, INTERACTION_OUTCOMES, isValidMilestoneKind, isValidMilestoneDate, MILESTONE_KINDS } from "@tminus/shared";
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
// Relationship CRUD + outcomes + milestones + reputation handlers
// ---------------------------------------------------------------------------

async function handleCreateRelationship(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const body = await parseJsonBody<{
    participant_hash?: string;
    display_name?: string;
    category?: string;
    closeness_weight?: number;
    city?: string;
    timezone?: string;
    interaction_frequency_target?: number;
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

  if (!body.category || typeof body.category !== "string") {
    return jsonResponse(
      errorEnvelope("category is required", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!isValidRelationshipCategory(body.category)) {
    return jsonResponse(
      errorEnvelope(
        `Invalid category: ${body.category}. Must be one of: ${RELATIONSHIP_CATEGORIES.join(", ")}`,
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const closenessWeight = body.closeness_weight ?? 0.5;
  if (typeof closenessWeight !== "number" || closenessWeight < 0 || closenessWeight > 1) {
    return jsonResponse(
      errorEnvelope("closeness_weight must be between 0.0 and 1.0", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const relationshipId = generateId("relationship");
    const result = await callDO<{
      relationship_id: string;
      participant_hash: string;
      display_name: string | null;
      category: string;
      closeness_weight: number;
      last_interaction_ts: string | null;
      city: string | null;
      timezone: string | null;
      interaction_frequency_target: number | null;
      created_at: string;
      updated_at: string;
    }>(env.USER_GRAPH, auth.userId, "/createRelationship", {
      relationship_id: relationshipId,
      participant_hash: body.participant_hash,
      display_name: body.display_name ?? null,
      category: body.category,
      closeness_weight: closenessWeight,
      city: body.city ?? null,
      timezone: body.timezone ?? null,
      interaction_frequency_target: body.interaction_frequency_target ?? null,
    });

    if (!result.ok) {
      const errorData = result.data as unknown as { error?: string };
      return jsonResponse(
        errorEnvelope(errorData.error ?? "Failed to create relationship", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 201);
  } catch (err) {
    console.error("Failed to create relationship", err);
    return jsonResponse(
      errorEnvelope("Failed to create relationship", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleGetRelationship(
  _request: Request,
  auth: AuthContext,
  env: Env,
  relationshipId: string,
): Promise<Response> {
  if (!isValidId(relationshipId, "relationship")) {
    return jsonResponse(
      errorEnvelope("Invalid relationship ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<unknown>(
      env.USER_GRAPH,
      auth.userId,
      "/getRelationship",
      { relationship_id: relationshipId },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to get relationship", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    if (!result.data) {
      return jsonResponse(
        errorEnvelope("Relationship not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to get relationship", err);
    return jsonResponse(
      errorEnvelope("Failed to get relationship", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleListRelationships(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const category = url.searchParams.get("category") ?? undefined;

  try {
    const result = await callDO<{
      items: unknown[];
    }>(env.USER_GRAPH, auth.userId, "/listRelationships", {
      category,
    });

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to list relationships", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data.items ?? result.data), 200);
  } catch (err) {
    console.error("Failed to list relationships", err);
    return jsonResponse(
      errorEnvelope("Failed to list relationships", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleUpdateRelationship(
  request: Request,
  auth: AuthContext,
  env: Env,
  relationshipId: string,
): Promise<Response> {
  if (!isValidId(relationshipId, "relationship")) {
    return jsonResponse(
      errorEnvelope("Invalid relationship ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const body = await parseJsonBody<{
    display_name?: string | null;
    category?: string;
    closeness_weight?: number;
    city?: string | null;
    timezone?: string | null;
    interaction_frequency_target?: number | null;
  }>(request);

  if (!body) {
    return jsonResponse(
      errorEnvelope("Request body must be valid JSON", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (body.category !== undefined && !isValidRelationshipCategory(body.category)) {
    return jsonResponse(
      errorEnvelope(
        `Invalid category: ${body.category}. Must be one of: ${RELATIONSHIP_CATEGORIES.join(", ")}`,
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<unknown>(
      env.USER_GRAPH,
      auth.userId,
      "/updateRelationship",
      {
        relationship_id: relationshipId,
        ...body,
      },
    );

    if (!result.ok) {
      const errorData = result.data as { error?: string };
      return jsonResponse(
        errorEnvelope(errorData.error ?? "Failed to update relationship", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    if (!result.data) {
      return jsonResponse(
        errorEnvelope("Relationship not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to update relationship", err);
    return jsonResponse(
      errorEnvelope("Failed to update relationship", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleDeleteRelationship(
  _request: Request,
  auth: AuthContext,
  env: Env,
  relationshipId: string,
): Promise<Response> {
  if (!isValidId(relationshipId, "relationship")) {
    return jsonResponse(
      errorEnvelope("Invalid relationship ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{ deleted: boolean }>(
      env.USER_GRAPH,
      auth.userId,
      "/deleteRelationship",
      { relationship_id: relationshipId },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to delete relationship", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    if (!result.data.deleted) {
      return jsonResponse(
        errorEnvelope("Relationship not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope({ deleted: true }), 200);
  } catch (err) {
    console.error("Failed to delete relationship", err);
    return jsonResponse(
      errorEnvelope("Failed to delete relationship", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- Milestone CRUD (Phase 4B) -----------------------------------------------

async function handleCreateMilestone(
  request: Request,
  auth: AuthContext,
  env: Env,
  relationshipId: string,
): Promise<Response> {
  if (!isValidId(relationshipId, "relationship")) {
    return jsonResponse(
      errorEnvelope("Invalid relationship ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const body = await parseJsonBody<{
    kind?: string;
    date?: string;
    recurs_annually?: boolean;
    note?: string;
  }>(request);

  if (!body) {
    return jsonResponse(
      errorEnvelope("Request body must be valid JSON", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!body.kind || typeof body.kind !== "string") {
    return jsonResponse(
      errorEnvelope("kind is required", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!isValidMilestoneKind(body.kind)) {
    return jsonResponse(
      errorEnvelope(
        `Invalid milestone kind: ${body.kind}. Must be one of: ${MILESTONE_KINDS.join(", ")}`,
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!body.date || typeof body.date !== "string") {
    return jsonResponse(
      errorEnvelope("date is required (YYYY-MM-DD format)", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!isValidMilestoneDate(body.date)) {
    return jsonResponse(
      errorEnvelope(
        `Invalid date: ${body.date}. Must be YYYY-MM-DD format with a valid date.`,
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const milestoneId = generateId("milestone");
    const result = await callDO<{
      milestone_id: string;
      participant_hash: string;
      kind: string;
      date: string;
      recurs_annually: boolean;
      note: string | null;
      created_at: string;
    } | null>(env.USER_GRAPH, auth.userId, "/createMilestone", {
      milestone_id: milestoneId,
      relationship_id: relationshipId,
      kind: body.kind,
      date: body.date,
      recurs_annually: body.recurs_annually ?? false,
      note: body.note ?? null,
    });

    if (!result.ok) {
      const errorData = result.data as unknown as { error?: string };
      return jsonResponse(
        errorEnvelope(errorData.error ?? "Failed to create milestone", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    if (result.data === null) {
      return jsonResponse(
        errorEnvelope("Relationship not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope(result.data), 201);
  } catch (err) {
    console.error("Failed to create milestone", err);
    return jsonResponse(
      errorEnvelope("Failed to create milestone", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleListMilestones(
  _request: Request,
  auth: AuthContext,
  env: Env,
  relationshipId: string,
): Promise<Response> {
  if (!isValidId(relationshipId, "relationship")) {
    return jsonResponse(
      errorEnvelope("Invalid relationship ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{ items: unknown[] } | { error: string }>(
      env.USER_GRAPH,
      auth.userId,
      "/listMilestones",
      { relationship_id: relationshipId },
    );

    if (!result.ok) {
      if (result.status === 404) {
        return jsonResponse(
          errorEnvelope("Relationship not found", "NOT_FOUND"),
          ErrorCode.NOT_FOUND,
        );
      }
      return jsonResponse(
        errorEnvelope("Failed to list milestones", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    const data = result.data as { items?: unknown[] };
    return jsonResponse(successEnvelope(data.items ?? data), 200);
  } catch (err) {
    console.error("Failed to list milestones", err);
    return jsonResponse(
      errorEnvelope("Failed to list milestones", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleDeleteMilestone(
  _request: Request,
  auth: AuthContext,
  env: Env,
  _relationshipId: string,
  milestoneId: string,
): Promise<Response> {
  if (!isValidId(milestoneId, "milestone")) {
    return jsonResponse(
      errorEnvelope("Invalid milestone ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{ deleted: boolean }>(
      env.USER_GRAPH,
      auth.userId,
      "/deleteMilestone",
      { milestone_id: milestoneId },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to delete milestone", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    if (!result.data.deleted) {
      return jsonResponse(
        errorEnvelope("Milestone not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope({ deleted: true }), 200);
  } catch (err) {
    console.error("Failed to delete milestone", err);
    return jsonResponse(
      errorEnvelope("Failed to delete milestone", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleListUpcomingMilestones(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const daysParam = url.searchParams.get("days");
  const maxDays = daysParam ? parseInt(daysParam, 10) : 30;

  if (isNaN(maxDays) || maxDays < 1 || maxDays > 365) {
    return jsonResponse(
      errorEnvelope("days must be between 1 and 365", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{ items: unknown[] }>(
      env.USER_GRAPH,
      auth.userId,
      "/listUpcomingMilestones",
      { max_days: maxDays },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to list upcoming milestones", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data.items ?? result.data), 200);
  } catch (err) {
    console.error("Failed to list upcoming milestones", err);
    return jsonResponse(
      errorEnvelope("Failed to list upcoming milestones", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- Interaction Ledger (outcomes) -------------------------------------------

async function handleMarkOutcome(
  request: Request,
  auth: AuthContext,
  env: Env,
  relationshipId: string,
): Promise<Response> {
  if (!isValidId(relationshipId, "relationship")) {
    return jsonResponse(
      errorEnvelope("Invalid relationship ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const body = await parseJsonBody<{
    outcome?: string;
    canonical_event_id?: string | null;
    note?: string | null;
  }>(request);

  if (!body) {
    return jsonResponse(
      errorEnvelope("Request body must be valid JSON", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!body.outcome || typeof body.outcome !== "string") {
    return jsonResponse(
      errorEnvelope("outcome is required", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!isValidOutcome(body.outcome)) {
    return jsonResponse(
      errorEnvelope(
        `Invalid outcome: ${body.outcome}. Must be one of: ${INTERACTION_OUTCOMES.join(", ")}`,
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{
      ledger_id: string;
      participant_hash: string;
      canonical_event_id: string | null;
      outcome: string;
      weight: number;
      note: string | null;
      ts: string;
    } | null>(env.USER_GRAPH, auth.userId, "/markOutcome", {
      relationship_id: relationshipId,
      outcome: body.outcome,
      canonical_event_id: body.canonical_event_id ?? null,
      note: body.note ?? null,
    });

    if (!result.ok) {
      const errorData = result.data as unknown as { error?: string };
      return jsonResponse(
        errorEnvelope(errorData.error ?? "Failed to mark outcome", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    if (!result.data) {
      return jsonResponse(
        errorEnvelope("Relationship not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope(result.data), 201);
  } catch (err) {
    console.error("Failed to mark outcome", err);
    return jsonResponse(
      errorEnvelope("Failed to mark outcome", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleListOutcomes(
  request: Request,
  auth: AuthContext,
  env: Env,
  relationshipId: string,
): Promise<Response> {
  if (!isValidId(relationshipId, "relationship")) {
    return jsonResponse(
      errorEnvelope("Invalid relationship ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const url = new URL(request.url);
  const outcomeFilter = url.searchParams.get("outcome") ?? undefined;

  if (outcomeFilter && !isValidOutcome(outcomeFilter)) {
    return jsonResponse(
      errorEnvelope(
        `Invalid outcome filter: ${outcomeFilter}. Must be one of: ${INTERACTION_OUTCOMES.join(", ")}`,
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{
      items: unknown[] | null;
    }>(env.USER_GRAPH, auth.userId, "/listOutcomes", {
      relationship_id: relationshipId,
      outcome: outcomeFilter,
    });

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to list outcomes", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    if (result.data.items === null) {
      return jsonResponse(
        errorEnvelope("Relationship not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope(result.data.items), 200);
  } catch (err) {
    console.error("Failed to list outcomes", err);
    return jsonResponse(
      errorEnvelope("Failed to list outcomes", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- Reputation scoring (Phase 4) -------------------------------------------

async function handleGetReputation(
  _request: Request,
  auth: AuthContext,
  env: Env,
  relationshipId: string,
): Promise<Response> {
  if (!isValidId(relationshipId, "relationship")) {
    return jsonResponse(
      errorEnvelope("Invalid relationship ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{
      reliability_score: number;
      reciprocity_score: number;
      total_interactions: number;
      last_30_days: number;
      computed_at: string;
    } | null>(env.USER_GRAPH, auth.userId, "/getReputation", {
      relationship_id: relationshipId,
    });

    if (!result.ok) {
      const errorData = result.data as unknown as { error?: string };
      return jsonResponse(
        errorEnvelope(errorData.error ?? "Failed to get reputation", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    if (!result.data) {
      return jsonResponse(
        errorEnvelope("Relationship not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to get reputation", err);
    return jsonResponse(
      errorEnvelope("Failed to get reputation", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleListRelationshipsWithReputation(
  _request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    const result = await callDO<{
      items: unknown[];
    }>(env.USER_GRAPH, auth.userId, "/listRelationshipsWithReputation", {});

    if (!result.ok) {
      const errorData = result.data as unknown as { error?: string };
      return jsonResponse(
        errorEnvelope(errorData.error ?? "Failed to list relationships with reputation", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data.items), 200);
  } catch (err) {
    console.error("Failed to list relationships with reputation", err);
    return jsonResponse(
      errorEnvelope("Failed to list relationships with reputation", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ---------------------------------------------------------------------------
// Drift, reconnection, and trip handlers
// ---------------------------------------------------------------------------

async function handleGetDriftReport(
  _request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    const result = await callDO<unknown>(
      env.USER_GRAPH,
      auth.userId,
      "/getDriftReport",
      {},
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to get drift report", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to get drift report", err);
    return jsonResponse(
      errorEnvelope("Failed to get drift report", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleGetDriftAlerts(
  _request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    const result = await callDO<unknown>(
      env.USER_GRAPH,
      auth.userId,
      "/getDriftAlerts",
      {},
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to get drift alerts", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to get drift alerts", err);
    return jsonResponse(
      errorEnvelope("Failed to get drift alerts", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- Reconnection suggestions -----------------------------------------------

/**
 * GET /v1/trips/:trip_id/reconnections
 *
 * Dedicated REST route for trip-scoped reconnection suggestions.
 * Resolves the trip constraint by ID from the URL path and returns
 * overdue contacts in the trip's destination city.
 */
async function handleGetTripReconnections(
  request: Request,
  auth: AuthContext,
  env: Env,
  tripId: string,
): Promise<Response> {
  try {
    const result = await callDO<unknown>(
      env.USER_GRAPH,
      auth.userId,
      "/getReconnectionSuggestions",
      { city: null, trip_id: tripId },
    );

    if (!result.ok) {
      const errData = result.data as { message?: string };
      return jsonResponse(
        errorEnvelope(
          errData.message ?? "Failed to get reconnection suggestions for trip",
          "INTERNAL_ERROR",
        ),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to get trip reconnection suggestions", err);
    return jsonResponse(
      errorEnvelope("Failed to get reconnection suggestions for trip", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleGetReconnectionSuggestions(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const tripId = url.searchParams.get("trip_id") || null;
    const city = url.searchParams.get("city") || null;

    if (!tripId && !city) {
      return jsonResponse(
        errorEnvelope(
          "Either trip_id or city query parameter is required",
          "VALIDATION_ERROR",
        ),
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const result = await callDO<unknown>(
      env.USER_GRAPH,
      auth.userId,
      "/getReconnectionSuggestions",
      { city, trip_id: tripId },
    );

    if (!result.ok) {
      const errData = result.data as { message?: string };
      return jsonResponse(
        errorEnvelope(
          errData.message ?? "Failed to get reconnection suggestions",
          "INTERNAL_ERROR",
        ),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to get reconnection suggestions", err);
    return jsonResponse(
      errorEnvelope("Failed to get reconnection suggestions", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

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

