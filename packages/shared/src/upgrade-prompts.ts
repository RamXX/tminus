/**
 * @tminus/shared -- Smart Upgrade Prompts & Contextual Nudges (TM-d17.4).
 *
 * Pure functions for evaluating when to show upgrade prompts to ICS-only users.
 * Prompts guide users from zero-auth ICS feed import toward full OAuth sync.
 *
 * Key design decisions:
 * - Pure functions, no side effects -- all state passed in, results returned
 * - Optional fields use key omission (undefined), not false, per TM-lfy retro learning
 * - Prompts are informational, not blocking (BR-1)
 * - Max 1 prompt per session (BR-2)
 * - Dismissed prompt type suppressed for 7 days (BR-3)
 * - Prompts only for ICS-only feeds, never for OAuth-connected accounts (BR-4)
 *
 * Trigger priority (highest first):
 * 1. conflict_detected -- immediate value proposition
 * 2. write_intent -- user hit a wall, most receptive
 * 3. stale_data -- data quality concern
 * 4. engagement -- general encouragement after proven usage
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Dismissal suppression duration: 7 days in milliseconds. */
export const DISMISSAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/** Default engagement thresholds for triggering prompts. */
export const DEFAULT_ENGAGEMENT_THRESHOLDS: PromptThresholds = {
  engagementDaysThreshold: 3,
};

/** Trigger priority order (highest priority first). */
const TRIGGER_PRIORITY: readonly PromptTriggerType[] = [
  "conflict_detected",
  "write_intent",
  "stale_data",
  "engagement",
];

/** Provider display names for prompt messages. */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  google: "Google",
  microsoft: "Microsoft",
  apple: "Apple",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Types of upgrade prompts. */
export type PromptTriggerType =
  | "conflict_detected"
  | "stale_data"
  | "write_intent"
  | "engagement";

/** User engagement metrics for prompt evaluation. */
export interface EngagementMetrics {
  /** Number of unique days the user has accessed the calendar view. */
  readonly daysActive: number;
  /** Number of event detail views. */
  readonly eventsViewed: number;
  /** Number of detected scheduling conflicts across feeds. */
  readonly conflictsDetected: number;
  /** Number of ICS feeds imported. */
  readonly feedsAdded: number;
}

/**
 * Contextual information about the current feed state.
 * All fields optional -- use key omission for unset values.
 */
export interface FeedContext {
  /** Whether a scheduling conflict was detected in the current view. */
  readonly hasConflict?: boolean;
  /** Names of the feeds involved in the conflict. */
  readonly conflictFeedNames?: readonly string[];
  /** Whether any feed is stale (>30 minutes since last refresh). */
  readonly isFeedStale?: boolean;
  /** Name of the stale feed. */
  readonly staleFeedName?: string;
  /** Provider of the stale feed (for branded messaging). */
  readonly staleFeedProvider?: string;
  /** Whether user attempted a write action on an ICS-only feed. */
  readonly writeIntentOnIcsFeed?: boolean;
  /** Provider associated with the write intent. */
  readonly writeIntentFeedProvider?: string;
}

/** Configurable thresholds for prompt triggers. */
export interface PromptThresholds {
  /** Minimum active days before engagement prompt fires. Default: 3. */
  readonly engagementDaysThreshold: number;
}

/** Result of evaluating a single prompt trigger. */
export interface PromptTriggerResult {
  /** Which trigger type fired. */
  readonly type: PromptTriggerType;
  /** Provider for branded messaging (omitted if not provider-specific). */
  readonly provider?: string;
  /** Pre-built message for this trigger. */
  readonly message: string;
}

/** Record of a dismissed prompt. */
export interface PromptDismissal {
  /** The prompt type that was dismissed. */
  readonly type: PromptTriggerType;
  /** Timestamp (ms since epoch) when dismissed. */
  readonly dismissedAt: number;
}

/**
 * User-level prompt settings.
 * Uses key omission for unset values per retro learning:
 * - undefined permanentlyDismissed means "never interacted with prompts"
 * - explicit true means "user actively chose to dismiss all prompts"
 */
export interface PromptSettings {
  /** If true, user has permanently disabled all upgrade prompts. */
  readonly permanentlyDismissed?: true;
}

// ---------------------------------------------------------------------------
// Core evaluation functions
// ---------------------------------------------------------------------------

/**
 * Evaluate which prompt triggers are active given current metrics and context.
 *
 * Returns all triggers that match, sorted by priority. The caller should
 * use shouldShowPrompt() to pick at most one, applying dismissal and
 * session constraints.
 *
 * @param metrics - Current engagement metrics
 * @param context - Current feed context (conflict, stale, write intent)
 * @param thresholds - Configurable thresholds (optional, defaults provided)
 * @returns Array of triggered prompts, ordered by priority
 */
export function evaluatePromptTriggers(
  metrics: EngagementMetrics,
  context: FeedContext,
  thresholds: PromptThresholds = DEFAULT_ENGAGEMENT_THRESHOLDS,
): PromptTriggerResult[] {
  const results: PromptTriggerResult[] = [];

  // Conflict detected: overlapping events across different feeds
  if (context.hasConflict && metrics.conflictsDetected > 0) {
    results.push({
      type: "conflict_detected",
      message: getPromptMessage("conflict_detected", context),
    });
  }

  // Write intent: user tried to create/edit on ICS-only feed
  if (context.writeIntentOnIcsFeed) {
    results.push({
      type: "write_intent",
      provider: context.writeIntentFeedProvider,
      message: getPromptMessage("write_intent", context),
    });
  }

  // Stale data: feed hasn't refreshed in >30 minutes
  if (context.isFeedStale) {
    results.push({
      type: "stale_data",
      provider: context.staleFeedProvider,
      message: getPromptMessage("stale_data", context),
    });
  }

  // Engagement: user has been active for 3+ days
  if (metrics.daysActive >= thresholds.engagementDaysThreshold) {
    results.push({
      type: "engagement",
      message: getPromptMessage("engagement", context),
    });
  }

  // Sort by priority
  return results.sort(
    (a, b) => TRIGGER_PRIORITY.indexOf(a.type) - TRIGGER_PRIORITY.indexOf(b.type),
  );
}

/**
 * Determine which (if any) prompt to show, applying all suppression rules.
 *
 * Rules applied in order:
 * 1. If permanently dismissed via settings -> null
 * 2. If a prompt was already shown this session -> null (BR-2: max 1)
 * 3. For each trigger in priority order:
 *    - Skip if that type was dismissed within 7 days (BR-3)
 *    - Return the first non-dismissed trigger
 *
 * @param triggers - Evaluated triggers from evaluatePromptTriggers()
 * @param dismissals - Array of previous dismissal records
 * @param sessionPromptShown - The prompt type shown this session, or undefined
 * @param settings - User-level prompt settings
 * @param now - Current timestamp in milliseconds
 * @returns The prompt to show, or null if none should be shown
 */
export function shouldShowPrompt(
  triggers: PromptTriggerResult[],
  dismissals: PromptDismissal[],
  sessionPromptShown: PromptTriggerType | undefined,
  settings: PromptSettings,
  now: number = Date.now(),
): PromptTriggerResult | null {
  // BR-1: permanent suppression
  if (settings.permanentlyDismissed) {
    return null;
  }

  // BR-2: max 1 prompt per session
  if (isSessionPromptShown(sessionPromptShown)) {
    return null;
  }

  // Find first non-dismissed trigger
  for (const trigger of triggers) {
    if (!isDismissed(trigger.type, dismissals, now)) {
      return trigger;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Dismissal helpers
// ---------------------------------------------------------------------------

/**
 * Check if a prompt type is currently dismissed (within 7-day window).
 *
 * @param type - Prompt trigger type to check
 * @param dismissals - Array of dismissal records
 * @param now - Current timestamp in milliseconds
 * @returns true if this prompt type should be suppressed
 */
export function isDismissed(
  type: PromptTriggerType,
  dismissals: PromptDismissal[],
  now: number = Date.now(),
): boolean {
  const matching = dismissals.find((d) => d.type === type);
  if (!matching) return false;
  return now - matching.dismissedAt < DISMISSAL_DURATION_MS;
}

/**
 * Create a dismissal record for a prompt type.
 *
 * @param type - Prompt trigger type being dismissed
 * @param now - Current timestamp in milliseconds
 * @returns New dismissal record
 */
export function createDismissal(
  type: PromptTriggerType,
  now: number = Date.now(),
): PromptDismissal {
  return { type, dismissedAt: now };
}

/**
 * Check if any prompt has been shown in the current session.
 *
 * @param sessionPromptShown - The prompt type shown this session, or undefined
 * @returns true if a prompt has already been shown
 */
export function isSessionPromptShown(
  sessionPromptShown: PromptTriggerType | undefined,
): boolean {
  return sessionPromptShown !== undefined;
}

// ---------------------------------------------------------------------------
// Message generation
// ---------------------------------------------------------------------------

/**
 * Generate a user-facing prompt message for a trigger type.
 *
 * Messages are provider-specific where applicable, using the provider
 * display name from the feed context.
 *
 * @param type - Prompt trigger type
 * @param context - Feed context for provider-specific messaging
 * @returns Human-readable prompt message
 */
export function getPromptMessage(
  type: PromptTriggerType,
  context: FeedContext,
): string {
  switch (type) {
    case "conflict_detected": {
      const names = context.conflictFeedNames?.join(" and ") ?? "your calendars";
      return `T-Minus detected a scheduling conflict between ${names}. Upgrade to full sync to automatically manage conflicts.`;
    }
    case "stale_data": {
      const provider = context.staleFeedProvider
        ? PROVIDER_DISPLAY_NAMES[context.staleFeedProvider] ?? context.staleFeedProvider
        : "your";
      return `Your ${provider} calendar may be out of date. Connect directly for real-time updates.`;
    }
    case "write_intent": {
      const provider = context.writeIntentFeedProvider
        ? PROVIDER_DISPLAY_NAMES[context.writeIntentFeedProvider] ?? context.writeIntentFeedProvider
        : "this provider's";
      return `ICS feeds are read-only. Connect your ${provider} account to create and edit events.`;
    }
    case "engagement":
      return "You're getting value from T-Minus! Upgrade to full sync for real-time updates and two-way editing.";
  }
}
