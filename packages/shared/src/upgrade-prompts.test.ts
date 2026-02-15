/**
 * Unit tests for upgrade prompt logic (TM-d17.4).
 *
 * Covers:
 * - Engagement threshold calculation (days active, events viewed, conflicts, feeds)
 * - Each prompt trigger fires at correct threshold
 * - Dismissal suppresses prompt type for 7 days
 * - Max 1 prompt per session enforced
 * - Permanent suppression via settings
 * - Provider-specific prompt messaging
 * - Optional fields use key omission (not false) per retro learning
 */

import { describe, it, expect } from "vitest";
import {
  evaluatePromptTriggers,
  shouldShowPrompt,
  createDismissal,
  isDismissed,
  isSessionPromptShown,
  getPromptMessage,
  DEFAULT_ENGAGEMENT_THRESHOLDS,
  DISMISSAL_DURATION_MS,
  type EngagementMetrics,
  type PromptTriggerType,
  type PromptDismissal,
  type PromptSettings,
  type PromptTriggerResult,
  type FeedContext,
} from "./upgrade-prompts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_METRICS: EngagementMetrics = {
  daysActive: 0,
  eventsViewed: 0,
  conflictsDetected: 0,
  feedsAdded: 0,
};

const NOW = new Date("2026-02-15T12:00:00Z").getTime();
const SEVEN_DAYS_AGO = new Date("2026-02-08T12:00:00Z").getTime();
const EIGHT_DAYS_AGO = new Date("2026-02-07T12:00:00Z").getTime();

// ---------------------------------------------------------------------------
// evaluatePromptTriggers
// ---------------------------------------------------------------------------

describe("evaluatePromptTriggers", () => {
  it("returns no triggers when metrics are all zero", () => {
    const result = evaluatePromptTriggers(BASE_METRICS, {});
    expect(result).toEqual([]);
  });

  it("returns 'conflict_detected' trigger when conflicts > 0 and feed context has conflict", () => {
    const metrics: EngagementMetrics = { ...BASE_METRICS, conflictsDetected: 1 };
    const feedContext: FeedContext = {
      hasConflict: true,
      conflictFeedNames: ["Work Calendar", "Personal Calendar"],
    };
    const result = evaluatePromptTriggers(metrics, feedContext);
    expect(result).toContainEqual(
      expect.objectContaining({ type: "conflict_detected" }),
    );
  });

  it("returns 'stale_data' trigger when a feed is stale (>30 min)", () => {
    const feedContext: FeedContext = {
      staleFeedName: "Work Calendar",
      staleFeedProvider: "google",
      isFeedStale: true,
    };
    const result = evaluatePromptTriggers(BASE_METRICS, feedContext);
    expect(result).toContainEqual(
      expect.objectContaining({ type: "stale_data" }),
    );
  });

  it("returns 'write_intent' trigger when write intent on ICS feed", () => {
    const feedContext: FeedContext = {
      writeIntentOnIcsFeed: true,
      writeIntentFeedProvider: "google",
    };
    const result = evaluatePromptTriggers(BASE_METRICS, feedContext);
    expect(result).toContainEqual(
      expect.objectContaining({ type: "write_intent" }),
    );
  });

  it("returns 'engagement' trigger after 3+ active days", () => {
    const metrics: EngagementMetrics = { ...BASE_METRICS, daysActive: 3 };
    const result = evaluatePromptTriggers(metrics, {});
    expect(result).toContainEqual(
      expect.objectContaining({ type: "engagement" }),
    );
  });

  it("does NOT return 'engagement' trigger with only 2 active days", () => {
    const metrics: EngagementMetrics = { ...BASE_METRICS, daysActive: 2 };
    const result = evaluatePromptTriggers(metrics, {});
    const engagement = result.find((t) => t.type === "engagement");
    expect(engagement).toBeUndefined();
  });

  it("uses configurable thresholds", () => {
    const metrics: EngagementMetrics = { ...BASE_METRICS, daysActive: 5 };
    const result = evaluatePromptTriggers(metrics, {}, { engagementDaysThreshold: 7 });
    const engagement = result.find((t) => t.type === "engagement");
    expect(engagement).toBeUndefined();
  });

  it("returns multiple triggers when multiple conditions are met", () => {
    const metrics: EngagementMetrics = {
      daysActive: 4,
      eventsViewed: 20,
      conflictsDetected: 3,
      feedsAdded: 2,
    };
    const feedContext: FeedContext = {
      hasConflict: true,
      conflictFeedNames: ["A", "B"],
      isFeedStale: true,
      staleFeedName: "C",
      staleFeedProvider: "microsoft",
    };
    const result = evaluatePromptTriggers(metrics, feedContext);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// isDismissed
// ---------------------------------------------------------------------------

describe("isDismissed", () => {
  it("returns false when no dismissals exist", () => {
    expect(isDismissed("conflict_detected", [], NOW)).toBe(false);
  });

  it("returns true when prompt type was dismissed within 7 days", () => {
    const dismissals: PromptDismissal[] = [
      { type: "conflict_detected", dismissedAt: SEVEN_DAYS_AGO + 1 },
    ];
    expect(isDismissed("conflict_detected", dismissals, NOW)).toBe(true);
  });

  it("returns false when prompt type was dismissed more than 7 days ago", () => {
    const dismissals: PromptDismissal[] = [
      { type: "conflict_detected", dismissedAt: EIGHT_DAYS_AGO },
    ];
    expect(isDismissed("conflict_detected", dismissals, NOW)).toBe(false);
  });

  it("only checks matching prompt type", () => {
    const dismissals: PromptDismissal[] = [
      { type: "stale_data", dismissedAt: NOW - 1000 },
    ];
    expect(isDismissed("conflict_detected", dismissals, NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createDismissal
// ---------------------------------------------------------------------------

describe("createDismissal", () => {
  it("creates a dismissal record with current timestamp", () => {
    const dismissal = createDismissal("write_intent", NOW);
    expect(dismissal.type).toBe("write_intent");
    expect(dismissal.dismissedAt).toBe(NOW);
  });
});

// ---------------------------------------------------------------------------
// isSessionPromptShown
// ---------------------------------------------------------------------------

describe("isSessionPromptShown", () => {
  it("returns false when no prompt has been shown in this session", () => {
    expect(isSessionPromptShown(undefined)).toBe(false);
  });

  it("returns true when a prompt has been shown in this session", () => {
    expect(isSessionPromptShown("conflict_detected")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shouldShowPrompt
// ---------------------------------------------------------------------------

describe("shouldShowPrompt", () => {
  it("returns the highest priority trigger when no dismissals or session prompts", () => {
    const triggers: PromptTriggerResult[] = [
      { type: "conflict_detected", provider: "google", message: "test" },
      { type: "engagement", message: "test2" },
    ];
    const result = shouldShowPrompt(triggers, [], undefined, {}, NOW);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("conflict_detected");
  });

  it("returns null when all triggers are dismissed", () => {
    const triggers: PromptTriggerResult[] = [
      { type: "conflict_detected", provider: "google", message: "test" },
    ];
    const dismissals: PromptDismissal[] = [
      { type: "conflict_detected", dismissedAt: NOW - 1000 },
    ];
    const result = shouldShowPrompt(triggers, dismissals, undefined, {}, NOW);
    expect(result).toBeNull();
  });

  it("returns null when a session prompt has already been shown (max 1 per session)", () => {
    const triggers: PromptTriggerResult[] = [
      { type: "engagement", message: "test" },
    ];
    const result = shouldShowPrompt(triggers, [], "conflict_detected", {}, NOW);
    expect(result).toBeNull();
  });

  it("returns null when permanently dismissed via settings", () => {
    const triggers: PromptTriggerResult[] = [
      { type: "engagement", message: "test" },
    ];
    const settings: PromptSettings = { permanentlyDismissed: true };
    const result = shouldShowPrompt(triggers, [], undefined, settings, NOW);
    expect(result).toBeNull();
  });

  it("skips dismissed trigger and returns next available", () => {
    const triggers: PromptTriggerResult[] = [
      { type: "conflict_detected", provider: "google", message: "test" },
      { type: "engagement", message: "test2" },
    ];
    const dismissals: PromptDismissal[] = [
      { type: "conflict_detected", dismissedAt: NOW - 1000 },
    ];
    const result = shouldShowPrompt(triggers, dismissals, undefined, {}, NOW);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("engagement");
  });

  it("returns null when triggers list is empty", () => {
    const result = shouldShowPrompt([], [], undefined, {}, NOW);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getPromptMessage
// ---------------------------------------------------------------------------

describe("getPromptMessage", () => {
  it("returns conflict message with feed names", () => {
    const msg = getPromptMessage("conflict_detected", {
      conflictFeedNames: ["Work Calendar", "Personal Calendar"],
    });
    expect(msg).toContain("scheduling conflict");
  });

  it("returns stale data message with provider name", () => {
    const msg = getPromptMessage("stale_data", {
      staleFeedName: "Work Calendar",
      staleFeedProvider: "google",
    });
    expect(msg).toContain("out of date");
    expect(msg).toContain("Google");
  });

  it("returns write intent message with provider context", () => {
    const msg = getPromptMessage("write_intent", {
      writeIntentFeedProvider: "microsoft",
    });
    expect(msg).toContain("read-only");
    expect(msg).toContain("Microsoft");
  });

  it("returns engagement message", () => {
    const msg = getPromptMessage("engagement", {});
    expect(msg).toContain("value from T-Minus");
    expect(msg).toContain("real-time");
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_ENGAGEMENT_THRESHOLDS
// ---------------------------------------------------------------------------

describe("DEFAULT_ENGAGEMENT_THRESHOLDS", () => {
  it("has engagement days threshold of 3", () => {
    expect(DEFAULT_ENGAGEMENT_THRESHOLDS.engagementDaysThreshold).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// DISMISSAL_DURATION_MS
// ---------------------------------------------------------------------------

describe("DISMISSAL_DURATION_MS", () => {
  it("equals 7 days in milliseconds", () => {
    expect(DISMISSAL_DURATION_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// Optional fields use key omission (retro learning)
// ---------------------------------------------------------------------------

describe("optional fields use key omission per retro learning", () => {
  it("PromptSettings with no permanentlyDismissed is different from explicit true", () => {
    const notSet: PromptSettings = {};
    const explicitTrue: PromptSettings = { permanentlyDismissed: true };
    // Undefined means "never interacted with prompts"
    expect(notSet.permanentlyDismissed).toBeUndefined();
    // Explicit true means "user actively chose to dismiss"
    expect(explicitTrue.permanentlyDismissed).toBe(true);
  });

  it("PromptTriggerResult provider is optional (omitted for engagement)", () => {
    const engagementTrigger: PromptTriggerResult = {
      type: "engagement",
      message: "test",
    };
    expect(engagementTrigger.provider).toBeUndefined();
  });
});
