/**
 * Relationship CRUD handlers: create, get, list, update, delete.
 *
 * Extracted from relationships.ts for single-responsibility decomposition.
 */

import { isValidId, generateId, isValidRelationshipCategory, RELATIONSHIP_CATEGORIES } from "@tminus/shared";
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
// Create relationship
// ---------------------------------------------------------------------------

export async function handleCreateRelationship(
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

// ---------------------------------------------------------------------------
// Get relationship
// ---------------------------------------------------------------------------

export async function handleGetRelationship(
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

// ---------------------------------------------------------------------------
// List relationships
// ---------------------------------------------------------------------------

export async function handleListRelationships(
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

// ---------------------------------------------------------------------------
// Update relationship
// ---------------------------------------------------------------------------

export async function handleUpdateRelationship(
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

// ---------------------------------------------------------------------------
// Delete relationship
// ---------------------------------------------------------------------------

export async function handleDeleteRelationship(
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
