/**
 * Scheduling API route handlers for the T-Minus REST API.
 *
 * Provides three endpoints:
 * - POST /v1/scheduling/sessions  -- Create a scheduling session (triggers workflow)
 * - GET  /v1/scheduling/sessions/:id/candidates -- Get candidates for a session
 * - POST /v1/scheduling/sessions/:id/commit -- Commit a selected candidate
 *
 * These handlers delegate to the SchedulingWorkflow which interacts with
 * UserGraphDO for availability computation, session storage, and event creation.
 */

import { SchedulingWorkflow } from "@tminus/workflow-scheduling";
import type { SchedulingParams } from "@tminus/workflow-scheduling";

// ---------------------------------------------------------------------------
// Types for the API handler signatures
// ---------------------------------------------------------------------------

/** Auth context passed from the main router. */
interface AuthContext {
  userId: string;
}

/** API response envelope. */
interface ApiEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  meta: {
    request_id: string;
    timestamp: string;
  };
}

// ---------------------------------------------------------------------------
// Env bindings needed by scheduling handlers
// ---------------------------------------------------------------------------

export interface SchedulingHandlerEnv {
  USER_GRAPH: DurableObjectNamespace;
  ACCOUNT: DurableObjectNamespace;
  WRITE_QUEUE: Queue;
}

// ---------------------------------------------------------------------------
// Response helpers (mirroring the pattern in workers/api/src/index.ts)
// ---------------------------------------------------------------------------

function generateRequestId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `req_${ts}_${rand}`;
}

function successEnvelope<T>(data: T): ApiEnvelope<T> {
  return {
    ok: true,
    data,
    meta: {
      request_id: generateRequestId(),
      timestamp: new Date().toISOString(),
    },
  };
}

function errorEnvelope(error: string): ApiEnvelope {
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
