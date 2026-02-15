/**
 * tminus-api -- Main REST API worker.
 *
 * Provides programmatic access to accounts, events, policies, and sync status.
 * Hosts UserGraphDO and AccountDO class definitions (per wrangler.toml).
 *
 * Key design:
 * - Bearer token auth (JWT HS256) on all /v1/* routes
 * - Consistent response envelope: {ok, data, error, meta}
 * - Cursor-based pagination on list endpoints
 * - Routes delegate to UserGraphDO and AccountDO via DO stubs
 * - D1 for account lookups (cross-user registry)
 */

import { isValidId, generateId, isValidBillingCategory, BILLING_CATEGORIES, isValidRelationshipCategory, RELATIONSHIP_CATEGORIES, isValidOutcome, INTERACTION_OUTCOMES, isValidMilestoneKind, isValidMilestoneDate, MILESTONE_KINDS, buildExcusePrompt, parseExcuseResponse, buildVCalendar } from "@tminus/shared";
import type { CanonicalEvent, SimulationScenario, ImpactReport } from "@tminus/shared";
import type { ExcuseTone, TruthLevel, ExcuseContext } from "@tminus/shared";
import {
  checkRateLimit as checkRL,
  selectRateLimitConfig,
  getRateLimitIdentity,
  detectAuthEndpoint,
  extractClientIp,
  buildRateLimitResponse,
  applyRateLimitHeaders,
  addSecurityHeaders,
  addCorsHeaders,
  buildPreflightResponse,
} from "@tminus/shared";
import type { RateLimitKV, RateLimitTier } from "@tminus/shared";
import { createAuthRoutes } from "./routes/auth";
import {
  handleCreateDeletionRequest,
  handleGetDeletionRequest,
  handleCancelDeletionRequest,
} from "./routes/privacy";
import {
  handleCreateCheckoutSession,
  handleStripeWebhook,
  handleGetBillingStatus,
  handleCreatePortalSession,
  handleGetBillingEvents,
} from "./routes/billing";
import type { BillingEnv } from "./routes/billing";
import {
  handleCreateSchedulingSession,
  handleListSchedulingSessions,
  handleGetSchedulingSession,
  handleGetSchedulingCandidates,
  handleCommitSchedulingCandidate,
  handleCancelSchedulingSession,
  handleExtendHold,
} from "./routes/scheduling";
import {
  handleCreateGroupSession,
  handleGetGroupSession,
  handleCommitGroupSession,
} from "./routes/group-scheduling";
import { enforceFeatureGate, enforceAccountLimit } from "./middleware/feature-gate";
import { generateApiKey, hashApiKey, isApiKeyFormat, extractPrefix } from "./api-keys";
import {
  formatGraphEvent,
  formatGraphRelationship,
  formatTimelineEntry,
  filterGraphEvents,
  filterGraphRelationships,
  filterTimeline,
  buildGraphOpenApiSpec,
} from "./routes/graph";
import type { GraphEventInput, GraphRelationshipInput, TimelineEntryInput } from "./routes/graph";
import {
  handleCreateOrg,
  handleGetOrg,
  handleAddMember,
  handleListMembers,
  handleRemoveMember,
  handleChangeRole,
  handleCreateOrgPolicy,
  handleListOrgPolicies,
  handleUpdateOrgPolicy,
  handleDeleteOrgPolicy,
} from "./routes/orgs";

// ---------------------------------------------------------------------------
// Version -- read from package.json at build time or fallback
// ---------------------------------------------------------------------------

export const API_VERSION = "0.0.1";

// ---------------------------------------------------------------------------
// Durable Object class re-exports (required by wrangler for DO hosting)
// ---------------------------------------------------------------------------

export { UserGraphDO } from "@tminus/do-user-graph";
export { AccountDO } from "@tminus/do-account";

// ---------------------------------------------------------------------------
// Error codes (from DESIGN.md Section 3)
// ---------------------------------------------------------------------------

export const ErrorCode = {
  VALIDATION_ERROR: 400,
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  ACCOUNT_REVOKED: 422,
  ACCOUNT_SYNC_STALE: 422,
  PROVIDER_ERROR: 502,
  PROVIDER_QUOTA: 429,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCodeName = keyof typeof ErrorCode;

// ---------------------------------------------------------------------------
// Response envelope
// ---------------------------------------------------------------------------

export interface ApiEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  meta: {
    request_id: string;
    timestamp: string;
    next_cursor?: string;
  };
}

/** Generate a short request ID (not cryptographically secure, just for tracing). */
function generateRequestId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `req_${ts}_${rand}`;
}

export function successEnvelope<T>(data: T, meta?: { next_cursor?: string }): ApiEnvelope<T> {
  return {
    ok: true,
    data,
    meta: {
      request_id: generateRequestId(),
      timestamp: new Date().toISOString(),
      ...(meta?.next_cursor ? { next_cursor: meta.next_cursor } : {}),
    },
  };
}

export function errorEnvelope(error: string, code: ErrorCodeName): ApiEnvelope {
  return {
    ok: false,
    error,
    meta: {
      request_id: generateRequestId(),
      timestamp: new Date().toISOString(),
    },
  };
}

function jsonResponse(envelope: ApiEnvelope, status: number): Response {
  return new Response(JSON.stringify(envelope), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// JWT validation (HS256, Phase 1 simple)
// ---------------------------------------------------------------------------

/**
 * Decode and validate a JWT signed with HS256.
 *
 * Returns the payload on success, or null on failure.
 * Phase 1: simple validation -- no audience/issuer checks.
 */
export async function verifyJwt(
  token: string,
  secret: string,
): Promise<{ sub: string; [key: string]: unknown } | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;

    // Decode header and verify algorithm
    const header = JSON.parse(b64UrlDecode(headerB64));
    if (header.alg !== "HS256") return null;

    // Verify signature
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const signatureData = b64UrlToBytes(signatureB64);
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

    const valid = await crypto.subtle.verify("HMAC", key, signatureData, signingInput);
    if (!valid) return null;

    // Decode payload
    const payload = JSON.parse(b64UrlDecode(payloadB64));

    // Check expiration
    if (payload.exp && typeof payload.exp === "number") {
      const now = Math.floor(Date.now() / 1000);
      if (now >= payload.exp) return null;
    }

    // Must have sub claim
    if (!payload.sub || typeof payload.sub !== "string") return null;

    return payload;
  } catch {
    return null;
  }
}

/** Base64URL decode to string. */
function b64UrlDecode(str: string): string {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  const fullPadded = pad ? padded + "=".repeat(4 - pad) : padded;
  return atob(fullPadded);
}

/** Base64URL decode to Uint8Array. */
function b64UrlToBytes(str: string): Uint8Array {
  const decoded = b64UrlDecode(str);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) {
    bytes[i] = decoded.charCodeAt(i);
  }
  return bytes;
}

/**
 * Create a JWT signed with HS256. Used for testing.
 * Exported so test code can create valid tokens.
 */
export async function createJwt(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = b64UrlEncode(JSON.stringify(header));
  const payloadB64 = b64UrlEncode(JSON.stringify(payload));

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = await crypto.subtle.sign("HMAC", key, signingInput);

  const signatureB64 = bytesToB64Url(new Uint8Array(signature));
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

/** Base64URL encode a string. */
function b64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Uint8Array to Base64URL. */
function bytesToB64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

interface AuthContext {
  userId: string;
}

async function extractAuth(
  request: Request,
  jwtSecret: string,
  db?: D1Database,
): Promise<AuthContext | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return null;

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return null;

  const token = parts[1];

  // API key path: if token starts with tmk_, validate as API key
  if (token.startsWith("tmk_")) {
    if (!db) return null;
    if (!isApiKeyFormat(token)) return null;

    const prefix = extractPrefix(token);
    if (!prefix) return null;

    try {
      const row = await db
        .prepare(
          `SELECT k.key_id, k.key_hash, k.user_id
           FROM api_keys k
           WHERE k.prefix = ?1 AND k.revoked_at IS NULL`,
        )
        .bind(prefix)
        .first<{
          key_id: string;
          key_hash: string;
          user_id: string;
        }>();

      if (!row) return null;

      const presentedHash = await hashApiKey(token);
      if (presentedHash !== row.key_hash) return null;

      // Update last_used_at (best-effort, non-blocking)
      db.prepare("UPDATE api_keys SET last_used_at = ?1 WHERE key_id = ?2")
        .bind(new Date().toISOString(), row.key_id)
        .run()
        .catch(() => {});

      return { userId: row.user_id };
    } catch {
      return null;
    }
  }

  // JWT path
  const payload = await verifyJwt(token, jwtSecret);
  if (!payload) return null;

  return { userId: payload.sub };
}

// ---------------------------------------------------------------------------
// Route parameter extraction
// ---------------------------------------------------------------------------

interface RouteMatch {
  /** Matched parameter values in order. */
  params: string[];
}

/**
 * Match a URL path against a pattern like "/v1/events/:id".
 * Returns matched params or null if no match.
 */
function matchRoute(pathname: string, pattern: string): RouteMatch | null {
  const pathParts = pathname.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);

  if (pathParts.length !== patternParts.length) return null;

  const params: string[] = [];
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params.push(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }

  return { params };
}

// ---------------------------------------------------------------------------
// DO stub helpers
// ---------------------------------------------------------------------------

/**
 * Send a JSON RPC-style request to a Durable Object.
 *
 * UserGraphDO and AccountDO in production will expose an HTTP API
 * (fetch handler inside the DO class). We send JSON payloads and
 * receive JSON responses.
 *
 * For this REST surface, the DO is addressed by user_id or account_id,
 * and the path maps to a DO method (e.g. /listCanonicalEvents).
 */
async function callDO<T>(
  namespace: DurableObjectNamespace,
  name: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: T }> {
  const id = namespace.idFromName(name);
  const stub = namespace.get(id);

  const init: RequestInit = {
    method: body !== undefined ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const response = await stub.fetch(`https://do.internal${path}`, init);
  const data = (await response.json()) as T;
  return { ok: response.ok, status: response.status, data };
}

// ---------------------------------------------------------------------------
// Request body parsing
// ---------------------------------------------------------------------------

async function parseJsonBody<T>(request: Request): Promise<T | null> {
  try {
    const text = await request.text();
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

// -- Accounts ---------------------------------------------------------------

async function handleAccountLink(
  _request: Request,
  _auth: AuthContext,
  _env: Env,
): Promise<Response> {
  // Phase 1: redirect to oauth-worker URL
  // In production, this would construct the OAuth URL. For now, return the
  // redirect information in the envelope.
  const envelope = successEnvelope({
    redirect_url: "/oauth/google/authorize",
    message: "Redirect to OAuth flow to link a new account",
  });
  return jsonResponse(envelope, 200);
}

async function handleListAccounts(
  _request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    const result = await env.DB
      .prepare(
        "SELECT account_id, user_id, provider, email, status, created_at FROM accounts WHERE user_id = ?1",
      )
      .bind(auth.userId)
      .all<{
        account_id: string;
        user_id: string;
        provider: string;
        email: string;
        status: string;
        created_at: string;
      }>();

    const accounts = result.results ?? [];
    return jsonResponse(successEnvelope(accounts), 200);
  } catch (err) {
    console.error("Failed to list accounts", err);
    return jsonResponse(
      errorEnvelope("Failed to list accounts", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleGetAccount(
  _request: Request,
  auth: AuthContext,
  env: Env,
  accountId: string,
): Promise<Response> {
  if (!isValidId(accountId, "account")) {
    return jsonResponse(
      errorEnvelope("Invalid account ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    // Get account from D1
    const row = await env.DB
      .prepare(
        "SELECT account_id, user_id, provider, email, status, created_at FROM accounts WHERE account_id = ?1 AND user_id = ?2",
      )
      .bind(accountId, auth.userId)
      .first<{
        account_id: string;
        user_id: string;
        provider: string;
        email: string;
        status: string;
        created_at: string;
      }>();

    if (!row) {
      return jsonResponse(
        errorEnvelope("Account not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    // Get health from AccountDO
    const health = await callDO<{
      lastSyncTs: string | null;
      lastSuccessTs: string | null;
      fullSyncNeeded: boolean;
    }>(env.ACCOUNT, accountId, "/getHealth");

    return jsonResponse(
      successEnvelope({
        ...row,
        health: health.ok ? health.data : null,
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to get account", err);
    return jsonResponse(
      errorEnvelope("Failed to get account details", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleDeleteAccount(
  _request: Request,
  auth: AuthContext,
  env: Env,
  accountId: string,
): Promise<Response> {
  if (!isValidId(accountId, "account")) {
    return jsonResponse(
      errorEnvelope("Invalid account ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    // Verify ownership in D1
    const row = await env.DB
      .prepare(
        "SELECT account_id FROM accounts WHERE account_id = ?1 AND user_id = ?2",
      )
      .bind(accountId, auth.userId)
      .first<{ account_id: string }>();

    if (!row) {
      return jsonResponse(
        errorEnvelope("Account not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    // Step 1: Revoke OAuth tokens (AccountDO)
    // Errors are non-fatal -- tokens may already be revoked
    try {
      await callDO(env.ACCOUNT, accountId, "/revokeTokens", {});
    } catch {
      // Proceed anyway -- tokens may already be revoked
    }

    // Step 2: Stop watch channels (AccountDO)
    try {
      await callDO(env.ACCOUNT, accountId, "/stopWatchChannels", {});
    } catch {
      // Proceed anyway -- channels may already be expired
    }

    // Steps 3-8: Cascade cleanup in UserGraphDO
    // (mirrors, events, policies, calendars, journal)
    await callDO(env.USER_GRAPH, auth.userId, "/unlinkAccount", {
      account_id: accountId,
    });

    // Step 9: Update D1 registry status
    await env.DB
      .prepare("UPDATE accounts SET status = 'revoked' WHERE account_id = ?1")
      .bind(accountId)
      .run();

    return jsonResponse(successEnvelope({ deleted: true }), 200);
  } catch (err) {
    console.error("Failed to delete account", err);
    return jsonResponse(
      errorEnvelope("Failed to delete account", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- Events ---------------------------------------------------------------

async function handleListEvents(
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

  if (start) query.time_min = start;
  if (end) query.time_max = end;
  if (accountIdFilter) query.origin_account_id = accountIdFilter;
  if (cursor) query.cursor = cursor;
  if (limitStr) {
    const limit = parseInt(limitStr, 10);
    if (!isNaN(limit) && limit > 0) query.limit = limit;
  }

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

async function handleGetEvent(
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

async function handleCreateEvent(
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

async function handleUpdateEvent(
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

async function handleDeleteEvent(
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

// -- Policies -------------------------------------------------------------

async function handleListPolicies(
  _request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    const result = await callDO<{
      items: unknown[];
      cursor: string | null;
      has_more: boolean;
    }>(env.USER_GRAPH, auth.userId, "/listPolicies");

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to list policies", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(
      successEnvelope(result.data.items ?? result.data, {
        next_cursor: result.data.cursor ?? undefined,
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to list policies", err);
    return jsonResponse(
      errorEnvelope("Failed to list policies", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleGetPolicy(
  _request: Request,
  auth: AuthContext,
  env: Env,
  policyId: string,
): Promise<Response> {
  if (!isValidId(policyId, "policy")) {
    return jsonResponse(
      errorEnvelope("Invalid policy ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<unknown>(
      env.USER_GRAPH,
      auth.userId,
      "/getPolicy",
      { policy_id: policyId },
    );

    if (!result.ok || result.data === null) {
      return jsonResponse(
        errorEnvelope("Policy not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to get policy", err);
    return jsonResponse(
      errorEnvelope("Failed to get policy", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleCreatePolicy(
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

  if (!body.name || typeof body.name !== "string") {
    return jsonResponse(
      errorEnvelope("Policy must have a name", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<unknown>(
      env.USER_GRAPH,
      auth.userId,
      "/createPolicy",
      body,
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to create policy", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 201);
  } catch (err) {
    console.error("Failed to create policy", err);
    return jsonResponse(
      errorEnvelope("Failed to create policy", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleSetPolicyEdges(
  request: Request,
  auth: AuthContext,
  env: Env,
  policyId: string,
): Promise<Response> {
  if (!isValidId(policyId, "policy")) {
    return jsonResponse(
      errorEnvelope("Invalid policy ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const body = await parseJsonBody<{ edges: unknown[] }>(request);
  if (!body || !Array.isArray(body.edges)) {
    return jsonResponse(
      errorEnvelope("Request body must include an edges array", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    // Set edges and trigger recomputeProjections
    const result = await callDO<unknown>(
      env.USER_GRAPH,
      auth.userId,
      "/setPolicyEdges",
      { policy_id: policyId, edges: body.edges },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to set policy edges", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to set policy edges", err);
    return jsonResponse(
      errorEnvelope("Failed to set policy edges", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- Sync Status ----------------------------------------------------------

async function handleAggregateStatus(
  _request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    // Get all accounts for this user
    const accountsResult = await env.DB
      .prepare("SELECT account_id, status FROM accounts WHERE user_id = ?1")
      .bind(auth.userId)
      .all<{ account_id: string; status: string }>();

    const accounts = accountsResult.results ?? [];
    const healthResults: Array<{
      account_id: string;
      status: string;
      health: unknown;
    }> = [];

    // Get health from each account's DO
    for (const account of accounts) {
      try {
        const health = await callDO(
          env.ACCOUNT,
          account.account_id,
          "/getHealth",
        );
        healthResults.push({
          account_id: account.account_id,
          status: account.status,
          health: health.ok ? health.data : null,
        });
      } catch {
        healthResults.push({
          account_id: account.account_id,
          status: account.status,
          health: null,
        });
      }
    }

    // Get UserGraphDO sync health
    const userGraphHealth = await callDO(
      env.USER_GRAPH,
      auth.userId,
      "/getSyncHealth",
    );

    return jsonResponse(
      successEnvelope({
        accounts: healthResults,
        user_graph: userGraphHealth.ok ? userGraphHealth.data : null,
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to get aggregate status", err);
    return jsonResponse(
      errorEnvelope("Failed to get sync status", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleAccountStatus(
  _request: Request,
  auth: AuthContext,
  env: Env,
  accountId: string,
): Promise<Response> {
  if (!isValidId(accountId, "account")) {
    return jsonResponse(
      errorEnvelope("Invalid account ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    // Verify ownership
    const row = await env.DB
      .prepare(
        "SELECT account_id FROM accounts WHERE account_id = ?1 AND user_id = ?2",
      )
      .bind(accountId, auth.userId)
      .first<{ account_id: string }>();

    if (!row) {
      return jsonResponse(
        errorEnvelope("Account not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    const health = await callDO(env.ACCOUNT, accountId, "/getHealth");

    return jsonResponse(
      successEnvelope(health.ok ? health.data : null),
      200,
    );
  } catch (err) {
    console.error("Failed to get account status", err);
    return jsonResponse(
      errorEnvelope("Failed to get account status", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleJournal(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const query: Record<string, unknown> = {};

  const eventId = url.searchParams.get("event_id");
  const cursor = url.searchParams.get("cursor");
  const limitStr = url.searchParams.get("limit");

  if (eventId) query.canonical_event_id = eventId;
  if (cursor) query.cursor = cursor;
  if (limitStr) {
    const limit = parseInt(limitStr, 10);
    if (!isNaN(limit) && limit > 0) query.limit = limit;
  }

  try {
    const result = await callDO<{
      items: unknown[];
      cursor: string | null;
      has_more: boolean;
    }>(env.USER_GRAPH, auth.userId, "/queryJournal", query);

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to query journal", "INTERNAL_ERROR"),
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
    console.error("Failed to query journal", err);
    return jsonResponse(
      errorEnvelope("Failed to query journal", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- Constraint config validation (API-level, before DO call) -----------------

/** Valid constraint kinds. Must stay in sync with UserGraphDO.VALID_CONSTRAINT_KINDS. */
export const VALID_CONSTRAINT_KINDS = new Set(["trip", "working_hours", "buffer", "no_meetings_after", "override"]);

/**
 * Validate constraint kind and config_json at the API level.
 * Returns an error message string if validation fails, or null if valid.
 *
 * This provides fast feedback before hitting the DO. The DO also validates,
 * so this is a defense-in-depth measure, not the sole validation point.
 */
export function validateConstraintKindAndConfig(
  kind: string,
  configJson: Record<string, unknown>,
  activeFrom?: string | null,
  activeTo?: string | null,
): string | null {
  if (!VALID_CONSTRAINT_KINDS.has(kind)) {
    return `Invalid constraint kind "${kind}". Must be one of: ${[...VALID_CONSTRAINT_KINDS].join(", ")}`;
  }

  const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

  switch (kind) {
    case "trip": {
      if (!configJson.name || typeof configJson.name !== "string") {
        return "Trip config_json must include a 'name' string";
      }
      if (!configJson.timezone || typeof configJson.timezone !== "string") {
        return "Trip config_json must include a 'timezone' string";
      }
      const validPolicies = ["BUSY", "TITLE"];
      if (!configJson.block_policy || !validPolicies.includes(configJson.block_policy as string)) {
        return `Trip config_json.block_policy must be one of: ${validPolicies.join(", ")}`;
      }
      if (!activeFrom || !activeTo) {
        return "Trip constraint must have active_from and active_to";
      }
      break;
    }
    case "working_hours": {
      if (!Array.isArray(configJson.days) || configJson.days.length === 0) {
        return "Working hours config_json must include a non-empty 'days' array";
      }
      for (const day of configJson.days) {
        if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) {
          return `Working hours config_json.days values must be integers 0-6, got ${JSON.stringify(day)}`;
        }
      }
      if (typeof configJson.start_time !== "string" || !timeRegex.test(configJson.start_time)) {
        return "Working hours config_json must include 'start_time' in HH:MM 24-hour format";
      }
      if (typeof configJson.end_time !== "string" || !timeRegex.test(configJson.end_time)) {
        return "Working hours config_json must include 'end_time' in HH:MM 24-hour format";
      }
      if (configJson.end_time <= configJson.start_time) {
        return "Working hours config_json.end_time must be after start_time";
      }
      if (typeof configJson.timezone !== "string" || configJson.timezone.length === 0) {
        return "Working hours config_json must include a 'timezone' string";
      }
      break;
    }
    case "buffer": {
      const validTypes = ["travel", "prep", "cooldown"];
      if (typeof configJson.type !== "string" || !validTypes.includes(configJson.type)) {
        return `Buffer config_json.type must be one of: ${validTypes.join(", ")}`;
      }
      if (typeof configJson.minutes !== "number" || !Number.isInteger(configJson.minutes) || configJson.minutes <= 0) {
        return "Buffer config_json.minutes must be a positive integer";
      }
      const validAppliesTo = ["all", "external"];
      if (typeof configJson.applies_to !== "string" || !validAppliesTo.includes(configJson.applies_to)) {
        return `Buffer config_json.applies_to must be one of: ${validAppliesTo.join(", ")}`;
      }
      break;
    }
    case "no_meetings_after": {
      if (typeof configJson.time !== "string" || !timeRegex.test(configJson.time)) {
        return "no_meetings_after config_json must include 'time' in HH:MM 24-hour format";
      }
      if (typeof configJson.timezone !== "string" || configJson.timezone.length === 0) {
        return "no_meetings_after config_json must include a 'timezone' string";
      }
      break;
    }
    case "override": {
      if (typeof configJson.reason !== "string" || configJson.reason.trim().length === 0) {
        return "override config_json must include a non-empty 'reason' string";
      }
      // slot_start and slot_end are required for working hours bypass (TM-yke.2)
      if (configJson.slot_start !== undefined) {
        if (typeof configJson.slot_start !== "string" || isNaN(Date.parse(configJson.slot_start))) {
          return "override config_json.slot_start must be a valid ISO 8601 date string";
        }
      }
      if (configJson.slot_end !== undefined) {
        if (typeof configJson.slot_end !== "string" || isNaN(Date.parse(configJson.slot_end))) {
          return "override config_json.slot_end must be a valid ISO 8601 date string";
        }
      }
      if (configJson.slot_start && configJson.slot_end) {
        if (new Date(configJson.slot_start as string) >= new Date(configJson.slot_end as string)) {
          return "override config_json.slot_start must be before slot_end";
        }
      }
      if (configJson.timezone !== undefined) {
        if (typeof configJson.timezone !== "string" || configJson.timezone.length === 0) {
          return "override config_json.timezone must be a non-empty string";
        }
        try {
          Intl.DateTimeFormat(undefined, { timeZone: configJson.timezone as string });
        } catch {
          return `override config_json.timezone "${configJson.timezone}" is not a valid IANA timezone`;
        }
      }
      break;
    }
  }

  return null;
}

// -- Constraints (Trips, Working Hours, etc.) --------------------------------

async function handleCreateConstraint(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const body = await parseJsonBody<{
    kind?: string;
    config_json?: Record<string, unknown>;
    active_from?: string;
    active_to?: string;
  }>(request);

  if (!body) {
    return jsonResponse(
      errorEnvelope("Request body must be valid JSON", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Validate required fields
  if (!body.kind || typeof body.kind !== "string") {
    return jsonResponse(
      errorEnvelope("Constraint must have a 'kind' field", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!body.config_json || typeof body.config_json !== "object") {
    return jsonResponse(
      errorEnvelope("Constraint must have a 'config_json' object", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Validate ISO 8601 date strings when provided
  if (body.active_from && isNaN(Date.parse(body.active_from))) {
    return jsonResponse(
      errorEnvelope("active_from must be a valid ISO 8601 date string", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }
  if (body.active_to && isNaN(Date.parse(body.active_to))) {
    return jsonResponse(
      errorEnvelope("active_to must be a valid ISO 8601 date string", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Kind-specific config validation (API-level, fast feedback)
  const kindError = validateConstraintKindAndConfig(
    body.kind,
    body.config_json,
    body.active_from,
    body.active_to,
  );
  if (kindError) {
    return jsonResponse(
      errorEnvelope(kindError, "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{
      constraint_id: string;
      kind: string;
      config_json: Record<string, unknown>;
      active_from: string | null;
      active_to: string | null;
      created_at: string;
    }>(env.USER_GRAPH, auth.userId, "/addConstraint", {
      kind: body.kind,
      config_json: body.config_json,
      active_from: body.active_from ?? null,
      active_to: body.active_to ?? null,
    });

    if (!result.ok) {
      // Check if it's a validation error from the DO
      const errData = result.data as unknown as { error?: string };
      const errMsg = errData?.error ?? "Failed to create constraint";
      return jsonResponse(
        errorEnvelope(errMsg, "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 201);
  } catch (err) {
    console.error("Failed to create constraint", err);
    return jsonResponse(
      errorEnvelope("Failed to create constraint", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleListConstraints(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const kindFilter = url.searchParams.get("kind");

  try {
    const result = await callDO<{
      items: unknown[];
    }>(env.USER_GRAPH, auth.userId, "/listConstraints", {
      kind: kindFilter ?? undefined,
    });

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to list constraints", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data.items ?? result.data), 200);
  } catch (err) {
    console.error("Failed to list constraints", err);
    return jsonResponse(
      errorEnvelope("Failed to list constraints", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleDeleteConstraint(
  _request: Request,
  auth: AuthContext,
  env: Env,
  constraintId: string,
): Promise<Response> {
  if (!isValidId(constraintId, "constraint")) {
    return jsonResponse(
      errorEnvelope("Invalid constraint ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{ deleted: boolean }>(
      env.USER_GRAPH,
      auth.userId,
      "/deleteConstraint",
      { constraint_id: constraintId },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to delete constraint", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    if (!result.data.deleted) {
      return jsonResponse(
        errorEnvelope("Constraint not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope({ deleted: true }), 200);
  } catch (err) {
    console.error("Failed to delete constraint", err);
    return jsonResponse(
      errorEnvelope("Failed to delete constraint", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleGetConstraint(
  _request: Request,
  auth: AuthContext,
  env: Env,
  constraintId: string,
): Promise<Response> {
  if (!isValidId(constraintId, "constraint")) {
    return jsonResponse(
      errorEnvelope("Invalid constraint ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{
      constraint_id: string;
      kind: string;
      config_json: Record<string, unknown>;
      active_from: string | null;
      active_to: string | null;
      created_at: string;
    } | null>(env.USER_GRAPH, auth.userId, "/getConstraint", {
      constraint_id: constraintId,
    });

    if (!result.ok || result.data === null) {
      return jsonResponse(
        errorEnvelope("Constraint not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to get constraint", err);
    return jsonResponse(
      errorEnvelope("Failed to get constraint", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleUpdateConstraint(
  request: Request,
  auth: AuthContext,
  env: Env,
  constraintId: string,
): Promise<Response> {
  if (!isValidId(constraintId, "constraint")) {
    return jsonResponse(
      errorEnvelope("Invalid constraint ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const body = await parseJsonBody<{
    config_json?: Record<string, unknown>;
    active_from?: string | null;
    active_to?: string | null;
  }>(request);

  if (!body) {
    return jsonResponse(
      errorEnvelope("Request body must be valid JSON", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!body.config_json || typeof body.config_json !== "object") {
    return jsonResponse(
      errorEnvelope("Constraint update must include a 'config_json' object", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Validate ISO 8601 date strings when provided
  if (body.active_from && typeof body.active_from === "string" && isNaN(Date.parse(body.active_from))) {
    return jsonResponse(
      errorEnvelope("active_from must be a valid ISO 8601 date string", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }
  if (body.active_to && typeof body.active_to === "string" && isNaN(Date.parse(body.active_to))) {
    return jsonResponse(
      errorEnvelope("active_to must be a valid ISO 8601 date string", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Note: kind-specific validation cannot be done at API level for updates
  // because we don't know the kind until we fetch from the DO. The DO handles this.

  try {
    const result = await callDO<{
      constraint_id: string;
      kind: string;
      config_json: Record<string, unknown>;
      active_from: string | null;
      active_to: string | null;
      created_at: string;
    } | null>(env.USER_GRAPH, auth.userId, "/updateConstraint", {
      constraint_id: constraintId,
      config_json: body.config_json,
      active_from: body.active_from ?? null,
      active_to: body.active_to ?? null,
    });

    if (!result.ok || result.data === null) {
      return jsonResponse(
        errorEnvelope("Constraint not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to update constraint", err);
    return jsonResponse(
      errorEnvelope("Failed to update constraint", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- Scheduling Override (TM-yke.2) -----------------------------------------

/**
 * POST /v1/scheduling/override
 *
 * Creates an override constraint that exempts a specific time window from
 * working hours enforcement. This is the "escape hatch" that allows
 * scheduling outside working hours without VIP status.
 *
 * Required fields:
 * - reason: non-empty string explaining the override
 * - slot_start: ISO 8601 start of the override window
 * - slot_end: ISO 8601 end of the override window
 *
 * Optional fields:
 * - timezone: IANA timezone (defaults to UTC)
 */
async function handleCreateSchedulingOverride(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const body = await parseJsonBody<{
    reason?: string;
    slot_start?: string;
    slot_end?: string;
    timezone?: string;
  }>(request);

  if (!body) {
    return jsonResponse(
      errorEnvelope("Request body must be valid JSON", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Validate required fields
  if (!body.reason || typeof body.reason !== "string" || body.reason.trim().length === 0) {
    return jsonResponse(
      errorEnvelope("reason is required and must be a non-empty string", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!body.slot_start || typeof body.slot_start !== "string") {
    return jsonResponse(
      errorEnvelope("slot_start is required (ISO 8601 datetime)", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }
  if (isNaN(Date.parse(body.slot_start))) {
    return jsonResponse(
      errorEnvelope("slot_start must be a valid ISO 8601 date string", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!body.slot_end || typeof body.slot_end !== "string") {
    return jsonResponse(
      errorEnvelope("slot_end is required (ISO 8601 datetime)", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }
  if (isNaN(Date.parse(body.slot_end))) {
    return jsonResponse(
      errorEnvelope("slot_end must be a valid ISO 8601 date string", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (new Date(body.slot_start) >= new Date(body.slot_end)) {
    return jsonResponse(
      errorEnvelope("slot_start must be before slot_end", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Validate timezone if provided
  const timezone = body.timezone ?? "UTC";
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    return jsonResponse(
      errorEnvelope(`timezone "${timezone}" is not a valid IANA timezone`, "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Create an override constraint via the existing constraint pipeline
  const configJson = {
    reason: body.reason.trim(),
    slot_start: body.slot_start,
    slot_end: body.slot_end,
    timezone,
  };

  try {
    const result = await callDO<{
      constraint_id: string;
      kind: string;
      config_json: Record<string, unknown>;
      active_from: string | null;
      active_to: string | null;
      created_at: string;
    }>(env.USER_GRAPH, auth.userId, "/addConstraint", {
      kind: "override",
      config_json: configJson,
      active_from: body.slot_start,
      active_to: body.slot_end,
    });

    if (!result.ok) {
      const errData = result.data as unknown as { error?: string };
      const errMsg = errData?.error ?? "Failed to create scheduling override";
      return jsonResponse(
        errorEnvelope(errMsg, "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 201);
  } catch (err) {
    console.error("Failed to create scheduling override", err);
    return jsonResponse(
      errorEnvelope("Failed to create scheduling override", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- Time Allocations -------------------------------------------------------

async function handleSetAllocation(
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

async function handleGetAllocation(
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

async function handleUpdateAllocation(
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

async function handleDeleteAllocation(
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

// -- Pre-meeting context briefing ---------------------------------------------

async function handleGetEventBriefing(
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
      event_id: string;
      event_title: string | null;
      event_start: string;
      topics: string[];
      participants: Array<{
        participant_hash: string;
        display_name: string | null;
        category: string;
        last_interaction_ts: string | null;
        last_interaction_summary: string | null;
        reputation_score: number;
        mutual_connections_count: number;
      }>;
      computed_at: string;
    } | { error: string }>(env.USER_GRAPH, auth.userId, "/getEventBriefing", {
      canonical_event_id: eventId,
    });

    if (!result.ok) {
      const errData = result.data as { error?: string };
      if (result.status === 404) {
        return jsonResponse(
          errorEnvelope(errData.error ?? "Event not found", "NOT_FOUND"),
          ErrorCode.NOT_FOUND,
        );
      }
      return jsonResponse(
        errorEnvelope(errData.error ?? "Failed to get event briefing", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to get event briefing", err);
    return jsonResponse(
      errorEnvelope("Failed to get event briefing", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- Excuse generator (BR-17: draft only, never auto-send) -------------------

const VALID_TONES: ExcuseTone[] = ["formal", "casual", "apologetic"];
const VALID_TRUTH_LEVELS: TruthLevel[] = ["full", "vague", "white_lie"];

async function handleGenerateExcuse(
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
    tone?: string;
    truth_level?: string;
  }>(request);

  if (!body) {
    return jsonResponse(
      errorEnvelope("Request body is required", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Validate tone
  const tone = body.tone as ExcuseTone | undefined;
  if (!tone || !VALID_TONES.includes(tone)) {
    return jsonResponse(
      errorEnvelope(
        `Invalid tone. Must be one of: ${VALID_TONES.join(", ")}`,
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Validate truth_level
  const truthLevel = body.truth_level as TruthLevel | undefined;
  if (!truthLevel || !VALID_TRUTH_LEVELS.includes(truthLevel)) {
    return jsonResponse(
      errorEnvelope(
        `Invalid truth_level. Must be one of: ${VALID_TRUTH_LEVELS.join(", ")}`,
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    // Step 1: Get event briefing for context
    const briefingResult = await callDO<{
      event_id: string;
      event_title: string | null;
      event_start: string;
      topics: string[];
      participants: Array<{
        participant_hash: string;
        display_name: string | null;
        category: string;
        last_interaction_ts: string | null;
        last_interaction_summary: string | null;
        reputation_score: number;
        mutual_connections_count: number;
      }>;
      computed_at: string;
    } | { error: string }>(env.USER_GRAPH, auth.userId, "/getEventBriefing", {
      canonical_event_id: eventId,
    });

    if (!briefingResult.ok) {
      const errData = briefingResult.data as { error?: string };
      if (briefingResult.status === 404) {
        return jsonResponse(
          errorEnvelope(errData.error ?? "Event not found", "NOT_FOUND"),
          ErrorCode.NOT_FOUND,
        );
      }
      return jsonResponse(
        errorEnvelope(errData.error ?? "Failed to get event context", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    const briefing = briefingResult.data as {
      event_id: string;
      event_title: string | null;
      event_start: string;
      participants: Array<{
        display_name: string | null;
        category: string;
        last_interaction_summary: string | null;
        reputation_score: number;
      }>;
    };

    // Step 2: Pick the primary participant (first one, highest reputation)
    const primaryParticipant = briefing.participants[0] ?? null;

    // Step 3: Build the excuse context from briefing + user input
    const excuseCtx: ExcuseContext = {
      event_title: briefing.event_title,
      event_start: briefing.event_start,
      participant_name: primaryParticipant?.display_name ?? null,
      participant_category: primaryParticipant?.category ?? "UNKNOWN",
      last_interaction_summary: primaryParticipant?.last_interaction_summary ?? null,
      reputation_score: primaryParticipant?.reputation_score ?? 0,
      tone,
      truth_level: truthLevel,
    };

    // Step 4: Build prompt and call Workers AI
    const prompt = buildExcusePrompt(excuseCtx);
    let aiResponse = "";

    if (env.AI) {
      try {
        const aiResult = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct-fp8",
          {
            prompt,
            max_tokens: 256,
          },
        );
        // Workers AI returns { response: string } for text generation
        if (aiResult && typeof aiResult === "object" && "response" in aiResult) {
          aiResponse = (aiResult as { response: string }).response;
        }
      } catch (aiErr) {
        // AI failure is non-fatal -- fall back to template
        console.error("Workers AI inference failed, using template fallback:", aiErr);
      }
    }

    // Step 5: Parse response (uses fallback template if AI returned empty)
    const excuseOutput = parseExcuseResponse(aiResponse, tone, truthLevel);

    return jsonResponse(successEnvelope(excuseOutput), 200);
  } catch (err) {
    console.error("Failed to generate excuse", err);
    return jsonResponse(
      errorEnvelope("Failed to generate excuse", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- Relationship tracking ---------------------------------------------------

async function handleCreateRelationship(
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

async function handleGetRelationship(
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

async function handleListRelationships(
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

async function handleUpdateRelationship(
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

async function handleDeleteRelationship(
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

// -- Milestone CRUD (Phase 4B) -----------------------------------------------

async function handleCreateMilestone(
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

async function handleListMilestones(
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

async function handleDeleteMilestone(
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

async function handleListUpcomingMilestones(
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

// -- Interaction Ledger (outcomes) -------------------------------------------

async function handleMarkOutcome(
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

async function handleListOutcomes(
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

// -- Reputation scoring (Phase 4) -------------------------------------------

async function handleGetReputation(
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

async function handleListRelationshipsWithReputation(
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

// -- Cognitive load intelligence -------------------------------------------------

async function handleGetCognitiveLoad(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const date = url.searchParams.get("date");
  const range = url.searchParams.get("range") ?? "day";

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return jsonResponse(
      errorEnvelope(
        "date query parameter is required (YYYY-MM-DD format)",
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (range !== "day" && range !== "week") {
    return jsonResponse(
      errorEnvelope(
        "range must be 'day' or 'week'",
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{
      score: number;
      meeting_density: number;
      context_switches: number;
      deep_work_blocks: number;
      fragmentation: number;
    }>(env.USER_GRAPH, auth.userId, "/getCognitiveLoad", { date, range });

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to compute cognitive load", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to compute cognitive load", err);
    return jsonResponse(
      errorEnvelope("Failed to compute cognitive load", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- Probabilistic availability -----------------------------------------------

async function handleGetAvailability(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode");
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  const granularityParam = url.searchParams.get("granularity");

  if (!start || !end) {
    return jsonResponse(
      errorEnvelope(
        "start and end query parameters are required (ISO 8601 datetime)",
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Validate ISO 8601 datetime format (basic check)
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (isNaN(startMs) || isNaN(endMs)) {
    return jsonResponse(
      errorEnvelope(
        "start and end must be valid ISO 8601 datetimes",
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (startMs >= endMs) {
    return jsonResponse(
      errorEnvelope(
        "start must be before end",
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Max 7 days to prevent excessively large responses
  const MAX_RANGE_MS = 7 * 24 * 60 * 60 * 1000;
  if (endMs - startMs > MAX_RANGE_MS) {
    return jsonResponse(
      errorEnvelope(
        "Time range must not exceed 7 days",
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Parse granularity (default 30 minutes)
  let granularity_minutes = 30;
  if (granularityParam) {
    const parsed = parseInt(granularityParam, 10);
    if (isNaN(parsed) || parsed <= 0 || parsed > 120) {
      return jsonResponse(
        errorEnvelope(
          "granularity must be a positive integer (minutes, max 120)",
          "VALIDATION_ERROR",
        ),
        ErrorCode.VALIDATION_ERROR,
      );
    }
    granularity_minutes = parsed;
  }

  if (mode === "probabilistic") {
    try {
      const result = await callDO<{
        slots: Array<{ start: string; end: string; probability: number }>;
      }>(env.USER_GRAPH, auth.userId, "/getProbabilisticAvailability", {
        start,
        end,
        granularity_minutes,
      });

      if (!result.ok) {
        return jsonResponse(
          errorEnvelope("Failed to compute probabilistic availability", "INTERNAL_ERROR"),
          ErrorCode.INTERNAL_ERROR,
        );
      }

      return jsonResponse(successEnvelope(result.data), 200);
    } catch (err) {
      console.error("Failed to compute probabilistic availability", err);
      return jsonResponse(
        errorEnvelope("Failed to compute probabilistic availability", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }
  }

  // Default mode: delegate to existing DO computeAvailability for binary free/busy
  try {
    const result = await callDO<{
      busy_intervals: Array<{ start: string; end: string; account_ids: string[] }>;
      free_intervals: Array<{ start: string; end: string }>;
    }>(env.USER_GRAPH, auth.userId, "/computeAvailability", {
      start,
      end,
    });

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to compute availability", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to compute availability", err);
    return jsonResponse(
      errorEnvelope("Failed to compute availability", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- Context-switch cost estimation -------------------------------------------

async function handleGetContextSwitches(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const date = url.searchParams.get("date");
  const range = url.searchParams.get("range") ?? "day";

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return jsonResponse(
      errorEnvelope(
        "date query parameter is required (YYYY-MM-DD format)",
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (range !== "day" && range !== "week") {
    return jsonResponse(
      errorEnvelope(
        "range must be 'day' or 'week'",
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{
      transitions: unknown[];
      total_cost: number;
      daily_costs: number[];
      suggestions: unknown[];
    }>(env.USER_GRAPH, auth.userId, "/getContextSwitches", { date, range });

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to compute context switches", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to compute context switches", err);
    return jsonResponse(
      errorEnvelope("Failed to compute context switches", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- Deep work window optimization ------------------------------------------------

async function handleGetDeepWork(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const date = url.searchParams.get("date");
  const range = url.searchParams.get("range") ?? "day";

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return jsonResponse(
      errorEnvelope(
        "date query parameter is required (YYYY-MM-DD format)",
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (range !== "day" && range !== "week") {
    return jsonResponse(
      errorEnvelope(
        "range must be 'day' or 'week'",
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Optional min_block_minutes parameter
  const minBlockStr = url.searchParams.get("min_block_minutes");
  const minBlockMinutes = minBlockStr ? parseInt(minBlockStr, 10) : undefined;
  if (minBlockMinutes !== undefined && (isNaN(minBlockMinutes) || minBlockMinutes < 1)) {
    return jsonResponse(
      errorEnvelope(
        "min_block_minutes must be a positive integer",
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const body: Record<string, unknown> = { date, range };
    if (minBlockMinutes !== undefined) body.min_block_minutes = minBlockMinutes;

    const result = await callDO<{
      blocks: unknown[];
      total_deep_hours: number;
      protected_hours_target: number;
      suggestions: unknown[];
    }>(env.USER_GRAPH, auth.userId, "/getDeepWork", body);

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to compute deep work report", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to compute deep work report", err);
    return jsonResponse(
      errorEnvelope("Failed to compute deep work report", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- Temporal risk scoring --------------------------------------------------------

async function handleGetRiskScores(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const weeksStr = url.searchParams.get("weeks") ?? "4";
  const weeks = parseInt(weeksStr, 10);

  if (isNaN(weeks) || weeks < 1 || weeks > 52) {
    return jsonResponse(
      errorEnvelope(
        "weeks must be a positive integer between 1 and 52",
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{
      burnout_risk: number;
      travel_overload: number;
      strategic_drift: number;
      overall_risk: number;
      risk_level: string;
      recommendations: string[];
    }>(env.USER_GRAPH, auth.userId, "/getRiskScores", { weeks });

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to compute risk scores", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to compute risk scores", err);
    return jsonResponse(
      errorEnvelope("Failed to compute risk scores", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- Temporal Graph API (TM-b3i.4) -----------------------------------------------

/**
 * GET /v1/graph/events -- Rich event data with participants and category.
 *
 * Queries the UserGraphDO for canonical events, enriches each with
 * participant hashes and billing category from allocations, then formats
 * via pure graph functions.
 */
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

// -- Drift & reputation ---------------------------------------------------------

async function handleGetDriftReport(
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

async function handleGetDriftAlerts(
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

// -- Reconnection suggestions -----------------------------------------------

/**
 * GET /v1/trips/:trip_id/reconnections
 *
 * Dedicated REST route for trip-scoped reconnection suggestions.
 * Resolves the trip constraint by ID from the URL path and returns
 * overdue contacts in the trip's destination city.
 */
async function handleGetTripReconnections(
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

async function handleGetReconnectionSuggestions(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const tripId = url.searchParams.get("trip_id") || null;
    const city = url.searchParams.get("city") || null;

    if (!tripId && !city) {
      return jsonResponse(
        errorEnvelope(
          "Either trip_id or city query parameter is required",
          "VALIDATION_ERROR",
        ),
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const result = await callDO<unknown>(
      env.USER_GRAPH,
      auth.userId,
      "/getReconnectionSuggestions",
      { city, trip_id: tripId },
    );

    if (!result.ok) {
      const errData = result.data as { message?: string };
      return jsonResponse(
        errorEnvelope(
          errData.message ?? "Failed to get reconnection suggestions",
          "INTERNAL_ERROR",
        ),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to get reconnection suggestions", err);
    return jsonResponse(
      errorEnvelope("Failed to get reconnection suggestions", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- VIP Policies -----------------------------------------------------------

async function handleCreateVipPolicy(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const body = await parseJsonBody<{
    participant_hash?: string;
    display_name?: string;
    priority_weight?: number;
    conditions_json?: Record<string, unknown>;
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

  if (!body.conditions_json || typeof body.conditions_json !== "object") {
    return jsonResponse(
      errorEnvelope("conditions_json is required and must be an object", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const priorityWeight = body.priority_weight ?? 1.0;
  if (typeof priorityWeight !== "number" || priorityWeight < 0) {
    return jsonResponse(
      errorEnvelope("priority_weight must be a non-negative number", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const vipId = generateId("vip");
    const result = await callDO<{
      vip_id: string;
      participant_hash: string;
      display_name: string | null;
      priority_weight: number;
      conditions_json: Record<string, unknown>;
      created_at: string;
    }>(env.USER_GRAPH, auth.userId, "/createVipPolicy", {
      vip_id: vipId,
      participant_hash: body.participant_hash,
      display_name: body.display_name ?? null,
      priority_weight: priorityWeight,
      conditions_json: body.conditions_json,
    });

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to create VIP policy", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 201);
  } catch (err) {
    console.error("Failed to create VIP policy", err);
    return jsonResponse(
      errorEnvelope("Failed to create VIP policy", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleListVipPolicies(
  _request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    const result = await callDO<{
      items: unknown[];
    }>(env.USER_GRAPH, auth.userId, "/listVipPolicies");

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to list VIP policies", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data.items ?? result.data), 200);
  } catch (err) {
    console.error("Failed to list VIP policies", err);
    return jsonResponse(
      errorEnvelope("Failed to list VIP policies", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleDeleteVipPolicy(
  _request: Request,
  auth: AuthContext,
  env: Env,
  vipId: string,
): Promise<Response> {
  if (!isValidId(vipId, "vip")) {
    return jsonResponse(
      errorEnvelope("Invalid VIP policy ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{ deleted: boolean }>(
      env.USER_GRAPH,
      auth.userId,
      "/deleteVipPolicy",
      { vip_id: vipId },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to delete VIP policy", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    if (!result.data.deleted) {
      return jsonResponse(
        errorEnvelope("VIP policy not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope({ deleted: true }), 200);
  } catch (err) {
    console.error("Failed to delete VIP policy", err);
    return jsonResponse(
      errorEnvelope("Failed to delete VIP policy", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- Commitment tracking routes ------------------------------------------------

async function handleCreateCommitment(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const body = await parseJsonBody<{
    client_id?: string;
    target_hours?: number;
    window_type?: string;
    client_name?: string;
    rolling_window_weeks?: number;
    hard_minimum?: boolean;
    proof_required?: boolean;
  }>(request);

  if (!body) {
    return jsonResponse(
      errorEnvelope("Request body must be valid JSON", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!body.client_id || typeof body.client_id !== "string") {
    return jsonResponse(
      errorEnvelope("client_id is required", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (body.target_hours === undefined || typeof body.target_hours !== "number" || body.target_hours <= 0) {
    return jsonResponse(
      errorEnvelope("target_hours is required and must be a positive number", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (body.window_type !== undefined) {
    const validWindowTypes = ["WEEKLY", "MONTHLY"];
    if (!validWindowTypes.includes(body.window_type)) {
      return jsonResponse(
        errorEnvelope(
          `Invalid window_type: ${body.window_type}. Must be one of: ${validWindowTypes.join(", ")}`,
          "VALIDATION_ERROR",
        ),
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  if (body.rolling_window_weeks !== undefined) {
    if (typeof body.rolling_window_weeks !== "number" || body.rolling_window_weeks < 1 || !Number.isInteger(body.rolling_window_weeks)) {
      return jsonResponse(
        errorEnvelope("rolling_window_weeks must be a positive integer", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  try {
    const commitmentId = generateId("commitment");
    const result = await callDO<{
      commitment_id: string;
      client_id: string;
      client_name: string | null;
      window_type: string;
      target_hours: number;
      rolling_window_weeks: number;
      hard_minimum: boolean;
      proof_required: boolean;
      created_at: string;
    }>(env.USER_GRAPH, auth.userId, "/createCommitment", {
      commitment_id: commitmentId,
      client_id: body.client_id,
      target_hours: body.target_hours,
      window_type: body.window_type ?? "WEEKLY",
      client_name: body.client_name ?? null,
      rolling_window_weeks: body.rolling_window_weeks ?? 4,
      hard_minimum: body.hard_minimum ?? false,
      proof_required: body.proof_required ?? false,
    });

    if (!result.ok) {
      const errorData = result.data as { error?: string };
      const errorMsg = errorData.error ?? "Failed to create commitment";
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
    console.error("Failed to create commitment", err);
    return jsonResponse(
      errorEnvelope("Failed to create commitment", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleListCommitments(
  _request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    const result = await callDO<{ items: unknown[] }>(
      env.USER_GRAPH,
      auth.userId,
      "/listCommitments",
      {},
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to list commitments", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data.items), 200);
  } catch (err) {
    console.error("Failed to list commitments", err);
    return jsonResponse(
      errorEnvelope("Failed to list commitments", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleGetCommitmentStatus(
  _request: Request,
  auth: AuthContext,
  env: Env,
  commitmentId: string,
): Promise<Response> {
  if (!isValidId(commitmentId, "commitment")) {
    return jsonResponse(
      errorEnvelope("Invalid commitment ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{
      commitment_id: string;
      client_id: string;
      client_name: string | null;
      window_type: string;
      target_hours: number;
      actual_hours: number;
      status: string;
      window_start: string;
      window_end: string;
      rolling_window_weeks: number;
    } | null>(env.USER_GRAPH, auth.userId, "/getCommitmentStatus", {
      commitment_id: commitmentId,
    });

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to get commitment status", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    if (result.data === null) {
      return jsonResponse(
        errorEnvelope("Commitment not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to get commitment status", err);
    return jsonResponse(
      errorEnvelope("Failed to get commitment status", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleDeleteCommitment(
  _request: Request,
  auth: AuthContext,
  env: Env,
  commitmentId: string,
): Promise<Response> {
  if (!isValidId(commitmentId, "commitment")) {
    return jsonResponse(
      errorEnvelope("Invalid commitment ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{ deleted: boolean }>(
      env.USER_GRAPH,
      auth.userId,
      "/deleteCommitment",
      { commitment_id: commitmentId },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to delete commitment", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    if (!result.data.deleted) {
      return jsonResponse(
        errorEnvelope("Commitment not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope({ deleted: true }), 200);
  } catch (err) {
    console.error("Failed to delete commitment", err);
    return jsonResponse(
      errorEnvelope("Failed to delete commitment", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- Commitment Proof Export --------------------------------------------------

/**
 * Shape of the proof data returned by the UserGraphDO.
 * Matches CommitmentProofData from the DO module.
 */
interface ProofEvent {
  canonical_event_id: string;
  title: string | null;
  start_ts: string;
  end_ts: string;
  hours: number;
  billing_category: string;
}

interface CommitmentProofData {
  commitment: {
    commitment_id: string;
    client_id: string;
    client_name: string | null;
    window_type: string;
    target_hours: number;
    rolling_window_weeks: number;
    hard_minimum: boolean;
    proof_required: boolean;
    created_at: string;
  };
  window_start: string;
  window_end: string;
  actual_hours: number;
  status: string;
  events: ProofEvent[];
}

/**
 * Compute a SHA-256 hash of the canonical proof data.
 *
 * The hash is computed over a deterministic JSON serialization of the
 * proof payload (commitment + window + events). This allows anyone with
 * the data to independently verify the hash.
 */
export async function computeProofHash(data: CommitmentProofData): Promise<string> {
  // Build a deterministic canonical representation for hashing.
  // Keys are sorted implicitly by the order we construct the object.
  const canonical = {
    commitment_id: data.commitment.commitment_id,
    client_id: data.commitment.client_id,
    client_name: data.commitment.client_name,
    window_type: data.commitment.window_type,
    target_hours: data.commitment.target_hours,
    window_start: data.window_start,
    window_end: data.window_end,
    actual_hours: data.actual_hours,
    status: data.status,
    events: data.events.map((e) => ({
      canonical_event_id: e.canonical_event_id,
      title: e.title,
      start_ts: e.start_ts,
      end_ts: e.end_ts,
      hours: e.hours,
      billing_category: e.billing_category,
    })),
  };

  const encoded = new TextEncoder().encode(JSON.stringify(canonical));
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate CSV content from commitment proof data.
 *
 * Format:
 * - Header row with column names
 * - One row per event
 * - Summary row at bottom with totals and hash
 */
export function generateProofCsv(data: CommitmentProofData, proofHash: string): string {
  const lines: string[] = [];

  // Metadata header
  lines.push("# Commitment Proof Export");
  lines.push(`# Commitment ID: ${data.commitment.commitment_id}`);
  lines.push(`# Client: ${data.commitment.client_name ?? data.commitment.client_id}`);
  lines.push(`# Window Type: ${data.commitment.window_type}`);
  lines.push(`# Window: ${data.window_start} to ${data.window_end}`);
  lines.push(`# Target Hours: ${data.commitment.target_hours}`);
  lines.push(`# Actual Hours: ${data.actual_hours}`);
  lines.push(`# Status: ${data.status}`);
  lines.push(`# Proof Hash (SHA-256): ${proofHash}`);
  lines.push(`# Generated: ${new Date().toISOString()}`);
  lines.push("");

  // CSV header
  lines.push("event_id,title,start,end,hours,billing_category");

  // Event rows
  for (const event of data.events) {
    const title = csvEscape(event.title ?? "");
    lines.push(
      `${event.canonical_event_id},${title},${event.start_ts},${event.end_ts},${event.hours},${event.billing_category}`,
    );
  }

  // Summary row
  lines.push("");
  lines.push(`# Total Events: ${data.events.length}`);
  lines.push(`# Total Hours: ${data.actual_hours}`);

  return lines.join("\n");
}

/** Escape a string for CSV (wrap in quotes if it contains comma, quote, or newline). */
function csvEscape(str: string): string {
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Generate a text-based proof document (used as the "PDF" output).
 *
 * In a Workers environment, true PDF generation is impractical without
 * large libraries. This produces a structured, human-readable text document
 * that contains all the verifiable data. The Content-Type is set to
 * application/pdf and the content is a plain-text representation that
 * can be saved and verified.
 */
export function generateProofDocument(data: CommitmentProofData, proofHash: string): string {
  const lines: string[] = [];
  const divider = "=".repeat(72);
  const thinDivider = "-".repeat(72);

  lines.push(divider);
  lines.push("                    COMMITMENT PROOF DOCUMENT");
  lines.push(divider);
  lines.push("");
  lines.push(`  Commitment ID:    ${data.commitment.commitment_id}`);
  lines.push(`  Client:           ${data.commitment.client_name ?? data.commitment.client_id}`);
  lines.push(`  Window Type:      ${data.commitment.window_type}`);
  lines.push(`  Rolling Window:   ${data.commitment.rolling_window_weeks} weeks`);
  lines.push(`  Hard Minimum:     ${data.commitment.hard_minimum ? "Yes" : "No"}`);
  lines.push(`  Proof Required:   ${data.commitment.proof_required ? "Yes" : "No"}`);
  lines.push("");
  lines.push(thinDivider);
  lines.push("  COMPLIANCE SUMMARY");
  lines.push(thinDivider);
  lines.push("");
  lines.push(`  Window Start:     ${data.window_start}`);
  lines.push(`  Window End:       ${data.window_end}`);
  lines.push(`  Target Hours:     ${data.commitment.target_hours}`);
  lines.push(`  Actual Hours:     ${data.actual_hours}`);
  lines.push(`  Status:           ${data.status.toUpperCase()}`);
  lines.push("");
  lines.push(thinDivider);
  lines.push(`  EVENT DETAIL (${data.events.length} events)`);
  lines.push(thinDivider);
  lines.push("");

  if (data.events.length === 0) {
    lines.push("  No events found in this window.");
  } else {
    for (const event of data.events) {
      lines.push(`  ${event.canonical_event_id}`);
      lines.push(`    Title:     ${event.title ?? "(untitled)"}`);
      lines.push(`    Start:     ${event.start_ts}`);
      lines.push(`    End:       ${event.end_ts}`);
      lines.push(`    Hours:     ${event.hours}`);
      lines.push(`    Category:  ${event.billing_category}`);
      lines.push("");
    }
  }

  lines.push(divider);
  lines.push("  CRYPTOGRAPHIC VERIFICATION");
  lines.push(divider);
  lines.push("");
  lines.push(`  SHA-256 Proof Hash: ${proofHash}`);
  lines.push("");
  lines.push("  To verify: compute SHA-256 of the canonical JSON representation");
  lines.push("  of the commitment data (commitment + window + events).");
  lines.push("");
  lines.push(`  Generated: ${new Date().toISOString()}`);
  lines.push(divider);

  return lines.join("\n");
}

/**
 * Generate an HTML proof document suitable for browser Print-to-PDF.
 *
 * Contains: client name, window, target/actual hours, event-level breakdown,
 * proof hash, and HMAC signature. The HTML is self-contained with inline
 * styles for clean rendering.
 */
export function generateProofHtml(
  data: CommitmentProofData,
  proofHash: string,
  signature?: string,
): string {
  const clientDisplay = data.commitment.client_name ?? data.commitment.client_id;
  const statusUpper = data.status.toUpperCase();

  // Build event rows
  let eventRows = "";
  if (data.events.length === 0) {
    eventRows = `<tr><td colspan="6" style="text-align:center;color:#888;">No events found in this window.</td></tr>`;
  } else {
    for (const event of data.events) {
      eventRows += `<tr>
        <td>${escapeHtml(event.canonical_event_id)}</td>
        <td>${escapeHtml(event.title ?? "(untitled)")}</td>
        <td>${escapeHtml(event.start_ts)}</td>
        <td>${escapeHtml(event.end_ts)}</td>
        <td style="text-align:right;">${event.hours}</td>
        <td>${escapeHtml(event.billing_category)}</td>
      </tr>`;
    }
  }

  const signatureSection = signature
    ? `<tr><td><strong>HMAC-SHA256 Signature</strong></td><td style="font-family:monospace;word-break:break-all;">${escapeHtml(signature)}</td></tr>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Commitment Proof - ${escapeHtml(data.commitment.commitment_id)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 2rem; color: #1a1a1a; }
    h1 { font-size: 1.5rem; border-bottom: 2px solid #333; padding-bottom: 0.5rem; }
    h2 { font-size: 1.2rem; margin-top: 2rem; border-bottom: 1px solid #ccc; padding-bottom: 0.3rem; }
    table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
    th, td { border: 1px solid #ddd; padding: 0.5rem; text-align: left; font-size: 0.9rem; }
    th { background-color: #f5f5f5; }
    .meta-table { border: none; }
    .meta-table td { border: none; padding: 0.25rem 0.5rem; }
    .status { font-weight: bold; }
    .status.compliant { color: #2e7d32; }
    .status.under { color: #c62828; }
    .status.over { color: #1565c0; }
    .hash { font-family: monospace; word-break: break-all; font-size: 0.85rem; }
    @media print { body { margin: 1cm; } }
  </style>
</head>
<body>
  <h1>Commitment Proof Document</h1>

  <h2>Commitment Details</h2>
  <table class="meta-table">
    <tr><td><strong>Commitment ID</strong></td><td>${escapeHtml(data.commitment.commitment_id)}</td></tr>
    <tr><td><strong>Client</strong></td><td>${escapeHtml(clientDisplay)}</td></tr>
    <tr><td><strong>Window Type</strong></td><td>${escapeHtml(data.commitment.window_type)}</td></tr>
    <tr><td><strong>Rolling Window</strong></td><td>${data.commitment.rolling_window_weeks} weeks</td></tr>
    <tr><td><strong>Hard Minimum</strong></td><td>${data.commitment.hard_minimum ? "Yes" : "No"}</td></tr>
    <tr><td><strong>Proof Required</strong></td><td>${data.commitment.proof_required ? "Yes" : "No"}</td></tr>
  </table>

  <h2>Compliance Summary</h2>
  <table class="meta-table">
    <tr><td><strong>Window Start</strong></td><td>${escapeHtml(data.window_start)}</td></tr>
    <tr><td><strong>Window End</strong></td><td>${escapeHtml(data.window_end)}</td></tr>
    <tr><td><strong>Target Hours</strong></td><td>${data.commitment.target_hours}</td></tr>
    <tr><td><strong>Actual Hours</strong></td><td>${data.actual_hours}</td></tr>
    <tr><td><strong>Status</strong></td><td class="status ${data.status}">${statusUpper}</td></tr>
  </table>

  <h2>Event Detail (${data.events.length} events)</h2>
  <table>
    <thead>
      <tr>
        <th>Event ID</th>
        <th>Title</th>
        <th>Start</th>
        <th>End</th>
        <th>Hours</th>
        <th>Category</th>
      </tr>
    </thead>
    <tbody>
      ${eventRows}
    </tbody>
  </table>

  <h2>Cryptographic Verification</h2>
  <table class="meta-table">
    <tr><td><strong>SHA-256 Proof Hash</strong></td><td class="hash">${escapeHtml(proofHash)}</td></tr>
    ${signatureSection}
  </table>
  <p style="font-size:0.85rem;color:#666;">
    To verify: compute SHA-256 of the canonical JSON representation of the commitment data
    (commitment + window + events), then verify the HMAC-SHA256 signature using the system key.
  </p>
  <p style="font-size:0.85rem;color:#888;">Generated: ${new Date().toISOString()}</p>
</body>
</html>`;
}

/** Escape HTML special characters to prevent XSS in generated documents. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ---------------------------------------------------------------------------
// Cryptographic proof signing and verification
// ---------------------------------------------------------------------------

/**
 * Encode a Uint8Array to hex string. Same logic as in deletion-certificate.ts
 * but kept local to avoid cross-module coupling for this self-contained feature.
 */
function bytesToHex(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (const byte of bytes) {
    parts.push(byte.toString(16).padStart(2, "0"));
  }
  return parts.join("");
}

/** Convert a hex string to Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Compute HMAC-SHA256 signature for a commitment proof.
 *
 * Signature = HMAC-SHA256(proof_hash + commitment_id + window, MASTER_KEY)
 *
 * The signing input concatenates proof_hash, commitment_id, and window
 * (start..end) to bind the signature to the specific proof and context.
 *
 * @param proofHash - SHA-256 hash of the canonical proof data
 * @param commitmentId - The commitment ID
 * @param windowStart - Window start timestamp
 * @param windowEnd - Window end timestamp
 * @param masterKey - MASTER_KEY secret for HMAC signing
 * @returns Hex-encoded HMAC-SHA256 signature
 */
export async function computeProofSignature(
  proofHash: string,
  commitmentId: string,
  windowStart: string,
  windowEnd: string,
  masterKey: string,
): Promise<string> {
  const signingInput = `${proofHash}${commitmentId}${windowStart}..${windowEnd}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(masterKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const encoded = new TextEncoder().encode(signingInput);
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoded);
  return bytesToHex(new Uint8Array(signatureBuffer));
}

/**
 * Verify a commitment proof signature using Web Crypto (constant-time).
 *
 * Re-computes the signing input and uses crypto.subtle.verify for
 * timing-safe comparison.
 *
 * @returns true if the signature is valid, false otherwise.
 */
export async function verifyProofSignature(
  proofHash: string,
  commitmentId: string,
  windowStart: string,
  windowEnd: string,
  signature: string,
  masterKey: string,
): Promise<boolean> {
  try {
    const signingInput = `${proofHash}${commitmentId}${windowStart}..${windowEnd}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(masterKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signatureBytes = hexToBytes(signature);
    const encoded = new TextEncoder().encode(signingInput);
    return crypto.subtle.verify("HMAC", key, signatureBytes, encoded);
  } catch {
    return false;
  }
}

/** Seven years in seconds, used for R2 object retention. */
const SEVEN_YEARS_SECONDS = 7 * 365 * 24 * 60 * 60; // 220,752,000

/**
 * POST /v1/commitments/:id/export
 *
 * Export a commitment proof document with cryptographic verification.
 * Gathers proof data from the UserGraphDO, computes SHA-256 hash,
 * signs with HMAC-SHA256 using MASTER_KEY, generates HTML (PDF) or CSV,
 * stores in R2 with 7-year retention, and returns the download URL.
 *
 * Body: { format?: "pdf" | "csv" }
 * Response: { proof_id, download_url, proof_hash, signature, signed_at, format, r2_key }
 */
async function handleExportCommitmentProof(
  request: Request,
  auth: AuthContext,
  env: Env,
  commitmentId: string,
): Promise<Response> {
  if (!isValidId(commitmentId, "commitment")) {
    return jsonResponse(
      errorEnvelope("Invalid commitment ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!env.PROOF_BUCKET) {
    return jsonResponse(
      errorEnvelope("Proof export not configured (R2 bucket missing)", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }

  if (!env.MASTER_KEY) {
    return jsonResponse(
      errorEnvelope("Proof signing not configured (MASTER_KEY missing)", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }

  // Parse optional body for format
  let format: "pdf" | "csv" = "pdf";
  try {
    const body = await parseJsonBody<{ format?: string }>(request);
    if (body?.format) {
      if (body.format !== "pdf" && body.format !== "csv") {
        return jsonResponse(
          errorEnvelope("format must be 'pdf' or 'csv'", "VALIDATION_ERROR"),
          ErrorCode.VALIDATION_ERROR,
        );
      }
      format = body.format;
    }
  } catch {
    // No body or invalid JSON -- use default format
  }

  try {
    // Get proof data from DO
    const result = await callDO<CommitmentProofData | null>(
      env.USER_GRAPH,
      auth.userId,
      "/getCommitmentProofData",
      { commitment_id: commitmentId },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to get commitment proof data", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    if (result.data === null) {
      return jsonResponse(
        errorEnvelope("Commitment not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    const proofData = result.data;

    // Compute SHA-256 proof hash
    const proofHash = await computeProofHash(proofData);

    // Compute HMAC-SHA256 signature: sign(proof_hash + commitment_id + window, MASTER_KEY)
    const signature = await computeProofSignature(
      proofHash,
      commitmentId,
      proofData.window_start,
      proofData.window_end,
      env.MASTER_KEY,
    );

    const signedAt = new Date().toISOString();
    const proofId = generateId("proof");

    // Generate document content
    let content: string;
    let contentType: string;
    let fileExtension: string;

    if (format === "csv") {
      content = generateProofCsv(proofData, proofHash);
      contentType = "text/csv";
      fileExtension = "csv";
    } else {
      // HTML document for browser Print-to-PDF
      content = generateProofHtml(proofData, proofHash, signature);
      contentType = "text/html";
      fileExtension = "html";
    }

    // Build R2 key: proofs/{userId}/{commitmentId}/{window}.{ext}
    const windowKey = `${proofData.window_start}_${proofData.window_end}`.replace(/[:.]/g, "-");
    const r2Key = `proofs/${auth.userId}/${commitmentId}/${windowKey}.${fileExtension}`;

    // Store in R2 with 7-year retention metadata for compliance (NFR-27)
    const retentionExpiry = new Date(Date.now() + SEVEN_YEARS_SECONDS * 1000).toISOString();
    await env.PROOF_BUCKET.put(r2Key, content, {
      httpMetadata: {
        contentType,
        contentDisposition: `attachment; filename="commitment-proof-${commitmentId}.${fileExtension}"`,
      },
      customMetadata: {
        proof_id: proofId,
        commitment_id: commitmentId,
        user_id: auth.userId,
        proof_hash: proofHash,
        signature,
        signed_at: signedAt,
        format,
        generated_at: signedAt,
        retention_policy: "7_years",
        retention_expiry: retentionExpiry,
        window_start: proofData.window_start,
        window_end: proofData.window_end,
      },
    });

    // Build download URL
    const downloadUrl = `/v1/proofs/${encodeURIComponent(r2Key)}`;

    return jsonResponse(
      successEnvelope({
        proof_id: proofId,
        download_url: downloadUrl,
        proof_hash: proofHash,
        signature,
        signed_at: signedAt,
        format,
        r2_key: r2Key,
        commitment_id: commitmentId,
        actual_hours: proofData.actual_hours,
        target_hours: proofData.commitment.target_hours,
        status: proofData.status,
        event_count: proofData.events.length,
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to export commitment proof", err);
    return jsonResponse(
      errorEnvelope("Failed to export commitment proof", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

/**
 * POST /v1/simulation
 *
 * Run a what-if simulation. Takes a scenario and returns an impact report.
 * Read-only: does not modify any real calendar data.
 *
 * Body: { scenario: SimulationScenario }
 * Returns: { ok: true, data: ImpactReport }
 */
async function handleSimulation(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const body = await parseJsonBody<{
    scenario?: {
      type?: string;
      client_id?: string;
      hours_per_week?: number;
      title?: string;
      day_of_week?: number;
      start_time?: number;
      end_time?: number;
      duration_weeks?: number;
      start_hour?: number;
      end_hour?: number;
    };
  }>(request);

  if (!body || !body.scenario) {
    return jsonResponse(
      errorEnvelope("Request body must include a scenario object", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const { scenario } = body;

  if (!scenario.type) {
    return jsonResponse(
      errorEnvelope("scenario.type is required", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const validTypes = ["add_commitment", "add_recurring_event", "change_working_hours"];
  if (!validTypes.includes(scenario.type)) {
    return jsonResponse(
      errorEnvelope(
        `Invalid scenario.type: ${scenario.type}. Must be one of: ${validTypes.join(", ")}`,
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Type-specific validation
  if (scenario.type === "add_commitment") {
    if (!scenario.client_id || typeof scenario.client_id !== "string") {
      return jsonResponse(
        errorEnvelope("scenario.client_id is required for add_commitment", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (scenario.hours_per_week === undefined || typeof scenario.hours_per_week !== "number" || scenario.hours_per_week < 0) {
      return jsonResponse(
        errorEnvelope("scenario.hours_per_week is required and must be a non-negative number", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  if (scenario.type === "add_recurring_event") {
    if (!scenario.title || typeof scenario.title !== "string") {
      return jsonResponse(
        errorEnvelope("scenario.title is required for add_recurring_event", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (scenario.day_of_week === undefined || typeof scenario.day_of_week !== "number" || scenario.day_of_week < 0 || scenario.day_of_week > 6) {
      return jsonResponse(
        errorEnvelope("scenario.day_of_week must be 0-6 (Monday-Sunday)", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (scenario.start_time === undefined || typeof scenario.start_time !== "number") {
      return jsonResponse(
        errorEnvelope("scenario.start_time is required (decimal hour, e.g. 14 for 2pm)", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (scenario.end_time === undefined || typeof scenario.end_time !== "number") {
      return jsonResponse(
        errorEnvelope("scenario.end_time is required (decimal hour)", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (scenario.duration_weeks === undefined || typeof scenario.duration_weeks !== "number" || scenario.duration_weeks < 1) {
      return jsonResponse(
        errorEnvelope("scenario.duration_weeks must be a positive integer", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  if (scenario.type === "change_working_hours") {
    if (scenario.start_hour === undefined || typeof scenario.start_hour !== "number") {
      return jsonResponse(
        errorEnvelope("scenario.start_hour is required for change_working_hours", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (scenario.end_hour === undefined || typeof scenario.end_hour !== "number") {
      return jsonResponse(
        errorEnvelope("scenario.end_hour is required for change_working_hours", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (scenario.start_hour >= scenario.end_hour) {
      return jsonResponse(
        errorEnvelope("scenario.start_hour must be less than scenario.end_hour", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  try {
    const result = await callDO<ImpactReport>(
      env.USER_GRAPH,
      auth.userId,
      "/simulate",
      { scenario: scenario as SimulationScenario },
    );

    if (!result.ok) {
      const errorData = result.data as unknown as { error?: string };
      return jsonResponse(
        errorEnvelope(errorData.error ?? "Simulation failed", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Simulation failed", err);
    return jsonResponse(
      errorEnvelope("Simulation failed", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

/**
 * GET /v1/proofs/*
 *
 * Download a proof document from R2 by its key.
 * The key is the full R2 path after /v1/proofs/.
 */
async function handleDownloadProof(
  _request: Request,
  auth: AuthContext,
  env: Env,
  r2Key: string,
): Promise<Response> {
  if (!env.PROOF_BUCKET) {
    return jsonResponse(
      errorEnvelope("Proof export not configured", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }

  // Security: verify the proof belongs to this user
  if (!r2Key.startsWith(`proofs/${auth.userId}/`)) {
    return jsonResponse(
      errorEnvelope("Proof not found", "NOT_FOUND"),
      ErrorCode.NOT_FOUND,
    );
  }

  try {
    const object = await env.PROOF_BUCKET.get(r2Key);
    if (!object) {
      return jsonResponse(
        errorEnvelope("Proof not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);

    return new Response(object.body, { headers });
  } catch (err) {
    console.error("Failed to download proof", err);
    return jsonResponse(
      errorEnvelope("Failed to download proof", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

/**
 * GET /v1/proofs/:proof_id/verify
 *
 * Verify a proof document's cryptographic signature.
 * Looks up the proof metadata in R2 by proof_id (stored in customMetadata),
 * then re-verifies the HMAC-SHA256 signature.
 *
 * Response: { valid: boolean, proof_hash: string, signed_at: string }
 */
async function handleVerifyProof(
  _request: Request,
  auth: AuthContext,
  env: Env,
  proofId: string,
): Promise<Response> {
  // Validate input first, before checking env bindings
  if (!proofId || !proofId.startsWith("prf_")) {
    return jsonResponse(
      errorEnvelope("Invalid proof ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!env.PROOF_BUCKET) {
    return jsonResponse(
      errorEnvelope("Proof export not configured", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }

  if (!env.MASTER_KEY) {
    return jsonResponse(
      errorEnvelope("Proof verification not configured", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }

  try {
    // List objects in user's proof directory to find the one with matching proof_id
    const prefix = `proofs/${auth.userId}/`;
    const listed = await env.PROOF_BUCKET.list({ prefix, limit: 500 });

    let foundObject: R2Object | null = null;
    for (const obj of listed.objects) {
      if (obj.customMetadata?.proof_id === proofId) {
        foundObject = obj;
        break;
      }
    }

    if (!foundObject) {
      return jsonResponse(
        errorEnvelope("Proof not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    const meta = foundObject.customMetadata ?? {};
    const proofHash = meta.proof_hash;
    const storedSignature = meta.signature;
    const signedAt = meta.signed_at;
    const commitmentId = meta.commitment_id;
    const windowStart = meta.window_start;
    const windowEnd = meta.window_end;

    if (!proofHash || !storedSignature || !commitmentId || !windowStart || !windowEnd) {
      return jsonResponse(
        successEnvelope({
          valid: false,
          proof_hash: proofHash ?? null,
          signed_at: signedAt ?? null,
          reason: "Incomplete proof metadata",
        }),
        200,
      );
    }

    // Re-verify the HMAC-SHA256 signature using Web Crypto (constant-time)
    const valid = await verifyProofSignature(
      proofHash,
      commitmentId,
      windowStart,
      windowEnd,
      storedSignature,
      env.MASTER_KEY,
    );

    return jsonResponse(
      successEnvelope({
        valid,
        proof_hash: proofHash,
        signed_at: signedAt ?? null,
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to verify proof", err);
    return jsonResponse(
      errorEnvelope("Failed to verify proof", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- Deletion Certificates (Public, no auth) --------------------------------

/**
 * GET /v1/account/deletion-certificate/:certificateId
 *
 * Public endpoint -- no authentication required.
 * The certificate ID itself serves as the access token.
 * Returns the signed deletion certificate or 404.
 */
async function handleGetDeletionCertificate(
  certificateId: string,
  env: Env,
): Promise<Response> {
  try {
    const row = await env.DB
      .prepare(
        `SELECT cert_id, entity_type, entity_id, deleted_at, proof_hash, signature, deletion_summary
         FROM deletion_certificates
         WHERE cert_id = ?1`,
      )
      .bind(certificateId)
      .first<{
        cert_id: string;
        entity_type: string;
        entity_id: string;
        deleted_at: string;
        proof_hash: string;
        signature: string;
        deletion_summary: string | null;
      }>();

    if (!row) {
      return jsonResponse(
        errorEnvelope("Deletion certificate not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(
      successEnvelope({
        certificate_id: row.cert_id,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        deleted_at: row.deleted_at,
        proof_hash: row.proof_hash,
        signature: row.signature,
        deletion_summary: row.deletion_summary ? JSON.parse(row.deletion_summary) : null,
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to retrieve deletion certificate", err);
    return jsonResponse(
      errorEnvelope("Failed to retrieve deletion certificate", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- API Keys ---------------------------------------------------------------

async function handleCreateApiKey(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const body = await parseJsonBody<{ name?: string }>(request);
  if (!body || !body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
    return jsonResponse(
      errorEnvelope("API key must have a name", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const keyId = generateId("apikey");
    const { rawKey, prefix, keyHash } = await generateApiKey();

    await env.DB
      .prepare(
        `INSERT INTO api_keys (key_id, user_id, name, prefix, key_hash)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(keyId, auth.userId, body.name.trim(), prefix, keyHash)
      .run();

    // Return the full raw key ONLY at creation time
    return jsonResponse(
      successEnvelope({
        key_id: keyId,
        name: body.name.trim(),
        prefix,
        key: rawKey,
        created_at: new Date().toISOString(),
      }),
      201,
    );
  } catch (err) {
    console.error("Failed to create API key", err);
    return jsonResponse(
      errorEnvelope("Failed to create API key", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleListApiKeys(
  _request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    const result = await env.DB
      .prepare(
        `SELECT key_id, name, prefix, created_at, last_used_at, revoked_at
         FROM api_keys
         WHERE user_id = ?1
         ORDER BY created_at DESC`,
      )
      .bind(auth.userId)
      .all<{
        key_id: string;
        name: string;
        prefix: string;
        created_at: string;
        last_used_at: string | null;
        revoked_at: string | null;
      }>();

    const keys = result.results ?? [];
    return jsonResponse(successEnvelope(keys), 200);
  } catch (err) {
    console.error("Failed to list API keys", err);
    return jsonResponse(
      errorEnvelope("Failed to list API keys", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleRevokeApiKey(
  _request: Request,
  auth: AuthContext,
  env: Env,
  keyId: string,
): Promise<Response> {
  if (!isValidId(keyId, "apikey")) {
    return jsonResponse(
      errorEnvelope("Invalid API key ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    // Verify ownership and that key exists
    const row = await env.DB
      .prepare(
        "SELECT key_id, revoked_at FROM api_keys WHERE key_id = ?1 AND user_id = ?2",
      )
      .bind(keyId, auth.userId)
      .first<{ key_id: string; revoked_at: string | null }>();

    if (!row) {
      return jsonResponse(
        errorEnvelope("API key not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    if (row.revoked_at) {
      return jsonResponse(
        errorEnvelope("API key already revoked", "CONFLICT"),
        ErrorCode.CONFLICT,
      );
    }

    await env.DB
      .prepare("UPDATE api_keys SET revoked_at = ?1 WHERE key_id = ?2")
      .bind(new Date().toISOString(), keyId)
      .run();

    return jsonResponse(successEnvelope({ revoked: true }), 200);
  } catch (err) {
    console.error("Failed to revoke API key", err);
    return jsonResponse(
      errorEnvelope("Failed to revoke API key", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ---------------------------------------------------------------------------
// CalDAV feed handler (Phase 5A)
// ---------------------------------------------------------------------------

/**
 * Handle GET /v1/caldav/:user_id/calendar.ics
 *
 * Returns a complete iCalendar (RFC 5545) document containing all canonical
 * events for the authenticated user. Calendar apps (Apple Calendar, Google
 * Calendar, Outlook) can subscribe to this URL for live feed updates.
 *
 * Authentication is required. The :user_id in the path must match the
 * authenticated user's ID (prevents accessing another user's feed).
 *
 * Response includes Cache-Control headers for 5-minute caching, which
 * balances freshness with performance for calendar app polling.
 */
async function handleCalDavFeed(
  _request: Request,
  auth: AuthContext,
  env: Env,
  requestedUserId: string,
): Promise<Response> {
  // Security: verify the authenticated user matches the requested user
  if (auth.userId !== requestedUserId) {
    return jsonResponse(
      errorEnvelope("Forbidden: cannot access another user's calendar feed", "FORBIDDEN"),
      ErrorCode.FORBIDDEN,
    );
  }

  try {
    // Fetch all canonical events from UserGraphDO (no time bounds = all events)
    const result = await callDO<{
      items: CanonicalEvent[];
      cursor: string | null;
      has_more: boolean;
    }>(env.USER_GRAPH, auth.userId, "/listCanonicalEvents", {});

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to fetch events for calendar feed", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    // Generate iCalendar document from canonical events
    const icalBody = buildVCalendar(result.data.items);

    // Return iCalendar with appropriate headers
    return new Response(icalBody, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'attachment; filename="calendar.ics"',
        "Cache-Control": "public, max-age=300",
        // CalDAV ETag for conditional requests (based on data hash, simplified)
        "X-Calendar-Subscription-URL": `/v1/caldav/${auth.userId}/calendar.ics`,
      },
    });
  } catch (err) {
    console.error("Failed to generate CalDAV feed", err);
    return jsonResponse(
      errorEnvelope("Failed to generate calendar feed", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Creates the worker handler. Factory pattern allows tests to inject
 * dependencies and validate the full request flow.
 */
export function createHandler() {
  return {
    async fetch(
      request: Request,
      env: Env,
      _ctx: ExecutionContext,
    ): Promise<Response> {
      const url = new URL(request.url);
      const { pathname } = url;
      const method = request.method;
      const origin = request.headers.get("Origin");
      const environment = env.ENVIRONMENT ?? "development";

      // Helper: wrap response with security + CORS headers before returning.
      // Every response from the API goes through this to guarantee coverage.
      const finalize = (response: Response): Response => {
        const secured = addSecurityHeaders(response);
        return addCorsHeaders(secured, origin, environment);
      };

      // CORS preflight -- handled before anything else, including health check.
      // Returns 204 with appropriate CORS + security headers.
      if (method === "OPTIONS") {
        const preflight = buildPreflightResponse(origin, environment);
        return addSecurityHeaders(preflight);
      }

      // Health check -- no auth required
      if (method === "GET" && pathname === "/health") {
        return finalize(new Response(
          JSON.stringify({
            ok: true,
            data: {
              status: "healthy",
              version: API_VERSION,
            },
            error: null,
            meta: {
              timestamp: new Date().toISOString(),
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ));
      }

      // Public route: deletion certificate retrieval (no auth -- certificate ID is the access token)
      const certMatch = matchRoute(pathname, "/v1/account/deletion-certificate/:id");
      if (certMatch && method === "GET") {
        return finalize(await handleGetDeletionCertificate(certMatch.params[0], env));
      }

      // Public route: Stripe webhook (authenticated via Stripe-Signature header, not JWT)
      if (method === "POST" && pathname === "/v1/billing/webhook") {
        if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
          return finalize(jsonResponse(
            errorEnvelope("Billing not configured", "INTERNAL_ERROR"),
            ErrorCode.INTERNAL_ERROR,
          ));
        }
        return finalize(await handleStripeWebhook(request, env as unknown as BillingEnv));
      }

      // All /v1/* routes require auth (except /v1/auth/*)
      if (!pathname.startsWith("/v1/")) {
        return finalize(jsonResponse(
          errorEnvelope("Not Found", "NOT_FOUND"),
          ErrorCode.NOT_FOUND,
        ));
      }

      // Auth routes (/v1/auth/*) do NOT require existing JWT -- they create tokens.
      // Delegate to the Hono auth router.
      if (pathname.startsWith("/v1/auth/")) {
        // Rate limit auth endpoints (register/login have stricter limits)
        if (env.RATE_LIMITS) {
          const authEndpoint = detectAuthEndpoint(pathname);
          if (authEndpoint) {
            const clientIp = extractClientIp(request);
            const identity = getRateLimitIdentity(null, clientIp, authEndpoint);
            const config = selectRateLimitConfig(null, authEndpoint);
            const rlResult = await checkRL(env.RATE_LIMITS as unknown as RateLimitKV, identity, config);
            if (!rlResult.allowed) {
              return finalize(buildRateLimitResponse(rlResult));
            }
          }
        }

        const authRouter = createAuthRoutes();
        // Rewrite path: strip /v1/auth prefix so Hono routes match at /register, /login, etc.
        const rewrittenUrl = new URL(request.url);
        rewrittenUrl.pathname = pathname.slice("/v1/auth".length);
        const rewrittenRequest = new Request(rewrittenUrl.toString(), request);
        const authResponse = await authRouter.fetch(rewrittenRequest, env);
        return finalize(authResponse);
      }

      // Authenticate -- all other /v1/* routes require a valid JWT or API key
      const auth = await extractAuth(request, env.JWT_SECRET, env.DB);
      if (!auth) {
        // Rate limit unauthenticated requests hitting protected endpoints by IP
        if (env.RATE_LIMITS) {
          const clientIp = extractClientIp(request);
          const identity = getRateLimitIdentity(null, clientIp);
          const config = selectRateLimitConfig(null);
          const rlResult = await checkRL(env.RATE_LIMITS as unknown as RateLimitKV, identity, config);
          if (!rlResult.allowed) {
            return finalize(buildRateLimitResponse(rlResult));
          }
        }
        return finalize(jsonResponse(
          errorEnvelope("Authentication required", "AUTH_REQUIRED"),
          ErrorCode.AUTH_REQUIRED,
        ));
      }

      // Rate limit authenticated requests by user_id and tier
      // Default tier to "free" -- future: look up actual tier from auth context
      let rateLimitResult: import("@tminus/shared").RateLimitResult | null = null;
      if (env.RATE_LIMITS) {
        const tier: RateLimitTier = "free"; // TODO: extract from JWT payload when tier system is fully wired
        const identity = getRateLimitIdentity(auth.userId, extractClientIp(request));
        const config = selectRateLimitConfig(tier);
        rateLimitResult = await checkRL(env.RATE_LIMITS as unknown as RateLimitKV, identity, config);
        if (!rateLimitResult.allowed) {
          return finalize(buildRateLimitResponse(rateLimitResult));
        }
      }

      // -- Route to handler and apply rate limit headers ----------------------

      let response = await routeAuthenticatedRequest(request, method, pathname, auth, env);

      // Apply rate limit headers to all authenticated responses
      if (rateLimitResult) {
        response = await applyRateLimitHeaders(response, rateLimitResult);
      }

      return finalize(response);
    },
  };
}

/**
 * Route an authenticated request to the appropriate handler.
 * Extracted to allow the fetch handler to wrap responses with rate limit headers.
 */
async function routeAuthenticatedRequest(
  request: Request,
  method: string,
  pathname: string,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
      // -- Privacy / deletion request routes --------------------------------

      if (pathname === "/v1/account/delete-request") {
        if (method === "POST") {
          return handleCreateDeletionRequest(request, auth, env);
        }
        if (method === "GET") {
          return handleGetDeletionRequest(request, auth, env);
        }
        if (method === "DELETE") {
          return handleCancelDeletionRequest(request, auth, env);
        }
      }

      // -- API key routes ---------------------------------------------------

      if (method === "POST" && pathname === "/v1/api-keys") {
        return handleCreateApiKey(request, auth, env);
      }

      if (method === "GET" && pathname === "/v1/api-keys") {
        return handleListApiKeys(request, auth, env);
      }

      let match = matchRoute(pathname, "/v1/api-keys/:id");
      if (match && method === "DELETE") {
        return handleRevokeApiKey(request, auth, env, match.params[0]);
      }

      // -- Account routes ---------------------------------------------------

      if (method === "POST" && pathname === "/v1/accounts/link") {
        // Enforce account limit before allowing new account linking
        const accountLimited = await enforceAccountLimit(auth.userId, env.DB);
        if (accountLimited) return accountLimited;
        return handleAccountLink(request, auth, env);
      }

      if (method === "GET" && pathname === "/v1/accounts") {
        return handleListAccounts(request, auth, env);
      }

      match = matchRoute(pathname, "/v1/accounts/:id");
      if (match) {
        if (method === "GET") {
          return handleGetAccount(request, auth, env, match.params[0]);
        }
        if (method === "DELETE") {
          return handleDeleteAccount(request, auth, env, match.params[0]);
        }
      }

      // -- Event routes -----------------------------------------------------

      if (method === "GET" && pathname === "/v1/events") {
        return handleListEvents(request, auth, env);
      }

      if (method === "POST" && pathname === "/v1/events") {
        return handleCreateEvent(request, auth, env);
      }

      match = matchRoute(pathname, "/v1/events/:id");
      if (match) {
        if (method === "GET") {
          return handleGetEvent(request, auth, env, match.params[0]);
        }
        if (method === "PATCH") {
          return handleUpdateEvent(request, auth, env, match.params[0]);
        }
        if (method === "DELETE") {
          return handleDeleteEvent(request, auth, env, match.params[0]);
        }
      }

      // -- Policy routes ----------------------------------------------------

      if (method === "GET" && pathname === "/v1/policies") {
        return handleListPolicies(request, auth, env);
      }

      if (method === "POST" && pathname === "/v1/policies") {
        return handleCreatePolicy(request, auth, env);
      }

      match = matchRoute(pathname, "/v1/policies/:id");
      if (match && method === "GET") {
        return handleGetPolicy(request, auth, env, match.params[0]);
      }

      match = matchRoute(pathname, "/v1/policies/:id/edges");
      if (match && method === "PUT") {
        return handleSetPolicyEdges(request, auth, env, match.params[0]);
      }

      // -- Constraint routes (Premium+) ----------------------------------------

      if (method === "POST" && pathname === "/v1/constraints") {
        const constraintGate = await enforceFeatureGate(auth.userId, "premium", env.DB);
        if (constraintGate) return constraintGate;
        return handleCreateConstraint(request, auth, env);
      }

      if (method === "GET" && pathname === "/v1/constraints") {
        // Listing constraints is read-only, allowed for all tiers
        return handleListConstraints(request, auth, env);
      }

      match = matchRoute(pathname, "/v1/constraints/:id");
      if (match) {
        if (method === "GET") {
          // Reading a single constraint is read-only, allowed for all tiers
          return handleGetConstraint(request, auth, env, match.params[0]);
        }
        if (method === "PUT") {
          const updateGate = await enforceFeatureGate(auth.userId, "premium", env.DB);
          if (updateGate) return updateGate;
          return handleUpdateConstraint(request, auth, env, match.params[0]);
        }
        if (method === "DELETE") {
          const deleteGate = await enforceFeatureGate(auth.userId, "premium", env.DB);
          if (deleteGate) return deleteGate;
          return handleDeleteConstraint(request, auth, env, match.params[0]);
        }
      }

      // -- Sync status routes -----------------------------------------------

      if (method === "GET" && pathname === "/v1/sync/status") {
        return handleAggregateStatus(request, auth, env);
      }

      match = matchRoute(pathname, "/v1/sync/status/:id");
      if (match && method === "GET") {
        return handleAccountStatus(request, auth, env, match.params[0]);
      }

      if (method === "GET" && pathname === "/v1/sync/journal") {
        return handleJournal(request, auth, env);
      }

      // -- Scheduling routes ------------------------------------------------

      if (method === "POST" && pathname === "/v1/scheduling/override") {
        const overrideGate = await enforceFeatureGate(auth.userId, "premium", env.DB);
        if (overrideGate) return overrideGate;
        return handleCreateSchedulingOverride(request, auth, env);
      }

      if (method === "POST" && pathname === "/v1/scheduling/sessions") {
        return handleCreateSchedulingSession(request, auth, env);
      }

      if (method === "GET" && pathname === "/v1/scheduling/sessions") {
        return handleListSchedulingSessions(request, auth, env);
      }

      match = matchRoute(pathname, "/v1/scheduling/sessions/:id/candidates");
      if (match && method === "GET") {
        return handleGetSchedulingCandidates(request, auth, env, match.params[0]);
      }

      match = matchRoute(pathname, "/v1/scheduling/sessions/:id/commit");
      if (match && method === "POST") {
        return handleCommitSchedulingCandidate(request, auth, env, match.params[0]);
      }

      // TM-82s.4: Hold extension route
      match = matchRoute(pathname, "/v1/scheduling/sessions/:id/extend-hold");
      if (match && method === "POST") {
        return handleExtendHold(request, auth, env, match.params[0]);
      }

      match = matchRoute(pathname, "/v1/scheduling/sessions/:id");
      if (match) {
        if (method === "GET") {
          return handleGetSchedulingSession(request, auth, env, match.params[0]);
        }
        if (method === "DELETE") {
          return handleCancelSchedulingSession(request, auth, env, match.params[0]);
        }
      }

      // -- Group scheduling routes (Phase 4D) ------------------------------------

      if (method === "POST" && pathname === "/v1/scheduling/group-sessions") {
        return handleCreateGroupSession(request, auth, env);
      }

      match = matchRoute(pathname, "/v1/scheduling/group-sessions/:id/commit");
      if (match && method === "POST") {
        return handleCommitGroupSession(request, auth, env, match.params[0]);
      }

      match = matchRoute(pathname, "/v1/scheduling/group-sessions/:id");
      if (match && method === "GET") {
        return handleGetGroupSession(request, auth, env, match.params[0]);
      }

      // -- Time allocation routes -----------------------------------------------

      match = matchRoute(pathname, "/v1/events/:id/allocation");
      if (match) {
        const allocEventId = match.params[0];
        if (method === "POST") {
          return handleSetAllocation(request, auth, env, allocEventId);
        }
        if (method === "GET") {
          return handleGetAllocation(request, auth, env, allocEventId);
        }
        if (method === "PUT") {
          return handleUpdateAllocation(request, auth, env, allocEventId);
        }
        if (method === "DELETE") {
          return handleDeleteAllocation(request, auth, env, allocEventId);
        }
      }

      // -- Pre-meeting context briefing routes -----------------------------------

      match = matchRoute(pathname, "/v1/events/:id/briefing");
      if (match && method === "GET") {
        return handleGetEventBriefing(request, auth, env, match.params[0]);
      }

      // -- Excuse generator routes (BR-17: draft only, never auto-send) ---------

      match = matchRoute(pathname, "/v1/events/:id/excuse");
      if (match && method === "POST") {
        return handleGenerateExcuse(request, auth, env, match.params[0]);
      }

      // -- Relationship tracking routes -----------------------------------------

      if (method === "POST" && pathname === "/v1/relationships") {
        return handleCreateRelationship(request, auth, env);
      }

      if (method === "GET" && pathname === "/v1/relationships") {
        // Check for ?sort=reliability_desc to return relationships with reputation
        const urlCheck = new URL(request.url);
        if (urlCheck.searchParams.get("sort") === "reliability_desc") {
          return handleListRelationshipsWithReputation(request, auth, env);
        }
        return handleListRelationships(request, auth, env);
      }

      if (method === "GET" && pathname === "/v1/drift-report") {
        return handleGetDriftReport(request, auth, env);
      }

      if (method === "GET" && pathname === "/v1/drift-alerts") {
        return handleGetDriftAlerts(request, auth, env);
      }

      if (method === "GET" && pathname === "/v1/reconnection-suggestions") {
        return handleGetReconnectionSuggestions(request, auth, env);
      }

      match = matchRoute(pathname, "/v1/trips/:id/reconnections");
      if (match && method === "GET") {
        return handleGetTripReconnections(request, auth, env, match.params[0]);
      }

      // -- Interaction ledger (outcomes) routes ---------------------------------
      // Must match before /v1/relationships/:id since it has more segments

      match = matchRoute(pathname, "/v1/relationships/:id/outcomes");
      if (match) {
        const relId = match.params[0];
        if (method === "POST") {
          return handleMarkOutcome(request, auth, env, relId);
        }
        if (method === "GET") {
          return handleListOutcomes(request, auth, env, relId);
        }
      }

      // -- Milestone routes ---------------------------------------------------------
      // Must match before /v1/relationships/:id since they have more segments

      // DELETE /v1/relationships/:id/milestones/:mid
      match = matchRoute(pathname, "/v1/relationships/:id/milestones/:mid");
      if (match && method === "DELETE") {
        return handleDeleteMilestone(request, auth, env, match.params[0], match.params[1]);
      }

      // POST/GET /v1/relationships/:id/milestones
      match = matchRoute(pathname, "/v1/relationships/:id/milestones");
      if (match) {
        const relId = match.params[0];
        if (method === "POST") {
          return handleCreateMilestone(request, auth, env, relId);
        }
        if (method === "GET") {
          return handleListMilestones(request, auth, env, relId);
        }
      }

      // GET /v1/milestones/upcoming?days=30
      if (method === "GET" && pathname === "/v1/milestones/upcoming") {
        return handleListUpcomingMilestones(request, auth, env);
      }

      // -- Reputation scoring routes ----------------------------------------------
      // Must match before /v1/relationships/:id since it has more segments

      match = matchRoute(pathname, "/v1/relationships/:id/reputation");
      if (match && method === "GET") {
        return handleGetReputation(request, auth, env, match.params[0]);
      }

      match = matchRoute(pathname, "/v1/relationships/:id");
      if (match) {
        const relId = match.params[0];
        if (method === "GET") {
          return handleGetRelationship(request, auth, env, relId);
        }
        if (method === "PUT") {
          return handleUpdateRelationship(request, auth, env, relId);
        }
        if (method === "DELETE") {
          return handleDeleteRelationship(request, auth, env, relId);
        }
      }

      // -- VIP policy routes (Premium+) ----------------------------------------

      if (method === "POST" && pathname === "/v1/vip-policies") {
        const vipGate = await enforceFeatureGate(auth.userId, "premium", env.DB);
        if (vipGate) return vipGate;
        return handleCreateVipPolicy(request, auth, env);
      }

      if (method === "GET" && pathname === "/v1/vip-policies") {
        return handleListVipPolicies(request, auth, env);
      }

      match = matchRoute(pathname, "/v1/vip-policies/:id");
      if (match && method === "DELETE") {
        const vipDeleteGate = await enforceFeatureGate(auth.userId, "premium", env.DB);
        if (vipDeleteGate) return vipDeleteGate;
        return handleDeleteVipPolicy(request, auth, env, match.params[0]);
      }

      // -- Commitment tracking routes (Premium+) --------------------------------

      if (method === "POST" && pathname === "/v1/commitments") {
        const commitGate = await enforceFeatureGate(auth.userId, "premium", env.DB);
        if (commitGate) return commitGate;
        return handleCreateCommitment(request, auth, env);
      }

      if (method === "GET" && pathname === "/v1/commitments") {
        return handleListCommitments(request, auth, env);
      }

      match = matchRoute(pathname, "/v1/commitments/:id/status");
      if (match && method === "GET") {
        return handleGetCommitmentStatus(request, auth, env, match.params[0]);
      }

      match = matchRoute(pathname, "/v1/commitments/:id/export");
      if (match && method === "POST") {
        const exportGate = await enforceFeatureGate(auth.userId, "premium", env.DB);
        if (exportGate) return exportGate;
        return handleExportCommitmentProof(request, auth, env, match.params[0]);
      }

      match = matchRoute(pathname, "/v1/commitments/:id");
      if (match && method === "DELETE") {
        const commitDeleteGate = await enforceFeatureGate(auth.userId, "premium", env.DB);
        if (commitDeleteGate) return commitDeleteGate;
        return handleDeleteCommitment(request, auth, env, match.params[0]);
      }

      // -- What-If Simulation route (Premium+) -----------------------------------

      if (method === "POST" && pathname === "/v1/simulation") {
        const simGate = await enforceFeatureGate(auth.userId, "premium", env.DB);
        if (simGate) return simGate;
        return handleSimulation(request, auth, env);
      }

      // -- Proof verification and download routes --------------------------------

      match = matchRoute(pathname, "/v1/proofs/:id/verify");
      if (match && method === "GET") {
        return handleVerifyProof(request, auth, env, match.params[0]);
      }

      if (method === "GET" && pathname.startsWith("/v1/proofs/")) {
        const r2Key = decodeURIComponent(pathname.slice("/v1/proofs/".length));
        return handleDownloadProof(request, auth, env, r2Key);
      }

      // -- Billing routes ---------------------------------------------------

      if (method === "POST" && pathname === "/v1/billing/checkout") {
        if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
          return jsonResponse(
            errorEnvelope("Billing not configured", "INTERNAL_ERROR"),
            ErrorCode.INTERNAL_ERROR,
          );
        }
        return handleCreateCheckoutSession(request, auth.userId, env as unknown as BillingEnv);
      }

      if (method === "GET" && pathname === "/v1/billing/status") {
        return handleGetBillingStatus(auth.userId, env as unknown as BillingEnv);
      }

      if (method === "POST" && pathname === "/v1/billing/portal") {
        if (!env.STRIPE_SECRET_KEY) {
          return jsonResponse(
            errorEnvelope("Billing not configured", "INTERNAL_ERROR"),
            ErrorCode.INTERNAL_ERROR,
          );
        }
        return handleCreatePortalSession(auth.userId, env as unknown as BillingEnv);
      }

      if (method === "GET" && pathname === "/v1/billing/events") {
        return handleGetBillingEvents(auth.userId, env as unknown as BillingEnv);
      }

      // -- CalDAV feed routes (Phase 5A) ------------------------------------

      match = matchRoute(pathname, "/v1/caldav/:user_id/calendar.ics");
      if (match && method === "GET") {
        return handleCalDavFeed(request, auth, env, match.params[0]);
      }

      // -- Subscription URL info route --------------------------------------

      if (method === "GET" && pathname === "/v1/caldav/subscription-url") {
        const baseUrl = new URL(request.url);
        const subscriptionUrl = `${baseUrl.protocol}//${baseUrl.host}/v1/caldav/${auth.userId}/calendar.ics`;
        return jsonResponse(
          successEnvelope({
            subscription_url: subscriptionUrl,
            content_type: "text/calendar",
            instructions: "Add this URL as a calendar subscription in your calendar app (Apple Calendar, Google Calendar, Outlook, etc.).",
          }),
          200,
        );
      }

      // -- Intelligence routes -------------------------------------------------

      if (method === "GET" && pathname === "/v1/intelligence/cognitive-load") {
        return handleGetCognitiveLoad(request, auth, env);
      }

      if (method === "GET" && pathname === "/v1/intelligence/context-switches") {
        return handleGetContextSwitches(request, auth, env);
      }

      if (method === "GET" && pathname === "/v1/intelligence/deep-work") {
        return handleGetDeepWork(request, auth, env);
      }

      if (method === "GET" && pathname === "/v1/intelligence/risk-scores") {
        return handleGetRiskScores(request, auth, env);
      }

      if (method === "GET" && pathname === "/v1/availability") {
        return handleGetAvailability(request, auth, env);
      }

      // -- Temporal Graph API routes (TM-b3i.4) --------------------------------

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

      // -- Organization routes (Enterprise) -----------------------------------

      if (method === "POST" && pathname === "/v1/orgs") {
        const orgGate = await enforceFeatureGate(auth.userId, "enterprise", env.DB);
        if (orgGate) return orgGate;
        return handleCreateOrg(request, auth, env.DB);
      }

      match = matchRoute(pathname, "/v1/orgs/:id/members/:uid/role");
      if (match && method === "PUT") {
        return handleChangeRole(request, auth, env.DB, match.params[0], match.params[1]);
      }

      match = matchRoute(pathname, "/v1/orgs/:id/members/:uid");
      if (match && method === "DELETE") {
        return handleRemoveMember(request, auth, env.DB, match.params[0], match.params[1]);
      }

      match = matchRoute(pathname, "/v1/orgs/:id/members");
      if (match) {
        if (method === "POST") {
          return handleAddMember(request, auth, env.DB, match.params[0]);
        }
        if (method === "GET") {
          return handleListMembers(request, auth, env.DB, match.params[0]);
        }
      }

      // -- Org policy routes (Enterprise, admin for write, member for read) ----

      match = matchRoute(pathname, "/v1/orgs/:id/policies/:pid");
      if (match) {
        const pOrgId = match.params[0];
        const pPolicyId = match.params[1];
        const policyGate = await enforceFeatureGate(auth.userId, "enterprise", env.DB);
        if (policyGate) return policyGate;
        if (method === "PUT") {
          return handleUpdateOrgPolicy(request, auth, env.DB, pOrgId, pPolicyId);
        }
        if (method === "DELETE") {
          return handleDeleteOrgPolicy(request, auth, env.DB, pOrgId, pPolicyId);
        }
      }

      match = matchRoute(pathname, "/v1/orgs/:id/policies");
      if (match) {
        const pOrgId = match.params[0];
        const policyGate = await enforceFeatureGate(auth.userId, "enterprise", env.DB);
        if (policyGate) return policyGate;
        if (method === "POST") {
          return handleCreateOrgPolicy(request, auth, env.DB, pOrgId);
        }
        if (method === "GET") {
          return handleListOrgPolicies(request, auth, env.DB, pOrgId);
        }
      }

      match = matchRoute(pathname, "/v1/orgs/:id");
      if (match && method === "GET") {
        return handleGetOrg(request, auth, env.DB, match.params[0]);
      }

      // -- Fallback ---------------------------------------------------------

      return jsonResponse(
        errorEnvelope("Not Found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
}

// ---------------------------------------------------------------------------
// Default export for Cloudflare Workers runtime
// ---------------------------------------------------------------------------

const handler = createHandler();
export default handler;
