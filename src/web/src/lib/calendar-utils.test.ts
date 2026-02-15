/**
 * Unit tests for calendar utility functions.
 *
 * Tests cover:
 * - Stable color mapping per account ID
 * - Date range computation for week/month/day views
 * - Event transformation and grouping
 * - Date formatting helpers
 */
import { describe, it, expect } from "vitest";
import {
  getAccountColor,
  getWeekRange,
  getMonthRange,
  getDayRange,
  getDateRangeForView,
  groupEventsByDate,
  formatTimeShort,
  formatDateHeader,
  getHoursInDay,
  isToday,
  isSameDay,
  type CalendarViewType,
} from "./calendar-utils";
import type { CalendarEvent } from "./api";

// ---------------------------------------------------------------------------
// Color mapping
// ---------------------------------------------------------------------------

describe("getAccountColor", () => {
  it("returns a hex color string for any account ID", () => {
    const color = getAccountColor("account-123");
    expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("returns the same color for the same account ID (stable)", () => {
    const a = getAccountColor("account-abc");
    const b = getAccountColor("account-abc");
    expect(a).toBe(b);
  });

  it("returns different colors for different account IDs", () => {
    const colors = new Set([
      getAccountColor("account-1"),
      getAccountColor("account-2"),
      getAccountColor("account-3"),
      getAccountColor("account-4"),
    ]);
    // With 4 different IDs, we should get at least 2 distinct colors
    // (hash collisions are possible but extremely unlikely with a good palette)
    expect(colors.size).toBeGreaterThanOrEqual(2);
  });

  it("handles empty string gracefully", () => {
    const color = getAccountColor("");
    expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("handles undefined/null origin by returning a fallback color", () => {
    const color = getAccountColor(undefined);
    expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});

// ---------------------------------------------------------------------------
// Date range computation
// ---------------------------------------------------------------------------

describe("getWeekRange", () => {
  it("returns start (Sunday) and end (Saturday) of the week", () => {
    // Wednesday Feb 14, 2026
    const date = new Date(2026, 1, 14);
    const { start, end } = getWeekRange(date);
    // Sunday Feb 8
    expect(start.getDay()).toBe(0); // Sunday
    expect(start.getDate()).toBe(8);
    expect(start.getMonth()).toBe(1); // February
    // Saturday Feb 14
    expect(end.getDay()).toBe(6); // Saturday
    expect(end.getDate()).toBe(14);
  });

  it("handles Sunday input (start of week)", () => {
    const date = new Date(2026, 1, 8); // Sunday
    const { start, end } = getWeekRange(date);
    expect(start.getDay()).toBe(0);
    expect(start.getDate()).toBe(8);
    expect(end.getDay()).toBe(6);
    expect(end.getDate()).toBe(14);
  });

  it("handles Saturday input (end of week)", () => {
    const date = new Date(2026, 1, 14); // Saturday
    const { start, end } = getWeekRange(date);
    expect(start.getDay()).toBe(0);
    expect(end.getDay()).toBe(6);
  });

  it("spans month boundary correctly", () => {
    // Feb 1 2026 is a Sunday
    const date = new Date(2026, 1, 3); // Tuesday Feb 3
    const { start, end } = getWeekRange(date);
    expect(start.getDay()).toBe(0);
    expect(start.getMonth()).toBe(1); // Feb 1 is Sunday
    expect(start.getDate()).toBe(1);
  });
});

describe("getMonthRange", () => {
  it("returns first and last day of month", () => {
    const date = new Date(2026, 1, 14); // Feb 14
    const { start, end } = getMonthRange(date);
    expect(start.getDate()).toBe(1);
    expect(start.getMonth()).toBe(1);
    expect(end.getDate()).toBe(28); // Feb 2026 has 28 days
    expect(end.getMonth()).toBe(1);
  });

  it("handles months with 31 days", () => {
    const date = new Date(2026, 0, 15); // Jan 15
    const { start, end } = getMonthRange(date);
    expect(start.getDate()).toBe(1);
    expect(end.getDate()).toBe(31);
  });

  it("handles leap year February", () => {
    const date = new Date(2028, 1, 15); // Feb 2028 (leap year)
    const { start, end } = getMonthRange(date);
    expect(end.getDate()).toBe(29);
  });
});

describe("getDayRange", () => {
  it("returns start and end of the given day", () => {
    const date = new Date(2026, 1, 14, 15, 30);
    const { start, end } = getDayRange(date);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
    expect(start.getDate()).toBe(14);
    expect(end.getDate()).toBe(14);
  });
});

describe("getDateRangeForView", () => {
  const date = new Date(2026, 1, 14);

  it("returns week range for 'week' view", () => {
    const range = getDateRangeForView(date, "week");
    expect(range.start.getDay()).toBe(0);
    expect(range.end.getDay()).toBe(6);
  });

  it("returns month range for 'month' view", () => {
    const range = getDateRangeForView(date, "month");
    expect(range.start.getDate()).toBe(1);
  });

  it("returns day range for 'day' view", () => {
    const range = getDateRangeForView(date, "day");
    expect(range.start.getDate()).toBe(14);
    expect(range.end.getDate()).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// Event grouping
// ---------------------------------------------------------------------------

describe("groupEventsByDate", () => {
  const makeEvent = (
    id: string,
    start: string,
    end: string,
    summary?: string,
    accountId?: string,
  ): CalendarEvent => ({
    canonical_event_id: id,
    start,
    end,
    summary,
    origin_account_id: accountId,
  });

  it("groups events by their start date", () => {
    const events = [
      makeEvent("e1", "2026-02-14T09:00:00Z", "2026-02-14T10:00:00Z", "Morning"),
      makeEvent("e2", "2026-02-14T14:00:00Z", "2026-02-14T15:00:00Z", "Afternoon"),
      makeEvent("e3", "2026-02-15T09:00:00Z", "2026-02-15T10:00:00Z", "Next day"),
    ];
    const grouped = groupEventsByDate(events);
    const keys = Object.keys(grouped);
    expect(keys).toHaveLength(2);
    // Both e1 and e2 on same date
    const feb14Key = keys.find((k) => grouped[k].length === 2);
    expect(feb14Key).toBeDefined();
    expect(grouped[feb14Key!]).toHaveLength(2);
  });

  it("sorts events within a date by start time", () => {
    const events = [
      makeEvent("e2", "2026-02-14T14:00:00Z", "2026-02-14T15:00:00Z", "Later"),
      makeEvent("e1", "2026-02-14T09:00:00Z", "2026-02-14T10:00:00Z", "Earlier"),
    ];
    const grouped = groupEventsByDate(events);
    const dateKey = Object.keys(grouped)[0];
    expect(grouped[dateKey][0].canonical_event_id).toBe("e1");
    expect(grouped[dateKey][1].canonical_event_id).toBe("e2");
  });

  it("returns empty object for empty events array", () => {
    const grouped = groupEventsByDate([]);
    expect(Object.keys(grouped)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

describe("formatTimeShort", () => {
  it("formats an ISO string to a short time representation", () => {
    // We just need it to return a non-empty string
    const result = formatTimeShort("2026-02-14T09:30:00Z");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles invalid ISO string gracefully", () => {
    const result = formatTimeShort("not-a-date");
    expect(typeof result).toBe("string");
  });
});

describe("formatDateHeader", () => {
  it("formats a date string to a readable header", () => {
    const result = formatDateHeader("2026-02-14");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

describe("getHoursInDay", () => {
  it("returns an array of 24 hour labels", () => {
    const hours = getHoursInDay();
    expect(hours).toHaveLength(24);
    expect(hours[0]).toBe(0);
    expect(hours[23]).toBe(23);
  });
});

describe("isToday", () => {
  it("returns true for today", () => {
    expect(isToday(new Date())).toBe(true);
  });

  it("returns false for yesterday", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(isToday(yesterday)).toBe(false);
  });
});

describe("isSameDay", () => {
  it("returns true for same day different times", () => {
    const a = new Date(2026, 1, 14, 9, 0);
    const b = new Date(2026, 1, 14, 17, 30);
    expect(isSameDay(a, b)).toBe(true);
  });

  it("returns false for different days", () => {
    const a = new Date(2026, 1, 14);
    const b = new Date(2026, 1, 15);
    expect(isSameDay(a, b)).toBe(false);
  });
});
