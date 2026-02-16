/**
 * Interaction ledger (outcomes) handlers: mark outcome, list outcomes.
 *
 * Extracted from relationships.ts for single-responsibility decomposition.
 */

import { isValidId, isValidOutcome, INTERACTION_OUTCOMES } from "@tminus/shared";
import {
  type AuthContext,
  callDO,
  parseJsonBody,
  jsonResponse,
  successEnvelope,
  errorEnvelope,
  ErrorCode,
} from "../../shared";

// ---------------------------------------------------------------------------
// Mark outcome
// ---------------------------------------------------------------------------

export async function handleMarkOutcome(
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

// ---------------------------------------------------------------------------
// List outcomes
// ---------------------------------------------------------------------------

export async function handleListOutcomes(
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
