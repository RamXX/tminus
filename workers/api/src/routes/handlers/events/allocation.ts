/**
 * Time allocation CRUD handlers: set, get, update, delete allocations.
 *
 * Extracted from events.ts for single-responsibility decomposition.
 */

import { isValidId, generateId, isValidBillingCategory, BILLING_CATEGORIES } from "@tminus/shared";
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
// Set (create) allocation
// ---------------------------------------------------------------------------

export async function handleSetAllocation(
  request: Request,
  auth: AuthContext,
  env: Env,
  eventId: string,
): Promise<Response> {
  if (!isValidId(eventId, "event")) {
    return jsonResponse(
      errorEnvelope("Invalid event ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const body = await parseJsonBody<{
    billing_category?: string;
    client_id?: string;
    rate?: number;
  }>(request);

  if (!body) {
    return jsonResponse(
      errorEnvelope("Request body must be valid JSON", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!body.billing_category || typeof body.billing_category !== "string") {
    return jsonResponse(
      errorEnvelope("billing_category is required", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!isValidBillingCategory(body.billing_category)) {
    return jsonResponse(
      errorEnvelope(
        `Invalid billing_category: ${body.billing_category}. Must be one of: ${BILLING_CATEGORIES.join(", ")}`,
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (body.rate !== undefined && body.rate !== null) {
    if (typeof body.rate !== "number" || body.rate < 0) {
      return jsonResponse(
        errorEnvelope("rate must be a non-negative number", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  try {
    const allocationId = generateId("allocation");
    const result = await callDO<{
      allocation_id: string;
      canonical_event_id: string;
      client_id: string | null;
      billing_category: string;
      rate: number | null;
      confidence: string;
      locked: boolean;
      created_at: string;
    }>(env.USER_GRAPH, auth.userId, "/createAllocation", {
      allocation_id: allocationId,
      canonical_event_id: eventId,
      billing_category: body.billing_category,
      client_id: body.client_id ?? null,
      rate: body.rate ?? null,
    });

    if (!result.ok) {
      const errorData = result.data as { error?: string };
      const errorMsg = errorData.error ?? "Failed to create allocation";
      // Check if it's a "not found" or "already exists" error
      if (errorMsg.includes("not found")) {
        return jsonResponse(
          errorEnvelope(errorMsg, "NOT_FOUND"),
          ErrorCode.NOT_FOUND,
        );
      }
      if (errorMsg.includes("already exists")) {
        return jsonResponse(
          errorEnvelope(errorMsg, "CONFLICT"),
          ErrorCode.CONFLICT,
        );
      }
      return jsonResponse(
        errorEnvelope(errorMsg, "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 201);
  } catch (err) {
    console.error("Failed to create allocation", err);
    return jsonResponse(
      errorEnvelope("Failed to create allocation", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ---------------------------------------------------------------------------
// Get allocation
// ---------------------------------------------------------------------------

export async function handleGetAllocation(
  _request: Request,
  auth: AuthContext,
  env: Env,
  eventId: string,
): Promise<Response> {
  if (!isValidId(eventId, "event")) {
    return jsonResponse(
      errorEnvelope("Invalid event ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{
      allocation_id: string;
      canonical_event_id: string;
      client_id: string | null;
      billing_category: string;
      rate: number | null;
      confidence: string;
      locked: boolean;
      created_at: string;
    } | null>(env.USER_GRAPH, auth.userId, "/getAllocation", {
      canonical_event_id: eventId,
    });

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to get allocation", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    if (result.data === null) {
      return jsonResponse(
        errorEnvelope("No allocation found for this event", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to get allocation", err);
    return jsonResponse(
      errorEnvelope("Failed to get allocation", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ---------------------------------------------------------------------------
// Update allocation
// ---------------------------------------------------------------------------

export async function handleUpdateAllocation(
  request: Request,
  auth: AuthContext,
  env: Env,
  eventId: string,
): Promise<Response> {
  if (!isValidId(eventId, "event")) {
    return jsonResponse(
      errorEnvelope("Invalid event ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const body = await parseJsonBody<{
    billing_category?: string;
    client_id?: string | null;
    rate?: number | null;
  }>(request);

  if (!body) {
    return jsonResponse(
      errorEnvelope("Request body must be valid JSON", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (body.billing_category !== undefined) {
    if (!isValidBillingCategory(body.billing_category)) {
      return jsonResponse(
        errorEnvelope(
          `Invalid billing_category: ${body.billing_category}. Must be one of: ${BILLING_CATEGORIES.join(", ")}`,
          "VALIDATION_ERROR",
        ),
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  if (body.rate !== undefined && body.rate !== null) {
    if (typeof body.rate !== "number" || body.rate < 0) {
      return jsonResponse(
        errorEnvelope("rate must be a non-negative number", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  try {
    const result = await callDO<{
      allocation_id: string;
      canonical_event_id: string;
      client_id: string | null;
      billing_category: string;
      rate: number | null;
      confidence: string;
      locked: boolean;
      created_at: string;
    } | null>(env.USER_GRAPH, auth.userId, "/updateAllocation", {
      canonical_event_id: eventId,
      updates: {
        billing_category: body.billing_category,
        client_id: body.client_id,
        rate: body.rate,
      },
    });

    if (!result.ok) {
      const errorData = result.data as { error?: string };
      return jsonResponse(
        errorEnvelope(errorData.error ?? "Failed to update allocation", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    if (result.data === null) {
      return jsonResponse(
        errorEnvelope("No allocation found for this event", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to update allocation", err);
    return jsonResponse(
      errorEnvelope("Failed to update allocation", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ---------------------------------------------------------------------------
// Delete allocation
// ---------------------------------------------------------------------------

export async function handleDeleteAllocation(
  _request: Request,
  auth: AuthContext,
  env: Env,
  eventId: string,
): Promise<Response> {
  if (!isValidId(eventId, "event")) {
    return jsonResponse(
      errorEnvelope("Invalid event ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{ deleted: boolean }>(
      env.USER_GRAPH,
      auth.userId,
      "/deleteAllocation",
      { canonical_event_id: eventId },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to delete allocation", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    if (!result.data.deleted) {
      return jsonResponse(
        errorEnvelope("No allocation found for this event", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope({ deleted: true }), 200);
  } catch (err) {
    console.error("Failed to delete allocation", err);
    return jsonResponse(
      errorEnvelope("Failed to delete allocation", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}
