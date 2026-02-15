/**
 * Unit tests for provider health dashboard logic.
 *
 * Tests cover:
 * - Health badge computation (synced, syncing, error, stale)
 * - Provider-specific color assignment (Google=blue, Microsoft=purple, Apple=gray)
 * - Remediation guidance for error messages
 * - Stale threshold (configurable, default 1 hour per AC6)
 * - Token expiry formatting (without exposing actual tokens)
 * - Relative time formatting
 * - Badge color, label, and symbol helpers
 */
import { describe, it, expect } from "vitest";
import {
  computeHealthBadge,
  badgeColor,
  badgeLabel,
  badgeSymbol,
  providerColor,
  getRemediationGuidance,
  formatRelativeTime,
  formatTokenExpiry,
  DEFAULT_STALE_THRESHOLD_MS,
  type AccountHealthData,
  type HealthBadge,
} from "./provider-health";

// ---------------------------------------------------------------------------
// Test data factory
// ---------------------------------------------------------------------------

const NOW = new Date("2026-02-14T12:00:00Z").getTime();

function makeAccount(overrides: Partial<AccountHealthData> = {}): AccountHealthData {
  return {
    account_id: "acc-test-1",
    email: "user@gmail.com",
    provider: "google",
    status: "active",
    calendar_count: 3,
    calendar_names: ["Work", "Personal", "Shared"],
    last_successful_sync: new Date(NOW - 5 * 60 * 1000).toISOString(), // 5 min ago
    is_syncing: false,
    error_message: null,
    token_expires_at: new Date(NOW + 60 * 60 * 1000).toISOString(), // 1 hr from now
    created_at: new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeHealthBadge
// ---------------------------------------------------------------------------

describe("computeHealthBadge", () => {
  describe("synced state", () => {
    it("returns synced for active account with recent sync", () => {
      const account = makeAccount();
      expect(computeHealthBadge(account, NOW)).toBe("synced");
    });

    it("returns synced at exactly the stale threshold boundary", () => {
      // At exactly threshold, diff equals threshold (not greater-than), so synced
      const account = makeAccount({
        last_successful_sync: new Date(NOW - DEFAULT_STALE_THRESHOLD_MS).toISOString(),
      });
      expect(computeHealthBadge(account, NOW)).toBe("synced");
    });
  });

  describe("syncing state", () => {
    it("returns syncing when is_syncing is true", () => {
      const account = makeAccount({ is_syncing: true });
      expect(computeHealthBadge(account, NOW)).toBe("syncing");
    });

    it("error takes priority over syncing", () => {
      const account = makeAccount({
        is_syncing: true,
        error_message: "Token expired",
      });
      expect(computeHealthBadge(account, NOW)).toBe("error");
    });
  });

  describe("error state", () => {
    it("returns error when error_message is present", () => {
      const account = makeAccount({ error_message: "Token expired" });
      expect(computeHealthBadge(account, NOW)).toBe("error");
    });

    it("error takes priority over stale", () => {
      const account = makeAccount({
        error_message: "Revoked",
        last_successful_sync: null,
      });
      expect(computeHealthBadge(account, NOW)).toBe("error");
    });
  });

  describe("stale state", () => {
    it("returns stale when last_successful_sync is null (never synced)", () => {
      const account = makeAccount({ last_successful_sync: null });
      expect(computeHealthBadge(account, NOW)).toBe("stale");
    });

    it("returns stale when last sync exceeds default 1-hour threshold", () => {
      const account = makeAccount({
        last_successful_sync: new Date(NOW - DEFAULT_STALE_THRESHOLD_MS - 1).toISOString(),
      });
      expect(computeHealthBadge(account, NOW)).toBe("stale");
    });

    it("returns stale with custom threshold", () => {
      const customThreshold = 30 * 60 * 1000; // 30 minutes
      const account = makeAccount({
        last_successful_sync: new Date(NOW - customThreshold - 1).toISOString(),
      });
      expect(computeHealthBadge(account, NOW, customThreshold)).toBe("stale");
    });

    it("returns synced when within custom threshold", () => {
      const customThreshold = 2 * 60 * 60 * 1000; // 2 hours
      const account = makeAccount({
        last_successful_sync: new Date(NOW - 90 * 60 * 1000).toISOString(), // 90 min ago
      });
      expect(computeHealthBadge(account, NOW, customThreshold)).toBe("synced");
    });
  });

  describe("default stale threshold is 1 hour (AC6)", () => {
    it("DEFAULT_STALE_THRESHOLD_MS equals 3600000 (1 hour)", () => {
      expect(DEFAULT_STALE_THRESHOLD_MS).toBe(60 * 60 * 1000);
    });
  });
});

// ---------------------------------------------------------------------------
// Provider-specific colors (retro insight: no hash-based assignment)
// ---------------------------------------------------------------------------

describe("providerColor", () => {
  it("returns blue for Google", () => {
    expect(providerColor("google")).toBe("#4285F4");
  });

  it("returns purple for Microsoft", () => {
    expect(providerColor("microsoft")).toBe("#7B1FA2");
  });

  it("returns gray for Apple", () => {
    expect(providerColor("apple")).toBe("#8E8E93");
  });

  it("same provider always returns same color (stability)", () => {
    const color1 = providerColor("google");
    const color2 = providerColor("google");
    expect(color1).toBe(color2);
  });
});

// ---------------------------------------------------------------------------
// Badge display helpers
// ---------------------------------------------------------------------------

describe("badgeColor", () => {
  it("returns green for synced", () => {
    expect(badgeColor("synced")).toBe("#16a34a");
  });

  it("returns blue for syncing", () => {
    expect(badgeColor("syncing")).toBe("#2563eb");
  });

  it("returns red for error", () => {
    expect(badgeColor("error")).toBe("#dc2626");
  });

  it("returns yellow for stale", () => {
    expect(badgeColor("stale")).toBe("#ca8a04");
  });
});

describe("badgeLabel", () => {
  const cases: [HealthBadge, string][] = [
    ["synced", "Synced"],
    ["syncing", "Syncing"],
    ["error", "Error"],
    ["stale", "Stale"],
  ];

  it.each(cases)("returns '%s' -> '%s'", (badge, label) => {
    expect(badgeLabel(badge)).toBe(label);
  });
});

describe("badgeSymbol", () => {
  it("returns Unicode symbols for each badge type", () => {
    expect(badgeSymbol("synced")).toBe("\u25CF");
    expect(badgeSymbol("syncing")).toBe("\u21BB");
    expect(badgeSymbol("error")).toBe("\u2716");
    expect(badgeSymbol("stale")).toBe("\u25A0");
  });
});

// ---------------------------------------------------------------------------
// Remediation guidance (AC2)
// ---------------------------------------------------------------------------

describe("getRemediationGuidance", () => {
  it("returns empty string for null error", () => {
    expect(getRemediationGuidance(null)).toBe("");
  });

  it("returns token expiry guidance for token-related errors", () => {
    const guidance = getRemediationGuidance("Token expired during refresh");
    expect(guidance).toContain("expired");
    expect(guidance).toContain("Reconnect");
  });

  it("returns revoked guidance for access denied errors", () => {
    const guidance = getRemediationGuidance("Access was revoked by user");
    expect(guidance).toContain("revoked");
    expect(guidance).toContain("Reconnect");
  });

  it("returns rate limit guidance for 429 errors", () => {
    const guidance = getRemediationGuidance("Rate limit exceeded (429)");
    expect(guidance).toContain("rate-limiting");
  });

  it("returns network guidance for connection errors", () => {
    const guidance = getRemediationGuidance("Network timeout connecting to provider");
    expect(guidance).toContain("network");
  });

  it("returns not-found guidance for 404 errors", () => {
    const guidance = getRemediationGuidance("Calendar not found (404)");
    expect(guidance).toContain("not be found");
  });

  it("returns generic guidance for unknown errors", () => {
    const guidance = getRemediationGuidance("Something completely unexpected");
    expect(guidance).toContain("unexpected");
    expect(guidance).toContain("Reconnect");
  });
});

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

describe("formatRelativeTime", () => {
  it("returns 'Never' for null timestamp", () => {
    expect(formatRelativeTime(null, NOW)).toBe("Never");
  });

  it("returns 'Just now' for very recent timestamp", () => {
    const ts = new Date(NOW - 30 * 1000).toISOString(); // 30 sec ago
    expect(formatRelativeTime(ts, NOW)).toBe("Just now");
  });

  it("returns minutes for timestamps within an hour", () => {
    const ts = new Date(NOW - 15 * 60 * 1000).toISOString(); // 15 min ago
    expect(formatRelativeTime(ts, NOW)).toBe("15m ago");
  });

  it("returns hours for timestamps within a day", () => {
    const ts = new Date(NOW - 3 * 60 * 60 * 1000).toISOString(); // 3 hr ago
    expect(formatRelativeTime(ts, NOW)).toBe("3h ago");
  });

  it("returns days for timestamps older than a day", () => {
    const ts = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
    expect(formatRelativeTime(ts, NOW)).toBe("2d ago");
  });
});

describe("formatTokenExpiry", () => {
  it("returns 'No token info available' for null", () => {
    expect(formatTokenExpiry(null, NOW)).toBe("No token info available");
  });

  it("returns 'Expired' for past timestamp", () => {
    const ts = new Date(NOW - 60 * 1000).toISOString();
    expect(formatTokenExpiry(ts, NOW)).toBe("Expired");
  });

  it("returns minutes for near-future expiry", () => {
    const ts = new Date(NOW + 45 * 60 * 1000).toISOString();
    expect(formatTokenExpiry(ts, NOW)).toBe("Expires in 45m");
  });

  it("returns hours for hours-away expiry", () => {
    const ts = new Date(NOW + 5 * 60 * 60 * 1000).toISOString();
    expect(formatTokenExpiry(ts, NOW)).toBe("Expires in 5h");
  });

  it("returns days for days-away expiry", () => {
    const ts = new Date(NOW + 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatTokenExpiry(ts, NOW)).toBe("Expires in 3d");
  });
});
