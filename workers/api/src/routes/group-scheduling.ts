/**
 * Group scheduling API route handlers for the T-Minus REST API (Phase 4D).
 *
 * Provides endpoints for multi-user scheduling coordination:
 * - POST /v1/scheduling/group-sessions  -- Create a group scheduling session
 * - GET  /v1/scheduling/group-sessions/:id -- Get a group session
 * - POST /v1/scheduling/group-sessions/:id/commit -- Commit a candidate
 *
 * These handlers delegate to GroupScheduleDO which coordinates across
 * multiple UserGraphDOs.
 */

import { GroupScheduleDO } from "@tminus/do-group-schedule";
import type { GroupSessionParams } from "@tminus/do-group-schedule";

// ---------------------------------------------------------------------------
// Types for the API handler signatures
// ---------------------------------------------------------------------------

interface AuthContext {
  userId: string;
}

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
// Env bindings needed by group scheduling handlers
// ---------------------------------------------------------------------------

export interface GroupSchedulingHandlerEnv {
  USER_GRAPH: DurableObjectNamespace;
  WRITE_QUEUE: Queue;
  DB: D1Database;
}

// ---------------------------------------------------------------------------
// Response helpers
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
 * POST /v1/scheduling/group-sessions
 *
 * Creates a group scheduling session: gathers availability from all
 * participants, runs solver on intersection, creates holds in all calendars.
 */
export async function handleCreateGroupSession(
  request: Request,
  auth: AuthContext,
  env: GroupSchedulingHandlerEnv,
): Promise<Response> {
  const body = await parseJsonBody<{
    title?: string;
    duration_minutes?: number;
    window_start?: string;
    window_end?: string;
    participant_user_ids?: string[];
    max_candidates?: number;
  }>(request);

  if (!body) {
    return jsonResponse(errorEnvelope("Request body must be valid JSON"), 400);
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
  if (!body.participant_user_ids || !Array.isArray(body.participant_user_ids) || body.participant_user_ids.length < 2) {
    return jsonResponse(errorEnvelope("participant_user_ids must be an array with at least 2 user IDs"), 400);
  }

  // Ensure the creator is in the participant list
  const participants = body.participant_user_ids.includes(auth.userId)
    ? body.participant_user_ids
    : [auth.userId, ...body.participant_user_ids];

  try {
    const groupDO = new GroupScheduleDO(env);
    const params: GroupSessionParams = {
      creatorUserId: auth.userId,
      participantUserIds: participants,
      title: body.title.trim(),
      durationMinutes: body.duration_minutes,
      windowStart: body.window_start,
      windowEnd: body.window_end,
      maxCandidates: body.max_candidates,
    };

    const session = await groupDO.createGroupSession(params);

    return jsonResponse(successEnvelope(session), 201);
  } catch (err) {
    console.error("Failed to create group scheduling session", err);
    const message = err instanceof Error ? err.message : "Failed to create group session";
    return jsonResponse(errorEnvelope(message), 500);
  }
}

/**
 * GET /v1/scheduling/group-sessions/:id
 *
 * Retrieves a group scheduling session. Only accessible by participants.
 */
export async function handleGetGroupSession(
  _request: Request,
  auth: AuthContext,
  env: GroupSchedulingHandlerEnv,
  sessionId: string,
): Promise<Response> {
  try {
    const groupDO = new GroupScheduleDO(env);
    const session = await groupDO.getGroupSession(sessionId, auth.userId);

    return jsonResponse(successEnvelope(session), 200);
  } catch (err) {
    console.error("Failed to get group scheduling session", err);
    const message = err instanceof Error ? err.message : "Failed to get group session";
    const status = message.includes("not found") ? 404 : message.includes("not a participant") ? 403 : 500;
    return jsonResponse(errorEnvelope(message), status);
  }
}

/**
 * POST /v1/scheduling/group-sessions/:id/commit
 *
 * Commits a selected candidate across ALL participants.
 * Atomic: all get the event, or none do.
 */
export async function handleCommitGroupSession(
  request: Request,
  auth: AuthContext,
  env: GroupSchedulingHandlerEnv,
  sessionId: string,
): Promise<Response> {
  const body = await parseJsonBody<{ candidate_id?: string }>(request);

  if (!body || !body.candidate_id || typeof body.candidate_id !== "string") {
    return jsonResponse(errorEnvelope("candidate_id is required"), 400);
  }

  try {
    const groupDO = new GroupScheduleDO(env);
    const result = await groupDO.commitGroupSession(
      sessionId,
      body.candidate_id,
      auth.userId,
    );

    return jsonResponse(
      successEnvelope({
        event_ids: result.eventIds,
        session: result.session,
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to commit group scheduling session", err);
    const message = err instanceof Error ? err.message : "Failed to commit group session";

    let status = 500;
    if (message.includes("not found")) status = 404;
    if (message.includes("not a participant")) status = 403;
    if (message.includes("already committed") || message.includes("cancelled") || message.includes("expired")) {
      status = 409;
    }

    return jsonResponse(errorEnvelope(message), status);
  }
}
