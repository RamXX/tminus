/**
 * Unit tests for deep work window optimization engine.
 *
 * Tests the DeepWorkEngine which detects uninterrupted blocks,
 * evaluates impact of new events, generates optimization suggestions,
 * and produces weekly deep work reports.
 *
 * TDD RED phase: all tests written before implementation.
 */

import { describe, it, expect } from "vitest";
import {
  detectDeepWorkBlocks,
  computeDeepWorkReport,
  evaluateDeepWorkImpact,
  suggestDeepWorkOptimizations,
} from "./deep-work";
import type {
  DeepWorkBlock,
  DeepWorkReport,
  DeepWorkImpact,
  DeepWorkSuggestion,
} from "./deep-work";
import type { CanonicalEvent, EventId, AccountId } from "./types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a minimal timed CanonicalEvent for testing. */
function makeEvent(
  overrides: Partial<CanonicalEvent> & { start_dt: string; end_dt: string },
): CanonicalEvent {
  const { start_dt, end_dt, ...rest } = overrides;
  return {
    canonical_event_id: `evt_${Math.random().toString(36).slice(2, 10)}` as EventId,
    origin_account_id: "acc_test" as AccountId,
    origin_event_id: "google_123",
    title: "Meeting",
    start: { dateTime: start_dt },
    end: { dateTime: end_dt },
    all_day: false,
    status: "confirmed",
    visibility: "default",
    transparency: "opaque",
    source: "provider",
    version: 1,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// detectDeepWorkBlocks
// ---------------------------------------------------------------------------

describe("detectDeepWorkBlocks", () => {
  it("returns the full working day as a single deep work block when no events", () => {
    const blocks = detectDeepWorkBlocks([], 9, 17);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].duration_minutes).toBe(480); // 8 hours
  });

  it("identifies a 3-hour gap between two meetings as a deep work block", () => {
    // Working hours: 9-17
    // Meeting 1: 09:00-10:00
    // Gap: 10:00-13:00 (3h)
    // Meeting 2: 13:00-14:00
    const events = [
      makeEvent({ start_dt: "2025-06-15T09:00:00Z", end_dt: "2025-06-15T10:00:00Z" }),
      makeEvent({ start_dt: "2025-06-15T13:00:00Z", end_dt: "2025-06-15T14:00:00Z" }),
    ];

    const blocks = detectDeepWorkBlocks(events, 9, 17);
    expect(blocks.length).toBeGreaterThanOrEqual(1);

    // The 10:00-13:00 gap (3h = 180min) should be detected
    const threeHourBlock = blocks.find((b) => b.duration_minutes === 180);
    expect(threeHourBlock).toBeDefined();
    expect(threeHourBlock!.start).toBe("2025-06-15T10:00:00.000Z");
    expect(threeHourBlock!.end).toBe("2025-06-15T13:00:00.000Z");
  });

  it("excludes gaps shorter than 2 hours (default threshold)", () => {
    // Meeting 1: 09:00-10:00
    // Gap: 10:00-11:30 (1.5h -- below 2h threshold)
    // Meeting 2: 11:30-12:00
    const events = [
      makeEvent({ start_dt: "2025-06-15T09:00:00Z", end_dt: "2025-06-15T10:00:00Z" }),
      makeEvent({ start_dt: "2025-06-15T11:30:00Z", end_dt: "2025-06-15T12:00:00Z" }),
    ];

    const blocks = detectDeepWorkBlocks(events, 9, 17);
    // The 90-min gap should NOT appear as a deep work block
    const shortBlock = blocks.find((b) => b.duration_minutes === 90);
    expect(shortBlock).toBeUndefined();
  });

  it("respects custom minimum block duration", () => {
    // Gap: 10:00-11:30 (90 min)
    // With minBlockMinutes=60, this should be included
    const events = [
      makeEvent({ start_dt: "2025-06-15T09:00:00Z", end_dt: "2025-06-15T10:00:00Z" }),
      makeEvent({ start_dt: "2025-06-15T11:30:00Z", end_dt: "2025-06-15T17:00:00Z" }),
    ];

    const blocks = detectDeepWorkBlocks(events, 9, 17, 60);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].duration_minutes).toBe(90);
  });

  it("clips events to working hours boundaries", () => {
    // Event starts before working hours and ends within them
    const events = [
      makeEvent({ start_dt: "2025-06-15T07:00:00Z", end_dt: "2025-06-15T11:00:00Z" }),
    ];

    const blocks = detectDeepWorkBlocks(events, 9, 17);
    // Clipped: 09:00-11:00 is meeting. Free: 11:00-17:00 (6h = 360min)
    expect(blocks).toHaveLength(1);
    expect(blocks[0].duration_minutes).toBe(360);
  });

  it("filters out cancelled and transparent events", () => {
    const events = [
      makeEvent({
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T17:00:00Z",
        status: "cancelled",
      }),
    ];

    const blocks = detectDeepWorkBlocks(events, 9, 17);
    // Cancelled event is ignored, so full day is free
    expect(blocks).toHaveLength(1);
    expect(blocks[0].duration_minutes).toBe(480);
  });

  it("filters out all-day events", () => {
    const events = [
      makeEvent({
        start_dt: "2025-06-15T00:00:00Z",
        end_dt: "2025-06-16T00:00:00Z",
        all_day: true,
      }),
    ];

    const blocks = detectDeepWorkBlocks(events, 9, 17);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].duration_minutes).toBe(480);
  });

  it("merges overlapping meetings before computing gaps", () => {
    // Two overlapping meetings: 09:00-11:00 and 10:00-12:00 -> merged: 09:00-12:00
    // Free: 12:00-17:00 (5h = 300min)
    const events = [
      makeEvent({ start_dt: "2025-06-15T09:00:00Z", end_dt: "2025-06-15T11:00:00Z" }),
      makeEvent({ start_dt: "2025-06-15T10:00:00Z", end_dt: "2025-06-15T12:00:00Z" }),
    ];

    const blocks = detectDeepWorkBlocks(events, 9, 17);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].duration_minutes).toBe(300);
  });

  it("handles events that span the entire working day (no deep work)", () => {
    const events = [
      makeEvent({ start_dt: "2025-06-15T09:00:00Z", end_dt: "2025-06-15T17:00:00Z" }),
    ];

    const blocks = detectDeepWorkBlocks(events, 9, 17);
    expect(blocks).toHaveLength(0);
  });

  it("detects both leading and trailing deep work blocks", () => {
    // Meeting in the middle: 12:00-13:00
    // Leading block: 09:00-12:00 (3h)
    // Trailing block: 13:00-17:00 (4h)
    const events = [
      makeEvent({ start_dt: "2025-06-15T12:00:00Z", end_dt: "2025-06-15T13:00:00Z" }),
    ];

    const blocks = detectDeepWorkBlocks(events, 9, 17);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].duration_minutes).toBe(180);
    expect(blocks[1].duration_minutes).toBe(240);
  });

  it("handles exactly 2-hour block (boundary case)", () => {
    // Meeting: 09:00-15:00, leaving exactly 15:00-17:00 (2h)
    const events = [
      makeEvent({ start_dt: "2025-06-15T09:00:00Z", end_dt: "2025-06-15T15:00:00Z" }),
    ];

    const blocks = detectDeepWorkBlocks(events, 9, 17);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].duration_minutes).toBe(120);
  });

  it("includes day field in each block from the event dates", () => {
    const events = [
      makeEvent({ start_dt: "2025-06-15T12:00:00Z", end_dt: "2025-06-15T13:00:00Z" }),
    ];

    const blocks = detectDeepWorkBlocks(events, 9, 17);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    for (const block of blocks) {
      expect(block.day).toBe("2025-06-15");
    }
  });
});

// ---------------------------------------------------------------------------
// computeDeepWorkReport
// ---------------------------------------------------------------------------

describe("computeDeepWorkReport", () => {
  it("returns empty report for no events and no days", () => {
    const report = computeDeepWorkReport([], { workingHoursStart: 9, workingHoursEnd: 17 }, []);
    expect(report.blocks).toHaveLength(0);
    expect(report.total_deep_hours).toBe(0);
    expect(report.protected_hours_target).toBeGreaterThan(0);
  });

  it("computes total deep hours across multiple days", () => {
    // Day 1: no meetings -> 8h deep work
    // Day 2: full day meeting -> 0h deep work
    const events = [
      makeEvent({ start_dt: "2025-06-16T09:00:00Z", end_dt: "2025-06-16T17:00:00Z" }),
    ];

    const report = computeDeepWorkReport(
      events,
      { workingHoursStart: 9, workingHoursEnd: 17 },
      ["2025-06-15", "2025-06-16"],
    );

    expect(report.total_deep_hours).toBe(8); // Only day 1 has deep work
    expect(report.blocks.length).toBeGreaterThanOrEqual(1);
  });

  it("generates a weekly report for 5 working days", () => {
    const days = [
      "2025-06-16", // Mon
      "2025-06-17", // Tue
      "2025-06-18", // Wed
      "2025-06-19", // Thu
      "2025-06-20", // Fri
    ];

    // One 1-hour meeting each day at 12:00
    const events = days.map((d) =>
      makeEvent({
        start_dt: `${d}T12:00:00Z`,
        end_dt: `${d}T13:00:00Z`,
      }),
    );

    const report = computeDeepWorkReport(
      events,
      { workingHoursStart: 9, workingHoursEnd: 17 },
      days,
    );

    // Each day: 09:00-12:00 (3h) + 13:00-17:00 (4h) = 7h deep work
    // 5 days * 7h = 35h total
    expect(report.total_deep_hours).toBe(35);
    // Each day produces 2 blocks => 10 total
    expect(report.blocks).toHaveLength(10);
  });

  it("includes a positive protected_hours_target", () => {
    const report = computeDeepWorkReport(
      [],
      { workingHoursStart: 9, workingHoursEnd: 17 },
      ["2025-06-15"],
    );

    // Default target should be positive (e.g., 4h/day or 20h/week)
    expect(report.protected_hours_target).toBeGreaterThan(0);
  });

  it("respects configurable minimum block duration", () => {
    // Meeting splits day: 09:00-10:00 and 10:30-17:00
    // Gap = 30 min. With default 120min threshold, no blocks.
    // With 30min threshold, the gap counts.
    const events = [
      makeEvent({ start_dt: "2025-06-15T09:00:00Z", end_dt: "2025-06-15T10:00:00Z" }),
      makeEvent({ start_dt: "2025-06-15T10:30:00Z", end_dt: "2025-06-15T17:00:00Z" }),
    ];

    const reportDefault = computeDeepWorkReport(
      events,
      { workingHoursStart: 9, workingHoursEnd: 17 },
      ["2025-06-15"],
    );

    const reportCustom = computeDeepWorkReport(
      events,
      { workingHoursStart: 9, workingHoursEnd: 17 },
      ["2025-06-15"],
      30, // 30 min minimum
    );

    expect(reportDefault.blocks).toHaveLength(0);
    expect(reportCustom.blocks).toHaveLength(1);
    expect(reportCustom.blocks[0].duration_minutes).toBe(30);
  });

  it("block entries contain day, start, end, duration_minutes", () => {
    const report = computeDeepWorkReport(
      [],
      { workingHoursStart: 9, workingHoursEnd: 17 },
      ["2025-06-15"],
    );

    expect(report.blocks).toHaveLength(1);
    const block = report.blocks[0];
    expect(block).toHaveProperty("day");
    expect(block).toHaveProperty("start");
    expect(block).toHaveProperty("end");
    expect(block).toHaveProperty("duration_minutes");
    expect(block.day).toBe("2025-06-15");
  });
});

// ---------------------------------------------------------------------------
// evaluateDeepWorkImpact
// ---------------------------------------------------------------------------

describe("evaluateDeepWorkImpact", () => {
  it("returns breaks_block=true when new event splits a deep work block", () => {
    // Existing block: 09:00-17:00 (full day free)
    const existingBlocks: DeepWorkBlock[] = [
      {
        day: "2025-06-15",
        start: "2025-06-15T09:00:00.000Z",
        end: "2025-06-15T17:00:00.000Z",
        duration_minutes: 480,
      },
    ];

    // New meeting at 12:00-13:00 breaks the block into two smaller pieces
    const impact = evaluateDeepWorkImpact(
      "2025-06-15T12:00:00Z",
      "2025-06-15T13:00:00Z",
      existingBlocks,
    );

    expect(impact.breaks_block).toBe(true);
    expect(impact.affected_blocks).toHaveLength(1);
    expect(impact.affected_blocks[0].day).toBe("2025-06-15");
  });

  it("returns breaks_block=false when new event is outside all deep work blocks", () => {
    // Deep work block: 14:00-17:00
    const existingBlocks: DeepWorkBlock[] = [
      {
        day: "2025-06-15",
        start: "2025-06-15T14:00:00.000Z",
        end: "2025-06-15T17:00:00.000Z",
        duration_minutes: 180,
      },
    ];

    // New event at 09:00-10:00 (outside deep work block)
    const impact = evaluateDeepWorkImpact(
      "2025-06-15T09:00:00Z",
      "2025-06-15T10:00:00Z",
      existingBlocks,
    );

    expect(impact.breaks_block).toBe(false);
    expect(impact.affected_blocks).toHaveLength(0);
  });

  it("calculates lost deep work minutes correctly", () => {
    // Block: 09:00-13:00 (4h = 240min)
    // New event: 10:00-11:00
    // Result: 09:00-10:00 (60min) + 11:00-13:00 (120min)
    // Lost if threshold is 120min: 09:00-10:00 block (60min) is below threshold
    // Net loss = 60 min (the piece that became too small)
    const existingBlocks: DeepWorkBlock[] = [
      {
        day: "2025-06-15",
        start: "2025-06-15T09:00:00.000Z",
        end: "2025-06-15T13:00:00.000Z",
        duration_minutes: 240,
      },
    ];

    const impact = evaluateDeepWorkImpact(
      "2025-06-15T10:00:00Z",
      "2025-06-15T11:00:00Z",
      existingBlocks,
    );

    expect(impact.breaks_block).toBe(true);
    expect(impact.lost_minutes).toBeGreaterThan(0);
  });

  it("handles event at the exact start of a deep work block", () => {
    const existingBlocks: DeepWorkBlock[] = [
      {
        day: "2025-06-15",
        start: "2025-06-15T09:00:00.000Z",
        end: "2025-06-15T13:00:00.000Z",
        duration_minutes: 240,
      },
    ];

    // Event at start: 09:00-10:00
    // Remaining: 10:00-13:00 (3h = 180min) -- still >= 120min, so block survives
    const impact = evaluateDeepWorkImpact(
      "2025-06-15T09:00:00Z",
      "2025-06-15T10:00:00Z",
      existingBlocks,
    );

    // Block is trimmed but not destroyed (180min remaining)
    expect(impact.breaks_block).toBe(true); // it still modifies the block
    expect(impact.remaining_blocks).toBeDefined();
  });

  it("handles event at the exact end of a deep work block", () => {
    const existingBlocks: DeepWorkBlock[] = [
      {
        day: "2025-06-15",
        start: "2025-06-15T09:00:00.000Z",
        end: "2025-06-15T13:00:00.000Z",
        duration_minutes: 240,
      },
    ];

    // Event at end: 12:00-13:00
    // Remaining: 09:00-12:00 (3h = 180min)
    const impact = evaluateDeepWorkImpact(
      "2025-06-15T12:00:00Z",
      "2025-06-15T13:00:00Z",
      existingBlocks,
    );

    expect(impact.breaks_block).toBe(true);
    expect(impact.remaining_blocks).toBeDefined();
  });

  it("detects impact on multiple blocks when event spans across them", () => {
    const existingBlocks: DeepWorkBlock[] = [
      {
        day: "2025-06-15",
        start: "2025-06-15T09:00:00.000Z",
        end: "2025-06-15T12:00:00.000Z",
        duration_minutes: 180,
      },
      {
        day: "2025-06-15",
        start: "2025-06-15T14:00:00.000Z",
        end: "2025-06-15T17:00:00.000Z",
        duration_minutes: 180,
      },
    ];

    // Event from 11:00-15:00 overlaps both blocks
    const impact = evaluateDeepWorkImpact(
      "2025-06-15T11:00:00Z",
      "2025-06-15T15:00:00Z",
      existingBlocks,
    );

    expect(impact.breaks_block).toBe(true);
    expect(impact.affected_blocks).toHaveLength(2);
  });

  it("returns breaks_block=false for empty blocks array", () => {
    const impact = evaluateDeepWorkImpact(
      "2025-06-15T12:00:00Z",
      "2025-06-15T13:00:00Z",
      [],
    );

    expect(impact.breaks_block).toBe(false);
    expect(impact.affected_blocks).toHaveLength(0);
    expect(impact.lost_minutes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// suggestDeepWorkOptimizations
// ---------------------------------------------------------------------------

describe("suggestDeepWorkOptimizations", () => {
  it("returns no suggestions when day has no meetings", () => {
    const suggestions = suggestDeepWorkOptimizations(
      [],
      { workingHoursStart: 9, workingHoursEnd: 17 },
    );

    expect(suggestions).toHaveLength(0);
  });

  it("suggests consolidating scattered short meetings", () => {
    // Three 30-min meetings spread across the day fragment deep work
    const events = [
      makeEvent({
        start_dt: "2025-06-15T09:30:00Z",
        end_dt: "2025-06-15T10:00:00Z",
        title: "Standup",
      }),
      makeEvent({
        start_dt: "2025-06-15T12:00:00Z",
        end_dt: "2025-06-15T12:30:00Z",
        title: "Check-in",
      }),
      makeEvent({
        start_dt: "2025-06-15T15:00:00Z",
        end_dt: "2025-06-15T15:30:00Z",
        title: "Sync",
      }),
    ];

    const suggestions = suggestDeepWorkOptimizations(
      events,
      { workingHoursStart: 9, workingHoursEnd: 17 },
    );

    expect(suggestions.length).toBeGreaterThanOrEqual(1);
    // Each suggestion should have a message and estimated time gain
    for (const s of suggestions) {
      expect(s).toHaveProperty("message");
      expect(typeof s.message).toBe("string");
      expect(s.message.length).toBeGreaterThan(0);
      expect(s).toHaveProperty("estimated_gain_minutes");
      expect(typeof s.estimated_gain_minutes).toBe("number");
    }
  });

  it("suggests moving meetings to edges of day to protect core deep work time", () => {
    // A meeting in the middle of the morning breaks the best deep work window
    const events = [
      makeEvent({
        start_dt: "2025-06-15T10:30:00Z",
        end_dt: "2025-06-15T11:00:00Z",
        title: "Quick Sync",
      }),
    ];

    const suggestions = suggestDeepWorkOptimizations(
      events,
      { workingHoursStart: 9, workingHoursEnd: 17 },
    );

    // Should suggest moving the meeting to before deep work time or after
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
  });

  it("does not suggest changes when deep work is already well-protected", () => {
    // All meetings clustered at start of day, leaving large deep work block
    const events = [
      makeEvent({
        start_dt: "2025-06-15T09:00:00Z",
        end_dt: "2025-06-15T09:30:00Z",
        title: "Standup",
      }),
      makeEvent({
        start_dt: "2025-06-15T09:30:00Z",
        end_dt: "2025-06-15T10:00:00Z",
        title: "Planning",
      }),
    ];

    const suggestions = suggestDeepWorkOptimizations(
      events,
      { workingHoursStart: 9, workingHoursEnd: 17 },
    );

    // No need to optimize -- meetings are already clustered
    expect(suggestions).toHaveLength(0);
  });

  it("handles multiple meeting clusters", () => {
    // Two clusters with a small gap between them
    const events = [
      makeEvent({ start_dt: "2025-06-15T09:00:00Z", end_dt: "2025-06-15T10:00:00Z", title: "Meeting A" }),
      makeEvent({ start_dt: "2025-06-15T10:00:00Z", end_dt: "2025-06-15T11:00:00Z", title: "Meeting B" }),
      // Gap of 1h
      makeEvent({ start_dt: "2025-06-15T12:00:00Z", end_dt: "2025-06-15T13:00:00Z", title: "Meeting C" }),
      // Isolated meeting breaking afternoon
      makeEvent({ start_dt: "2025-06-15T15:00:00Z", end_dt: "2025-06-15T15:30:00Z", title: "Quick call" }),
    ];

    const suggestions = suggestDeepWorkOptimizations(
      events,
      { workingHoursStart: 9, workingHoursEnd: 17 },
    );

    // Should suggest moving the isolated 15:00 meeting closer to the cluster
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
  });
});
