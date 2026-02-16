/**
 * Route group: Temporal Graph API (TM-b3i.4).
 */

import {
  formatGraphEvent,
  formatGraphRelationship,
  formatTimelineEntry,
  filterGraphEvents,
  filterGraphRelationships,
  filterTimeline,
  buildGraphOpenApiSpec,
} from "../graph";
import type { GraphEventInput, GraphRelationshipInput, TimelineEntryInput } from "../graph";
import {
  type RouteGroupHandler,
  type AuthContext,
  callDO,
  jsonResponse,
  successEnvelope,
  errorEnvelope,
  ErrorCode,
} from "../shared";

// ---------------------------------------------------------------------------
// Graph handlers
// ---------------------------------------------------------------------------

async function handleGraphEvents(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const startDate = url.searchParams.get("start_date") ?? undefined;
  const endDate = url.searchParams.get("end_date") ?? undefined;
  const categoryFilter = url.searchParams.get("category") ?? undefined;

  try {
    // Build DO query with date filters
    const query: Record<string, unknown> = {};
    if (startDate) query.time_min = startDate;
    if (endDate) query.time_max = endDate + "T23:59:59Z";

    // Fetch events from DO
    const eventsResult = await callDO<{
      items: GraphEventInput[];
      cursor: string | null;
      has_more: boolean;
    }>(env.USER_GRAPH, auth.userId, "/listCanonicalEvents", query);

    if (!eventsResult.ok) {
      return jsonResponse(
        errorEnvelope("Failed to list graph events", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    // Enrich each event with participants and category
    const enriched = await Promise.all(
      eventsResult.data.items.map(async (event) => {
        // Get participant hashes
        let participants: string[] = [];
        try {
          const partResult = await callDO<{ hashes: string[] }>(
            env.USER_GRAPH,
            auth.userId,
            "/getEventParticipantHashes",
            { canonical_event_id: event.canonical_event_id },
          );
          if (partResult.ok) {
            participants = partResult.data.hashes ?? [];
          }
        } catch {
          // Non-fatal: event without participants still works
        }

        // Get billing category from allocation (if exists)
        let category: string | null = null;
        try {
          const allocResult = await callDO<{
            allocation: { billing_category: string } | null;
          }>(
            env.USER_GRAPH,
            auth.userId,
            "/getAllocation",
            { canonical_event_id: event.canonical_event_id },
          );
          if (allocResult.ok && allocResult.data.allocation) {
            category = allocResult.data.allocation.billing_category;
          }
        } catch {
          // Non-fatal: events without allocations get null category
        }

        return formatGraphEvent(event, participants, category);
      }),
    );

    // Apply client-side category filter (must be done after enrichment)
    const filtered = filterGraphEvents(enriched, {
      category: categoryFilter,
    });

    return jsonResponse(successEnvelope(filtered), 200);
  } catch (err) {
    console.error("Failed to list graph events", err);
    return jsonResponse(
      errorEnvelope("Failed to list graph events", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

/**
 * GET /v1/graph/relationships -- Relationship graph with reputation and drift.
 *
 * Queries UserGraphDO for relationships with computed reputation scores,
 * then formats with drift_days computation.
 */
async function handleGraphRelationships(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const categoryFilter = url.searchParams.get("category") ?? undefined;

  try {
    const result = await callDO<{
      items: GraphRelationshipInput[];
    }>(env.USER_GRAPH, auth.userId, "/listRelationshipsWithReputation", {});

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to list graph relationships", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    const formatted = (result.data.items ?? []).map((rel) =>
      formatGraphRelationship(rel),
    );

    const filtered = filterGraphRelationships(formatted, {
      category: categoryFilter,
    });

    return jsonResponse(successEnvelope(filtered), 200);
  } catch (err) {
    console.error("Failed to list graph relationships", err);
    return jsonResponse(
      errorEnvelope("Failed to list graph relationships", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

/**
 * GET /v1/graph/timeline -- Interaction timeline across all relationships.
 *
 * Queries UserGraphDO for the interaction ledger with optional
 * participant_hash and date range filters.
 */
async function handleGraphTimeline(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const participantHash = url.searchParams.get("participant_hash") ?? undefined;
  const startDate = url.searchParams.get("start_date") ?? undefined;
  const endDate = url.searchParams.get("end_date") ?? undefined;

  try {
    const result = await callDO<{
      items: TimelineEntryInput[];
    }>(env.USER_GRAPH, auth.userId, "/getTimeline", {
      participant_hash: participantHash ?? null,
      start_date: startDate ?? null,
      end_date: endDate ?? null,
    });

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to get timeline", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    const formatted = (result.data.items ?? []).map((entry) =>
      formatTimelineEntry(entry),
    );

    // Client-side filtering for any additional filters not handled by DO
    const filtered = filterTimeline(formatted, {
      participant_hash: participantHash,
      start_date: startDate,
      end_date: endDate,
    });

    return jsonResponse(successEnvelope(filtered), 200);
  } catch (err) {
    console.error("Failed to get timeline", err);
    return jsonResponse(
      errorEnvelope("Failed to get timeline", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

/**
 * GET /v1/graph/openapi.json -- OpenAPI documentation for graph endpoints.
 *
 * Returns the static OpenAPI spec wrapped in the standard API envelope.
 */
function handleGraphOpenApi(): Response {
  const spec = buildGraphOpenApiSpec();
  return jsonResponse(successEnvelope(spec), 200);
}

// ---------------------------------------------------------------------------
// Route group: Graph
// ---------------------------------------------------------------------------

export const routeGraphRoutes: RouteGroupHandler = async (request, method, pathname, auth, env) => {
  if (method === "GET" && pathname === "/v1/graph/events") {
    return handleGraphEvents(request, auth, env);
  }

  if (method === "GET" && pathname === "/v1/graph/relationships") {
    return handleGraphRelationships(request, auth, env);
  }

  if (method === "GET" && pathname === "/v1/graph/timeline") {
    return handleGraphTimeline(request, auth, env);
  }

  if (method === "GET" && pathname === "/v1/graph/openapi.json") {
    return handleGraphOpenApi();
  }

  return null;
};

