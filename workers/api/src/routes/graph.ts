/**
 * Temporal Graph API route handlers.
 *
 * Pure query formatting functions for the graph API endpoints:
 * - GET /v1/graph/events -- events with metadata
 * - GET /v1/graph/relationships -- relationship graph with reputation
 * - GET /v1/graph/timeline -- interaction timeline
 * - GET /v1/graph/openapi.json -- OpenAPI documentation
 *
 * These functions are pure (no side effects, no DO calls). The route handlers
 * in index.ts call the DO, then use these functions to format/filter results.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input: CanonicalEvent shape from DO (subset of fields we use). */
export interface GraphEventInput {
  canonical_event_id: string;
  title?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  [key: string]: unknown;
}

/** Output: formatted graph event. */
export interface GraphEvent {
  canonical_event_id: string;
  title: string | null;
  start: string;
  end: string;
  category: string | null;
  participants: string[];
}

/** Input: relationship with reputation from DO. */
export interface GraphRelationshipInput {
  relationship_id: string;
  participant_hash: string;
  display_name: string | null;
  category: string;
  last_interaction_ts: string | null;
  reputation: {
    reliability_score: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Output: formatted graph relationship. */
export interface GraphRelationship {
  relationship_id: string;
  participant_hash: string;
  display_name: string | null;
  category: string;
  reputation: number;
  drift_days: number | null;
}

/** Input: ledger entry from DO. */
export interface TimelineEntryInput {
  ledger_id: string;
  participant_hash: string;
  canonical_event_id: string | null;
  outcome: string;
  weight: number;
  note: string | null;
  ts: string;
}

/** Output: formatted timeline entry. */
export interface TimelineEntry {
  ledger_id: string;
  canonical_event_id: string | null;
  participant_hash: string;
  outcome: string;
  timestamp: string;
  note: string | null;
}

/** Filter options for graph events. */
export interface GraphEventFilters {
  start_date?: string;
  end_date?: string;
  category?: string;
}

/** Filter options for graph relationships. */
export interface GraphRelationshipFilters {
  category?: string;
}

/** Filter options for timeline. */
export interface TimelineFilters {
  participant_hash?: string;
  start_date?: string;
  end_date?: string;
}

// ---------------------------------------------------------------------------
// Pure formatting functions
// ---------------------------------------------------------------------------

/**
 * Format a canonical event into graph-enriched form.
 *
 * Extracts title, start, end from the event. Adds participants and optional
 * billing category. Start/end are resolved from dateTime or date fields.
 */
export function formatGraphEvent(
  event: GraphEventInput,
  participants: string[],
  category?: string | null,
): GraphEvent {
  return {
    canonical_event_id: event.canonical_event_id,
    title: (event.title as string) ?? null,
    start: event.start.dateTime ?? event.start.date ?? "",
    end: event.end.dateTime ?? event.end.date ?? "",
    category: category ?? null,
    participants,
  };
}

/**
 * Format a relationship with reputation into graph form.
 *
 * Extracts the reliability_score as the reputation number.
 * Computes drift_days from last_interaction_ts relative to asOf (or now).
 */
export function formatGraphRelationship(
  rel: GraphRelationshipInput,
  asOf?: string,
): GraphRelationship {
  let driftDays: number | null = null;

  if (rel.last_interaction_ts) {
    const now = asOf ? new Date(asOf) : new Date();
    const last = new Date(rel.last_interaction_ts);
    const diffMs = now.getTime() - last.getTime();
    driftDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  }

  return {
    relationship_id: rel.relationship_id,
    participant_hash: rel.participant_hash,
    display_name: rel.display_name,
    category: rel.category,
    reputation: rel.reputation.reliability_score,
    drift_days: driftDays,
  };
}

/**
 * Format a ledger entry into timeline form.
 *
 * Maps ts -> timestamp for API consistency.
 */
export function formatTimelineEntry(entry: TimelineEntryInput): TimelineEntry {
  return {
    ledger_id: entry.ledger_id,
    canonical_event_id: entry.canonical_event_id,
    participant_hash: entry.participant_hash,
    outcome: entry.outcome,
    timestamp: entry.ts,
    note: entry.note,
  };
}

// ---------------------------------------------------------------------------
// Pure filtering functions
// ---------------------------------------------------------------------------

/**
 * Filter graph events by date range and/or category.
 *
 * - start_date: only events whose start >= start_date (ISO date string)
 * - end_date: only events whose start <= end_date (ISO date string, compared as end of day)
 * - category: only events matching the given billing category
 */
export function filterGraphEvents(
  events: GraphEvent[],
  filters: GraphEventFilters,
): GraphEvent[] {
  let result = events;

  if (filters.start_date) {
    const startDate = filters.start_date;
    result = result.filter((e) => e.start >= startDate);
  }

  if (filters.end_date) {
    // Compare start against end_date (events that start before end of the filter day)
    const endDate = filters.end_date;
    result = result.filter((e) => e.start <= endDate + "T23:59:59Z");
  }

  if (filters.category) {
    result = result.filter((e) => e.category === filters.category);
  }

  return result;
}

/**
 * Filter graph relationships by category.
 */
export function filterGraphRelationships(
  relationships: GraphRelationship[],
  filters: GraphRelationshipFilters,
): GraphRelationship[] {
  if (!filters.category) return relationships;
  return relationships.filter((r) => r.category === filters.category);
}

/**
 * Filter timeline entries by participant_hash and/or date range.
 */
export function filterTimeline(
  entries: TimelineEntry[],
  filters: TimelineFilters,
): TimelineEntry[] {
  let result = entries;

  if (filters.participant_hash) {
    result = result.filter((e) => e.participant_hash === filters.participant_hash);
  }

  if (filters.start_date) {
    const startDate = filters.start_date;
    result = result.filter((e) => e.timestamp >= startDate);
  }

  if (filters.end_date) {
    const endDate = filters.end_date;
    result = result.filter((e) => e.timestamp <= endDate + "T23:59:59Z");
  }

  return result;
}

// ---------------------------------------------------------------------------
// OpenAPI spec
// ---------------------------------------------------------------------------

/**
 * Build the OpenAPI 3.0 specification for the Temporal Graph API endpoints.
 *
 * Returns a static JSON object describing the graph endpoints, their
 * parameters, and response shapes. Includes bearerAuth security scheme.
 */
export function buildGraphOpenApiSpec(): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: {
      title: "T-Minus Temporal Graph API",
      description:
        "External API for third-party integrations. Exposes temporal and relationship data via structured REST endpoints.",
      version: "1.0.0",
    },
    servers: [
      { url: "https://api.tminus.ink", description: "Production" },
      { url: "https://api-staging.tminus.ink", description: "Staging" },
    ],
    security: [{ bearerAuth: [] }],
    paths: {
      "/v1/graph/events": {
        get: {
          summary: "List graph events",
          description:
            "Returns events enriched with participant hashes and billing category. Supports filtering by date range and category.",
          operationId: "listGraphEvents",
          tags: ["Graph"],
          parameters: [
            {
              name: "start_date",
              in: "query",
              description: "Filter events starting on or after this date (ISO 8601 date, e.g. 2026-02-15)",
              schema: { type: "string", format: "date" },
            },
            {
              name: "end_date",
              in: "query",
              description: "Filter events starting on or before this date (ISO 8601 date, e.g. 2026-02-28)",
              schema: { type: "string", format: "date" },
            },
            {
              name: "category",
              in: "query",
              description: "Filter by billing category (e.g. CLIENT, FRIEND, INVESTOR)",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      data: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            canonical_event_id: { type: "string" },
                            title: { type: "string", nullable: true },
                            start: { type: "string" },
                            end: { type: "string" },
                            category: { type: "string", nullable: true },
                            participants: {
                              type: "array",
                              items: { type: "string" },
                            },
                          },
                        },
                      },
                      meta: {
                        type: "object",
                        properties: {
                          request_id: { type: "string" },
                          timestamp: { type: "string", format: "date-time" },
                        },
                      },
                    },
                  },
                },
              },
            },
            "401": { description: "Authentication required" },
            "429": { description: "Rate limit exceeded" },
          },
        },
      },
      "/v1/graph/relationships": {
        get: {
          summary: "Query relationship graph",
          description:
            "Returns the relationship graph with reputation scores and drift days. Supports filtering by category.",
          operationId: "listGraphRelationships",
          tags: ["Graph"],
          parameters: [
            {
              name: "category",
              in: "query",
              description: "Filter by relationship category (e.g. COLLEAGUE, INVESTOR, FAMILY)",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      data: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            relationship_id: { type: "string" },
                            participant_hash: { type: "string" },
                            display_name: { type: "string", nullable: true },
                            category: { type: "string" },
                            reputation: { type: "number" },
                            drift_days: { type: "integer", nullable: true },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "401": { description: "Authentication required" },
            "429": { description: "Rate limit exceeded" },
          },
        },
      },
      "/v1/graph/timeline": {
        get: {
          summary: "Get interaction timeline",
          description:
            "Returns the interaction history across all relationships. Shows meeting outcomes chronologically. Supports filtering by participant and date range.",
          operationId: "getGraphTimeline",
          tags: ["Graph"],
          parameters: [
            {
              name: "participant_hash",
              in: "query",
              description: "Filter by participant hash",
              schema: { type: "string" },
            },
            {
              name: "start_date",
              in: "query",
              description: "Filter entries on or after this date (ISO 8601 date)",
              schema: { type: "string", format: "date" },
            },
            {
              name: "end_date",
              in: "query",
              description: "Filter entries on or before this date (ISO 8601 date)",
              schema: { type: "string", format: "date" },
            },
          ],
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                      data: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            ledger_id: { type: "string" },
                            canonical_event_id: { type: "string", nullable: true },
                            participant_hash: { type: "string" },
                            outcome: { type: "string" },
                            timestamp: { type: "string", format: "date-time" },
                            note: { type: "string", nullable: true },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            "401": { description: "Authentication required" },
            "429": { description: "Rate limit exceeded" },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "JWT token or API key (tmk_...) passed as Bearer token",
        },
      },
    },
  };
}
