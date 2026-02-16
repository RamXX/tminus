/**
 * Scheduling API route handlers for the T-Minus REST API.
 *
 * Provides endpoints:
 * - POST /v1/scheduling/sessions  -- Create a scheduling session (triggers workflow)
 * - GET  /v1/scheduling/sessions -- List scheduling sessions
 * - GET  /v1/scheduling/sessions/:id -- Get a session
 * - GET  /v1/scheduling/sessions/:id/candidates -- Get candidates for a session
 * - POST /v1/scheduling/sessions/:id/commit -- Commit a selected candidate
 * - DELETE /v1/scheduling/sessions/:id -- Cancel a session
 * - POST /v1/scheduling/sessions/:id/extend-hold -- Extend hold expiry (TM-82s.4)
 *
 * These handlers delegate to the SchedulingWorkflow which interacts with
 * UserGraphDO for availability computation, session storage, and event creation.
 */

import { SchedulingWorkflow } from "@tminus/workflow-scheduling";
import type { SchedulingParams, SchedulingSession, Hold } from "@tminus/workflow-scheduling";
import {
  validateHoldDurationHours,
  computeExtendedExpiry,
  isApproachingExpiry,
  HOLD_DURATION_DEFAULT_HOURS,
} from "@tminus/workflow-scheduling";
import {
  type AuthContext,
  successEnvelope,
  errorEnvelope,
  jsonResponse,
  parseJsonBody,
} from "./shared";

// ---------------------------------------------------------------------------
// Env bindings needed by scheduling handlers
// ---------------------------------------------------------------------------

export interface SchedulingHandlerEnv {
  USER_GRAPH: DurableObjectNamespace;
  ACCOUNT: DurableObjectNamespace;
  WRITE_QUEUE: Queue;
}

// ---------------------------------------------------------------------------
// Hold lifecycle enrichment (TM-82s.4)
// ---------------------------------------------------------------------------

/**
 * Enrich a session response with hold lifecycle metadata for polling.
 *
 * Adds:
 * - approaching_expiry: true if any active hold is within 1 hour of expiry
 * - earliest_expiry: ISO string of the soonest hold expiry (for UI countdown)
 *
 * This is the polling-based notification mechanism (AC-2). The UI can poll
 * GET /v1/scheduling/sessions/:id and check these fields.
 */
function enrichSessionWithHoldStatus(
  session: SchedulingSession,
): SchedulingSession & { approaching_expiry: boolean; earliest_expiry: string | null } {
  const holds = session.holds ?? [];
  const activeHolds = holds.filter((h: Hold) => h.status === "held");

  if (activeHolds.length === 0) {
    return { ...session, approaching_expiry: false, earliest_expiry: null };
  }

  const anyApproaching = activeHolds.some((h: Hold) => isApproachingExpiry(h));

  // Find the earliest expiry among active holds
  const earliest = activeHolds.reduce((min: string | null, h: Hold) => {
    if (!min) return h.expires_at;
    return new Date(h.expires_at).getTime() < new Date(min).getTime() ? h.expires_at : min;
  }, null as string | null);

  return { ...session, approaching_expiry: anyApproaching, earliest_expiry: earliest };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /v1/scheduling/sessions
 *
 * Creates a scheduling session: computes availability, runs greedy solver,
 * stores candidates, returns the session with scored candidates.
 */
export async function handleCreateSchedulingSession(
  request: Request,
  auth: AuthContext,
  env: SchedulingHandlerEnv,
): Promise<Response> {
  const body = await parseJsonBody<{
    title?: string;
    duration_minutes?: number;
    window_start?: string;
    window_end?: string;
    required_account_ids?: string[];
    max_candidates?: number;
  }>(request);

  if (!body) {
    return jsonResponse(
      errorEnvelope("Request body must be valid JSON"),
      400,
    );
  }

  // Validate required fields
  if (!body.title || typeof body.title !== "string" || body.title.trim().length === 0) {
    return jsonResponse(errorEnvelope("title is required"), 400);
  }
  if (!body.duration_minutes || typeof body.duration_minutes !== "number") {
    return jsonResponse(errorEnvelope("duration_minutes is required and must be a number"), 400);
  }
  if (body.duration_minutes < 15 || body.duration_minutes > 480) {
    return jsonResponse(errorEnvelope("duration_minutes must be between 15 and 480"), 400);
  }
  if (!body.window_start || typeof body.window_start !== "string") {
    return jsonResponse(errorEnvelope("window_start is required"), 400);
  }
  if (!body.window_end || typeof body.window_end !== "string") {
    return jsonResponse(errorEnvelope("window_end is required"), 400);
  }
  if (isNaN(Date.parse(body.window_start))) {
    return jsonResponse(errorEnvelope("window_start must be a valid ISO 8601 date"), 400);
  }
  if (isNaN(Date.parse(body.window_end))) {
    return jsonResponse(errorEnvelope("window_end must be a valid ISO 8601 date"), 400);
  }
  if (new Date(body.window_start) >= new Date(body.window_end)) {
    return jsonResponse(errorEnvelope("window_start must be before window_end"), 400);
  }
  if (!body.required_account_ids || !Array.isArray(body.required_account_ids) || body.required_account_ids.length === 0) {
    return jsonResponse(errorEnvelope("required_account_ids must be a non-empty array"), 400);
  }

  try {
    const workflow = new SchedulingWorkflow(env);
    const params: SchedulingParams = {
      userId: auth.userId,
      title: body.title.trim(),
      durationMinutes: body.duration_minutes,
      windowStart: body.window_start,
      windowEnd: body.window_end,
      requiredAccountIds: body.required_account_ids,
      maxCandidates: body.max_candidates,
    };

    const session = await workflow.createSession(params);

    return jsonResponse(successEnvelope(session), 201);
  } catch (err) {
    console.error("Failed to create scheduling session", err);
    const message = err instanceof Error ? err.message : "Failed to create scheduling session";
    return jsonResponse(errorEnvelope(message), 500);
  }
}

/**
 * GET /v1/scheduling/sessions/:id/candidates
 *
 * Retrieves the session with its scored candidates.
 */
export async function handleGetSchedulingCandidates(
  _request: Request,
  auth: AuthContext,
  env: SchedulingHandlerEnv,
  sessionId: string,
): Promise<Response> {
  try {
    const workflow = new SchedulingWorkflow(env);
    const session = await workflow.getCandidates(auth.userId, sessionId);

    return jsonResponse(successEnvelope(session), 200);
  } catch (err) {
    console.error("Failed to get scheduling candidates", err);
    const message = err instanceof Error ? err.message : "Failed to get candidates";
    const status = message.includes("not found") ? 404 : 500;
    return jsonResponse(errorEnvelope(message), status);
  }
}

/**
 * GET /v1/scheduling/sessions
 *
 * Lists scheduling sessions for the authenticated user.
 * Supports optional ?status= query parameter for filtering.
 */
export async function handleListSchedulingSessions(
  request: Request,
  auth: AuthContext,
  env: SchedulingHandlerEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status") ?? undefined;
  const limitStr = url.searchParams.get("limit");
  const offsetStr = url.searchParams.get("offset");

  // Validate status filter if provided
  const validStatuses = new Set([
    "open",
    "candidates_ready",
    "committed",
    "cancelled",
    "expired",
  ]);
  if (statusFilter && !validStatuses.has(statusFilter)) {
    return jsonResponse(
      errorEnvelope(
        `Invalid status filter "${statusFilter}". Must be one of: ${[...validStatuses].join(", ")}`,
      ),
      400,
    );
  }

  const limit = limitStr ? parseInt(limitStr, 10) : 50;
  const offset = offsetStr ? parseInt(offsetStr, 10) : 0;

  if (isNaN(limit) || limit < 1 || limit > 100) {
    return jsonResponse(errorEnvelope("limit must be between 1 and 100"), 400);
  }
  if (isNaN(offset) || offset < 0) {
    return jsonResponse(errorEnvelope("offset must be >= 0"), 400);
  }

  try {
    const userGraphId = env.USER_GRAPH.idFromName(auth.userId);
    const stub = env.USER_GRAPH.get(userGraphId);

    const response = await stub.fetch(
      new Request("https://user-graph.internal/listSchedulingSessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: statusFilter, limit, offset }),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(body);
    }

    const data = await response.json();
    return jsonResponse(successEnvelope(data), 200);
  } catch (err) {
    console.error("Failed to list scheduling sessions", err);
    const message = err instanceof Error ? err.message : "Failed to list scheduling sessions";
    return jsonResponse(errorEnvelope(message), 500);
  }
}

/**
 * GET /v1/scheduling/sessions/:id
 *
 * Retrieves a single scheduling session with its candidates.
 * TM-82s.4: Response includes approaching_expiry and earliest_expiry fields
 * for UI polling of hold lifecycle status.
 */
export async function handleGetSchedulingSession(
  _request: Request,
  auth: AuthContext,
  env: SchedulingHandlerEnv,
  sessionId: string,
): Promise<Response> {
  try {
    const workflow = new SchedulingWorkflow(env);
    const session = await workflow.getCandidates(auth.userId, sessionId);

    // TM-82s.4: Enrich with hold lifecycle metadata for polling
    const enriched = enrichSessionWithHoldStatus(session);

    return jsonResponse(successEnvelope(enriched), 200);
  } catch (err) {
    console.error("Failed to get scheduling session", err);
    const message = err instanceof Error ? err.message : "Failed to get session";
    const status = message.includes("not found") ? 404 : 500;
    return jsonResponse(errorEnvelope(message), status);
  }
}

/**
 * DELETE /v1/scheduling/sessions/:id
 *
 * Cancels a scheduling session and releases any held calendar slots.
 */
export async function handleCancelSchedulingSession(
  _request: Request,
  auth: AuthContext,
  env: SchedulingHandlerEnv,
  sessionId: string,
): Promise<Response> {
  try {
    const userGraphId = env.USER_GRAPH.idFromName(auth.userId);
    const stub = env.USER_GRAPH.get(userGraphId);

    const response = await stub.fetch(
      new Request("https://user-graph.internal/cancelSchedulingSession", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      let errorMsg: string;
      try {
        const parsed = JSON.parse(body);
        errorMsg = parsed.error ?? body;
      } catch {
        errorMsg = body;
      }

      if (errorMsg.includes("not found")) {
        return jsonResponse(errorEnvelope(errorMsg), 404);
      }
      if (
        errorMsg.includes("already cancelled") ||
        errorMsg.includes("already committed") ||
        errorMsg.includes("expired")
      ) {
        return jsonResponse(errorEnvelope(errorMsg), 409);
      }
      throw new Error(errorMsg);
    }

    return jsonResponse(successEnvelope({ cancelled: true, session_id: sessionId }), 200);
  } catch (err) {
    console.error("Failed to cancel scheduling session", err);
    const message = err instanceof Error ? err.message : "Failed to cancel session";

    if (message.includes("not found")) {
      return jsonResponse(errorEnvelope(message), 404);
    }
    if (
      message.includes("already cancelled") ||
      message.includes("already committed") ||
      message.includes("expired")
    ) {
      return jsonResponse(errorEnvelope(message), 409);
    }

    return jsonResponse(errorEnvelope(message), 500);
  }
}

/**
 * POST /v1/scheduling/sessions/:id/commit
 *
 * Commits a selected candidate: creates canonical event, projects mirrors.
 */
export async function handleCommitSchedulingCandidate(
  request: Request,
  auth: AuthContext,
  env: SchedulingHandlerEnv,
  sessionId: string,
): Promise<Response> {
  const body = await parseJsonBody<{ candidate_id?: string }>(request);

  if (!body || !body.candidate_id || typeof body.candidate_id !== "string") {
    return jsonResponse(errorEnvelope("candidate_id is required"), 400);
  }

  try {
    const workflow = new SchedulingWorkflow(env);
    const result = await workflow.commitCandidate(
      auth.userId,
      sessionId,
      body.candidate_id,
    );

    return jsonResponse(
      successEnvelope({
        event_id: result.eventId,
        session: result.session,
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to commit scheduling candidate", err);
    const message = err instanceof Error ? err.message : "Failed to commit candidate";

    let status = 500;
    if (message.includes("not found")) status = 404;
    if (message.includes("already committed") || message.includes("expired") || message.includes("cancelled")) {
      status = 409;
    }

    return jsonResponse(errorEnvelope(message), status);
  }
}

/**
 * POST /v1/scheduling/sessions/:id/extend-hold (TM-82s.4)
 *
 * Extends the expiry of all active holds for a scheduling session.
 * Validates the session is in a valid state and the requested duration
 * is within the configurable range (1-72 hours).
 */
export async function handleExtendHold(
  request: Request,
  auth: AuthContext,
  env: SchedulingHandlerEnv,
  sessionId: string,
): Promise<Response> {
  const body = await parseJsonBody<{
    duration_hours?: number;
  }>(request);

  // duration_hours is optional -- defaults to HOLD_DURATION_DEFAULT_HOURS (24)
  const durationHours = body?.duration_hours ?? HOLD_DURATION_DEFAULT_HOURS;

  if (typeof durationHours !== "number" || isNaN(durationHours)) {
    return jsonResponse(errorEnvelope("duration_hours must be a number"), 400);
  }

  // Validate the duration is within range
  try {
    validateHoldDurationHours(durationHours);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid duration";
    return jsonResponse(errorEnvelope(message), 400);
  }

  try {
    // Get the session to verify it exists and is in a valid state
    const workflow = new SchedulingWorkflow(env);
    const session = await workflow.getCandidates(auth.userId, sessionId);

    if (session.status !== "candidates_ready") {
      return jsonResponse(
        errorEnvelope(
          `Cannot extend holds for session in '${session.status}' status. Session must be in 'candidates_ready' status.`,
        ),
        409,
      );
    }

    // Get active holds for this session
    const holds = await workflow.getHoldsBySession(auth.userId, sessionId);
    const activeHolds = holds.filter((h) => h.status === "held");

    if (activeHolds.length === 0) {
      return jsonResponse(
        errorEnvelope("No active holds found for this session"),
        404,
      );
    }

    // Compute new expiry for each active hold
    const now = new Date().toISOString();
    const extendedHolds: Array<{ hold_id: string; new_expires_at: string }> = [];

    for (const hold of activeHolds) {
      const newExpiresAt = computeExtendedExpiry(hold, durationHours, now);
      extendedHolds.push({ hold_id: hold.hold_id, new_expires_at: newExpiresAt });
    }

    // Update holds in UserGraphDO
    const userGraphId = env.USER_GRAPH.idFromName(auth.userId);
    const stub = env.USER_GRAPH.get(userGraphId);

    const response = await stub.fetch(
      new Request("https://user-graph.internal/extendHolds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          holds: extendedHolds,
        }),
      }),
    );

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`UserGraphDO.extendHolds failed (${response.status}): ${errBody}`);
    }

    return jsonResponse(
      successEnvelope({
        session_id: sessionId,
        extended_holds: extendedHolds.length,
        duration_hours: durationHours,
        new_expires_at: extendedHolds[0]?.new_expires_at ?? null,
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to extend holds", err);
    const message = err instanceof Error ? err.message : "Failed to extend holds";

    if (message.includes("not found")) {
      return jsonResponse(errorEnvelope(message), 404);
    }
    if (message.includes("Only holds in")) {
      return jsonResponse(errorEnvelope(message), 409);
    }

    return jsonResponse(errorEnvelope(message), 500);
  }
}
