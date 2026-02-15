/**
 * @tminus/shared -- Pre-meeting context briefing assembly.
 *
 * Pure functions for extracting topics from event titles and
 * assembling participant briefing data from relationship context.
 *
 * The briefing is computed on-demand from existing data in the
 * UserGraphDO. No external calls or side effects.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal participant data from event_participants + relationships. */
export interface BriefingParticipantInput {
  readonly participant_hash: string;
  readonly display_name: string | null;
  readonly category: string;
  readonly closeness_weight: number;
  readonly last_interaction_ts: string | null;
  readonly reputation_score: number;
  readonly total_interactions: number;
}

/** A participant in the briefing output with context. */
export interface BriefingParticipant {
  readonly participant_hash: string;
  readonly display_name: string | null;
  readonly category: string;
  readonly last_interaction_ts: string | null;
  readonly last_interaction_summary: string | null;
  readonly reputation_score: number;
  readonly mutual_connections_count: number;
}

/** The full briefing response for an event. */
export interface EventBriefing {
  readonly event_id: string;
  readonly event_title: string | null;
  readonly event_start: string;
  readonly topics: string[];
  readonly participants: BriefingParticipant[];
  readonly computed_at: string;
}

// ---------------------------------------------------------------------------
// Topic extraction
// ---------------------------------------------------------------------------

/**
 * Known meeting type keywords to extract from event titles.
 *
 * Simple keyword extraction (v1) -- not AI-powered.
 * Case-insensitive matching against title words and common bigrams.
 */
const TOPIC_KEYWORDS: readonly string[] = [
  "meeting",
  "sync",
  "standup",
  "stand-up",
  "retrospective",
  "retro",
  "review",
  "planning",
  "sprint",
  "demo",
  "kickoff",
  "kick-off",
  "brainstorm",
  "workshop",
  "interview",
  "onboarding",
  "training",
  "lunch",
  "dinner",
  "coffee",
  "happy hour",
  "1:1",
  "one-on-one",
  "check-in",
  "checkin",
  "debrief",
  "all-hands",
  "town hall",
  "quarterly",
  "weekly",
  "monthly",
  "daily",
  "status",
  "update",
  "handoff",
  "hand-off",
  "call",
  "presentation",
  "pitch",
  "board meeting",
  "investor",
  "fundraising",
  "strategy",
  "roadmap",
  "design review",
  "code review",
  "architecture",
  "postmortem",
  "post-mortem",
  "celebration",
  "offsite",
  "off-site",
] as const;

/**
 * Extract topic keywords from an event title.
 *
 * Performs case-insensitive matching against known meeting type
 * keywords. Multi-word keywords (e.g., "board meeting", "happy hour")
 * are matched as substrings. Single-word keywords are matched as
 * whole words to avoid false positives (e.g., "call" in "callback").
 *
 * Returns a deduplicated, sorted array of matched keywords.
 *
 * @param title - Event title string. Returns empty array for null/empty.
 * @returns Array of matched topic keywords, sorted alphabetically.
 */
export function extractTopics(title: string | null | undefined): string[] {
  if (!title || title.trim().length === 0) {
    return [];
  }

  const lower = title.toLowerCase();
  const matched = new Set<string>();

  for (const keyword of TOPIC_KEYWORDS) {
    if (keyword.includes(" ") || keyword.includes("-")) {
      // Multi-word or hyphenated: substring match
      if (lower.includes(keyword)) {
        matched.add(keyword);
      }
    } else {
      // Single word: whole-word boundary match
      const regex = new RegExp(`\\b${escapeRegex(keyword)}\\b`, "i");
      if (regex.test(lower)) {
        matched.add(keyword);
      }
    }
  }

  return Array.from(matched).sort();
}

/**
 * Escape special regex characters in a string.
 * Prevents injection when building dynamic RegExp from user/config data.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Last interaction summary
// ---------------------------------------------------------------------------

/**
 * Generate a human-readable summary of the last interaction time.
 *
 * @param lastInteractionTs - ISO 8601 timestamp, or null
 * @param now - Current timestamp for relative computation
 * @returns Human-readable string or null if no interaction
 */
export function summarizeLastInteraction(
  lastInteractionTs: string | null,
  now: string | Date,
): string | null {
  if (!lastInteractionTs) return null;

  const lastMs = new Date(lastInteractionTs).getTime();
  const nowMs = typeof now === "string" ? new Date(now).getTime() : now.getTime();
  const diffMs = nowMs - lastMs;

  if (diffMs < 0) return "upcoming";

  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));

  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  }
  if (days < 365) {
    const months = Math.floor(days / 30);
    return months === 1 ? "1 month ago" : `${months} months ago`;
  }
  const years = Math.floor(days / 365);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

// ---------------------------------------------------------------------------
// Briefing assembly
// ---------------------------------------------------------------------------

/**
 * Assemble a pre-meeting context briefing from event and relationship data.
 *
 * Pure function: takes all required data as inputs, returns the briefing
 * with no side effects.
 *
 * @param eventId - Canonical event ID
 * @param eventTitle - Event title (may be null)
 * @param eventStart - Event start timestamp (ISO 8601)
 * @param participants - Participant data with relationship context
 * @param mutualConnectionCounts - Map of participant_hash -> mutual connection count
 * @param now - Current timestamp for relative time computation
 * @returns Assembled event briefing
 */
export function assembleBriefing(
  eventId: string,
  eventTitle: string | null,
  eventStart: string,
  participants: readonly BriefingParticipantInput[],
  mutualConnectionCounts: ReadonlyMap<string, number>,
  now: string | Date,
): EventBriefing {
  const topics = extractTopics(eventTitle);
  const computedAt = typeof now === "string" ? now : now.toISOString();

  const briefingParticipants: BriefingParticipant[] = participants.map((p) => ({
    participant_hash: p.participant_hash,
    display_name: p.display_name,
    category: p.category,
    last_interaction_ts: p.last_interaction_ts,
    last_interaction_summary: summarizeLastInteraction(p.last_interaction_ts, now),
    reputation_score: Math.round(p.reputation_score * 100) / 100,
    mutual_connections_count: mutualConnectionCounts.get(p.participant_hash) ?? 0,
  }));

  // Sort by reputation score descending (most reliable first)
  briefingParticipants.sort((a, b) => b.reputation_score - a.reputation_score);

  return {
    event_id: eventId,
    event_title: eventTitle,
    event_start: eventStart,
    topics,
    participants: briefingParticipants,
    computed_at: computedAt,
  };
}
