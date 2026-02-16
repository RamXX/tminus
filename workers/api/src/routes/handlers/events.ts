/**
 * Route group: Events (CRUD + allocation + briefing + excuse).
 */

import { isValidId, generateId, isValidBillingCategory, BILLING_CATEGORIES, buildExcusePrompt, parseExcuseResponse } from "@tminus/shared";
import type { ExcuseTone, TruthLevel, ExcuseContext } from "@tminus/shared";
import {
  type RouteGroupHandler,
  type AuthContext,
  matchRoute,
  callDO,
  parseJsonBody,
  jsonResponse,
  successEnvelope,
  errorEnvelope,
  ErrorCode,
} from "../shared";

// ---------------------------------------------------------------------------
// Event CRUD handlers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Time Allocation handlers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Briefing and Excuse handlers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Route group: Events
// ---------------------------------------------------------------------------

export const routeEventRoutes: RouteGroupHandler = async (request, method, pathname, auth, env) => {
  if (method === "GET" && pathname === "/v1/events") {
    return handleListEvents(request, auth, env);
  }

  if (method === "POST" && pathname === "/v1/events") {
    return handleCreateEvent(request, auth, env);
  }

  // Time allocation routes -- must match before generic /v1/events/:id
  let match = matchRoute(pathname, "/v1/events/:id/allocation");
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

  // Pre-meeting context briefing
  match = matchRoute(pathname, "/v1/events/:id/briefing");
  if (match && method === "GET") {
    return handleGetEventBriefing(request, auth, env, match.params[0]);
  }

  // Excuse generator (BR-17: draft only, never auto-send)
  match = matchRoute(pathname, "/v1/events/:id/excuse");
  if (match && method === "POST") {
    return handleGenerateExcuse(request, auth, env, match.params[0]);
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

  return null;
};

