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

import { z } from "zod";
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
  /** Service binding to the tminus-api worker for constraint operations. */
  API?: Fetcher;
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
  {
    name: "calendar.get_availability",
    description:
      "Get unified free/busy availability across all connected accounts for a time range. Returns time slots with status (free/busy/tentative) and conflict counts. Supports granularity selection and account filtering.",
    inputSchema: {
      type: "object",
      properties: {
        start: {
          type: "string",
          description:
            "Start of time range (ISO 8601 datetime, e.g. '2026-03-15T09:00:00Z').",
        },
        end: {
          type: "string",
          description:
            "End of time range (ISO 8601 datetime, e.g. '2026-03-15T17:00:00Z').",
        },
        accounts: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of account IDs to filter. If omitted, includes all accounts.",
        },
        granularity: {
          type: "string",
          enum: ["15m", "30m", "1h"],
          description:
            "Slot duration: '15m' (15 minutes), '30m' (30 minutes, default), or '1h' (1 hour).",
        },
      },
      required: ["start", "end"],
    },
  },
  {
    name: "calendar.list_policies",
    description:
      "List all policy edges for the authenticated user. Each policy edge defines how events project from one account to another (e.g., BUSY overlay from work to personal).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "calendar.get_policy_edge",
    description:
      "Get a single policy edge by policy_id or by the (from_account, to_account) pair. Returns the policy edge details including detail_level and calendar_kind.",
    inputSchema: {
      type: "object",
      properties: {
        policy_id: {
          type: "string",
          description: "Policy edge ID. If provided, from_account and to_account are ignored.",
        },
        from_account: {
          type: "string",
          description: "Source account ID. Required if policy_id is not provided.",
        },
        to_account: {
          type: "string",
          description: "Target account ID. Required if policy_id is not provided.",
        },
      },
    },
  },
  {
    name: "calendar.set_policy_edge",
    description:
      "Create or update a policy edge between two accounts. Controls how events project from the source account to the target account. Uses BUSY_OVERLAY calendar kind by default (BR-11).",
    inputSchema: {
      type: "object",
      properties: {
        from_account: {
          type: "string",
          description: "Source account ID (events originate here).",
        },
        to_account: {
          type: "string",
          description: "Target account ID (events project to here).",
        },
        detail_level: {
          type: "string",
          enum: ["BUSY", "TITLE", "FULL"],
          description: "How much detail to project: BUSY (time only), TITLE (time + title), FULL (everything).",
        },
        calendar_kind: {
          type: "string",
          enum: ["BUSY_OVERLAY", "TRUE_MIRROR"],
          description: "Calendar type for projection. Default: BUSY_OVERLAY (per BR-11).",
        },
      },
      required: ["from_account", "to_account", "detail_level"],
    },
  },
  {
    name: "calendar.add_trip",
    description:
      "Add a trip constraint. Blocks calendar time for the trip duration with the specified block policy. Creates a constraint of kind 'trip' routed through the constraint API.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Trip name (e.g. 'NYC Business Trip').",
        },
        start: {
          type: "string",
          description: "Trip start datetime (ISO 8601, e.g. '2026-03-15T00:00:00Z').",
        },
        end: {
          type: "string",
          description: "Trip end datetime (ISO 8601, e.g. '2026-03-20T00:00:00Z').",
        },
        timezone: {
          type: "string",
          description: "IANA timezone for the trip (e.g. 'America/New_York').",
        },
        block_policy: {
          type: "string",
          enum: ["BUSY", "TITLE"],
          description: "How to block time: 'BUSY' (time only) or 'TITLE' (show trip name). Default: 'BUSY'.",
        },
      },
      required: ["name", "start", "end", "timezone"],
    },
  },
  {
    name: "calendar.add_constraint",
    description:
      "Add a scheduling constraint of any supported kind (trip, working_hours, buffer, no_meetings_after, override). Routes through the constraint API.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "Constraint kind: 'trip', 'working_hours', 'buffer', 'no_meetings_after', or 'override'.",
        },
        config: {
          type: "object",
          description:
            "Configuration object. Shape depends on kind. See constraint API docs for per-kind schemas.",
        },
      },
      required: ["kind", "config"],
    },
  },
  {
    name: "calendar.list_constraints",
    description:
      "List all scheduling constraints for the authenticated user. Optionally filter by kind.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "Optional filter: only return constraints of this kind.",
        },
      },
    },
  },
  {
    name: "calendar.propose_times",
    description:
      "Propose candidate meeting times for a set of participants within a time window. Creates a scheduling session that computes availability across all participants, runs a greedy solver, and returns scored candidate time slots. Requires Premium+ subscription.",
    inputSchema: {
      type: "object",
      properties: {
        participants: {
          type: "array",
          items: { type: "string" },
          description:
            "List of participant account IDs whose calendars must be checked for availability.",
        },
        window: {
          type: "object",
          description: "Time window to search for available slots.",
          properties: {
            start: {
              type: "string",
              description: "Window start (ISO 8601 datetime, e.g. '2026-03-15T09:00:00Z').",
            },
            end: {
              type: "string",
              description: "Window end (ISO 8601 datetime, e.g. '2026-03-15T17:00:00Z').",
            },
          },
          required: ["start", "end"],
        },
        duration_minutes: {
          type: "number",
          description: "Desired meeting duration in minutes (15-480).",
        },
        constraints: {
          type: "object",
          description:
            "Optional scheduling constraints (e.g. preferred times, buffer requirements). Passed through to the scheduling engine.",
        },
        objective: {
          type: "string",
          description:
            "Optional optimization objective: 'earliest' (default), 'least_conflicts', or 'best_distribution'.",
        },
      },
      required: ["participants", "window", "duration_minutes"],
    },
  },
  {
    name: "calendar.commit_candidate",
    description:
      "Commit a selected scheduling candidate from a propose_times session. Creates the calendar event at the chosen time and projects mirror events to all participant calendars. Requires Premium+ subscription.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "The scheduling session ID returned by propose_times.",
        },
        candidate_id: {
          type: "string",
          description: "The candidate ID to commit (from the candidates array).",
        },
      },
      required: ["session_id", "candidate_id"],
    },
  },
  {
    name: "calendar.set_vip",
    description:
      "Create or update a VIP policy for a contact/participant. VIP policies allow scheduling overrides (e.g., meetings outside working hours) for important contacts. The participant is identified by their email hash. Requires Premium+ subscription.",
    inputSchema: {
      type: "object",
      properties: {
        participant_email: {
          type: "string",
          description: "Email address of the VIP participant. Will be hashed for privacy.",
        },
        display_name: {
          type: "string",
          description: "Human-readable name for the VIP (e.g., 'Sarah - Investor').",
        },
        priority: {
          type: "number",
          description: "Priority weight (1.0 = normal, 2.0 = high, 3.0 = critical). Default: 1.0.",
        },
        conditions: {
          type: "object",
          description: "Override conditions for this VIP.",
          properties: {
            allow_after_hours: {
              type: "boolean",
              description: "Allow scheduling outside working hours for this VIP. Default: false.",
            },
            min_notice_hours: {
              type: "number",
              description: "Minimum notice period in hours before a meeting. Default: 0.",
            },
            override_deep_work: {
              type: "boolean",
              description: "Allow scheduling during deep work blocks for this VIP. Default: false.",
            },
          },
        },
      },
      required: ["participant_email", "display_name"],
    },
  },
  {
    name: "calendar.list_vips",
    description:
      "List all VIP policies for the authenticated user. Returns participant hashes, display names, priority weights, and override conditions.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "calendar.delete_vip",
    description:
      "Delete a VIP policy by its ID. Removes the scheduling override for that participant.",
    inputSchema: {
      type: "object",
      properties: {
        vip_id: {
          type: "string",
          description: "The VIP policy ID to delete.",
        },
      },
      required: ["vip_id"],
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
// Tier-based tool permissions (Layer 3 authorization)
// ---------------------------------------------------------------------------

/**
 * Subscription tier hierarchy. Higher numeric value = more access.
 * Used for comparing whether a user's tier meets a tool's requirement.
 */
const TIER_HIERARCHY: Record<string, number> = {
  free: 0,
  premium: 1,
  enterprise: 2,
};

/**
 * Map of tool name to the minimum subscription tier required.
 * Tools not in this map default to "free" (no restriction).
 *
 * Free tier: read-only tools (list, get, query).
 * Premium tier: write/mutate tools (create, update, delete, set).
 */
const TOOL_TIERS: Record<string, string> = {
  "calendar.list_accounts": "free",
  "calendar.get_sync_status": "free",
  "calendar.list_events": "free",
  "calendar.get_availability": "free",
  "calendar.list_policies": "free",
  "calendar.get_policy_edge": "free",
  "calendar.create_event": "premium",
  "calendar.update_event": "premium",
  "calendar.delete_event": "premium",
  "calendar.set_policy_edge": "premium",
  "calendar.add_trip": "premium",
  "calendar.add_constraint": "premium",
  "calendar.list_constraints": "free",
  "calendar.propose_times": "premium",
  "calendar.commit_candidate": "premium",
  "calendar.set_vip": "premium",
  "calendar.list_vips": "free",
  "calendar.delete_vip": "premium",
};

/**
 * Check whether a user's subscription tier grants access to a tool.
 *
 * @param toolName - The MCP tool being invoked.
 * @param userTier - The authenticated user's subscription tier.
 * @returns Object with `allowed: true` on success, or `allowed: false`
 *          with structured error data on failure.
 */
function checkTierAccess(
  toolName: string,
  userTier: string,
): { allowed: true } | {
  allowed: false;
  required_tier: string;
  current_tier: string;
  tool: string;
} {
  const requiredTier = TOOL_TIERS[toolName] ?? "free";
  const userLevel = TIER_HIERARCHY[userTier] ?? 0;
  const requiredLevel = TIER_HIERARCHY[requiredTier] ?? 0;

  if (userLevel >= requiredLevel) {
    return { allowed: true };
  }

  return {
    allowed: false,
    required_tier: requiredTier,
    current_tier: userTier,
    tool: toolName,
  };
}

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

/** Application-level error for policy not found. */
class PolicyNotFoundError extends Error {
  constructor(identifier: string) {
    super(`Policy not found: ${identifier}`);
    this.name = "PolicyNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a unique event ID with evt_ prefix and random hex suffix.
 * Uses crypto.randomUUID() for uniqueness.
 */
function generateEventId(): string {
  const uuid = crypto.randomUUID().replace(/-/g, "");
  return `evt_${uuid}`;
}

/**
 * Generate a unique policy ID with pol_ prefix and random hex suffix.
 * Uses crypto.randomUUID() for uniqueness.
 */
function generatePolicyId(): string {
  const uuid = crypto.randomUUID().replace(/-/g, "");
  return `pol_${uuid}`;
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
// Policy validation helpers (pure functions)
// ---------------------------------------------------------------------------

/** Valid detail_level values for policy edges. */
const VALID_DETAIL_LEVELS = ["BUSY", "TITLE", "FULL"] as const;

/** Valid calendar_kind values for policy edges. */
const VALID_CALENDAR_KINDS = ["BUSY_OVERLAY", "TRUE_MIRROR"] as const;

/**
 * Validate calendar.get_policy_edge input parameters.
 * Requires either policy_id OR both from_account and to_account.
 * Throws InvalidParamsError on validation failure.
 */
function validateGetPolicyEdgeParams(args: Record<string, unknown> | undefined): {
  policy_id: string | null;
  from_account: string | null;
  to_account: string | null;
} {
  if (!args) {
    throw new InvalidParamsError(
      "Missing required parameters: provide either policy_id or both from_account and to_account",
    );
  }

  const policy_id =
    typeof args.policy_id === "string" && args.policy_id
      ? args.policy_id
      : null;

  const from_account =
    typeof args.from_account === "string" && args.from_account
      ? args.from_account
      : null;

  const to_account =
    typeof args.to_account === "string" && args.to_account
      ? args.to_account
      : null;

  if (!policy_id && (!from_account || !to_account)) {
    throw new InvalidParamsError(
      "Provide either 'policy_id' or both 'from_account' and 'to_account'",
    );
  }

  return { policy_id, from_account, to_account };
}

/**
 * Validate calendar.set_policy_edge input parameters.
 * Throws InvalidParamsError on validation failure.
 */
function validateSetPolicyEdgeParams(args: Record<string, unknown> | undefined): {
  from_account: string;
  to_account: string;
  detail_level: "BUSY" | "TITLE" | "FULL";
  calendar_kind: "BUSY_OVERLAY" | "TRUE_MIRROR";
} {
  if (!args) {
    throw new InvalidParamsError(
      "Missing required parameters: from_account, to_account, detail_level",
    );
  }

  if (typeof args.from_account !== "string" || !args.from_account) {
    throw new InvalidParamsError(
      "Parameter 'from_account' is required and must be a non-empty string",
    );
  }

  if (typeof args.to_account !== "string" || !args.to_account) {
    throw new InvalidParamsError(
      "Parameter 'to_account' is required and must be a non-empty string",
    );
  }

  if (args.from_account === args.to_account) {
    throw new InvalidParamsError(
      "Parameters 'from_account' and 'to_account' must be different accounts",
    );
  }

  if (
    typeof args.detail_level !== "string" ||
    !(VALID_DETAIL_LEVELS as readonly string[]).includes(args.detail_level)
  ) {
    throw new InvalidParamsError(
      "Parameter 'detail_level' must be one of: BUSY, TITLE, FULL",
    );
  }

  // Default calendar_kind to BUSY_OVERLAY per BR-11
  let calendar_kind: "BUSY_OVERLAY" | "TRUE_MIRROR" = "BUSY_OVERLAY";
  if (args.calendar_kind !== undefined) {
    if (
      typeof args.calendar_kind !== "string" ||
      !(VALID_CALENDAR_KINDS as readonly string[]).includes(args.calendar_kind)
    ) {
      throw new InvalidParamsError(
        "Parameter 'calendar_kind' must be one of: BUSY_OVERLAY, TRUE_MIRROR",
      );
    }
    calendar_kind = args.calendar_kind as "BUSY_OVERLAY" | "TRUE_MIRROR";
  }

  return {
    from_account: args.from_account,
    to_account: args.to_account,
    detail_level: args.detail_level as "BUSY" | "TITLE" | "FULL",
    calendar_kind,
  };
}

// ---------------------------------------------------------------------------
// Availability validation and computation
// ---------------------------------------------------------------------------

/** Valid granularity values for availability slots. */
type AvailabilityGranularity = "15m" | "30m" | "1h";

/** A single availability slot in the response. */
interface AvailabilitySlot {
  start: string;
  end: string;
  status: "free" | "busy" | "tentative";
  conflicting_events?: number;
}

/** Granularity string to milliseconds mapping. */
const GRANULARITY_MS: Record<AvailabilityGranularity, number> = {
  "15m": 15 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
};

/**
 * Validate calendar.get_availability input parameters.
 * Throws InvalidParamsError on validation failure.
 */
function validateGetAvailabilityParams(args: Record<string, unknown> | undefined): {
  start: string;
  end: string;
  accounts: string[] | null;
  granularity: AvailabilityGranularity;
} {
  if (!args) {
    throw new InvalidParamsError("Missing required parameters: start, end");
  }

  if (typeof args.start !== "string" || !args.start) {
    throw new InvalidParamsError(
      "Parameter 'start' is required and must be an ISO 8601 datetime string",
    );
  }
  if (!isValidIsoDatetime(args.start)) {
    throw new InvalidParamsError(
      "Parameter 'start' is not a valid ISO 8601 datetime",
    );
  }

  if (typeof args.end !== "string" || !args.end) {
    throw new InvalidParamsError(
      "Parameter 'end' is required and must be an ISO 8601 datetime string",
    );
  }
  if (!isValidIsoDatetime(args.end)) {
    throw new InvalidParamsError(
      "Parameter 'end' is not a valid ISO 8601 datetime",
    );
  }

  const startMs = new Date(args.start).getTime();
  const endMs = new Date(args.end).getTime();

  if (startMs >= endMs) {
    throw new InvalidParamsError("Parameter 'start' must be before 'end'");
  }

  // Validate granularity
  let granularity: AvailabilityGranularity = "30m";
  if (args.granularity !== undefined) {
    if (
      typeof args.granularity !== "string" ||
      !["15m", "30m", "1h"].includes(args.granularity)
    ) {
      throw new InvalidParamsError(
        "Parameter 'granularity' must be one of: '15m', '30m', '1h'",
      );
    }
    granularity = args.granularity as AvailabilityGranularity;
  }

  // Limit time range to prevent excessively large responses.
  // Max 7 days at 15m granularity = 672 slots (reasonable).
  const MAX_RANGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  if (endMs - startMs > MAX_RANGE_MS) {
    throw new InvalidParamsError(
      "Time range must not exceed 7 days",
    );
  }

  // Validate accounts filter
  let accounts: string[] | null = null;
  if (args.accounts !== undefined) {
    if (!Array.isArray(args.accounts)) {
      throw new InvalidParamsError(
        "Parameter 'accounts' must be an array of account ID strings",
      );
    }
    for (const acc of args.accounts) {
      if (typeof acc !== "string" || !acc) {
        throw new InvalidParamsError(
          "Each element in 'accounts' must be a non-empty string",
        );
      }
    }
    if (args.accounts.length > 0) {
      accounts = args.accounts as string[];
    }
  }

  return { start: args.start, end: args.end, accounts, granularity };
}

/**
 * Generate time slots between start and end at the given granularity.
 * Returns an array of {start, end} ISO strings.
 * Pure function -- no side effects.
 */
function generateTimeSlots(
  startMs: number,
  endMs: number,
  granularityMs: number,
): Array<{ startMs: number; endMs: number }> {
  const slots: Array<{ startMs: number; endMs: number }> = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const slotEnd = Math.min(cursor + granularityMs, endMs);
    slots.push({ startMs: cursor, endMs: slotEnd });
    cursor = slotEnd;
  }
  return slots;
}

/** Row shape for events used in availability computation. */
interface AvailabilityEventRow {
  start_ts: string;
  end_ts: string;
  status: string;
  account_id: string | null;
}

/**
 * Compute availability slots from a set of events.
 * For each time slot, determines if it's free, busy, or tentative based
 * on overlapping events across all accounts.
 *
 * Logic:
 * - A slot is "busy" if ANY confirmed event overlaps it
 * - A slot is "tentative" if only tentative events overlap (no confirmed)
 * - A slot is "free" if no events overlap
 * - Cancelled events are ignored
 * - conflicting_events counts the number of events overlapping the slot
 *
 * Pure function -- no side effects.
 */
function computeAvailabilitySlots(
  timeSlots: Array<{ startMs: number; endMs: number }>,
  events: AvailabilityEventRow[],
): AvailabilitySlot[] {
  // Pre-parse event timestamps for performance
  const parsedEvents = events
    .filter((e) => e.status !== "cancelled")
    .map((e) => ({
      startMs: new Date(e.start_ts).getTime(),
      endMs: new Date(e.end_ts).getTime(),
      status: e.status,
    }));

  return timeSlots.map((slot) => {
    // Find all events that overlap this slot.
    // An event overlaps a slot if: event.start < slot.end AND event.end > slot.start
    const overlapping = parsedEvents.filter(
      (e) => e.startMs < slot.endMs && e.endMs > slot.startMs,
    );

    const conflictCount = overlapping.length;

    let status: "free" | "busy" | "tentative" = "free";
    if (conflictCount > 0) {
      const hasConfirmed = overlapping.some((e) => e.status === "confirmed");
      status = hasConfirmed ? "busy" : "tentative";
    }

    const result: AvailabilitySlot = {
      start: new Date(slot.startMs).toISOString(),
      end: new Date(slot.endMs).toISOString(),
      status,
    };

    if (conflictCount > 0) {
      result.conflicting_events = conflictCount;
    }

    return result;
  });
}

/**
 * Execute calendar.get_availability: query D1 for events in the time range,
 * compute availability slots, and return unified free/busy data.
 */
async function handleGetAvailability(
  user: McpUserContext,
  db: D1Database,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const { start, end, accounts, granularity } =
    validateGetAvailabilityParams(args);

  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const granularityMs = GRANULARITY_MS[granularity];

  // Query events in the time range.
  // We need events that OVERLAP the range: event.start < range.end AND event.end > range.start
  let result: { results: AvailabilityEventRow[] };

  if (accounts && accounts.length > 0) {
    // Query all events in range, then filter by account in JS.
    // This is simpler and safer than dynamic IN clause with D1.
    result = await db
      .prepare(
        "SELECT start_ts, end_ts, status, account_id FROM mcp_events WHERE user_id = ?1 AND start_ts < ?2 AND end_ts > ?3 AND status != 'cancelled'",
      )
      .bind(user.userId, end, start)
      .all<AvailabilityEventRow>();

    // Filter by requested accounts
    const accountSet = new Set(accounts);
    result.results = (result.results ?? []).filter(
      (e) => e.account_id !== null && accountSet.has(e.account_id),
    );
  } else {
    result = await db
      .prepare(
        "SELECT start_ts, end_ts, status, account_id FROM mcp_events WHERE user_id = ?1 AND start_ts < ?2 AND end_ts > ?3 AND status != 'cancelled'",
      )
      .bind(user.userId, end, start)
      .all<AvailabilityEventRow>();
  }

  const events = result.results ?? [];

  // Generate time slots
  const timeSlots = generateTimeSlots(startMs, endMs, granularityMs);

  // Compute availability
  const slots = computeAvailabilitySlots(timeSlots, events);

  return { slots };
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
  status: string;
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
        "SELECT event_id, user_id, account_id, title, start_ts, end_ts, timezone, description, location, status, source, created_at, updated_at FROM mcp_events WHERE user_id = ?1 AND account_id = ?2 AND start_ts >= ?3 AND end_ts <= ?4 ORDER BY start_ts ASC LIMIT ?5",
      )
      .bind(user.userId, account_id, start, end, limit)
      .all<EventQueryRow>();
  } else {
    result = await db
      .prepare(
        "SELECT event_id, user_id, account_id, title, start_ts, end_ts, timezone, description, location, status, source, created_at, updated_at FROM mcp_events WHERE user_id = ?1 AND start_ts >= ?2 AND end_ts <= ?3 ORDER BY start_ts ASC LIMIT ?4",
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
      "SELECT event_id, user_id, account_id, title, start_ts, end_ts, timezone, description, location, status, source, created_at, updated_at FROM mcp_events WHERE event_id = ?1",
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
      "SELECT event_id, user_id, account_id, title, start_ts, end_ts, timezone, description, location, status, source, created_at, updated_at FROM mcp_events WHERE event_id = ?1",
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
// Policy tool handlers
// ---------------------------------------------------------------------------

/** Row shape returned by the mcp_policies D1 query. */
interface PolicyQueryRow {
  policy_id: string;
  user_id: string;
  from_account: string;
  to_account: string;
  detail_level: string;
  calendar_kind: string;
  created_at: string;
  updated_at: string;
}

/**
 * Verify that an account_id belongs to the authenticated user.
 * Throws InvalidParamsError if the account does not exist or belongs to another user.
 */
async function verifyAccountOwnership(
  db: D1Database,
  userId: string,
  accountId: string,
  paramName: string,
): Promise<void> {
  const row = await db
    .prepare(
      "SELECT account_id FROM accounts WHERE account_id = ?1 AND user_id = ?2",
    )
    .bind(accountId, userId)
    .first<{ account_id: string }>();

  if (!row) {
    throw new InvalidParamsError(
      `Account '${accountId}' not found for parameter '${paramName}'. Ensure the account exists and belongs to you.`,
    );
  }
}

/**
 * Format a policy row for API response. Pure function.
 */
function formatPolicyRow(row: PolicyQueryRow): Record<string, unknown> {
  return {
    policy_id: row.policy_id,
    from_account: row.from_account,
    to_account: row.to_account,
    detail_level: row.detail_level,
    calendar_kind: row.calendar_kind,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Execute calendar.list_policies: query D1 for all policy edges
 * belonging to the authenticated user.
 */
async function handleListPolicies(
  user: McpUserContext,
  db: D1Database,
): Promise<unknown> {
  const result = await db
    .prepare(
      "SELECT policy_id, user_id, from_account, to_account, detail_level, calendar_kind, created_at, updated_at FROM mcp_policies WHERE user_id = ?1 ORDER BY created_at ASC",
    )
    .bind(user.userId)
    .all<PolicyQueryRow>();

  const policies = (result.results ?? []).map(formatPolicyRow);
  return { policies };
}

/**
 * Execute calendar.get_policy_edge: query D1 for a single policy edge
 * by policy_id or by (from_account, to_account) pair.
 */
async function handleGetPolicyEdge(
  user: McpUserContext,
  db: D1Database,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const { policy_id, from_account, to_account } =
    validateGetPolicyEdgeParams(args);

  let row: PolicyQueryRow | null;

  if (policy_id) {
    row = await db
      .prepare(
        "SELECT policy_id, user_id, from_account, to_account, detail_level, calendar_kind, created_at, updated_at FROM mcp_policies WHERE policy_id = ?1 AND user_id = ?2",
      )
      .bind(policy_id, user.userId)
      .first<PolicyQueryRow>();
  } else {
    row = await db
      .prepare(
        "SELECT policy_id, user_id, from_account, to_account, detail_level, calendar_kind, created_at, updated_at FROM mcp_policies WHERE user_id = ?1 AND from_account = ?2 AND to_account = ?3",
      )
      .bind(user.userId, from_account!, to_account!)
      .first<PolicyQueryRow>();
  }

  if (!row) {
    const identifier = policy_id
      ? policy_id
      : `${from_account} -> ${to_account}`;
    throw new PolicyNotFoundError(identifier);
  }

  return formatPolicyRow(row);
}

/**
 * Execute calendar.set_policy_edge: create or update a policy edge in D1.
 * Upserts based on the UNIQUE(user_id, from_account, to_account) constraint.
 * Validates that both from_account and to_account belong to the authenticated user.
 */
async function handleSetPolicyEdge(
  user: McpUserContext,
  db: D1Database,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const { from_account, to_account, detail_level, calendar_kind } =
    validateSetPolicyEdgeParams(args);

  // Validate account ownership (AC #6)
  await verifyAccountOwnership(db, user.userId, from_account, "from_account");
  await verifyAccountOwnership(db, user.userId, to_account, "to_account");

  // Check if policy already exists (for upsert)
  const existing = await db
    .prepare(
      "SELECT policy_id FROM mcp_policies WHERE user_id = ?1 AND from_account = ?2 AND to_account = ?3",
    )
    .bind(user.userId, from_account, to_account)
    .first<{ policy_id: string }>();

  if (existing) {
    // Update existing policy
    await db
      .prepare(
        "UPDATE mcp_policies SET detail_level = ?1, calendar_kind = ?2, updated_at = datetime('now') WHERE policy_id = ?3",
      )
      .bind(detail_level, calendar_kind, existing.policy_id)
      .run();

    // Read back updated row
    const row = await db
      .prepare(
        "SELECT policy_id, user_id, from_account, to_account, detail_level, calendar_kind, created_at, updated_at FROM mcp_policies WHERE policy_id = ?1",
      )
      .bind(existing.policy_id)
      .first<PolicyQueryRow>();

    return formatPolicyRow(row!);
  } else {
    // Create new policy
    const policyId = generatePolicyId();

    await db
      .prepare(
        "INSERT INTO mcp_policies (policy_id, user_id, from_account, to_account, detail_level, calendar_kind) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      )
      .bind(policyId, user.userId, from_account, to_account, detail_level, calendar_kind)
      .run();

    // Read back created row
    const row = await db
      .prepare(
        "SELECT policy_id, user_id, from_account, to_account, detail_level, calendar_kind, created_at, updated_at FROM mcp_policies WHERE policy_id = ?1",
      )
      .bind(policyId)
      .first<PolicyQueryRow>();

    return formatPolicyRow(row!);
  }
}

// ---------------------------------------------------------------------------
// Constraint tool validation helpers (pure functions)
// ---------------------------------------------------------------------------

/** Valid block_policy values for trip constraints. */
const VALID_BLOCK_POLICIES = ["BUSY", "TITLE"] as const;

/**
 * Validate calendar.add_trip input parameters.
 * Throws InvalidParamsError on validation failure.
 *
 * Transforms the MCP-level input into the API-level constraint shape:
 *   kind = "trip"
 *   config_json = { name, timezone, block_policy }
 *   active_from = start
 *   active_to = end
 */
function validateAddTripParams(args: Record<string, unknown> | undefined): {
  kind: "trip";
  config_json: { name: string; timezone: string; block_policy: "BUSY" | "TITLE" };
  active_from: string;
  active_to: string;
} {
  if (!args) {
    throw new InvalidParamsError("Missing required parameters: name, start, end, timezone");
  }

  if (typeof args.name !== "string" || !args.name.trim()) {
    throw new InvalidParamsError("Parameter 'name' is required and must be a non-empty string");
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

  if (typeof args.timezone !== "string" || !args.timezone.trim()) {
    throw new InvalidParamsError("Parameter 'timezone' is required and must be a non-empty string");
  }

  // Default block_policy to BUSY
  let block_policy: "BUSY" | "TITLE" = "BUSY";
  if (args.block_policy !== undefined) {
    if (
      typeof args.block_policy !== "string" ||
      !(VALID_BLOCK_POLICIES as readonly string[]).includes(args.block_policy)
    ) {
      throw new InvalidParamsError("Parameter 'block_policy' must be one of: BUSY, TITLE");
    }
    block_policy = args.block_policy as "BUSY" | "TITLE";
  }

  return {
    kind: "trip",
    config_json: {
      name: args.name.trim(),
      timezone: args.timezone.trim(),
      block_policy,
    },
    active_from: args.start,
    active_to: args.end,
  };
}

/**
 * Validate calendar.add_constraint input parameters.
 * Throws InvalidParamsError on validation failure.
 *
 * Passes kind + config through to the constraint API. The API performs
 * kind-specific validation (working_hours schema, buffer schema, etc.).
 */
function validateAddConstraintParams(args: Record<string, unknown> | undefined): {
  kind: string;
  config_json: Record<string, unknown>;
} {
  if (!args) {
    throw new InvalidParamsError("Missing required parameters: kind, config");
  }

  if (typeof args.kind !== "string" || !args.kind.trim()) {
    throw new InvalidParamsError("Parameter 'kind' is required and must be a non-empty string");
  }

  if (typeof args.config !== "object" || args.config === null || Array.isArray(args.config)) {
    throw new InvalidParamsError("Parameter 'config' is required and must be an object");
  }

  return {
    kind: args.kind.trim(),
    config_json: args.config as Record<string, unknown>,
  };
}

/**
 * Validate calendar.list_constraints input parameters.
 * Returns the optional kind filter (null if not provided).
 */
function validateListConstraintsParams(args: Record<string, unknown> | undefined): {
  kind: string | null;
} {
  if (!args) {
    return { kind: null };
  }

  if (args.kind !== undefined) {
    if (typeof args.kind !== "string" || !args.kind.trim()) {
      throw new InvalidParamsError("Parameter 'kind' must be a non-empty string when provided");
    }
    return { kind: args.kind.trim() };
  }

  return { kind: null };
}

// ---------------------------------------------------------------------------
// Scheduling tool Zod schemas (AC #3: Zod validation on all inputs)
// ---------------------------------------------------------------------------

/**
 * Zod schema for calendar.propose_times input.
 *
 * Validates:
 * - participants: non-empty array of non-empty strings (account IDs)
 * - window: { start: ISO8601, end: ISO8601 } where start < end
 * - duration_minutes: integer between 15 and 480
 * - constraints: optional object (passed through to scheduling engine)
 * - objective: optional enum
 */
const ProposeTimesSchema = z.object({
  participants: z
    .array(z.string().min(1, "Each participant must be a non-empty string"))
    .min(1, "At least one participant is required"),
  window: z.object({
    start: z.string().min(1, "window.start is required").refine(
      (s) => !isNaN(new Date(s).getTime()),
      "window.start must be a valid ISO 8601 datetime",
    ),
    end: z.string().min(1, "window.end is required").refine(
      (s) => !isNaN(new Date(s).getTime()),
      "window.end must be a valid ISO 8601 datetime",
    ),
  }).refine(
    (w) => new Date(w.start).getTime() < new Date(w.end).getTime(),
    "window.start must be before window.end",
  ),
  duration_minutes: z
    .number()
    .int("duration_minutes must be an integer")
    .min(15, "duration_minutes must be at least 15")
    .max(480, "duration_minutes must be at most 480"),
  constraints: z.record(z.string(), z.unknown()).optional(),
  objective: z
    .enum(["earliest", "least_conflicts", "best_distribution"])
    .optional(),
});

/** Inferred type for propose_times validated input. */
type ProposeTimesInput = z.infer<typeof ProposeTimesSchema>;

/**
 * Zod schema for calendar.commit_candidate input.
 *
 * Validates:
 * - session_id: non-empty string
 * - candidate_id: non-empty string
 */
const CommitCandidateSchema = z.object({
  session_id: z.string().min(1, "session_id is required"),
  candidate_id: z.string().min(1, "candidate_id is required"),
});

/** Inferred type for commit_candidate validated input. */
type CommitCandidateInput = z.infer<typeof CommitCandidateSchema>;

/**
 * Validate propose_times input using Zod schema.
 * Throws InvalidParamsError with structured Zod error messages on failure.
 */
function validateProposeTimesParams(
  args: Record<string, unknown> | undefined,
): ProposeTimesInput {
  if (!args) {
    throw new InvalidParamsError(
      "Missing required parameters: participants, window, duration_minutes",
    );
  }
  const result = ProposeTimesSchema.safeParse(args);
  if (!result.success) {
    const messages = result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    throw new InvalidParamsError(
      `Invalid parameters: ${messages.join("; ")}`,
    );
  }
  return result.data;
}

/**
 * Validate commit_candidate input using Zod schema.
 * Throws InvalidParamsError with structured Zod error messages on failure.
 */
function validateCommitCandidateParams(
  args: Record<string, unknown> | undefined,
): CommitCandidateInput {
  if (!args) {
    throw new InvalidParamsError(
      "Missing required parameters: session_id, candidate_id",
    );
  }
  const result = CommitCandidateSchema.safeParse(args);
  if (!result.success) {
    const messages = result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    throw new InvalidParamsError(
      `Invalid parameters: ${messages.join("; ")}`,
    );
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Scheduling tool error types
// ---------------------------------------------------------------------------

/** Application-level error for no candidates found. */
class NoCandidatesError extends Error {
  constructor(sessionId: string) {
    super(`No candidate times found for session ${sessionId}. Try widening the time window or reducing duration.`);
    this.name = "NoCandidatesError";
  }
}

// ---------------------------------------------------------------------------
// Constraint tool handlers (route through API service binding)
// ---------------------------------------------------------------------------

/** Application-level error for missing API service binding. */
class ApiBindingMissingError extends Error {
  constructor() {
    super("API service binding is not configured");
    this.name = "ApiBindingMissingError";
  }
}

/**
 * Forward a constraint creation request to the API worker via service binding.
 *
 * The API worker expects:
 *   POST /v1/constraints
 *   Body: { kind, config_json, active_from?, active_to? }
 *   Auth: Bearer <jwt>
 *
 * We forward the original JWT from the MCP request for auth passthrough.
 */
async function callConstraintApi(
  api: Fetcher,
  jwt: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const response = await api.fetch(`https://api.internal${path}`, init);
  const data = await response.json();
  return { ok: response.ok, status: response.status, data };
}

/**
 * Extract the raw JWT token from a request's Authorization header.
 * Returns null if no valid Bearer token is present.
 */
function extractRawJwt(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return null;
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return null;
  return parts[1];
}

/**
 * Execute calendar.add_trip: validate input, transform to constraint API shape,
 * and forward to the API worker via service binding.
 */
async function handleAddTrip(
  request: Request,
  api: Fetcher,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const validated = validateAddTripParams(args);
  const jwt = extractRawJwt(request);
  if (!jwt) throw new Error("JWT not available for API forwarding");

  const result = await callConstraintApi(api, jwt, "POST", "/v1/constraints", {
    kind: validated.kind,
    config_json: validated.config_json,
    active_from: validated.active_from,
    active_to: validated.active_to,
  });

  if (!result.ok) {
    const errData = result.data as { error?: string };
    throw new InvalidParamsError(errData.error ?? "Failed to create trip constraint");
  }

  // API returns envelope: { ok, data, meta }
  const envelope = result.data as { ok: boolean; data: unknown };
  return envelope.data;
}

/**
 * Execute calendar.add_constraint: validate input and forward to the API worker
 * via service binding.
 */
async function handleAddConstraint(
  request: Request,
  api: Fetcher,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const validated = validateAddConstraintParams(args);
  const jwt = extractRawJwt(request);
  if (!jwt) throw new Error("JWT not available for API forwarding");

  const result = await callConstraintApi(api, jwt, "POST", "/v1/constraints", {
    kind: validated.kind,
    config_json: validated.config_json,
  });

  if (!result.ok) {
    const errData = result.data as { error?: string };
    throw new InvalidParamsError(errData.error ?? "Failed to create constraint");
  }

  const envelope = result.data as { ok: boolean; data: unknown };
  return envelope.data;
}

/**
 * Execute calendar.list_constraints: validate optional kind filter and forward
 * to the API worker via service binding.
 */
async function handleListConstraints(
  request: Request,
  api: Fetcher,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const { kind } = validateListConstraintsParams(args);
  const jwt = extractRawJwt(request);
  if (!jwt) throw new Error("JWT not available for API forwarding");

  const path = kind
    ? `/v1/constraints?kind=${encodeURIComponent(kind)}`
    : "/v1/constraints";

  const result = await callConstraintApi(api, jwt, "GET", path);

  if (!result.ok) {
    const errData = result.data as { error?: string };
    throw new InvalidParamsError(errData.error ?? "Failed to list constraints");
  }

  const envelope = result.data as { ok: boolean; data: unknown };
  return envelope.data;
}

// ---------------------------------------------------------------------------
// Scheduling tool handlers (route through API service binding)
// ---------------------------------------------------------------------------

/**
 * Forward a scheduling API request to the API worker via service binding.
 *
 * Uses the same callConstraintApi helper (which is really a general-purpose
 * service-binding forwarder) since the pattern is identical:
 *   - method + path + optional body
 *   - Authorization: Bearer <jwt> header
 *   - Returns { ok, status, data }
 */
async function callSchedulingApi(
  api: Fetcher,
  jwt: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  return callConstraintApi(api, jwt, method, path, body);
}

/**
 * Execute calendar.propose_times: validate input with Zod, create a
 * scheduling session via the API service binding, and return the session
 * with scored candidate time slots.
 *
 * The API endpoint POST /v1/scheduling/sessions:
 * - Computes availability across all participant accounts
 * - Runs the greedy solver to find candidate slots
 * - Returns session_id + candidates array
 *
 * If no candidates are found, returns an explicit error with guidance.
 */
async function handleProposeTimes(
  request: Request,
  api: Fetcher,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const validated = validateProposeTimesParams(args);
  const jwt = extractRawJwt(request);
  if (!jwt) throw new Error("JWT not available for API forwarding");

  // Map MCP tool input to the scheduling API body shape
  const apiBody: Record<string, unknown> = {
    title: "Scheduling Session",
    duration_minutes: validated.duration_minutes,
    window_start: validated.window.start,
    window_end: validated.window.end,
    required_account_ids: validated.participants,
  };

  // Pass through optional fields
  if (validated.constraints) {
    apiBody.constraints = validated.constraints;
  }
  if (validated.objective) {
    apiBody.objective = validated.objective;
  }

  const result = await callSchedulingApi(
    api,
    jwt,
    "POST",
    "/v1/scheduling/sessions",
    apiBody,
  );

  if (!result.ok) {
    const errData = result.data as { error?: string };
    throw new InvalidParamsError(
      errData.error ?? "Failed to create scheduling session",
    );
  }

  const envelope = result.data as { ok: boolean; data: unknown };
  const session = envelope.data as {
    session_id?: string;
    candidates?: unknown[];
  };

  // AC #5: Proper error handling for no-candidates scenarios
  if (
    session &&
    session.candidates &&
    Array.isArray(session.candidates) &&
    session.candidates.length === 0
  ) {
    throw new NoCandidatesError(session.session_id ?? "unknown");
  }

  return envelope.data;
}

/**
 * Execute calendar.commit_candidate: validate input with Zod, commit the
 * selected candidate via the API service binding, and return the created event.
 *
 * The API endpoint POST /v1/scheduling/sessions/:id/commit:
 * - Validates the session is still open and candidate exists
 * - Creates the canonical event at the chosen time
 * - Projects mirror events to all participant calendars
 * - Returns { event_id, session }
 */
async function handleCommitCandidate(
  request: Request,
  api: Fetcher,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const validated = validateCommitCandidateParams(args);
  const jwt = extractRawJwt(request);
  if (!jwt) throw new Error("JWT not available for API forwarding");

  const result = await callSchedulingApi(
    api,
    jwt,
    "POST",
    `/v1/scheduling/sessions/${encodeURIComponent(validated.session_id)}/commit`,
    { candidate_id: validated.candidate_id },
  );

  if (!result.ok) {
    const errData = result.data as { error?: string };
    const errorMsg = errData.error ?? "Failed to commit candidate";

    // Surface not-found, conflict (already committed/expired/cancelled) errors
    if (result.status === 404) {
      throw new InvalidParamsError(errorMsg);
    }
    if (result.status === 409) {
      throw new InvalidParamsError(errorMsg);
    }
    throw new InvalidParamsError(errorMsg);
  }

  const envelope = result.data as { ok: boolean; data: unknown };
  return envelope.data;
}

// ---------------------------------------------------------------------------
// VIP policy tool handlers (route through API service binding)
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hash of a participant email + salt for privacy.
 * Uses the same hashing scheme as the relationship graph.
 */
async function computeParticipantHash(email: string): Promise<string> {
  // Per-org salt -- in production this would come from env.
  // For now, use a fixed salt that matches the relationship graph convention.
  const salt = "tminus-org-salt";
  const data = new TextEncoder().encode(email.toLowerCase().trim() + salt);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Execute calendar.set_vip: hash the participant email, then forward
 * to the API worker to create the VIP policy.
 */
async function handleSetVip(
  request: Request,
  api: Fetcher,
  args?: Record<string, unknown>,
): Promise<unknown> {
  if (!args || typeof args.participant_email !== "string" || args.participant_email.trim().length === 0) {
    throw new InvalidParamsError("participant_email is required");
  }
  if (typeof args.display_name !== "string" || args.display_name.trim().length === 0) {
    throw new InvalidParamsError("display_name is required");
  }

  const participantHash = await computeParticipantHash(args.participant_email as string);
  const priority = typeof args.priority === "number" ? args.priority : 1.0;
  const conditions = (args.conditions as Record<string, unknown>) ?? {};

  const conditionsJson = {
    allow_after_hours: conditions.allow_after_hours ?? false,
    min_notice_hours: conditions.min_notice_hours ?? 0,
    override_deep_work: conditions.override_deep_work ?? false,
  };

  const jwt = extractRawJwt(request);
  if (!jwt) throw new Error("JWT not available for API forwarding");

  const result = await callConstraintApi(api, jwt, "POST", "/v1/vip-policies", {
    participant_hash: participantHash,
    display_name: args.display_name,
    priority_weight: priority,
    conditions_json: conditionsJson,
  });

  if (!result.ok) {
    const errData = result.data as { error?: string };
    throw new InvalidParamsError(errData.error ?? "Failed to create VIP policy");
  }

  const envelope = result.data as { ok: boolean; data: unknown };
  return envelope.data;
}

/**
 * Execute calendar.list_vips: forward to the API worker to list VIP policies.
 */
async function handleListVips(
  request: Request,
  api: Fetcher,
): Promise<unknown> {
  const jwt = extractRawJwt(request);
  if (!jwt) throw new Error("JWT not available for API forwarding");

  const result = await callConstraintApi(api, jwt, "GET", "/v1/vip-policies");

  if (!result.ok) {
    const errData = result.data as { error?: string };
    throw new InvalidParamsError(errData.error ?? "Failed to list VIP policies");
  }

  const envelope = result.data as { ok: boolean; data: unknown };
  return envelope.data;
}

/**
 * Execute calendar.delete_vip: forward to the API worker to delete a VIP policy.
 */
async function handleDeleteVip(
  request: Request,
  api: Fetcher,
  args?: Record<string, unknown>,
): Promise<unknown> {
  if (!args || typeof args.vip_id !== "string" || args.vip_id.trim().length === 0) {
    throw new InvalidParamsError("vip_id is required");
  }

  const jwt = extractRawJwt(request);
  if (!jwt) throw new Error("JWT not available for API forwarding");

  const result = await callConstraintApi(
    api,
    jwt,
    "DELETE",
    `/v1/vip-policies/${encodeURIComponent(args.vip_id)}`,
  );

  if (!result.ok) {
    const errData = result.data as { error?: string };
    throw new InvalidParamsError(errData.error ?? "Failed to delete VIP policy");
  }

  const envelope = result.data as { ok: boolean; data: unknown };
  return envelope.data;
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
 *
 * @param rpcReq - Parsed JSON-RPC request.
 * @param user - Authenticated user context.
 * @param db - D1 database binding.
 * @param request - Original HTTP request (needed for JWT forwarding to service bindings).
 * @param env - Worker environment (needed for API service binding).
 */
async function dispatch(
  rpcReq: JsonRpcRequest,
  user: McpUserContext,
  db: D1Database,
  request: Request,
  env: McpEnv,
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

      // Tier-based authorization: check BEFORE executing the tool (fail fast)
      const tierCheck = checkTierAccess(toolName, user.tier);
      if (!tierCheck.allowed) {
        return makeErrorResponse(
          rpcReq.id,
          RPC_INTERNAL_ERROR,
          `This tool requires a ${tierCheck.required_tier} subscription. Please upgrade to access it.`,
          {
            code: "TIER_REQUIRED",
            required_tier: tierCheck.required_tier,
            current_tier: tierCheck.current_tier,
            tool: tierCheck.tool,
            upgrade_url: `https://app.tminus.ink/billing/upgrade?tier=${tierCheck.required_tier}`,
          },
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
          case "calendar.get_availability":
            result = await handleGetAvailability(user, db, toolArgs);
            break;
          case "calendar.list_policies":
            result = await handleListPolicies(user, db);
            break;
          case "calendar.get_policy_edge":
            result = await handleGetPolicyEdge(user, db, toolArgs);
            break;
          case "calendar.set_policy_edge":
            result = await handleSetPolicyEdge(user, db, toolArgs);
            break;
          case "calendar.add_trip": {
            if (!env.API) throw new ApiBindingMissingError();
            result = await handleAddTrip(request, env.API, toolArgs);
            break;
          }
          case "calendar.add_constraint": {
            if (!env.API) throw new ApiBindingMissingError();
            result = await handleAddConstraint(request, env.API, toolArgs);
            break;
          }
          case "calendar.list_constraints": {
            if (!env.API) throw new ApiBindingMissingError();
            result = await handleListConstraints(request, env.API, toolArgs);
            break;
          }
          case "calendar.propose_times": {
            if (!env.API) throw new ApiBindingMissingError();
            result = await handleProposeTimes(request, env.API, toolArgs);
            break;
          }
          case "calendar.commit_candidate": {
            if (!env.API) throw new ApiBindingMissingError();
            result = await handleCommitCandidate(request, env.API, toolArgs);
            break;
          }
          case "calendar.set_vip": {
            if (!env.API) throw new ApiBindingMissingError();
            result = await handleSetVip(request, env.API, toolArgs);
            break;
          }
          case "calendar.list_vips": {
            if (!env.API) throw new ApiBindingMissingError();
            result = await handleListVips(request, env.API);
            break;
          }
          case "calendar.delete_vip": {
            if (!env.API) throw new ApiBindingMissingError();
            result = await handleDeleteVip(request, env.API, toolArgs);
            break;
          }
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
        if (err instanceof PolicyNotFoundError) {
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
        if (err instanceof NoCandidatesError) {
          return makeErrorResponse(
            rpcReq.id,
            RPC_INVALID_PARAMS,
            err.message,
            { code: "NO_CANDIDATES" },
          );
        }
        if (err instanceof ApiBindingMissingError) {
          return makeErrorResponse(
            rpcReq.id,
            RPC_INTERNAL_ERROR,
            "API service binding is not configured",
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
  const result = await dispatch(rpcReq, user, env.DB, request, env);
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
  validateGetAvailabilityParams,
  generateTimeSlots,
  computeAvailabilitySlots,
  validateGetPolicyEdgeParams,
  validateSetPolicyEdgeParams,
  checkTierAccess,
  validateAddTripParams,
  validateAddConstraintParams,
  validateListConstraintsParams,
  validateProposeTimesParams,
  validateCommitCandidateParams,
};
