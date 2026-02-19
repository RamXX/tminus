/**
 * Unit tests for sync status health computation logic.
 *
 * Tests cover:
 * - Health state color mapping
 * - Per-account health computation (healthy, degraded, stale, error)
 * - Overall health computation from per-account statuses
 * - Edge cases: empty accounts, null timestamps, boundary thresholds
 */
import { describe, it, expect } from "vitest";
import {
  healthToColor,
  computeAccountHealth,
  computeAllAccountHealth,
  computeOverallHealth,
  computeUserGraphHealth,
  healthLabel,
  STALE_THRESHOLD_MS,
  type SyncAccountStatus,
  type AccountHealth,
  type UserGraphSyncHealth,
  type HealthState,
} from "./sync-status";

// ---------------------------------------------------------------------------
// Test data factory
// ---------------------------------------------------------------------------

function makeAccount(overrides: Partial<SyncAccountStatus> = {}): SyncAccountStatus {
  return {
    account_id: "acc-1",
    email: "user@example.com",
    provider: "google",
    status: "active",
    last_sync_ts: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min ago
    channel_status: "active",
    pending_writes: 0,
    error_count: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// healthToColor
// ---------------------------------------------------------------------------

describe("healthToColor", () => {
  it("maps healthy to green", () => {
    expect(healthToColor("healthy")).toBe("green");
  });

  it("maps degraded to yellow", () => {
    expect(healthToColor("degraded")).toBe("yellow");
  });

  it("maps stale to red", () => {
    expect(healthToColor("stale")).toBe("red");
  });

  it("maps error to red", () => {
    expect(healthToColor("error")).toBe("red");
  });
});

// ---------------------------------------------------------------------------
// healthLabel
// ---------------------------------------------------------------------------

describe("healthLabel", () => {
  const cases: [HealthState, string][] = [
    ["healthy", "Healthy"],
    ["degraded", "Degraded"],
    ["stale", "Stale"],
    ["error", "Error"],
  ];

  it.each(cases)("returns '%s' -> '%s'", (state, label) => {
    expect(healthLabel(state)).toBe(label);
  });
});

// ---------------------------------------------------------------------------
// computeAccountHealth
// ---------------------------------------------------------------------------

describe("computeAccountHealth", () => {
  const NOW = Date.now();

  describe("healthy state", () => {
    it("returns healthy for active account with recent sync", () => {
      const account = makeAccount({
        last_sync_ts: new Date(NOW - 5 * 60 * 1000).toISOString(),
      });
      expect(computeAccountHealth(account, NOW)).toBe("healthy");
    });

    it("returns healthy with zero errors and active channel", () => {
      const account = makeAccount({
        status: "active",
        channel_status: "active",
        error_count: 0,
        pending_writes: 0,
      });
      expect(computeAccountHealth(account, NOW)).toBe("healthy");
    });

    it("returns healthy with pending_writes at boundary (10)", () => {
      const account = makeAccount({ pending_writes: 10 });
      expect(computeAccountHealth(account, NOW)).toBe("healthy");
    });

    it("returns healthy when channel is active even if first sync timestamp is missing", () => {
      const account = makeAccount({ last_sync_ts: null, channel_status: "active" });
      expect(computeAccountHealth(account, NOW)).toBe("healthy");
    });
  });

  describe("degraded state", () => {
    it("returns degraded when channel_status is expired", () => {
      const account = makeAccount({ channel_status: "expired" });
      expect(computeAccountHealth(account, NOW)).toBe("degraded");
    });

    it("returns degraded when pending_writes exceeds 10", () => {
      const account = makeAccount({ pending_writes: 11 });
      expect(computeAccountHealth(account, NOW)).toBe("degraded");
    });

    it("returns degraded with many pending writes but no errors", () => {
      const account = makeAccount({ pending_writes: 50 });
      expect(computeAccountHealth(account, NOW)).toBe("degraded");
    });

    it("returns degraded for active channels idle beyond threshold", () => {
      const account = makeAccount({
        channel_status: "active",
        last_sync_ts: new Date(NOW - STALE_THRESHOLD_MS - 1).toISOString(),
      });
      expect(computeAccountHealth(account, NOW)).toBe("degraded");
    });
  });

  describe("stale state", () => {
    it("returns stale when channel is not active and last_sync_ts is null", () => {
      const account = makeAccount({ last_sync_ts: null, channel_status: "missing" });
      expect(computeAccountHealth(account, NOW)).toBe("stale");
    });

    it("returns stale when non-active channel last sync exceeds threshold", () => {
      const account = makeAccount({
        channel_status: "missing",
        last_sync_ts: new Date(NOW - STALE_THRESHOLD_MS - 1).toISOString(),
      });
      expect(computeAccountHealth(account, NOW)).toBe("stale");
    });

    it("returns degraded at exactly the threshold boundary for non-active channels", () => {
      const account = makeAccount({
        channel_status: "missing",
        last_sync_ts: new Date(NOW - STALE_THRESHOLD_MS).toISOString(),
      });
      expect(computeAccountHealth(account, NOW)).toBe("degraded");
    });
  });

  describe("error state", () => {
    it("returns error when status is error", () => {
      const account = makeAccount({ status: "error" });
      expect(computeAccountHealth(account, NOW)).toBe("error");
    });

    it("returns error when error_count > 0", () => {
      const account = makeAccount({ error_count: 1 });
      expect(computeAccountHealth(account, NOW)).toBe("error");
    });

    it("returns error when status is revoked", () => {
      const account = makeAccount({ status: "revoked" });
      expect(computeAccountHealth(account, NOW)).toBe("error");
    });

    it("returns error when channel_status is error", () => {
      const account = makeAccount({ channel_status: "error" });
      expect(computeAccountHealth(account, NOW)).toBe("error");
    });

    it("error takes priority over stale", () => {
      const account = makeAccount({
        error_count: 3,
        last_sync_ts: null, // would be stale
      });
      expect(computeAccountHealth(account, NOW)).toBe("error");
    });

    it("error takes priority over degraded", () => {
      const account = makeAccount({
        error_count: 1,
        channel_status: "expired", // would be degraded
      });
      expect(computeAccountHealth(account, NOW)).toBe("error");
    });
  });
});

// ---------------------------------------------------------------------------
// computeAllAccountHealth
// ---------------------------------------------------------------------------

describe("computeAllAccountHealth", () => {
  const NOW = Date.now();

  it("returns enriched accounts with health and color", () => {
    const accounts = [
      makeAccount({ account_id: "a1", email: "a@test.com" }),
      makeAccount({ account_id: "a2", email: "b@test.com", error_count: 2 }),
    ];

    const result = computeAllAccountHealth(accounts, NOW);

    expect(result).toHaveLength(2);
    expect(result[0].health).toBe("healthy");
    expect(result[0].color).toBe("green");
    expect(result[0].email).toBe("a@test.com");

    expect(result[1].health).toBe("error");
    expect(result[1].color).toBe("red");
    expect(result[1].email).toBe("b@test.com");
  });

  it("returns empty array for empty input", () => {
    expect(computeAllAccountHealth([], NOW)).toEqual([]);
  });

  it("preserves all original account fields", () => {
    const account = makeAccount({
      account_id: "x",
      email: "x@y.com",
      provider: "google",
      status: "active",
      pending_writes: 5,
    });
    const [result] = computeAllAccountHealth([account], NOW);
    expect(result.account_id).toBe("x");
    expect(result.provider).toBe("google");
    expect(result.pending_writes).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// computeOverallHealth
// ---------------------------------------------------------------------------

describe("computeOverallHealth", () => {
  function makeAccountHealth(health: HealthState): AccountHealth {
    return {
      ...makeAccount(),
      health,
      color: healthToColor(health),
    };
  }

  it("returns healthy when no accounts", () => {
    expect(computeOverallHealth([])).toBe("healthy");
  });

  it("returns healthy when all accounts healthy", () => {
    const accounts = [makeAccountHealth("healthy"), makeAccountHealth("healthy")];
    expect(computeOverallHealth(accounts)).toBe("healthy");
  });

  it("returns degraded when worst is degraded", () => {
    const accounts = [makeAccountHealth("healthy"), makeAccountHealth("degraded")];
    expect(computeOverallHealth(accounts)).toBe("degraded");
  });

  it("returns stale when worst is stale", () => {
    const accounts = [
      makeAccountHealth("healthy"),
      makeAccountHealth("degraded"),
      makeAccountHealth("stale"),
    ];
    expect(computeOverallHealth(accounts)).toBe("stale");
  });

  it("returns error when any account has error", () => {
    const accounts = [
      makeAccountHealth("healthy"),
      makeAccountHealth("degraded"),
      makeAccountHealth("error"),
    ];
    expect(computeOverallHealth(accounts)).toBe("error");
  });

  it("returns error even if only one account has error among many healthy", () => {
    const accounts = [
      makeAccountHealth("healthy"),
      makeAccountHealth("healthy"),
      makeAccountHealth("healthy"),
      makeAccountHealth("error"),
    ];
    expect(computeOverallHealth(accounts)).toBe("error");
  });

  it("handles single account correctly", () => {
    expect(computeOverallHealth([makeAccountHealth("degraded")])).toBe("degraded");
  });

  it("uses user graph errors as overall error even when accounts are healthy", () => {
    const graph: UserGraphSyncHealth = {
      total_events: 10,
      total_mirrors: 20,
      active_mirrors: 18,
      pending_mirrors: 0,
      error_mirrors: 2,
      last_activity_ts: new Date().toISOString(),
    };
    expect(computeOverallHealth([makeAccountHealth("healthy")], graph)).toBe("error");
  });

  it("uses user graph residual errors as overall degraded when below hard threshold", () => {
    const graph: UserGraphSyncHealth = {
      total_events: 100,
      total_mirrors: 10000,
      active_mirrors: 9950,
      pending_mirrors: 0,
      error_mirrors: 20,
      last_activity_ts: new Date().toISOString(),
    };
    expect(computeOverallHealth([makeAccountHealth("healthy")], graph)).toBe("degraded");
  });
});

describe("computeUserGraphHealth", () => {
  it("returns healthy when user graph is missing", () => {
    expect(computeUserGraphHealth(null)).toBe("healthy");
  });

  it("returns healthy for small residual pending mirrors", () => {
    expect(
      computeUserGraphHealth({
        total_events: 100,
        total_mirrors: 10000,
        active_mirrors: 9950,
        pending_mirrors: 50,
        error_mirrors: 0,
        last_activity_ts: new Date().toISOString(),
      }),
    ).toBe("healthy");
  });

  it("returns degraded when pending mirror count is materially high", () => {
    expect(
      computeUserGraphHealth({
        total_events: 100,
        total_mirrors: 10000,
        active_mirrors: 9300,
        pending_mirrors: 700,
        error_mirrors: 0,
        last_activity_ts: new Date().toISOString(),
      }),
    ).toBe("degraded");
  });

  it("returns degraded when pending mirror ratio is materially high", () => {
    expect(
      computeUserGraphHealth({
        total_events: 10,
        total_mirrors: 80,
        active_mirrors: 70,
        pending_mirrors: 10,
        error_mirrors: 0,
        last_activity_ts: new Date().toISOString(),
      }),
    ).toBe("degraded");
  });

  it("returns error when error mirrors exist", () => {
    expect(
      computeUserGraphHealth({
        total_events: 10,
        total_mirrors: 20,
        active_mirrors: 18,
        pending_mirrors: 0,
        error_mirrors: 2,
        last_activity_ts: new Date().toISOString(),
      }),
    ).toBe("error");
  });

  it("returns degraded when residual error mirrors are below hard threshold", () => {
    expect(
      computeUserGraphHealth({
        total_events: 100,
        total_mirrors: 10000,
        active_mirrors: 9980,
        pending_mirrors: 0,
        error_mirrors: 20,
        last_activity_ts: new Date().toISOString(),
      }),
    ).toBe("degraded");
  });
});
