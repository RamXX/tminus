/**
 * Milestone CRUD + upcoming milestones handlers (Phase 4B).
 *
 * Extracted from relationships.ts for single-responsibility decomposition.
 */

import { isValidId, generateId, isValidMilestoneKind, isValidMilestoneDate, MILESTONE_KINDS } from "@tminus/shared";
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
// Create milestone
// ---------------------------------------------------------------------------

export async function handleCreateMilestone(
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

// ---------------------------------------------------------------------------
// List milestones
// ---------------------------------------------------------------------------

export async function handleListMilestones(
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

// ---------------------------------------------------------------------------
// Delete milestone
// ---------------------------------------------------------------------------

export async function handleDeleteMilestone(
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

// ---------------------------------------------------------------------------
// List upcoming milestones
// ---------------------------------------------------------------------------

export async function handleListUpcomingMilestones(
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
