/**
 * Unit and integration tests for the web upgrade prompt state management (TM-d17.4).
 *
 * Covers:
 * - Unit: engagement threshold evaluation delegates to shared library
 * - Unit: each prompt trigger fires at correct threshold
 * - Unit: dismissal suppresses prompt type for 7 days
 * - Unit: max 1 prompt per session enforced
 * - Unit: permanent dismissal via settings
 * - Integration: conflict detection triggers upgrade prompt with correct message
 * - Integration: write intent on ICS feed triggers upgrade prompt
 * - Integration: dismissed prompt does not reappear within 7 days
 * - Integration: session state prevents multiple prompts
 * - Integration: localStorage persistence round-trip
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  UpgradePromptManager,
  STORAGE_KEY_DISMISSALS,
  STORAGE_KEY_SETTINGS,
  STORAGE_KEY_SESSION,
} from "./upgrade-prompts";

// ---------------------------------------------------------------------------
// Mock localStorage for consistent testing
// ---------------------------------------------------------------------------

const storageStore: Record<string, string> = {};

const mockStorage = {
  getItem: vi.fn((key: string) => storageStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { storageStore[key] = value; }),
  removeItem: vi.fn((key: string) => { delete storageStore[key]; }),
};

const NOW = new Date("2026-02-15T12:00:00Z").getTime();
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  Object.keys(storageStore).forEach((k) => delete storageStore[k]);
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Unit tests: UpgradePromptManager
// ---------------------------------------------------------------------------

describe("UpgradePromptManager", () => {
  describe("constructor", () => {
    it("initializes with empty dismissals and no session prompt", () => {
      const mgr = new UpgradePromptManager(mockStorage as unknown as Storage);
      expect(mgr.getDismissals()).toEqual([]);
      expect(mgr.getSessionPromptShown()).toBeUndefined();
    });

    it("restores dismissals from storage", () => {
      storageStore[STORAGE_KEY_DISMISSALS] = JSON.stringify([
        { type: "conflict_detected", dismissedAt: NOW - 1000 },
      ]);
      const mgr = new UpgradePromptManager(mockStorage as unknown as Storage);
      expect(mgr.getDismissals()).toHaveLength(1);
      expect(mgr.getDismissals()[0].type).toBe("conflict_detected");
    });

    it("restores settings from storage", () => {
      storageStore[STORAGE_KEY_SETTINGS] = JSON.stringify({ permanentlyDismissed: true });
      const mgr = new UpgradePromptManager(mockStorage as unknown as Storage);
      expect(mgr.getSettings().permanentlyDismissed).toBe(true);
    });
  });

  describe("evaluate", () => {
    it("returns conflict_detected prompt when conditions met", () => {
      const mgr = new UpgradePromptManager(mockStorage as unknown as Storage);
      const result = mgr.evaluate(
        { daysActive: 0, eventsViewed: 0, conflictsDetected: 2, feedsAdded: 1 },
        { hasConflict: true, conflictFeedNames: ["Work", "Personal"] },
        NOW,
      );
      expect(result).not.toBeNull();
      expect(result!.type).toBe("conflict_detected");
      expect(result!.message).toContain("scheduling conflict");
    });

    it("returns write_intent prompt when user attempts write on ICS feed", () => {
      const mgr = new UpgradePromptManager(mockStorage as unknown as Storage);
      const result = mgr.evaluate(
        { daysActive: 0, eventsViewed: 0, conflictsDetected: 0, feedsAdded: 1 },
        { writeIntentOnIcsFeed: true, writeIntentFeedProvider: "google" },
        NOW,
      );
      expect(result).not.toBeNull();
      expect(result!.type).toBe("write_intent");
      expect(result!.message).toContain("read-only");
      expect(result!.message).toContain("Google");
    });

    it("returns stale_data prompt when feed is stale", () => {
      const mgr = new UpgradePromptManager(mockStorage as unknown as Storage);
      const result = mgr.evaluate(
        { daysActive: 0, eventsViewed: 0, conflictsDetected: 0, feedsAdded: 1 },
        { isFeedStale: true, staleFeedName: "Work", staleFeedProvider: "microsoft" },
        NOW,
      );
      expect(result).not.toBeNull();
      expect(result!.type).toBe("stale_data");
      expect(result!.message).toContain("out of date");
      expect(result!.message).toContain("Microsoft");
    });

    it("returns engagement prompt after 3+ active days", () => {
      const mgr = new UpgradePromptManager(mockStorage as unknown as Storage);
      const result = mgr.evaluate(
        { daysActive: 3, eventsViewed: 15, conflictsDetected: 0, feedsAdded: 1 },
        {},
        NOW,
      );
      expect(result).not.toBeNull();
      expect(result!.type).toBe("engagement");
      expect(result!.message).toContain("value from T-Minus");
    });

    it("returns null when no triggers are active", () => {
      const mgr = new UpgradePromptManager(mockStorage as unknown as Storage);
      const result = mgr.evaluate(
        { daysActive: 0, eventsViewed: 0, conflictsDetected: 0, feedsAdded: 0 },
        {},
        NOW,
      );
      expect(result).toBeNull();
    });
  });

  describe("dismiss", () => {
    it("suppresses prompt type for 7 days", () => {
      const mgr = new UpgradePromptManager(mockStorage as unknown as Storage);

      // First evaluation should return the prompt
      const result1 = mgr.evaluate(
        { daysActive: 5, eventsViewed: 0, conflictsDetected: 0, feedsAdded: 1 },
        {},
        NOW,
      );
      expect(result1).not.toBeNull();
      expect(result1!.type).toBe("engagement");

      // Dismiss it and mark session
      mgr.dismiss("engagement", NOW);
      mgr.markSessionPromptShown("engagement");

      // Same session: blocked by session limit
      const result2 = mgr.evaluate(
        { daysActive: 5, eventsViewed: 0, conflictsDetected: 0, feedsAdded: 1 },
        {},
        NOW,
      );
      expect(result2).toBeNull();

      // New session (reset), but still within 7 days: blocked by dismissal
      mgr.resetSession();
      const result3 = mgr.evaluate(
        { daysActive: 5, eventsViewed: 0, conflictsDetected: 0, feedsAdded: 1 },
        {},
        NOW + 1000,
      );
      expect(result3).toBeNull();

      // After 7 days: prompt appears again
      mgr.resetSession();
      const result4 = mgr.evaluate(
        { daysActive: 5, eventsViewed: 0, conflictsDetected: 0, feedsAdded: 1 },
        {},
        NOW + SEVEN_DAYS_MS + 1,
      );
      expect(result4).not.toBeNull();
      expect(result4!.type).toBe("engagement");
    });

    it("persists dismissal to storage", () => {
      const mgr = new UpgradePromptManager(mockStorage as unknown as Storage);
      mgr.dismiss("stale_data", NOW);
      expect(mockStorage.setItem).toHaveBeenCalledWith(
        STORAGE_KEY_DISMISSALS,
        expect.any(String),
      );
      const stored = JSON.parse(storageStore[STORAGE_KEY_DISMISSALS]);
      expect(stored).toHaveLength(1);
      expect(stored[0].type).toBe("stale_data");
    });
  });

  describe("session prompt limit (max 1 per session)", () => {
    it("blocks all prompts after one is shown in session", () => {
      const mgr = new UpgradePromptManager(mockStorage as unknown as Storage);

      // Show first prompt
      const result1 = mgr.evaluate(
        { daysActive: 5, eventsViewed: 0, conflictsDetected: 2, feedsAdded: 1 },
        { hasConflict: true, conflictFeedNames: ["A", "B"] },
        NOW,
      );
      expect(result1).not.toBeNull();

      // Mark it shown
      mgr.markSessionPromptShown(result1!.type);

      // Try another trigger in same session
      const result2 = mgr.evaluate(
        { daysActive: 5, eventsViewed: 0, conflictsDetected: 0, feedsAdded: 1 },
        { isFeedStale: true, staleFeedName: "C", staleFeedProvider: "google" },
        NOW,
      );
      expect(result2).toBeNull();
    });

    it("allows prompts again after session reset", () => {
      const mgr = new UpgradePromptManager(mockStorage as unknown as Storage);

      // Show and dismiss a prompt
      mgr.markSessionPromptShown("conflict_detected");
      mgr.dismiss("conflict_detected", NOW);

      // Reset session
      mgr.resetSession();

      // Different prompt type should work (conflict is dismissed, engagement is not)
      const result = mgr.evaluate(
        { daysActive: 4, eventsViewed: 0, conflictsDetected: 0, feedsAdded: 1 },
        {},
        NOW,
      );
      expect(result).not.toBeNull();
      expect(result!.type).toBe("engagement");
    });
  });

  describe("permanent dismissal", () => {
    it("blocks all prompts when permanently dismissed", () => {
      const mgr = new UpgradePromptManager(mockStorage as unknown as Storage);
      mgr.setPermanentlyDismissed(true);

      const result = mgr.evaluate(
        { daysActive: 10, eventsViewed: 100, conflictsDetected: 5, feedsAdded: 3 },
        { hasConflict: true, conflictFeedNames: ["A", "B"] },
        NOW,
      );
      expect(result).toBeNull();
    });

    it("persists permanent dismissal to storage", () => {
      const mgr = new UpgradePromptManager(mockStorage as unknown as Storage);
      mgr.setPermanentlyDismissed(true);
      expect(mockStorage.setItem).toHaveBeenCalledWith(
        STORAGE_KEY_SETTINGS,
        expect.any(String),
      );
      const stored = JSON.parse(storageStore[STORAGE_KEY_SETTINGS]);
      expect(stored.permanentlyDismissed).toBe(true);
    });

    it("can re-enable prompts by removing permanent dismissal", () => {
      const mgr = new UpgradePromptManager(mockStorage as unknown as Storage);
      mgr.setPermanentlyDismissed(true);

      // Blocked
      const r1 = mgr.evaluate(
        { daysActive: 5, eventsViewed: 0, conflictsDetected: 0, feedsAdded: 1 },
        {},
        NOW,
      );
      expect(r1).toBeNull();

      // Re-enable
      mgr.setPermanentlyDismissed(false);

      // Now works
      const r2 = mgr.evaluate(
        { daysActive: 5, eventsViewed: 0, conflictsDetected: 0, feedsAdded: 1 },
        {},
        NOW,
      );
      expect(r2).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Integration: conflict detection triggers upgrade prompt
  // ---------------------------------------------------------------------------

  describe("integration: conflict detection triggers upgrade prompt", () => {
    it("end-to-end: detect conflict, show prompt, dismiss, verify suppression", () => {
      const mgr = new UpgradePromptManager(mockStorage as unknown as Storage);

      // Step 1: Detect conflict
      const prompt = mgr.evaluate(
        { daysActive: 1, eventsViewed: 5, conflictsDetected: 1, feedsAdded: 2 },
        {
          hasConflict: true,
          conflictFeedNames: ["Work Calendar", "Personal Calendar"],
        },
        NOW,
      );

      // Step 2: Verify prompt details
      expect(prompt).not.toBeNull();
      expect(prompt!.type).toBe("conflict_detected");
      expect(prompt!.message).toContain("scheduling conflict");
      expect(prompt!.message).toContain("Work Calendar");
      expect(prompt!.message).toContain("Personal Calendar");

      // Step 3: Dismiss and mark shown
      mgr.dismiss("conflict_detected", NOW);
      mgr.markSessionPromptShown("conflict_detected");

      // Step 4: Same session -> no prompt
      const prompt2 = mgr.evaluate(
        { daysActive: 1, eventsViewed: 5, conflictsDetected: 1, feedsAdded: 2 },
        { hasConflict: true, conflictFeedNames: ["Work", "Personal"] },
        NOW + 1000,
      );
      expect(prompt2).toBeNull();

      // Step 5: New session within 7 days -> still dismissed
      mgr.resetSession();
      const prompt3 = mgr.evaluate(
        { daysActive: 1, eventsViewed: 5, conflictsDetected: 1, feedsAdded: 2 },
        { hasConflict: true, conflictFeedNames: ["Work", "Personal"] },
        NOW + 3 * 24 * 60 * 60 * 1000, // 3 days later
      );
      expect(prompt3).toBeNull();

      // Step 6: After 7 days -> prompt reappears
      mgr.resetSession();
      const prompt4 = mgr.evaluate(
        { daysActive: 1, eventsViewed: 5, conflictsDetected: 1, feedsAdded: 2 },
        { hasConflict: true, conflictFeedNames: ["Work", "Personal"] },
        NOW + SEVEN_DAYS_MS + 1,
      );
      expect(prompt4).not.toBeNull();
      expect(prompt4!.type).toBe("conflict_detected");
    });
  });

  // ---------------------------------------------------------------------------
  // Integration: write intent on ICS feed triggers upgrade prompt
  // ---------------------------------------------------------------------------

  describe("integration: write intent triggers upgrade prompt", () => {
    it("end-to-end: write attempt on ICS feed shows provider-specific prompt", () => {
      const mgr = new UpgradePromptManager(mockStorage as unknown as Storage);

      // Step 1: User attempts write on ICS-only Google feed
      const prompt = mgr.evaluate(
        { daysActive: 1, eventsViewed: 3, conflictsDetected: 0, feedsAdded: 1 },
        { writeIntentOnIcsFeed: true, writeIntentFeedProvider: "google" },
        NOW,
      );

      // Step 2: Verify prompt
      expect(prompt).not.toBeNull();
      expect(prompt!.type).toBe("write_intent");
      expect(prompt!.message).toContain("read-only");
      expect(prompt!.message).toContain("Google");
      expect(prompt!.provider).toBe("google");
    });

    it("end-to-end: Microsoft provider branding in write intent", () => {
      const mgr = new UpgradePromptManager(mockStorage as unknown as Storage);
      const prompt = mgr.evaluate(
        { daysActive: 0, eventsViewed: 0, conflictsDetected: 0, feedsAdded: 1 },
        { writeIntentOnIcsFeed: true, writeIntentFeedProvider: "microsoft" },
        NOW,
      );
      expect(prompt).not.toBeNull();
      expect(prompt!.message).toContain("Microsoft");
    });
  });

  // ---------------------------------------------------------------------------
  // Integration: dismissed prompt does not reappear within 7 days
  // ---------------------------------------------------------------------------

  describe("integration: dismissed prompt 7-day suppression", () => {
    it("stale_data prompt dismissed for exactly 7 days", () => {
      const mgr = new UpgradePromptManager(mockStorage as unknown as Storage);

      // Dismiss stale_data
      mgr.dismiss("stale_data", NOW);

      // Day 1: suppressed
      const r1 = mgr.evaluate(
        { daysActive: 0, eventsViewed: 0, conflictsDetected: 0, feedsAdded: 1 },
        { isFeedStale: true, staleFeedName: "Cal", staleFeedProvider: "google" },
        NOW + 24 * 60 * 60 * 1000,
      );
      expect(r1).toBeNull();

      // Day 6: suppressed
      const r6 = mgr.evaluate(
        { daysActive: 0, eventsViewed: 0, conflictsDetected: 0, feedsAdded: 1 },
        { isFeedStale: true, staleFeedName: "Cal", staleFeedProvider: "google" },
        NOW + 6 * 24 * 60 * 60 * 1000,
      );
      expect(r6).toBeNull();

      // Day 7 - 1ms: still suppressed (exactly at boundary)
      const r7minus = mgr.evaluate(
        { daysActive: 0, eventsViewed: 0, conflictsDetected: 0, feedsAdded: 1 },
        { isFeedStale: true, staleFeedName: "Cal", staleFeedProvider: "google" },
        NOW + SEVEN_DAYS_MS - 1,
      );
      expect(r7minus).toBeNull();

      // Day 7 + 1ms: appears again
      const r7plus = mgr.evaluate(
        { daysActive: 0, eventsViewed: 0, conflictsDetected: 0, feedsAdded: 1 },
        { isFeedStale: true, staleFeedName: "Cal", staleFeedProvider: "google" },
        NOW + SEVEN_DAYS_MS + 1,
      );
      expect(r7plus).not.toBeNull();
      expect(r7plus!.type).toBe("stale_data");
    });
  });

  describe("storage resilience", () => {
    it("handles corrupted localStorage gracefully", () => {
      storageStore[STORAGE_KEY_DISMISSALS] = "not valid json";
      const mgr = new UpgradePromptManager(mockStorage as unknown as Storage);
      // Should not throw, should initialize with empty dismissals
      expect(mgr.getDismissals()).toEqual([]);
    });

    it("handles missing localStorage gracefully", () => {
      const nullStorage = {
        getItem: () => null,
        setItem: vi.fn(),
        removeItem: vi.fn(),
      };
      const mgr = new UpgradePromptManager(nullStorage as unknown as Storage);
      expect(mgr.getDismissals()).toEqual([]);
      expect(mgr.getSettings().permanentlyDismissed).toBeUndefined();
    });
  });
});
