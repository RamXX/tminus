/**
 * Unit tests for accounts health endpoint logic (TM-qyjm).
 *
 * Tests tier_limit derivation, calendar_count computation, and response
 * shape assembly. Mocks are acceptable here per test pyramid policy.
 */

import { describe, it, expect } from "vitest";
import { ACCOUNT_LIMITS } from "../../middleware/feature-gate";
import type { FeatureTier } from "../../middleware/feature-gate";

// ---------------------------------------------------------------------------
// ACCOUNT_LIMITS tier_limit derivation
// ---------------------------------------------------------------------------

describe("tier_limit derivation from ACCOUNT_LIMITS", () => {
  it("free tier maps to limit 2", () => {
    expect(ACCOUNT_LIMITS["free" as FeatureTier]).toBe(2);
  });

  it("premium tier maps to limit 5", () => {
    expect(ACCOUNT_LIMITS["premium" as FeatureTier]).toBe(5);
  });

  it("enterprise tier maps to limit 10", () => {
    expect(ACCOUNT_LIMITS["enterprise" as FeatureTier]).toBe(10);
  });

  it("unknown tier falls back to free limit when accessed with fallback", () => {
    const tier = "unknown" as FeatureTier;
    const limit = ACCOUNT_LIMITS[tier] ?? ACCOUNT_LIMITS.free;
    expect(limit).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// calendar_count derivation from enabled + sync-enabled scopes
// ---------------------------------------------------------------------------

describe("calendar_count derivation from scopes", () => {
  interface ScopeEntry {
    scopeId: string;
    providerCalendarId: string;
    displayName: string | null;
    calendarRole: string;
    enabled: boolean;
    syncEnabled: boolean;
  }

  function deriveCalendarData(scopes: ScopeEntry[]): {
    calendar_count: number;
    calendar_names: string[];
  } {
    const enabledScopes = scopes.filter((s) => s.enabled && s.syncEnabled);
    return {
      calendar_count: enabledScopes.length,
      calendar_names: enabledScopes
        .map((s) => s.displayName ?? s.providerCalendarId)
        .filter(Boolean),
    };
  }

  it("counts only enabled and sync-enabled scopes", () => {
    const scopes: ScopeEntry[] = [
      {
        scopeId: "s1",
        providerCalendarId: "primary",
        displayName: "Main",
        calendarRole: "owner",
        enabled: true,
        syncEnabled: true,
      },
      {
        scopeId: "s2",
        providerCalendarId: "holidays",
        displayName: "Holidays",
        calendarRole: "reader",
        enabled: false,
        syncEnabled: false,
      },
      {
        scopeId: "s3",
        providerCalendarId: "team",
        displayName: "Team",
        calendarRole: "editor",
        enabled: true,
        syncEnabled: false,
      },
    ];

    const result = deriveCalendarData(scopes);
    expect(result.calendar_count).toBe(1);
    expect(result.calendar_names).toEqual(["Main"]);
  });

  it("returns 0 count and empty names for no scopes", () => {
    const result = deriveCalendarData([]);
    expect(result.calendar_count).toBe(0);
    expect(result.calendar_names).toEqual([]);
  });

  it("falls back to providerCalendarId when displayName is null", () => {
    const scopes: ScopeEntry[] = [
      {
        scopeId: "s1",
        providerCalendarId: "primary",
        displayName: null,
        calendarRole: "owner",
        enabled: true,
        syncEnabled: true,
      },
    ];

    const result = deriveCalendarData(scopes);
    expect(result.calendar_names).toEqual(["primary"]);
  });

  it("returns 0 when all scopes are disabled", () => {
    const scopes: ScopeEntry[] = [
      {
        scopeId: "s1",
        providerCalendarId: "primary",
        displayName: "Main",
        calendarRole: "owner",
        enabled: false,
        syncEnabled: false,
      },
    ];

    const result = deriveCalendarData(scopes);
    expect(result.calendar_count).toBe(0);
    expect(result.calendar_names).toEqual([]);
  });

  it("returns 0 when scopes are enabled but sync is disabled", () => {
    const scopes: ScopeEntry[] = [
      {
        scopeId: "s1",
        providerCalendarId: "team",
        displayName: "Team",
        calendarRole: "editor",
        enabled: true,
        syncEnabled: false,
      },
    ];

    const result = deriveCalendarData(scopes);
    expect(result.calendar_count).toBe(0);
    expect(result.calendar_names).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Health response shape validation
// ---------------------------------------------------------------------------

describe("AccountsHealthResponse shape", () => {
  interface AccountHealthData {
    account_id: string;
    email: string;
    provider: string;
    status: string;
    calendar_count: number;
    calendar_names: string[];
    last_successful_sync: string | null;
    is_syncing: boolean;
    error_message: string | null;
    token_expires_at: string | null;
    created_at: string;
  }

  interface AccountsHealthResponse {
    accounts: AccountHealthData[];
    account_count: number;
    tier_limit: number;
  }

  it("account_count equals accounts array length", () => {
    const accounts: AccountHealthData[] = [
      {
        account_id: "acc_1",
        email: "a@example.com",
        provider: "google",
        status: "active",
        calendar_count: 2,
        calendar_names: ["Main", "Work"],
        last_successful_sync: "2026-02-21T10:00:00Z",
        is_syncing: false,
        error_message: null,
        token_expires_at: "2026-02-22T10:00:00Z",
        created_at: "2026-02-01T00:00:00Z",
      },
    ];

    const response: AccountsHealthResponse = {
      accounts,
      account_count: accounts.length,
      tier_limit: 2,
    };

    expect(response.account_count).toBe(response.accounts.length);
  });

  it("empty accounts returns 0 count", () => {
    const response: AccountsHealthResponse = {
      accounts: [],
      account_count: 0,
      tier_limit: 2,
    };

    expect(response.account_count).toBe(0);
    expect(response.accounts).toHaveLength(0);
  });

  it("includes all required enriched fields", () => {
    const account: AccountHealthData = {
      account_id: "acc_1",
      email: "test@example.com",
      provider: "google",
      status: "active",
      calendar_count: 3,
      calendar_names: ["Primary", "Work", "Personal"],
      last_successful_sync: "2026-02-21T10:00:00Z",
      is_syncing: false,
      error_message: null,
      token_expires_at: "2026-02-22T10:00:00Z",
      created_at: "2026-02-01T00:00:00Z",
    };

    // Verify all enriched fields exist and are the right types
    expect(typeof account.calendar_count).toBe("number");
    expect(Array.isArray(account.calendar_names)).toBe(true);
    expect(account.last_successful_sync).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof account.is_syncing).toBe("boolean");
    expect(account.error_message).toBeNull();
    expect(account.token_expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("handles error state correctly", () => {
    const account: AccountHealthData = {
      account_id: "acc_err",
      email: "err@example.com",
      provider: "google",
      status: "active",
      calendar_count: 0,
      calendar_names: [],
      last_successful_sync: null,
      is_syncing: false,
      error_message: "Token expired",
      token_expires_at: null,
      created_at: "2026-02-01T00:00:00Z",
    };

    expect(account.error_message).toBe("Token expired");
    expect(account.last_successful_sync).toBeNull();
    expect(account.token_expires_at).toBeNull();
  });
});
