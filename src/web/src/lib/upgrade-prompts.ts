/**
 * Upgrade prompt state management for the T-Minus SPA (TM-d17.4).
 *
 * Contains both the pure prompt evaluation logic and the stateful manager
 * that handles localStorage persistence and session tracking.
 *
 * Business rules enforced:
 * - BR-1: Prompts are informational, not blocking. User can always dismiss.
 * - BR-2: Max 1 prompt per session to avoid annoyance.
 * - BR-3: Dismissed prompt type suppressed for 7 days.
 * - BR-4: Prompts only show for ICS-only feeds, never for OAuth-connected accounts.
 *
 * Per retro learning: optional fields use key omission (undefined), not false.
 * - undefined permanentlyDismissed means "never interacted with prompts"
 * - explicit true means "user actively chose to dismiss all prompts"
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Dismissal suppression duration: 7 days in milliseconds. */
export const DISMISSAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/** localStorage key for dismissal records. */
export const STORAGE_KEY_DISMISSALS = "tminus_upgrade_prompt_dismissals";

/** localStorage key for prompt settings. */
export const STORAGE_KEY_SETTINGS = "tminus_upgrade_prompt_settings";

/** localStorage key for session prompt tracking. */
export const STORAGE_KEY_SESSION = "tminus_upgrade_prompt_session";

/** Default engagement thresholds. */
export const DEFAULT_ENGAGEMENT_THRESHOLDS: PromptThresholds = {
  engagementDaysThreshold: 3,
};

/** Provider display names for prompt messages. */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  google: "Google",
  microsoft: "Microsoft",
  apple: "Apple",
};

/** Trigger priority order (highest priority first). */
const TRIGGER_PRIORITY: readonly PromptTriggerType[] = [
  "conflict_detected",
  "write_intent",
  "stale_data",
  "engagement",
];

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
  readonly daysActive: number;
  readonly eventsViewed: number;
  readonly conflictsDetected: number;
  readonly feedsAdded: number;
}

/**
 * Contextual information about the current feed state.
 * All fields optional -- use key omission for unset values.
 */
export interface FeedContext {
  readonly hasConflict?: boolean;
  readonly conflictFeedNames?: readonly string[];
  readonly isFeedStale?: boolean;
  readonly staleFeedName?: string;
  readonly staleFeedProvider?: string;
  readonly writeIntentOnIcsFeed?: boolean;
  readonly writeIntentFeedProvider?: string;
}

/** Configurable thresholds for prompt triggers. */
export interface PromptThresholds {
  readonly engagementDaysThreshold: number;
}

/** Result of evaluating a single prompt trigger. */
export interface PromptTriggerResult {
  readonly type: PromptTriggerType;
  readonly provider?: string;
  readonly message: string;
}

/** Record of a dismissed prompt. */
export interface PromptDismissal {
  readonly type: PromptTriggerType;
  readonly dismissedAt: number;
}

/**
 * User-level prompt settings.
 * Uses key omission for unset values per retro learning.
 */
export interface PromptSettings {
  readonly permanentlyDismissed?: true;
}

// ---------------------------------------------------------------------------
// Pure functions: prompt evaluation
// ---------------------------------------------------------------------------

/**
 * Generate a user-facing prompt message for a trigger type.
 */
function getPromptMessage(type: PromptTriggerType, context: FeedContext): string {
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

/**
 * Evaluate which prompt triggers are active given current metrics and context.
 */
function evaluatePromptTriggers(
  metrics: EngagementMetrics,
  context: FeedContext,
  thresholds: PromptThresholds = DEFAULT_ENGAGEMENT_THRESHOLDS,
): PromptTriggerResult[] {
  const results: PromptTriggerResult[] = [];

  if (context.hasConflict && metrics.conflictsDetected > 0) {
    results.push({
      type: "conflict_detected",
      message: getPromptMessage("conflict_detected", context),
    });
  }

  if (context.writeIntentOnIcsFeed) {
    results.push({
      type: "write_intent",
      provider: context.writeIntentFeedProvider,
      message: getPromptMessage("write_intent", context),
    });
  }

  if (context.isFeedStale) {
    results.push({
      type: "stale_data",
      provider: context.staleFeedProvider,
      message: getPromptMessage("stale_data", context),
    });
  }

  if (metrics.daysActive >= thresholds.engagementDaysThreshold) {
    results.push({
      type: "engagement",
      message: getPromptMessage("engagement", context),
    });
  }

  return results.sort(
    (a, b) => TRIGGER_PRIORITY.indexOf(a.type) - TRIGGER_PRIORITY.indexOf(b.type),
  );
}

/**
 * Check if a prompt type is currently dismissed (within 7-day window).
 */
function isDismissed(
  type: PromptTriggerType,
  dismissals: PromptDismissal[],
  now: number,
): boolean {
  const matching = dismissals.find((d) => d.type === type);
  if (!matching) return false;
  return now - matching.dismissedAt < DISMISSAL_DURATION_MS;
}

/**
 * Determine which (if any) prompt to show, applying all suppression rules.
 */
function shouldShowPrompt(
  triggers: PromptTriggerResult[],
  dismissals: PromptDismissal[],
  sessionPromptShown: PromptTriggerType | undefined,
  settings: PromptSettings,
  now: number,
): PromptTriggerResult | null {
  if (settings.permanentlyDismissed) return null;
  if (sessionPromptShown !== undefined) return null;

  for (const trigger of triggers) {
    if (!isDismissed(trigger.type, dismissals, now)) {
      return trigger;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// UpgradePromptManager (stateful, manages storage + session)
// ---------------------------------------------------------------------------

/**
 * Manages upgrade prompt state with localStorage persistence.
 *
 * Usage:
 * ```typescript
 * const mgr = new UpgradePromptManager(localStorage);
 * const prompt = mgr.evaluate(metrics, feedContext);
 * if (prompt) {
 *   showBanner(prompt);
 *   mgr.markSessionPromptShown(prompt.type);
 * }
 * // User clicks "Not now":
 * mgr.dismiss(prompt.type);
 * ```
 */
export class UpgradePromptManager {
  private dismissals: PromptDismissal[];
  private settings: PromptSettings;
  private sessionPromptShown: PromptTriggerType | undefined;
  private readonly storage: Storage;

  constructor(storage: Storage) {
    this.storage = storage;
    this.dismissals = this.loadDismissals();
    this.settings = this.loadSettings();
    this.sessionPromptShown = undefined;
  }

  /**
   * Evaluate current conditions and return the prompt to show (or null).
   */
  evaluate(
    metrics: EngagementMetrics,
    context: FeedContext,
    now: number = Date.now(),
  ): PromptTriggerResult | null {
    const triggers = evaluatePromptTriggers(metrics, context);
    return shouldShowPrompt(
      triggers,
      this.dismissals,
      this.sessionPromptShown,
      this.settings,
      now,
    );
  }

  /**
   * Dismiss a prompt type for 7 days. Persists to localStorage.
   */
  dismiss(type: PromptTriggerType, now: number = Date.now()): void {
    this.dismissals = [
      ...this.dismissals.filter((d) => d.type !== type),
      { type, dismissedAt: now },
    ];
    this.saveDismissals();
  }

  /**
   * Mark that a prompt has been shown this session (BR-2: max 1).
   */
  markSessionPromptShown(type: PromptTriggerType): void {
    this.sessionPromptShown = type;
  }

  /**
   * Reset session state (e.g., on new page load).
   */
  resetSession(): void {
    this.sessionPromptShown = undefined;
  }

  getSessionPromptShown(): PromptTriggerType | undefined {
    return this.sessionPromptShown;
  }

  getDismissals(): PromptDismissal[] {
    return [...this.dismissals];
  }

  getSettings(): PromptSettings {
    return { ...this.settings };
  }

  /**
   * Set or clear permanent prompt dismissal. Persists to localStorage.
   */
  setPermanentlyDismissed(value: boolean): void {
    this.settings = value ? { permanentlyDismissed: true } : {};
    this.saveSettings();
  }

  // -------------------------------------------------------------------------
  // Private: localStorage I/O
  // -------------------------------------------------------------------------

  private loadDismissals(): PromptDismissal[] {
    try {
      const raw = this.storage.getItem(STORAGE_KEY_DISMISSALS);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed;
    } catch {
      return [];
    }
  }

  private saveDismissals(): void {
    try {
      this.storage.setItem(
        STORAGE_KEY_DISMISSALS,
        JSON.stringify(this.dismissals),
      );
    } catch {
      // Storage full or disabled -- fail silently
    }
  }

  private loadSettings(): PromptSettings {
    try {
      const raw = this.storage.getItem(STORAGE_KEY_SETTINGS);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return {};
      return parsed;
    } catch {
      return {};
    }
  }

  private saveSettings(): void {
    try {
      this.storage.setItem(
        STORAGE_KEY_SETTINGS,
        JSON.stringify(this.settings),
      );
    } catch {
      // Storage full or disabled -- fail silently
    }
  }
}
