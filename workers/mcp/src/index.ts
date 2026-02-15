/**
 * tminus-mcp -- MCP (Model Context Protocol) server worker.
 *
 * Exposes calendar tools via JSON-RPC for AI agent consumption.
 * Implements a minimal MCP-compatible HTTP handler:
 *   POST /mcp  -- JSON-RPC endpoint (tools/list, tools/call)
 *   GET /health -- Health check
 *
 * Retro constraint: Worker entrypoint must NOT export constants,
 * types, or utilities (workerd restriction).
 */

import { extractMcpAuth } from "./auth";
import type { McpUserContext } from "./auth";
import {
  addSecurityHeaders,
  addCorsHeaders,
  buildPreflightResponse,
} from "@tminus/shared";

// ---------------------------------------------------------------------------
// Env type (local to worker -- not exported)
// ---------------------------------------------------------------------------

interface McpEnv {
  JWT_SECRET: string;
  DB: D1Database;
  ENVIRONMENT?: string;
}

// ---------------------------------------------------------------------------
// JSON-RPC types (local to worker -- not exported)
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: string;
  method: string;
  params?: Record<string, unknown>;
  id: string | number | null;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: JsonRpcError;
  id: string | number | null;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// MCP tool definitions (local to worker -- not exported)
// ---------------------------------------------------------------------------

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Registry of available MCP tools with their schemas. */
const TOOL_REGISTRY: McpToolDefinition[] = [
  {
    name: "calendar.list_accounts",
    description:
      "List all connected calendar accounts for the authenticated user. Returns account ID, provider, email, status, and channel status for each linked account.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "calendar.get_sync_status",
    description:
      "Get sync health status for the authenticated user's calendar accounts. Returns per-account health (healthy/degraded/stale/unhealthy/error) based on last sync time, plus an overall aggregate status. Optionally filter by account_id.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: {
          type: "string",
          description: "Optional account ID to filter to a single account.",
        },
      },
    },
  },
  {
    name: "calendar.list_events",
    description:
      "List events in a time range for the authenticated user. Returns events sorted by start time. Optionally filter by account_id and limit the number of results.",
    inputSchema: {
      type: "object",
      properties: {
        start: {
          type: "string",
          description: "Start of time range (ISO 8601 datetime, e.g. '2026-01-01T00:00:00Z').",
        },
        end: {
          type: "string",
          description: "End of time range (ISO 8601 datetime, e.g. '2026-12-31T23:59:59Z').",
        },
        account_id: {
          type: "string",
          description: "Optional account ID to filter events by originating account.",
        },
        limit: {
          type: "number",
          description: "Maximum number of events to return (default: 100, max: 500).",
        },
      },
      required: ["start", "end"],
    },
  },
  {
    name: "calendar.create_event",
    description:
      "Create a new calendar event for the authenticated user. Returns the created event with its event_id.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Event title/summary.",
        },
        start_ts: {
          type: "string",
          description: "Event start time (ISO 8601 datetime, e.g. '2026-03-15T09:00:00Z').",
        },
        end_ts: {
          type: "string",
          description: "Event end time (ISO 8601 datetime, e.g. '2026-03-15T10:00:00Z').",
        },
        timezone: {
          type: "string",
          description: "IANA timezone (e.g. 'America/Chicago'). Defaults to 'UTC'.",
        },
        description: {
          type: "string",
          description: "Event description/notes.",
        },
        location: {
          type: "string",
          description: "Event location (free-form text or address).",
        },
      },
      required: ["title", "start_ts", "end_ts"],
    },
  },
  {
    name: "calendar.update_event",
    description:
      "Update an existing calendar event. Only provided fields in the patch object are updated; omitted fields remain unchanged.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: {
          type: "string",
          description: "ID of the event to update.",
        },
        patch: {
          type: "object",
          description: "Fields to update. Only provided fields are changed.",
          properties: {
            title: { type: "string", description: "New event title." },
            start_ts: { type: "string", description: "New start time (ISO 8601)." },
            end_ts: { type: "string", description: "New end time (ISO 8601)." },
            description: { type: "string", description: "New description." },
            location: { type: "string", description: "New location." },
          },
        },
      },
      required: ["event_id", "patch"],
    },
  },
  {
    name: "calendar.delete_event",
    description:
      "Delete a calendar event by its event_id. The event is permanently removed.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: {
          type: "string",
          description: "ID of the event to delete.",
        },
      },
      required: ["event_id"],
    },
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC error codes (per spec)
// ---------------------------------------------------------------------------

/** Standard JSON-RPC error codes. */
const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;
/** Application-level error: authentication required. */
const RPC_AUTH_REQUIRED = -32000;

// ---------------------------------------------------------------------------
// Health status computation
// ---------------------------------------------------------------------------

/** Possible sync health statuses, from best to worst. */
type SyncHealth = "healthy" | "degraded" | "stale" | "unhealthy" | "error";

/** Thresholds for health computation (in milliseconds). */
const HEALTH_THRESHOLD_HEALTHY_MS = 60 * 60 * 1000;        // 1 hour
const HEALTH_THRESHOLD_DEGRADED_MS = 6 * 60 * 60 * 1000;   // 6 hours
const HEALTH_THRESHOLD_STALE_MS = 24 * 60 * 60 * 1000;     // 24 hours

/**
 * Compute sync health status for an account based on its status and
 * last sync timestamp. Pure function -- no side effects.
 *
 * Priority:
 *   1. status === 'error' -> "error"
 *   2. last_sync_ts is null (never synced) -> "unhealthy"
 *   3. Age of last sync determines healthy/degraded/stale/unhealthy
 *
 * @param accountStatus - The account's status column value.
 * @param lastSyncTs - ISO8601 timestamp of the last sync, or null.
 * @param nowMs - Current time in epoch ms (injectable for testing).
 */
function computeHealthStatus(
  accountStatus: string,
  lastSyncTs: string | null,
  nowMs: number,
): SyncHealth {
  if (accountStatus === "error") return "error";
  if (!lastSyncTs) return "unhealthy";

  const syncTime = new Date(lastSyncTs).getTime();
  if (isNaN(syncTime)) return "unhealthy";

  const ageMs = nowMs - syncTime;

  if (ageMs <= HEALTH_THRESHOLD_HEALTHY_MS) return "healthy";
  if (ageMs <= HEALTH_THRESHOLD_DEGRADED_MS) return "degraded";
  if (ageMs <= HEALTH_THRESHOLD_STALE_MS) return "stale";
  return "unhealthy";
}

/**
 * Derive the overall health status from an array of per-account statuses.
 * Returns the worst status found, or "healthy" if the array is empty.
 */
function computeOverallHealth(statuses: SyncHealth[]): SyncHealth {
  if (statuses.length === 0) return "healthy";

  // Ordered from worst to best; return the first one found
  const severity: SyncHealth[] = ["error", "unhealthy", "stale", "degraded", "healthy"];
  for (const level of severity) {
    if (statuses.includes(level)) return level;
  }
  return "healthy";
}

/**
 * Derive channel status from channel_id and channel_expiry_ts.
 * Returns "active", "expired", or "none".
 */
function computeChannelStatus(
  channelId: string | null,
  channelExpiryTs: string | null,
  nowMs: number,
): "active" | "expired" | "none" {
  if (!channelId) return "none";
  if (!channelExpiryTs) return "active"; // channel exists but no expiry means active
  const expiryTime = new Date(channelExpiryTs).getTime();
  if (isNaN(expiryTime)) return "active";
  return expiryTime > nowMs ? "active" : "expired";
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

/** Row shape returned by the list_accounts D1 query. */
interface AccountQueryRow {
  account_id: string;
  provider: string;
  email: string;
  status: string;
  channel_id: string | null;
  channel_expiry_ts: string | null;
}

/**
 * Execute calendar.list_accounts: query D1 for the authenticated user's
 * connected calendar accounts with channel status.
 */
async function handleListAccounts(
  user: McpUserContext,
  db: D1Database,
): Promise<unknown> {
  const nowMs = Date.now();
  const result = await db
    .prepare(
      "SELECT account_id, provider, email, status, channel_id, channel_expiry_ts FROM accounts WHERE user_id = ?1",
    )
    .bind(user.userId)
    .all<AccountQueryRow>();

  const accounts = result.results ?? [];
  return accounts.map((a) => ({
    account_id: a.account_id,
    provider: a.provider,
    email: a.email,
    status: a.status,
    channel_status: computeChannelStatus(a.channel_id, a.channel_expiry_ts, nowMs),
  }));
}

/** Row shape returned by the sync_status D1 query. */
interface SyncStatusQueryRow {
  account_id: string;
  provider: string;
  email: string;
  status: string;
  channel_id: string | null;
  channel_expiry_ts: string | null;
  last_sync_ts: string | null;
  error_count: number;
}

/**
 * Execute calendar.get_sync_status: query D1 for the authenticated user's
 * sync health across all (or a single) calendar account.
 */
async function handleGetSyncStatus(
  user: McpUserContext,
  db: D1Database,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const nowMs = Date.now();
  const accountIdFilter =
    params?.account_id && typeof params.account_id === "string"
      ? params.account_id
      : null;

  let result: { results: SyncStatusQueryRow[] };

  if (accountIdFilter) {
    result = await db
      .prepare(
        "SELECT account_id, provider, email, status, channel_id, channel_expiry_ts, last_sync_ts, error_count FROM accounts WHERE user_id = ?1 AND account_id = ?2",
      )
      .bind(user.userId, accountIdFilter)
      .all<SyncStatusQueryRow>();

    if (!result.results || result.results.length === 0) {
      throw new AccountNotFoundError(accountIdFilter);
    }
  } else {
    result = await db
      .prepare(
        "SELECT account_id, provider, email, status, channel_id, channel_expiry_ts, last_sync_ts, error_count FROM accounts WHERE user_id = ?1",
      )
      .bind(user.userId)
      .all<SyncStatusQueryRow>();
  }

  const accounts = result.results ?? [];
  const statuses: SyncHealth[] = [];

  const accountResults = accounts.map((a) => {
    const health = computeHealthStatus(a.status, a.last_sync_ts, nowMs);
    statuses.push(health);
    return {
      account_id: a.account_id,
      provider: a.provider,
      email: a.email,
      health,
      last_sync_ts: a.last_sync_ts,
      channel_status: computeChannelStatus(a.channel_id, a.channel_expiry_ts, nowMs),
      error_count: a.error_count ?? 0,
    };
  });

  return {
    overall: computeOverallHealth(statuses),
    accounts: accountResults,
  };
}

/** Application-level error for account not found. */
class AccountNotFoundError extends Error {
  constructor(accountId: string) {
    super(`Account not found: ${accountId}`);
    this.name = "AccountNotFoundError";
  }
}

/** Application-level error for event not found. */
class EventNotFoundError extends Error {
  constructor(eventId: string) {
    super(`Event not found: ${eventId}`);
    this.name = "EventNotFoundError";
  }
}

/** Application-level error for invalid input parameters. */
class InvalidParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidParamsError";
  }
}

// ---------------------------------------------------------------------------
// Event ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a unique event ID with evt_ prefix and random hex suffix.
 * Uses crypto.randomUUID() for uniqueness.
 */
function generateEventId(): string {
  const uuid = crypto.randomUUID().replace(/-/g, "");
  return `evt_${uuid}`;
}

// ---------------------------------------------------------------------------
// Input validation helpers (pure functions)
// ---------------------------------------------------------------------------

/**
 * Validate that a string is a parseable ISO 8601 datetime.
 * Returns true if the string produces a valid Date.
 */
function isValidIsoDatetime(value: string): boolean {
  const d = new Date(value);
  return !isNaN(d.getTime());
}

/**
 * Validate calendar.list_events input parameters.
 * Throws InvalidParamsError on validation failure.
 */
function validateListEventsParams(args: Record<string, unknown> | undefined): {
  start: string;
  end: string;
  account_id: string | null;
  limit: number;
} {
  if (!args) {
    throw new InvalidParamsError("Missing required parameters: start, end");
  }

  if (typeof args.start !== "string" || !args.start) {
    throw new InvalidParamsError("Parameter 'start' is required and must be an ISO 8601 datetime string");
  }
  if (!isValidIsoDatetime(args.start)) {
    throw new InvalidParamsError("Parameter 'start' is not a valid ISO 8601 datetime");
  }

  if (typeof args.end !== "string" || !args.end) {
    throw new InvalidParamsError("Parameter 'end' is required and must be an ISO 8601 datetime string");
  }
  if (!isValidIsoDatetime(args.end)) {
    throw new InvalidParamsError("Parameter 'end' is not a valid ISO 8601 datetime");
  }

  // Validate start < end
  if (new Date(args.start).getTime() >= new Date(args.end).getTime()) {
    throw new InvalidParamsError("Parameter 'start' must be before 'end'");
  }

  const account_id =
    args.account_id !== undefined && typeof args.account_id === "string"
      ? args.account_id
      : null;

  let limit = 100;
  if (args.limit !== undefined) {
    if (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1) {
      throw new InvalidParamsError("Parameter 'limit' must be a positive integer");
    }
    limit = Math.min(args.limit, 500);
  }

  return { start: args.start, end: args.end, account_id, limit };
}

/**
 * Validate calendar.create_event input parameters.
 * Throws InvalidParamsError on validation failure.
 */
function validateCreateEventParams(args: Record<string, unknown> | undefined): {
  title: string;
  start_ts: string;
  end_ts: string;
  timezone: string;
  description: string | null;
  location: string | null;
} {
  if (!args) {
    throw new InvalidParamsError("Missing required parameters: title, start_ts, end_ts");
  }

  if (typeof args.title !== "string" || !args.title.trim()) {
    throw new InvalidParamsError("Parameter 'title' is required and must be a non-empty string");
  }

  if (typeof args.start_ts !== "string" || !args.start_ts) {
    throw new InvalidParamsError("Parameter 'start_ts' is required and must be an ISO 8601 datetime string");
  }
  if (!isValidIsoDatetime(args.start_ts)) {
    throw new InvalidParamsError("Parameter 'start_ts' is not a valid ISO 8601 datetime");
  }

  if (typeof args.end_ts !== "string" || !args.end_ts) {
    throw new InvalidParamsError("Parameter 'end_ts' is required and must be an ISO 8601 datetime string");
  }
  if (!isValidIsoDatetime(args.end_ts)) {
    throw new InvalidParamsError("Parameter 'end_ts' is not a valid ISO 8601 datetime");
  }

  // Validate start < end
  if (new Date(args.start_ts).getTime() >= new Date(args.end_ts).getTime()) {
    throw new InvalidParamsError("Parameter 'start_ts' must be before 'end_ts'");
  }

  const timezone =
    args.timezone !== undefined && typeof args.timezone === "string"
      ? args.timezone
      : "UTC";

  const description =
    args.description !== undefined && typeof args.description === "string"
      ? args.description
      : null;

  const location =
    args.location !== undefined && typeof args.location === "string"
      ? args.location
      : null;

  return {
    title: args.title.trim(),
    start_ts: args.start_ts,
    end_ts: args.end_ts,
    timezone,
    description,
    location,
  };
}

/**
 * Validate calendar.update_event input parameters.
 * Throws InvalidParamsError on validation failure.
 */
function validateUpdateEventParams(args: Record<string, unknown> | undefined): {
  event_id: string;
  patch: {
    title?: string;
    start_ts?: string;
    end_ts?: string;
    description?: string;
    location?: string;
  };
} {
  if (!args) {
    throw new InvalidParamsError("Missing required parameters: event_id, patch");
  }

  if (typeof args.event_id !== "string" || !args.event_id) {
    throw new InvalidParamsError("Parameter 'event_id' is required and must be a non-empty string");
  }

  if (typeof args.patch !== "object" || args.patch === null || Array.isArray(args.patch)) {
    throw new InvalidParamsError("Parameter 'patch' is required and must be an object");
  }

  const rawPatch = args.patch as Record<string, unknown>;
  const patch: Record<string, string> = {};

  // Validate each optional patch field
  if (rawPatch.title !== undefined) {
    if (typeof rawPatch.title !== "string" || !rawPatch.title.trim()) {
      throw new InvalidParamsError("Patch field 'title' must be a non-empty string");
    }
    patch.title = rawPatch.title.trim();
  }

  if (rawPatch.start_ts !== undefined) {
    if (typeof rawPatch.start_ts !== "string") {
      throw new InvalidParamsError("Patch field 'start_ts' must be an ISO 8601 datetime string");
    }
    if (!isValidIsoDatetime(rawPatch.start_ts)) {
      throw new InvalidParamsError("Patch field 'start_ts' is not a valid ISO 8601 datetime");
    }
    patch.start_ts = rawPatch.start_ts;
  }

  if (rawPatch.end_ts !== undefined) {
    if (typeof rawPatch.end_ts !== "string") {
      throw new InvalidParamsError("Patch field 'end_ts' must be an ISO 8601 datetime string");
    }
    if (!isValidIsoDatetime(rawPatch.end_ts)) {
      throw new InvalidParamsError("Patch field 'end_ts' is not a valid ISO 8601 datetime");
    }
    patch.end_ts = rawPatch.end_ts;
  }

  if (rawPatch.description !== undefined) {
    if (typeof rawPatch.description !== "string") {
      throw new InvalidParamsError("Patch field 'description' must be a string");
    }
    patch.description = rawPatch.description;
  }

  if (rawPatch.location !== undefined) {
    if (typeof rawPatch.location !== "string") {
      throw new InvalidParamsError("Patch field 'location' must be a string");
    }
    patch.location = rawPatch.location;
  }

  // At least one field must be provided
  if (Object.keys(patch).length === 0) {
    throw new InvalidParamsError("Patch must contain at least one field to update");
  }

  return { event_id: args.event_id, patch };
}

/**
 * Validate calendar.delete_event input parameters.
 * Throws InvalidParamsError on validation failure.
 */
function validateDeleteEventParams(args: Record<string, unknown> | undefined): {
  event_id: string;
} {
  if (!args) {
    throw new InvalidParamsError("Missing required parameter: event_id");
  }

  if (typeof args.event_id !== "string" || !args.event_id) {
    throw new InvalidParamsError("Parameter 'event_id' is required and must be a non-empty string");
  }

  return { event_id: args.event_id };
}

// ---------------------------------------------------------------------------
// Event tool handlers
// ---------------------------------------------------------------------------

/** Row shape returned by the mcp_events D1 query. */
interface EventQueryRow {
  event_id: string;
  user_id: string;
  account_id: string | null;
  title: string;
  start_ts: string;
  end_ts: string;
  timezone: string;
  description: string | null;
  location: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

/**
 * Execute calendar.list_events: query D1 for events in a time range.
 */
async function handleListEvents(
  user: McpUserContext,
  db: D1Database,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const { start, end, account_id, limit } = validateListEventsParams(args);

  let result: { results: EventQueryRow[] };

  if (account_id) {
    result = await db
      .prepare(
        "SELECT event_id, user_id, account_id, title, start_ts, end_ts, timezone, description, location, source, created_at, updated_at FROM mcp_events WHERE user_id = ?1 AND account_id = ?2 AND start_ts >= ?3 AND end_ts <= ?4 ORDER BY start_ts ASC LIMIT ?5",
      )
      .bind(user.userId, account_id, start, end, limit)
      .all<EventQueryRow>();
  } else {
    result = await db
      .prepare(
        "SELECT event_id, user_id, account_id, title, start_ts, end_ts, timezone, description, location, source, created_at, updated_at FROM mcp_events WHERE user_id = ?1 AND start_ts >= ?2 AND end_ts <= ?3 ORDER BY start_ts ASC LIMIT ?4",
      )
      .bind(user.userId, start, end, limit)
      .all<EventQueryRow>();
  }

  const events = result.results ?? [];
  return events.map((e) => ({
    event_id: e.event_id,
    title: e.title,
    start_ts: e.start_ts,
    end_ts: e.end_ts,
    timezone: e.timezone,
    description: e.description,
    location: e.location,
    account_id: e.account_id,
    source: e.source,
    created_at: e.created_at,
    updated_at: e.updated_at,
  }));
}

/**
 * Execute calendar.create_event: insert a new event into D1.
 */
async function handleCreateEvent(
  user: McpUserContext,
  db: D1Database,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const validated = validateCreateEventParams(args);
  const eventId = generateEventId();

  await db
    .prepare(
      "INSERT INTO mcp_events (event_id, user_id, title, start_ts, end_ts, timezone, description, location, source) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )
    .bind(
      eventId,
      user.userId,
      validated.title,
      validated.start_ts,
      validated.end_ts,
      validated.timezone,
      validated.description,
      validated.location,
      "mcp",
    )
    .run();

  // Read back the created event to return accurate timestamps
  const row = await db
    .prepare(
      "SELECT event_id, user_id, account_id, title, start_ts, end_ts, timezone, description, location, source, created_at, updated_at FROM mcp_events WHERE event_id = ?1",
    )
    .bind(eventId)
    .first<EventQueryRow>();

  return {
    event_id: row!.event_id,
    title: row!.title,
    start_ts: row!.start_ts,
    end_ts: row!.end_ts,
    timezone: row!.timezone,
    description: row!.description,
    location: row!.location,
    account_id: row!.account_id,
    source: row!.source,
    created_at: row!.created_at,
    updated_at: row!.updated_at,
  };
}

/**
 * Execute calendar.update_event: update an existing event in D1.
 */
async function handleUpdateEvent(
  user: McpUserContext,
  db: D1Database,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const { event_id, patch } = validateUpdateEventParams(args);

  // Verify event exists and belongs to this user
  const existing = await db
    .prepare(
      "SELECT event_id FROM mcp_events WHERE event_id = ?1 AND user_id = ?2",
    )
    .bind(event_id, user.userId)
    .first<{ event_id: string }>();

  if (!existing) {
    throw new EventNotFoundError(event_id);
  }

  // Build dynamic UPDATE -- only patch fields that were provided
  const setClauses: string[] = [];
  const bindValues: unknown[] = [];
  let paramIndex = 1;

  for (const [field, value] of Object.entries(patch)) {
    setClauses.push(`${field} = ?${paramIndex}`);
    bindValues.push(value);
    paramIndex++;
  }

  // Always update updated_at
  setClauses.push(`updated_at = datetime('now')`);

  // WHERE clause
  const sql = `UPDATE mcp_events SET ${setClauses.join(", ")} WHERE event_id = ?${paramIndex} AND user_id = ?${paramIndex + 1}`;
  bindValues.push(event_id, user.userId);

  await db.prepare(sql).bind(...bindValues).run();

  // Read back the updated event
  const row = await db
    .prepare(
      "SELECT event_id, user_id, account_id, title, start_ts, end_ts, timezone, description, location, source, created_at, updated_at FROM mcp_events WHERE event_id = ?1",
    )
    .bind(event_id)
    .first<EventQueryRow>();

  return {
    event_id: row!.event_id,
    title: row!.title,
    start_ts: row!.start_ts,
    end_ts: row!.end_ts,
    timezone: row!.timezone,
    description: row!.description,
    location: row!.location,
    account_id: row!.account_id,
    source: row!.source,
    created_at: row!.created_at,
    updated_at: row!.updated_at,
  };
}

/**
 * Execute calendar.delete_event: remove an event from D1.
 */
async function handleDeleteEvent(
  user: McpUserContext,
  db: D1Database,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const { event_id } = validateDeleteEventParams(args);

  // Verify event exists and belongs to this user
  const existing = await db
    .prepare(
      "SELECT event_id FROM mcp_events WHERE event_id = ?1 AND user_id = ?2",
    )
    .bind(event_id, user.userId)
    .first<{ event_id: string }>();

  if (!existing) {
    throw new EventNotFoundError(event_id);
  }

  await db
    .prepare("DELETE FROM mcp_events WHERE event_id = ?1 AND user_id = ?2")
    .bind(event_id, user.userId)
    .run();

  return { deleted: true, event_id };
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

/**
 * Parse and validate a JSON-RPC 2.0 request body.
 * Returns the parsed request or a JSON-RPC error response.
 */
function parseJsonRpcRequest(
  body: unknown,
): { request: JsonRpcRequest } | { error: JsonRpcResponse } {
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body)
  ) {
    return {
      error: makeErrorResponse(null, RPC_INVALID_REQUEST, "Invalid Request"),
    };
  }

  const obj = body as Record<string, unknown>;

  if (obj.jsonrpc !== "2.0") {
    return {
      error: makeErrorResponse(
        (obj.id as string | number | null) ?? null,
        RPC_INVALID_REQUEST,
        'Invalid Request: jsonrpc must be "2.0"',
      ),
    };
  }

  if (typeof obj.method !== "string") {
    return {
      error: makeErrorResponse(
        (obj.id as string | number | null) ?? null,
        RPC_INVALID_REQUEST,
        "Invalid Request: method must be a string",
      ),
    };
  }

  // id may be string, number, or null; missing id means notification (we still respond)
  const id = obj.id !== undefined ? (obj.id as string | number | null) : null;

  return {
    request: {
      jsonrpc: "2.0",
      method: obj.method,
      params: (obj.params as Record<string, unknown>) ?? undefined,
      id,
    },
  };
}

/** Build a JSON-RPC success response. */
function makeSuccessResponse(
  id: string | number | null,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", result, id };
}

/** Build a JSON-RPC error response. */
function makeErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    error: { code, message, ...(data !== undefined ? { data } : {}) },
    id,
  };
}

/**
 * Dispatch a validated JSON-RPC request to the appropriate handler.
 * Handles tools/list and tools/call methods.
 */
async function dispatch(
  rpcReq: JsonRpcRequest,
  user: McpUserContext,
  db: D1Database,
): Promise<JsonRpcResponse> {
  switch (rpcReq.method) {
    case "tools/list": {
      return makeSuccessResponse(rpcReq.id, { tools: TOOL_REGISTRY });
    }

    case "tools/call": {
      const toolName = rpcReq.params?.name;
      if (typeof toolName !== "string") {
        return makeErrorResponse(
          rpcReq.id,
          RPC_INVALID_PARAMS,
          "Invalid params: tools/call requires params.name (string)",
        );
      }

      // Look up tool in registry
      const tool = TOOL_REGISTRY.find((t) => t.name === toolName);
      if (!tool) {
        return makeErrorResponse(
          rpcReq.id,
          RPC_METHOD_NOT_FOUND,
          `Tool not found: ${toolName}`,
        );
      }

      // Extract tool arguments from params.arguments (MCP spec)
      const toolArgs = rpcReq.params?.arguments as
        | Record<string, unknown>
        | undefined;

      // Dispatch to tool handler
      try {
        let result: unknown;
        switch (toolName) {
          case "calendar.list_accounts":
            result = await handleListAccounts(user, db);
            break;
          case "calendar.get_sync_status":
            result = await handleGetSyncStatus(user, db, toolArgs);
            break;
          case "calendar.list_events":
            result = await handleListEvents(user, db, toolArgs);
            break;
          case "calendar.create_event":
            result = await handleCreateEvent(user, db, toolArgs);
            break;
          case "calendar.update_event":
            result = await handleUpdateEvent(user, db, toolArgs);
            break;
          case "calendar.delete_event":
            result = await handleDeleteEvent(user, db, toolArgs);
            break;
          default:
            return makeErrorResponse(
              rpcReq.id,
              RPC_INTERNAL_ERROR,
              `Tool registered but no handler: ${toolName}`,
            );
        }

        return makeSuccessResponse(rpcReq.id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
        });
      } catch (err) {
        if (err instanceof AccountNotFoundError) {
          return makeErrorResponse(
            rpcReq.id,
            RPC_INVALID_PARAMS,
            err.message,
          );
        }
        if (err instanceof EventNotFoundError) {
          return makeErrorResponse(
            rpcReq.id,
            RPC_INVALID_PARAMS,
            err.message,
          );
        }
        if (err instanceof InvalidParamsError) {
          return makeErrorResponse(
            rpcReq.id,
            RPC_INVALID_PARAMS,
            err.message,
          );
        }
        const message =
          err instanceof Error ? err.message : "Internal error";
        return makeErrorResponse(rpcReq.id, RPC_INTERNAL_ERROR, message);
      }
    }

    default:
      return makeErrorResponse(
        rpcReq.id,
        RPC_METHOD_NOT_FOUND,
        `Method not found: ${rpcReq.method}`,
      );
  }
}

// ---------------------------------------------------------------------------
// HTTP handler factory
// ---------------------------------------------------------------------------

/**
 * Create the MCP worker handler. Factory pattern allows tests to inject
 * dependencies and validate the full request flow.
 */
function createMcpHandler() {
  return {
    async fetch(
      request: Request,
      env: McpEnv,
      _ctx: ExecutionContext,
    ): Promise<Response> {
      const url = new URL(request.url);
      const { pathname } = url;
      const method = request.method;
      const origin = request.headers.get("Origin");
      const environment = env.ENVIRONMENT ?? "development";

      // Wrap response with security + CORS headers
      const finalize = (response: Response): Response => {
        const secured = addSecurityHeaders(response);
        return addCorsHeaders(secured, origin, environment);
      };

      // CORS preflight
      if (method === "OPTIONS") {
        const preflight = buildPreflightResponse(origin, environment);
        return addSecurityHeaders(preflight);
      }

      // Health check -- no auth required
      if (method === "GET" && pathname === "/health") {
        return finalize(
          new Response(
            JSON.stringify({ ok: true, status: "healthy" }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }

      // MCP JSON-RPC endpoint
      if (method === "POST" && pathname === "/mcp") {
        return finalize(await handleMcpRequest(request, env));
      }

      // Not found
      return finalize(
        new Response(
          JSON.stringify(
            makeErrorResponse(null, RPC_METHOD_NOT_FOUND, "Not Found"),
          ),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    },
  };
}

/**
 * Handle a POST /mcp request: parse body, authenticate, dispatch JSON-RPC.
 */
async function handleMcpRequest(
  request: Request,
  env: McpEnv,
): Promise<Response> {
  // Parse request body
  let body: unknown;
  try {
    const text = await request.text();
    body = JSON.parse(text);
  } catch {
    const errorResp = makeErrorResponse(null, RPC_PARSE_ERROR, "Parse error");
    return new Response(JSON.stringify(errorResp), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Validate JSON-RPC structure
  const parsed = parseJsonRpcRequest(body);
  if ("error" in parsed) {
    return new Response(JSON.stringify(parsed.error), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const rpcReq = parsed.request;

  // Authenticate via JWT
  const user = await extractMcpAuth(request, env.JWT_SECRET);
  if (!user) {
    const errorResp = makeErrorResponse(
      rpcReq.id,
      RPC_AUTH_REQUIRED,
      "Authentication required: provide a valid JWT in the Authorization header",
    );
    return new Response(JSON.stringify(errorResp), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Dispatch to method handler
  const result = await dispatch(rpcReq, user, env.DB);
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Default export for Cloudflare Workers runtime
//
// IMPORTANT: No constants, types, or utilities are exported from this file.
// workerd restriction (retro learning): worker entrypoints that export
// non-handler values cause deployment failures.
// ---------------------------------------------------------------------------

const handler = createMcpHandler();
export default handler;

// Named exports for testing ONLY -- the createMcpHandler factory and
// internal helpers. These are functions, not constants/types, which are
// safe to export from a worker entrypoint.
export {
  createMcpHandler,
  computeHealthStatus,
  computeOverallHealth,
  computeChannelStatus,
  validateListEventsParams,
  validateCreateEventParams,
  validateUpdateEventParams,
  validateDeleteEventParams,
};
