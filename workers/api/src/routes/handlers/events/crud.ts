/**
 * Event CRUD handlers: list, get, create, update, delete.
 *
 * Extracted from events.ts for single-responsibility decomposition.
 */

import { isValidId } from "@tminus/shared";
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
// List events
// ---------------------------------------------------------------------------

export async function handleListEvents(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const query: Record<string, unknown> = {};

  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  const accountIdFilter = url.searchParams.get("account_id");
  const cursor = url.searchParams.get("cursor");
  const limitStr = url.searchParams.get("limit");
  const originEventId = url.searchParams.get("origin_event_id");
  const updatedAfter = url.searchParams.get("updated_after");
  const provider = url.searchParams.get("provider");

  if (start) query.time_min = start;
  if (end) query.time_max = end;
  if (accountIdFilter) query.origin_account_id = accountIdFilter;
  if (cursor) query.cursor = cursor;
  if (limitStr) {
    const limit = parseInt(limitStr, 10);
    if (!isNaN(limit) && limit > 0) query.limit = limit;
  }
  if (originEventId) query.origin_event_id = originEventId;
  if (updatedAfter) query.updated_after = updatedAfter;
  if (provider) query.source = provider;

  try {
    const result = await callDO<{
      items: unknown[];
      cursor: string | null;
      has_more: boolean;
    }>(env.USER_GRAPH, auth.userId, "/listCanonicalEvents", query);

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to list events", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(
      successEnvelope(result.data.items, {
        next_cursor: result.data.cursor ?? undefined,
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to list events", err);
    return jsonResponse(
      errorEnvelope("Failed to list events", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ---------------------------------------------------------------------------
// Get event
// ---------------------------------------------------------------------------

export async function handleGetEvent(
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
      event: unknown;
      mirrors: unknown[];
    } | null>(env.USER_GRAPH, auth.userId, "/getCanonicalEvent", {
      canonical_event_id: eventId,
    });

    if (!result.ok || result.data === null) {
      return jsonResponse(
        errorEnvelope("Event not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to get event", err);
    return jsonResponse(
      errorEnvelope("Failed to get event", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ---------------------------------------------------------------------------
// Create event
// ---------------------------------------------------------------------------

export async function handleCreateEvent(
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

  // Basic validation: must have start and end
  if (!body.start || !body.end) {
    return jsonResponse(
      errorEnvelope("Event must have start and end", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<string>(
      env.USER_GRAPH,
      auth.userId,
      "/upsertCanonicalEvent",
      { event: body, source: "api" },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to create event", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(
      successEnvelope({ canonical_event_id: result.data }),
      201,
    );
  } catch (err) {
    console.error("Failed to create event", err);
    return jsonResponse(
      errorEnvelope("Failed to create event", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ---------------------------------------------------------------------------
// Update event
// ---------------------------------------------------------------------------

export async function handleUpdateEvent(
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

  const body = await parseJsonBody<Record<string, unknown>>(request);
  if (!body) {
    return jsonResponse(
      errorEnvelope("Request body must be valid JSON", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    // Merge the event ID into the body for the upsert
    const event = { ...body, canonical_event_id: eventId };
    const result = await callDO<string>(
      env.USER_GRAPH,
      auth.userId,
      "/upsertCanonicalEvent",
      { event, source: "api" },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to update event", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(
      successEnvelope({ canonical_event_id: result.data }),
      200,
    );
  } catch (err) {
    console.error("Failed to update event", err);
    return jsonResponse(
      errorEnvelope("Failed to update event", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ---------------------------------------------------------------------------
// Delete event
// ---------------------------------------------------------------------------

export async function handleDeleteEvent(
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
    const result = await callDO<boolean>(
      env.USER_GRAPH,
      auth.userId,
      "/deleteCanonicalEvent",
      { canonical_event_id: eventId, source: "api" },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to delete event", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    if (!result.data) {
      return jsonResponse(
        errorEnvelope("Event not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope({ deleted: true }), 200);
  } catch (err) {
    console.error("Failed to delete event", err);
    return jsonResponse(
      errorEnvelope("Failed to delete event", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}
