/**
 * Event intelligence handlers: pre-meeting briefing and excuse generation.
 *
 * Extracted from events.ts for single-responsibility decomposition.
 */

import { isValidId, buildExcusePrompt, parseExcuseResponse } from "@tminus/shared";
import type { ExcuseTone, TruthLevel, ExcuseContext } from "@tminus/shared";
import {
  type AuthContext,
  callDO,
  parseJsonBody,
  jsonResponse,
  successEnvelope,
  errorEnvelope,
  ErrorCode,
} from "../../shared";

// ---------------------------------------------------------------------------
// Pre-meeting briefing
// ---------------------------------------------------------------------------

export async function handleGetEventBriefing(
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

// ---------------------------------------------------------------------------
// Excuse generator (BR-17: draft only, never auto-send)
// ---------------------------------------------------------------------------

const VALID_TONES: ExcuseTone[] = ["formal", "casual", "apologetic"];
const VALID_TRUTH_LEVELS: TruthLevel[] = ["full", "vague", "white_lie"];

export async function handleGenerateExcuse(
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
