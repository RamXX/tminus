/**
 * Unit tests for the tentative holds state machine and lifecycle (TM-946.3, TM-82s.4).
 *
 * Covers:
 * - Hold state transitions (valid and invalid)
 * - Hold record creation with default and custom timeouts
 * - Timeout validation (minimum 5 minutes)
 * - Hold expiry detection
 * - Finding expired holds for cleanup
 * - Building UPSERT_MIRROR messages for tentative events
 * - Building DELETE_MANAGED_MIRROR messages for hold cleanup
 * - Terminal states cannot transition
 * - Configurable hold duration (1h-72h) (TM-82s.4)
 * - Expiry notification: approaching_expiry flag (TM-82s.4)
 * - Hold extension: computeExtendedExpiry (TM-82s.4)
 * - Conflict detection: detectHoldConflicts (TM-82s.4)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isValidTransition,
  transitionHold,
  createHoldRecord,
  buildHoldUpsertMessage,
  buildHoldDeleteMessage,
  isHoldExpired,
  findExpiredHolds,
  DEFAULT_HOLD_TIMEOUT_MS,
  MIN_HOLD_TIMEOUT_MS,
  // TM-82s.4: Advanced hold lifecycle
  validateHoldDurationHours,
  holdDurationHoursToMs,
  isApproachingExpiry,
  computeExtendedExpiry,
  detectHoldConflicts,
  HOLD_DURATION_MIN_HOURS,
  HOLD_DURATION_MAX_HOURS,
  HOLD_DURATION_DEFAULT_HOURS,
  APPROACHING_EXPIRY_THRESHOLD_MS,
} from "./holds";
import type { Hold, HoldStatus, CreateHoldParams } from "./holds";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHoldParams(overrides: Partial<CreateHoldParams> = {}): CreateHoldParams {
  return {
    sessionId: "ses_01TESTSES000000000000001",
    accountId: "acc_01TESTACC000000000000001",
    candidateStart: "2026-03-02T09:00:00Z",
    candidateEnd: "2026-03-02T10:00:00Z",
    title: "Team Standup",
    ...overrides,
  };
}

function makeHold(overrides: Partial<Hold> = {}): Hold {
  return {
    hold_id: "hld_01TESTHOLD00000000000001",
    session_id: "ses_01TESTSES000000000000001",
    account_id: "acc_01TESTACC000000000000001",
    provider_event_id: null,
    expires_at: new Date(Date.now() + DEFAULT_HOLD_TIMEOUT_MS).toISOString(),
    status: "held",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// State transition tests
// ---------------------------------------------------------------------------

describe("hold state transitions", () => {
  describe("isValidTransition", () => {
    it("allows held -> committed", () => {
      expect(isValidTransition("held", "committed")).toBe(true);
    });

    it("allows held -> released", () => {
      expect(isValidTransition("held", "released")).toBe(true);
    });

    it("allows held -> expired", () => {
      expect(isValidTransition("held", "expired")).toBe(true);
    });

    it("rejects committed -> held", () => {
      expect(isValidTransition("committed", "held")).toBe(false);
    });

    it("rejects committed -> released", () => {
      expect(isValidTransition("committed", "released")).toBe(false);
    });

    it("rejects released -> held", () => {
      expect(isValidTransition("released", "held")).toBe(false);
    });

    it("rejects released -> committed", () => {
      expect(isValidTransition("released", "committed")).toBe(false);
    });

    it("rejects expired -> held", () => {
      expect(isValidTransition("expired", "held")).toBe(false);
    });

    it("rejects expired -> committed", () => {
      expect(isValidTransition("expired", "committed")).toBe(false);
    });

    it("rejects held -> held (no self-transition)", () => {
      expect(isValidTransition("held", "held")).toBe(false);
    });

    const terminalStates: HoldStatus[] = ["committed", "released", "expired"];
    for (const state of terminalStates) {
      it(`rejects all transitions from terminal state '${state}'`, () => {
        const allStates: HoldStatus[] = ["held", "committed", "released", "expired"];
        for (const target of allStates) {
          expect(isValidTransition(state, target)).toBe(false);
        }
      });
    }
  });

  describe("transitionHold", () => {
    it("returns new status on valid transition", () => {
      expect(transitionHold("held", "committed")).toBe("committed");
      expect(transitionHold("held", "released")).toBe("released");
      expect(transitionHold("held", "expired")).toBe("expired");
    });

    it("throws on invalid transition", () => {
      expect(() => transitionHold("committed", "held")).toThrow(
        "Invalid hold transition",
      );
      expect(() => transitionHold("released", "committed")).toThrow(
        "Invalid hold transition",
      );
      expect(() => transitionHold("expired", "held")).toThrow(
        "Invalid hold transition",
      );
    });

    it("includes current and target state in error message", () => {
      expect(() => transitionHold("committed", "released")).toThrow(
        "'committed' -> 'released'",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Hold creation tests
// ---------------------------------------------------------------------------

describe("createHoldRecord", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a hold with default 24h timeout", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);

    const hold = createHoldRecord(makeHoldParams());

    expect(hold.hold_id).toMatch(/^hld_/);
    expect(hold.session_id).toBe("ses_01TESTSES000000000000001");
    expect(hold.account_id).toBe("acc_01TESTACC000000000000001");
    expect(hold.provider_event_id).toBeNull();
    expect(hold.status).toBe("held");

    const expiresMs = new Date(hold.expires_at).getTime();
    expect(expiresMs).toBe(now + DEFAULT_HOLD_TIMEOUT_MS);
  });

  it("creates a hold with custom timeout", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);

    const oneHour = 60 * 60 * 1000;
    const hold = createHoldRecord(makeHoldParams({ holdTimeoutMs: oneHour }));

    const expiresMs = new Date(hold.expires_at).getTime();
    expect(expiresMs).toBe(now + oneHour);
  });

  it("rejects timeout below minimum (5 minutes)", () => {
    expect(() =>
      createHoldRecord(makeHoldParams({ holdTimeoutMs: 1000 })),
    ).toThrow("below minimum");
  });

  it("accepts timeout exactly at minimum", () => {
    const hold = createHoldRecord(
      makeHoldParams({ holdTimeoutMs: MIN_HOLD_TIMEOUT_MS }),
    );
    expect(hold.status).toBe("held");
  });

  it("generates unique hold IDs", () => {
    const hold1 = createHoldRecord(makeHoldParams());
    const hold2 = createHoldRecord(makeHoldParams());
    expect(hold1.hold_id).not.toBe(hold2.hold_id);
  });
});

// ---------------------------------------------------------------------------
// Write-queue message builder tests
// ---------------------------------------------------------------------------

describe("buildHoldUpsertMessage", () => {
  it("builds UPSERT_MIRROR message with tentative projected payload", () => {
    const hold = makeHold();
    const params = makeHoldParams();
    const calendarId = "cal_01TESTCAL000000000000001";

    const msg = buildHoldUpsertMessage(hold, params, calendarId);

    expect(msg.type).toBe("UPSERT_MIRROR");
    expect(msg.target_account_id).toBe(params.accountId);
    expect(msg.target_calendar_id).toBe(calendarId);
    expect(msg.canonical_event_id).toBe(`hold_${hold.hold_id}`);
    expect(msg.idempotency_key).toBe(`hold_create_${hold.hold_id}`);
  });

  it("projected payload has [Hold] prefix in summary", () => {
    const hold = makeHold();
    const params = makeHoldParams({ title: "Design Review" });
    const msg = buildHoldUpsertMessage(hold, params, "cal_X");

    expect(msg.projected_payload.summary).toBe("[Hold] Design Review");
  });

  it("projected payload has correct start/end times", () => {
    const hold = makeHold();
    const params = makeHoldParams({
      candidateStart: "2026-04-01T14:00:00Z",
      candidateEnd: "2026-04-01T15:00:00Z",
    });
    const msg = buildHoldUpsertMessage(hold, params, "cal_X");

    expect(msg.projected_payload.start).toEqual({ dateTime: "2026-04-01T14:00:00Z" });
    expect(msg.projected_payload.end).toEqual({ dateTime: "2026-04-01T15:00:00Z" });
  });

  it("projected payload has tminus extended properties", () => {
    const hold = makeHold();
    const params = makeHoldParams();
    const msg = buildHoldUpsertMessage(hold, params, "cal_X");

    expect(msg.projected_payload.extendedProperties.private.tminus).toBe("true");
    expect(msg.projected_payload.extendedProperties.private.managed).toBe("true");
  });

  it("projected payload is opaque (blocks calendar time)", () => {
    const hold = makeHold();
    const params = makeHoldParams();
    const msg = buildHoldUpsertMessage(hold, params, "cal_X");

    expect(msg.projected_payload.transparency).toBe("opaque");
  });
});

describe("buildHoldDeleteMessage", () => {
  it("builds DELETE_MANAGED_MIRROR message when provider_event_id exists", () => {
    const hold = makeHold({ provider_event_id: "goog_event_123" });
    const msg = buildHoldDeleteMessage(hold);

    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("DELETE_MANAGED_MIRROR");
    expect(msg!.canonical_event_id).toBe(`hold_${hold.hold_id}`);
    expect(msg!.target_account_id).toBe(hold.account_id);
    expect(msg!.provider_event_id).toBe("goog_event_123");
    expect(msg!.idempotency_key).toBe(`hold_delete_${hold.hold_id}`);
  });

  it("returns null when no provider_event_id (event not yet created)", () => {
    const hold = makeHold({ provider_event_id: null });
    const msg = buildHoldDeleteMessage(hold);

    expect(msg).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Hold expiry tests
// ---------------------------------------------------------------------------

describe("isHoldExpired", () => {
  it("returns true when current time is past expires_at", () => {
    const hold = makeHold({
      expires_at: "2026-03-01T00:00:00Z",
    });
    expect(isHoldExpired(hold, "2026-03-02T00:00:00Z")).toBe(true);
  });

  it("returns true when current time equals expires_at", () => {
    const hold = makeHold({
      expires_at: "2026-03-01T12:00:00Z",
    });
    expect(isHoldExpired(hold, "2026-03-01T12:00:00Z")).toBe(true);
  });

  it("returns false when current time is before expires_at", () => {
    const hold = makeHold({
      expires_at: "2026-03-02T00:00:00Z",
    });
    expect(isHoldExpired(hold, "2026-03-01T00:00:00Z")).toBe(false);
  });

  it("uses Date.now() when no current time provided", () => {
    const futureHold = makeHold({
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(isHoldExpired(futureHold)).toBe(false);

    const pastHold = makeHold({
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(isHoldExpired(pastHold)).toBe(true);
  });
});

describe("findExpiredHolds", () => {
  const now = "2026-03-15T12:00:00Z";

  it("returns only holds that are 'held' and past expiry", () => {
    const holds: Hold[] = [
      makeHold({ hold_id: "h1", status: "held", expires_at: "2026-03-15T11:00:00Z" }), // expired
      makeHold({ hold_id: "h2", status: "held", expires_at: "2026-03-15T13:00:00Z" }), // not expired
      makeHold({ hold_id: "h3", status: "committed", expires_at: "2026-03-15T11:00:00Z" }), // committed (terminal)
      makeHold({ hold_id: "h4", status: "released", expires_at: "2026-03-15T10:00:00Z" }), // released (terminal)
      makeHold({ hold_id: "h5", status: "held", expires_at: "2026-03-15T11:30:00Z" }), // expired
    ];

    const expired = findExpiredHolds(holds, now);
    expect(expired).toHaveLength(2);
    expect(expired.map((h) => h.hold_id)).toEqual(["h1", "h5"]);
  });

  it("returns empty array when no holds are expired", () => {
    const holds: Hold[] = [
      makeHold({ status: "held", expires_at: "2026-03-15T13:00:00Z" }),
      makeHold({ status: "held", expires_at: "2026-03-16T00:00:00Z" }),
    ];
    expect(findExpiredHolds(holds, now)).toHaveLength(0);
  });

  it("returns empty array for empty input", () => {
    expect(findExpiredHolds([], now)).toHaveLength(0);
  });

  it("ignores expired holds already in terminal state", () => {
    const holds: Hold[] = [
      makeHold({ status: "expired", expires_at: "2026-03-15T10:00:00Z" }),
      makeHold({ status: "committed", expires_at: "2026-03-15T10:00:00Z" }),
      makeHold({ status: "released", expires_at: "2026-03-15T10:00:00Z" }),
    ];
    expect(findExpiredHolds(holds, now)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TM-82s.4: Configurable hold duration (1h-72h)
// ---------------------------------------------------------------------------

describe("validateHoldDurationHours", () => {
  it("accepts default 24 hours", () => {
    expect(validateHoldDurationHours(24)).toBe(24);
  });

  it("accepts minimum 1 hour", () => {
    expect(validateHoldDurationHours(1)).toBe(1);
  });

  it("accepts maximum 72 hours", () => {
    expect(validateHoldDurationHours(72)).toBe(72);
  });

  it("rejects below minimum (0.5 hours)", () => {
    expect(() => validateHoldDurationHours(0.5)).toThrow("between");
  });

  it("rejects above maximum (73 hours)", () => {
    expect(() => validateHoldDurationHours(73)).toThrow("between");
  });

  it("rejects zero", () => {
    expect(() => validateHoldDurationHours(0)).toThrow("between");
  });

  it("rejects negative values", () => {
    expect(() => validateHoldDurationHours(-1)).toThrow("between");
  });

  it("accepts fractional hours within range (1.5 hours)", () => {
    expect(validateHoldDurationHours(1.5)).toBe(1.5);
  });
});

describe("holdDurationHoursToMs", () => {
  it("converts 1 hour to 3600000 ms", () => {
    expect(holdDurationHoursToMs(1)).toBe(3_600_000);
  });

  it("converts 24 hours to 86400000 ms", () => {
    expect(holdDurationHoursToMs(24)).toBe(86_400_000);
  });

  it("converts 72 hours to 259200000 ms", () => {
    expect(holdDurationHoursToMs(72)).toBe(259_200_000);
  });

  it("converts fractional hours correctly (1.5h = 5400000 ms)", () => {
    expect(holdDurationHoursToMs(1.5)).toBe(5_400_000);
  });
});

describe("HOLD_DURATION constants", () => {
  it("has correct defaults", () => {
    expect(HOLD_DURATION_MIN_HOURS).toBe(1);
    expect(HOLD_DURATION_MAX_HOURS).toBe(72);
    expect(HOLD_DURATION_DEFAULT_HOURS).toBe(24);
  });
});

// ---------------------------------------------------------------------------
// TM-82s.4: Expiry notification (approaching expiry)
// ---------------------------------------------------------------------------

describe("isApproachingExpiry", () => {
  it("returns true when hold expires within 1 hour", () => {
    const hold = makeHold({
      expires_at: "2026-03-15T12:30:00Z",
    });
    // 30 minutes until expiry -- within the 1h threshold
    expect(isApproachingExpiry(hold, "2026-03-15T12:00:00Z")).toBe(true);
  });

  it("returns false when hold expires in more than 1 hour", () => {
    const hold = makeHold({
      expires_at: "2026-03-15T14:00:00Z",
    });
    // 2 hours until expiry -- outside the 1h threshold
    expect(isApproachingExpiry(hold, "2026-03-15T12:00:00Z")).toBe(false);
  });

  it("returns true when hold is already expired (expired is a subset of approaching)", () => {
    const hold = makeHold({
      expires_at: "2026-03-15T11:00:00Z",
    });
    expect(isApproachingExpiry(hold, "2026-03-15T12:00:00Z")).toBe(true);
  });

  it("returns false for holds not in held status", () => {
    const hold = makeHold({
      status: "committed",
      expires_at: "2026-03-15T12:30:00Z",
    });
    expect(isApproachingExpiry(hold, "2026-03-15T12:00:00Z")).toBe(false);
  });

  it("returns true when exactly 1 hour before expiry", () => {
    const hold = makeHold({
      expires_at: "2026-03-15T13:00:00Z",
    });
    // Exactly 1 hour -- boundary: at threshold
    expect(isApproachingExpiry(hold, "2026-03-15T12:00:00Z")).toBe(true);
  });

  it("returns false when 1 hour and 1 second before expiry", () => {
    const hold = makeHold({
      expires_at: "2026-03-15T13:00:01Z",
    });
    // Just beyond 1h threshold
    expect(isApproachingExpiry(hold, "2026-03-15T12:00:00Z")).toBe(false);
  });

  it("uses APPROACHING_EXPIRY_THRESHOLD_MS constant (1 hour)", () => {
    expect(APPROACHING_EXPIRY_THRESHOLD_MS).toBe(60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// TM-82s.4: Hold extension
// ---------------------------------------------------------------------------

describe("computeExtendedExpiry", () => {
  it("extends expiry by the configured duration from current time", () => {
    const hold = makeHold({
      expires_at: "2026-03-15T12:00:00Z",
    });
    const now = "2026-03-15T11:30:00Z";
    const durationHours = 24;

    const result = computeExtendedExpiry(hold, durationHours, now);
    // Should extend from now + 24h = 2026-03-16T11:30:00Z
    expect(result).toBe("2026-03-16T11:30:00.000Z");
  });

  it("extends with custom duration (4 hours)", () => {
    const hold = makeHold({
      expires_at: "2026-03-15T12:00:00Z",
    });
    const now = "2026-03-15T11:00:00Z";

    const result = computeExtendedExpiry(hold, 4, now);
    // 11:00 + 4h = 15:00
    expect(result).toBe("2026-03-15T15:00:00.000Z");
  });

  it("throws if hold is not in held status", () => {
    const hold = makeHold({ status: "committed" });
    expect(() => computeExtendedExpiry(hold, 24, "2026-03-15T11:00:00Z")).toThrow(
      "Only holds in 'held' status can be extended",
    );
  });

  it("throws if hold is expired status", () => {
    const hold = makeHold({ status: "expired" });
    expect(() => computeExtendedExpiry(hold, 24, "2026-03-15T11:00:00Z")).toThrow(
      "Only holds in 'held' status can be extended",
    );
  });

  it("throws if hold is released status", () => {
    const hold = makeHold({ status: "released" });
    expect(() => computeExtendedExpiry(hold, 24, "2026-03-15T11:00:00Z")).toThrow(
      "Only holds in 'held' status can be extended",
    );
  });

  it("validates duration is within configurable range", () => {
    const hold = makeHold();
    expect(() => computeExtendedExpiry(hold, 0.5, "2026-03-15T11:00:00Z")).toThrow("between");
    expect(() => computeExtendedExpiry(hold, 73, "2026-03-15T11:00:00Z")).toThrow("between");
  });
});

// ---------------------------------------------------------------------------
// TM-82s.4: Conflict detection
// ---------------------------------------------------------------------------

describe("detectHoldConflicts", () => {
  it("detects conflict when new event overlaps with an active hold", () => {
    const holds: Hold[] = [
      makeHold({
        hold_id: "h1",
        session_id: "ses_001",
        status: "held",
        // Hold covers 09:00-10:00 (from candidate times in hold creation)
      }),
    ];

    // Event from 09:30-10:30 overlaps with the hold at 09:00-10:00
    const conflicts = detectHoldConflicts(
      "2026-03-02T09:30:00Z",
      "2026-03-02T10:30:00Z",
      holds,
      // candidateTimes maps hold_id -> {start, end}
      { h1: { start: "2026-03-02T09:00:00Z", end: "2026-03-02T10:00:00Z" } },
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].hold_id).toBe("h1");
    expect(conflicts[0].session_id).toBe("ses_001");
  });

  it("returns empty when no holds overlap", () => {
    const holds: Hold[] = [
      makeHold({
        hold_id: "h1",
        status: "held",
      }),
    ];

    // Event from 11:00-12:00, hold covers 09:00-10:00
    const conflicts = detectHoldConflicts(
      "2026-03-02T11:00:00Z",
      "2026-03-02T12:00:00Z",
      holds,
      { h1: { start: "2026-03-02T09:00:00Z", end: "2026-03-02T10:00:00Z" } },
    );
    expect(conflicts).toHaveLength(0);
  });

  it("ignores holds not in held status", () => {
    const holds: Hold[] = [
      makeHold({ hold_id: "h1", status: "committed" }),
      makeHold({ hold_id: "h2", status: "released" }),
      makeHold({ hold_id: "h3", status: "expired" }),
    ];

    const conflicts = detectHoldConflicts(
      "2026-03-02T09:00:00Z",
      "2026-03-02T10:00:00Z",
      holds,
      {
        h1: { start: "2026-03-02T09:00:00Z", end: "2026-03-02T10:00:00Z" },
        h2: { start: "2026-03-02T09:00:00Z", end: "2026-03-02T10:00:00Z" },
        h3: { start: "2026-03-02T09:00:00Z", end: "2026-03-02T10:00:00Z" },
      },
    );
    expect(conflicts).toHaveLength(0);
  });

  it("detects multiple overlapping holds", () => {
    const holds: Hold[] = [
      makeHold({ hold_id: "h1", session_id: "ses_001", status: "held" }),
      makeHold({ hold_id: "h2", session_id: "ses_002", status: "held" }),
    ];

    // Both holds overlap with 09:00-10:00
    const conflicts = detectHoldConflicts(
      "2026-03-02T09:00:00Z",
      "2026-03-02T10:00:00Z",
      holds,
      {
        h1: { start: "2026-03-02T08:30:00Z", end: "2026-03-02T09:30:00Z" },
        h2: { start: "2026-03-02T09:30:00Z", end: "2026-03-02T10:30:00Z" },
      },
    );
    expect(conflicts).toHaveLength(2);
  });

  it("returns empty when no holds provided", () => {
    const conflicts = detectHoldConflicts(
      "2026-03-02T09:00:00Z",
      "2026-03-02T10:00:00Z",
      [],
      {},
    );
    expect(conflicts).toHaveLength(0);
  });

  it("skips holds without candidate time mapping", () => {
    const holds: Hold[] = [
      makeHold({ hold_id: "h1", status: "held" }),
    ];

    // No candidate time mapping for h1
    const conflicts = detectHoldConflicts(
      "2026-03-02T09:00:00Z",
      "2026-03-02T10:00:00Z",
      holds,
      {},
    );
    expect(conflicts).toHaveLength(0);
  });

  it("handles edge case: events touching but not overlapping", () => {
    const holds: Hold[] = [
      makeHold({ hold_id: "h1", status: "held" }),
    ];

    // Event ends exactly when hold starts (no overlap)
    const conflicts = detectHoldConflicts(
      "2026-03-02T08:00:00Z",
      "2026-03-02T09:00:00Z",
      holds,
      { h1: { start: "2026-03-02T09:00:00Z", end: "2026-03-02T10:00:00Z" } },
    );
    expect(conflicts).toHaveLength(0);
  });

  it("handles edge case: hold ends exactly when event starts (no overlap)", () => {
    const holds: Hold[] = [
      makeHold({ hold_id: "h1", status: "held" }),
    ];

    const conflicts = detectHoldConflicts(
      "2026-03-02T10:00:00Z",
      "2026-03-02T11:00:00Z",
      holds,
      { h1: { start: "2026-03-02T09:00:00Z", end: "2026-03-02T10:00:00Z" } },
    );
    expect(conflicts).toHaveLength(0);
  });

  it("conflict result includes hold_id and session_id", () => {
    const holds: Hold[] = [
      makeHold({
        hold_id: "h1",
        session_id: "ses_special",
        status: "held",
      }),
    ];

    const conflicts = detectHoldConflicts(
      "2026-03-02T09:30:00Z",
      "2026-03-02T10:30:00Z",
      holds,
      { h1: { start: "2026-03-02T09:00:00Z", end: "2026-03-02T10:00:00Z" } },
    );
    expect(conflicts[0]).toEqual({
      hold_id: "h1",
      session_id: "ses_special",
      hold_start: "2026-03-02T09:00:00Z",
      hold_end: "2026-03-02T10:00:00Z",
    });
  });
});
