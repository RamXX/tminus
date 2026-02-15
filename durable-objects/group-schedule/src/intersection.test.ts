/**
 * Unit tests for multi-user availability intersection (TM-82s.1).
 *
 * Tests the pure functions that merge busy intervals from multiple users
 * into a unified busy list for the greedy solver.
 */

import { describe, it, expect } from "vitest";
import {
  mergeBusyIntervals,
  buildGroupAccountIds,
  mergeOverlapping,
} from "./intersection";
import type { UserAvailability } from "./intersection";

// ---------------------------------------------------------------------------
// mergeOverlapping
// ---------------------------------------------------------------------------

describe("mergeOverlapping", () => {
  it("returns empty array for empty input", () => {
    expect(mergeOverlapping([])).toEqual([]);
  });

  it("returns single interval unchanged", () => {
    const result = mergeOverlapping([
      { start: "2026-03-01T09:00:00Z", end: "2026-03-01T10:00:00Z", account_ids: ["a1"] },
    ]);
    expect(result).toEqual([
      { start: "2026-03-01T09:00:00Z", end: "2026-03-01T10:00:00Z" },
    ]);
  });

  it("merges two overlapping intervals", () => {
    const result = mergeOverlapping([
      { start: "2026-03-01T09:00:00Z", end: "2026-03-01T10:30:00Z", account_ids: ["a1"] },
      { start: "2026-03-01T10:00:00Z", end: "2026-03-01T11:00:00Z", account_ids: ["a1"] },
    ]);
    expect(result).toEqual([
      { start: "2026-03-01T09:00:00Z", end: "2026-03-01T11:00:00Z" },
    ]);
  });

  it("merges adjacent intervals (no gap)", () => {
    const result = mergeOverlapping([
      { start: "2026-03-01T09:00:00Z", end: "2026-03-01T10:00:00Z", account_ids: ["a1"] },
      { start: "2026-03-01T10:00:00Z", end: "2026-03-01T11:00:00Z", account_ids: ["a1"] },
    ]);
    expect(result).toEqual([
      { start: "2026-03-01T09:00:00Z", end: "2026-03-01T11:00:00Z" },
    ]);
  });

  it("keeps non-overlapping intervals separate", () => {
    const result = mergeOverlapping([
      { start: "2026-03-01T09:00:00Z", end: "2026-03-01T10:00:00Z", account_ids: ["a1"] },
      { start: "2026-03-01T11:00:00Z", end: "2026-03-01T12:00:00Z", account_ids: ["a1"] },
    ]);
    expect(result).toEqual([
      { start: "2026-03-01T09:00:00Z", end: "2026-03-01T10:00:00Z" },
      { start: "2026-03-01T11:00:00Z", end: "2026-03-01T12:00:00Z" },
    ]);
  });

  it("handles unsorted input correctly", () => {
    const result = mergeOverlapping([
      { start: "2026-03-01T11:00:00Z", end: "2026-03-01T12:00:00Z", account_ids: ["a1"] },
      { start: "2026-03-01T09:00:00Z", end: "2026-03-01T10:00:00Z", account_ids: ["a1"] },
      { start: "2026-03-01T09:30:00Z", end: "2026-03-01T10:30:00Z", account_ids: ["a1"] },
    ]);
    expect(result).toEqual([
      { start: "2026-03-01T09:00:00Z", end: "2026-03-01T10:30:00Z" },
      { start: "2026-03-01T11:00:00Z", end: "2026-03-01T12:00:00Z" },
    ]);
  });

  it("merges three overlapping intervals into one", () => {
    const result = mergeOverlapping([
      { start: "2026-03-01T09:00:00Z", end: "2026-03-01T10:00:00Z", account_ids: ["a1"] },
      { start: "2026-03-01T09:30:00Z", end: "2026-03-01T10:30:00Z", account_ids: ["a2"] },
      { start: "2026-03-01T10:00:00Z", end: "2026-03-01T11:00:00Z", account_ids: ["a3"] },
    ]);
    expect(result).toEqual([
      { start: "2026-03-01T09:00:00Z", end: "2026-03-01T11:00:00Z" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildGroupAccountIds
// ---------------------------------------------------------------------------

describe("buildGroupAccountIds", () => {
  it("returns synthetic group account IDs for each user", () => {
    const result = buildGroupAccountIds(["user_alice", "user_bob"]);
    expect(result).toEqual(["group_user_alice", "group_user_bob"]);
  });

  it("handles single user", () => {
    const result = buildGroupAccountIds(["user_alice"]);
    expect(result).toEqual(["group_user_alice"]);
  });

  it("handles empty array", () => {
    const result = buildGroupAccountIds([]);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mergeBusyIntervals
// ---------------------------------------------------------------------------

describe("mergeBusyIntervals", () => {
  it("returns empty array for no users", () => {
    expect(mergeBusyIntervals([])).toEqual([]);
  });

  it("handles single user with one busy interval", () => {
    const users: UserAvailability[] = [
      {
        userId: "user_alice",
        busyIntervals: [
          { start: "2026-03-01T09:00:00Z", end: "2026-03-01T10:00:00Z", account_ids: ["acct_1"] },
        ],
      },
    ];

    const result = mergeBusyIntervals(users);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      start: "2026-03-01T09:00:00Z",
      end: "2026-03-01T10:00:00Z",
      account_ids: ["group_user_alice"],
    });
  });

  it("merges two users with non-overlapping busy times", () => {
    const users: UserAvailability[] = [
      {
        userId: "user_alice",
        busyIntervals: [
          { start: "2026-03-01T09:00:00Z", end: "2026-03-01T10:00:00Z", account_ids: ["a1"] },
        ],
      },
      {
        userId: "user_bob",
        busyIntervals: [
          { start: "2026-03-01T11:00:00Z", end: "2026-03-01T12:00:00Z", account_ids: ["b1"] },
        ],
      },
    ];

    const result = mergeBusyIntervals(users);
    expect(result).toHaveLength(2);

    // Alice's interval gets synthetic account ID
    expect(result[0]).toEqual({
      start: "2026-03-01T09:00:00Z",
      end: "2026-03-01T10:00:00Z",
      account_ids: ["group_user_alice"],
    });

    // Bob's interval gets synthetic account ID
    expect(result[1]).toEqual({
      start: "2026-03-01T11:00:00Z",
      end: "2026-03-01T12:00:00Z",
      account_ids: ["group_user_bob"],
    });
  });

  it("preserves separate user busy intervals even when overlapping", () => {
    // When Alice is busy 9-10 and Bob is busy 9:30-10:30,
    // both are kept separate with their own synthetic account IDs.
    // The solver will correctly exclude slots blocked by ANY required account.
    const users: UserAvailability[] = [
      {
        userId: "user_alice",
        busyIntervals: [
          { start: "2026-03-01T09:00:00Z", end: "2026-03-01T10:00:00Z", account_ids: ["a1"] },
        ],
      },
      {
        userId: "user_bob",
        busyIntervals: [
          { start: "2026-03-01T09:30:00Z", end: "2026-03-01T10:30:00Z", account_ids: ["b1"] },
        ],
      },
    ];

    const result = mergeBusyIntervals(users);
    expect(result).toHaveLength(2);
    expect(result[0].account_ids).toEqual(["group_user_alice"]);
    expect(result[1].account_ids).toEqual(["group_user_bob"]);
  });

  it("merges overlapping intervals WITHIN a single user", () => {
    // Alice has two overlapping meetings -> merged into one interval
    const users: UserAvailability[] = [
      {
        userId: "user_alice",
        busyIntervals: [
          { start: "2026-03-01T09:00:00Z", end: "2026-03-01T10:00:00Z", account_ids: ["a1"] },
          { start: "2026-03-01T09:30:00Z", end: "2026-03-01T10:30:00Z", account_ids: ["a2"] },
        ],
      },
    ];

    const result = mergeBusyIntervals(users);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      start: "2026-03-01T09:00:00Z",
      end: "2026-03-01T10:30:00Z",
      account_ids: ["group_user_alice"],
    });
  });

  it("uses synthetic account IDs -- never leaks real account IDs", () => {
    const users: UserAvailability[] = [
      {
        userId: "user_alice",
        busyIntervals: [
          { start: "2026-03-01T09:00:00Z", end: "2026-03-01T10:00:00Z", account_ids: ["real_secret_acct_123"] },
        ],
      },
      {
        userId: "user_bob",
        busyIntervals: [
          { start: "2026-03-01T11:00:00Z", end: "2026-03-01T12:00:00Z", account_ids: ["real_secret_acct_456"] },
        ],
      },
    ];

    const result = mergeBusyIntervals(users);

    // Verify no real account IDs leaked
    for (const interval of result) {
      for (const accId of interval.account_ids) {
        expect(accId).toMatch(/^group_user_/);
        expect(accId).not.toContain("real_secret");
      }
    }
  });

  it("handles user with empty busy intervals", () => {
    const users: UserAvailability[] = [
      { userId: "user_alice", busyIntervals: [] },
      {
        userId: "user_bob",
        busyIntervals: [
          { start: "2026-03-01T09:00:00Z", end: "2026-03-01T10:00:00Z", account_ids: ["b1"] },
        ],
      },
    ];

    const result = mergeBusyIntervals(users);
    expect(result).toHaveLength(1);
    expect(result[0].account_ids).toEqual(["group_user_bob"]);
  });

  it("handles three users with mixed overlaps", () => {
    const users: UserAvailability[] = [
      {
        userId: "user_alice",
        busyIntervals: [
          { start: "2026-03-01T09:00:00Z", end: "2026-03-01T10:00:00Z", account_ids: ["a1"] },
        ],
      },
      {
        userId: "user_bob",
        busyIntervals: [
          { start: "2026-03-01T10:00:00Z", end: "2026-03-01T11:00:00Z", account_ids: ["b1"] },
        ],
      },
      {
        userId: "user_charlie",
        busyIntervals: [
          { start: "2026-03-01T09:30:00Z", end: "2026-03-01T10:30:00Z", account_ids: ["c1"] },
        ],
      },
    ];

    const result = mergeBusyIntervals(users);
    expect(result).toHaveLength(3);
    // Each user produces separate intervals -- solver handles overlap checking
    expect(result.map((r) => r.account_ids[0])).toEqual([
      "group_user_alice",
      "group_user_bob",
      "group_user_charlie",
    ]);
  });
});
