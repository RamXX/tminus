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

import { isValidId, generateId, isValidBillingCategory, BILLING_CATEGORIES } from "@tminus/shared";
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
} from "./routes/scheduling";
import { enforceFeatureGate, enforceAccountLimit } from "./middleware/feature-gate";
import { generateApiKey, hashApiKey, isApiKeyFormat, extractPrefix } from "./api-keys";

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

      match = matchRoute(pathname, "/v1/scheduling/sessions/:id");
      if (match) {
        if (method === "GET") {
          return handleGetSchedulingSession(request, auth, env, match.params[0]);
        }
        if (method === "DELETE") {
          return handleCancelSchedulingSession(request, auth, env, match.params[0]);
        }
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

      match = matchRoute(pathname, "/v1/commitments/:id");
      if (match && method === "DELETE") {
        const commitDeleteGate = await enforceFeatureGate(auth.userId, "premium", env.DB);
        if (commitDeleteGate) return commitDeleteGate;
        return handleDeleteCommitment(request, auth, env, match.params[0]);
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
