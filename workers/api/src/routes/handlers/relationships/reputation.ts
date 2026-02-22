/**
 * Reputation scoring, drift reporting, and reconnection suggestion handlers.
 *
 * Extracted from relationships.ts for single-responsibility decomposition.
 */

import { isValidId } from "@tminus/shared";
import {
  type AuthContext,
  callDO,
  jsonResponse,
  successEnvelope,
  errorEnvelope,
  ErrorCode,
} from "../../shared";

// ---------------------------------------------------------------------------
// Reputation scoring (Phase 4)
// ---------------------------------------------------------------------------

export async function handleGetReputation(
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

export async function handleListRelationshipsWithReputation(
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
// Drift reporting
// ---------------------------------------------------------------------------

export async function handleGetDriftReport(
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

export async function handleGetDriftAlerts(
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

// ---------------------------------------------------------------------------
// Reconnection suggestions
// ---------------------------------------------------------------------------

/**
 * GET /v1/trips/:trip_id/reconnections
 *
 * Dedicated REST route for trip-scoped reconnection suggestions.
 * Resolves the trip constraint by ID from the URL path and returns
 * overdue contacts in the trip's destination city.
 */
export async function handleGetTripReconnections(
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

export async function handleGetReconnectionSuggestions(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const tripId = url.searchParams.get("trip_id") || null;
    const city = url.searchParams.get("city") || null;

    // Both params are optional -- when neither is provided, all suggestions
    // are returned (dashboard / Reconnections page use case).
    const result = await callDO<{
      suggestions: unknown[];
    }>(
      env.USER_GRAPH,
      auth.userId,
      "/getReconnectionSuggestions",
      { city, trip_id: tripId },
    );

    if (!result.ok) {
      const errData = result.data as unknown as { message?: string };
      return jsonResponse(
        errorEnvelope(
          errData.message ?? "Failed to get reconnection suggestions",
          "INTERNAL_ERROR",
        ),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    // Return the flat suggestions array (frontend expects ReconnectionSuggestionFull[])
    return jsonResponse(successEnvelope(result.data.suggestions), 200);
  } catch (err) {
    console.error("Failed to get reconnection suggestions", err);
    return jsonResponse(
      errorEnvelope("Failed to get reconnection suggestions", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}
