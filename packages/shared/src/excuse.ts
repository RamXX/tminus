/**
 * @tminus/shared -- Excuse generator: template-based, tone-aware message
 * drafting for event cancellations and rescheduling.
 *
 * BR-17: NEVER auto-send. All outputs are marked is_draft=true.
 * The user must explicitly confirm before sending.
 *
 * Architecture: Template + AI hybrid approach.
 *   1. Base templates provide structure per tone x truth_level (9 combos).
 *   2. Workers AI (@cf/meta/llama-3.1-8b-instruct) refines based on
 *      relationship context (participant name, category, reputation, etc.).
 *   3. parseExcuseResponse normalises AI output into a structured ExcuseOutput.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid tone options for excuse generation. */
export type ExcuseTone = "formal" | "casual" | "apologetic";

/** Valid truth level options for excuse generation. */
export type TruthLevel = "full" | "vague" | "white_lie";

/** Context provided to the excuse generator from event + relationship data. */
export interface ExcuseContext {
  readonly event_title: string | null;
  readonly event_start: string;
  readonly participant_name: string | null;
  readonly participant_category: string;
  readonly last_interaction_summary: string | null;
  readonly reputation_score: number;
  readonly tone: ExcuseTone;
  readonly truth_level: TruthLevel;
}

/** Structured output from excuse generation. */
export interface ExcuseOutput {
  /** The generated draft message text. */
  readonly draft_message: string;
  /** Optional suggested reschedule times (populated when event context allows). */
  readonly suggested_reschedule?: {
    readonly reason: string;
    readonly proposed_times?: string[];
  };
  /** Always true -- BR-17: never auto-send. */
  readonly is_draft: true;
  /** The tone used for generation. */
  readonly tone: ExcuseTone;
  /** The truth level used for generation. */
  readonly truth_level: TruthLevel;
}

// ---------------------------------------------------------------------------
// Base templates: one per tone x truth_level combination (9 total)
// ---------------------------------------------------------------------------

/**
 * Template lookup keyed by "tone:truth_level".
 *
 * Templates contain {plausible_reason} placeholder for white_lie variants
 * which AI fills with a contextually appropriate reason.
 *
 * Full truth: references a conflicting commitment directly.
 * Vague truth: uses generic "something came up" style phrasing.
 * White lie: AI generates a plausible excuse using the placeholder.
 */
export const EXCUSE_TEMPLATES: Record<string, string> = {
  // -- Formal ---------------------------------------------------------------
  "formal:full":
    "I regret to inform you that I will be unable to attend due to a prior commitment that conflicts with this time. I sincerely apologize for the inconvenience and hope we can find an alternative time.",

  "formal:vague":
    "Unfortunately, something unexpected has come up and I will be unavailable at the scheduled time. I apologize for any inconvenience this may cause.",

  "formal:white_lie":
    "I regret that I must cancel due to {plausible_reason}. I sincerely apologize for the inconvenience and would like to reschedule at your earliest convenience.",

  // -- Casual ---------------------------------------------------------------
  "casual:full":
    "Hey, sorry but I can't make it -- I have another commitment at that time. Can we find a different time that works?",

  "casual:vague":
    "Hey, something came up and I won't be able to make it. Sorry about that! Can we reschedule?",

  "casual:white_lie":
    "Hey, sorry but I have to cancel because {plausible_reason}. Can we reschedule?",

  // -- Apologetic -----------------------------------------------------------
  "apologetic:full":
    "I am so sorry, but I have a conflicting commitment and truly cannot make it to our meeting. I deeply apologize for the disruption and want to make it up by finding a time that works better for both of us.",

  "apologetic:vague":
    "I am so sorry -- something unexpected has come up and I truly cannot make it. I deeply apologize and want to reschedule as soon as possible.",

  "apologetic:white_lie":
    "I am so sorry, but I have to cancel because {plausible_reason}. I truly apologize for the inconvenience and would love to reschedule.",
};

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

/**
 * Build a Workers AI prompt from event/relationship context and the
 * selected base template.
 *
 * The prompt instructs the AI to:
 * 1. Use the base template as structure
 * 2. Personalise using relationship context
 * 3. For white_lie: replace {plausible_reason} with a believable excuse
 * 4. Return ONLY the draft message text (no metadata)
 *
 * @param ctx - Event and relationship context with tone/truth selection
 * @returns Prompt string ready for Workers AI inference
 */
export function buildExcusePrompt(ctx: ExcuseContext): string {
  const templateKey = `${ctx.tone}:${ctx.truth_level}`;
  const template = EXCUSE_TEMPLATES[templateKey];

  const eventName = ctx.event_title ?? "the scheduled event";
  const recipientName = ctx.participant_name ?? "the recipient";
  const lastInteraction = ctx.last_interaction_summary ?? "no prior interactions recorded";

  const lines: string[] = [
    "You are a professional message drafting assistant. Generate a draft cancellation/rescheduling message only. Do not send anything -- this is a draft message only.",
    "",
    `Tone: ${ctx.tone}`,
    `Event: ${eventName}`,
    `Scheduled for: ${ctx.event_start}`,
    `Recipient: ${recipientName}`,
    `Relationship category: ${ctx.participant_category}`,
    `Last interaction: ${lastInteraction}`,
    `Reputation score: ${ctx.reputation_score}`,
    "",
    "Base template to refine:",
    template,
    "",
  ];

  if (ctx.truth_level === "white_lie") {
    lines.push(
      "IMPORTANT: Replace {plausible_reason} with a plausible, believable reason for cancellation that is contextually appropriate for the relationship type. Generate a specific, realistic reason.",
      "",
    );
  }

  lines.push(
    "Instructions:",
    `- Keep the ${ctx.tone} tone throughout`,
    "- Personalise for the specific recipient and relationship context",
    "- Keep the message concise (2-4 sentences)",
    "- Return ONLY the message text, nothing else",
    "- This is a draft message only -- do not include any send instructions",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/** Fallback message when AI returns empty or invalid response. */
const FALLBACK_MESSAGES: Record<string, string> = {
  "formal:full":
    "I regret that I must cancel our upcoming meeting due to a scheduling conflict. I apologize for the inconvenience.",
  "formal:vague":
    "Unfortunately, I will be unable to attend our scheduled meeting. I apologize for any inconvenience.",
  "formal:white_lie":
    "I regret that I must cancel our upcoming meeting due to an unforeseen obligation. I apologize for the inconvenience.",
  "casual:full":
    "Hey, sorry but I have a conflict and can't make our meeting. Can we reschedule?",
  "casual:vague":
    "Hey, something came up and I won't be able to make it. Sorry! Can we reschedule?",
  "casual:white_lie":
    "Hey, sorry but I have to cancel -- something came up that I need to handle. Can we find another time?",
  "apologetic:full":
    "I am so sorry, but I have a conflicting commitment and cannot make our meeting. I truly apologize.",
  "apologetic:vague":
    "I am so sorry, but something has come up and I truly cannot make it. I deeply apologize.",
  "apologetic:white_lie":
    "I am so sorry, but I must cancel due to an unexpected situation. I truly apologize for the inconvenience.",
};

/**
 * Parse the raw AI response text into a structured ExcuseOutput.
 *
 * Enforces BR-17: is_draft is ALWAYS true. The excuse system never
 * auto-sends messages.
 *
 * @param rawResponse - Raw text from Workers AI
 * @param tone - Tone used for generation
 * @param truthLevel - Truth level used for generation
 * @returns Structured excuse output with is_draft=true
 */
export function parseExcuseResponse(
  rawResponse: string,
  tone: ExcuseTone,
  truthLevel: TruthLevel,
): ExcuseOutput {
  const trimmed = rawResponse.trim();

  const draftMessage =
    trimmed.length > 0
      ? trimmed
      : FALLBACK_MESSAGES[`${tone}:${truthLevel}`] ??
        "I will need to cancel our meeting. I apologize for the inconvenience.";

  return {
    draft_message: draftMessage,
    is_draft: true,
    tone,
    truth_level: truthLevel,
  };
}
