/**
 * Unit tests for the tentative holds state machine and lifecycle (TM-946.3).
 *
 * Covers:
 * - Hold state transitions (valid and invalid)
 * - Hold record creation with default and custom timeouts
 * - Timeout validation (minimum 5 minutes)
 * - Hold expiry detection
 * - Finding expired holds for cleanup
 * - Building UPSERT_MIRROR messages for tentative events
 * - Building DELETE_MIRROR messages for hold cleanup
 * - Terminal states cannot transition
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
  it("builds DELETE_MIRROR message when provider_event_id exists", () => {
    const hold = makeHold({ provider_event_id: "goog_event_123" });
    const msg = buildHoldDeleteMessage(hold);

    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("DELETE_MIRROR");
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
