/**
 * Shared types and utilities for route handlers.
 *
 * Centralizes types (RouteGroupHandler, AuthContext, ApiEnvelope) and helpers
 * (matchRoute, jsonResponse, successEnvelope, errorEnvelope) that are used
 * across multiple route group modules. Avoids circular imports between
 * index.ts and route files.
 */

// ---------------------------------------------------------------------------
// Auth context
// ---------------------------------------------------------------------------

export interface AuthContext {
  userId: string;
}

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

export function errorEnvelope(error: string, _code?: ErrorCodeName | string): ApiEnvelope {
  return {
    ok: false,
    error,
    meta: {
      request_id: generateRequestId(),
      timestamp: new Date().toISOString(),
    },
  };
}

export function jsonResponse(envelope: ApiEnvelope, status: number): Response {
  return new Response(JSON.stringify(envelope), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

export interface RouteMatch {
  /** Matched parameter values in order. */
  params: string[];
}

/**
 * Match a URL path against a pattern like "/v1/events/:id".
 * Returns matched params or null if no match.
 */
export function matchRoute(pathname: string, pattern: string): RouteMatch | null {
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
// Route group type
// ---------------------------------------------------------------------------

/**
 * A route group handler receives an authenticated request and returns a
 * Response if it handles the route, or null to delegate to the next group.
 */
export type RouteGroupHandler = (
  request: Request,
  method: string,
  pathname: string,
  auth: AuthContext,
  env: Env,
) => Promise<Response | null>;

// ---------------------------------------------------------------------------
// DO stub helpers
// ---------------------------------------------------------------------------

/**
 * Send a JSON RPC-style request to a Durable Object.
 */
export async function callDO<T>(
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

export async function parseJsonBody<T>(request: Request): Promise<T | null> {
  try {
    const text = await request.text();
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
