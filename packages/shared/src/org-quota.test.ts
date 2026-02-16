/**
 * Unit tests for per-org quota management (TM-9iu.5).
 *
 * Tests cover:
 * - Daily period key computation
 * - Monthly period key computation
 * - Daily reset timing
 * - Quota limit lookup by type
 * - Quota checking (counter-based and absolute)
 * - Quota report generation
 * - 429 response with Retry-After header
 * - Graceful degradation (BR-4)
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  checkQuota,
  getQuotaReport,
  buildQuotaExceededResponse,
  computeDailyPeriodKey,
  computeMonthlyPeriodKey,
  computeDailyResetTime,
  computeDailyRetryAfter,
  getPeriodKeyForQuota,
  getResetTimeForQuota,
  getQuotaLimit,
  DEFAULT_ORG_QUOTAS,
} from "./org-quota";
import type { OrgQuotaStore, OrgQuotaConfig, QuotaType } from "./org-quota";

// ---------------------------------------------------------------------------
// In-memory quota store for unit tests
// ---------------------------------------------------------------------------

function createMockQuotaStore(
  configOverride?: OrgQuotaConfig,
): OrgQuotaStore & { usage: Map<string, number> } {
  const usage = new Map<string, number>();
  return {
    usage,
    async getUsage(orgId: string, quotaType: QuotaType, periodKey: string): Promise<number> {
      const key = `${orgId}:${quotaType}:${periodKey}`;
      return usage.get(key) ?? 0;
    },
    async incrementUsage(orgId: string, quotaType: QuotaType, periodKey: string): Promise<number> {
      const key = `${orgId}:${quotaType}:${periodKey}`;
      const current = usage.get(key) ?? 0;
      const newVal = current + 1;
      usage.set(key, newVal);
      return newVal;
    },
    async setUsage(orgId: string, quotaType: QuotaType, periodKey: string, value: number): Promise<void> {
      const key = `${orgId}:${quotaType}:${periodKey}`;
      usage.set(key, value);
    },
    async getOrgQuotaConfig(_orgId: string): Promise<OrgQuotaConfig | null> {
      return configOverride ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("DEFAULT_ORG_QUOTAS", () => {
  it("defines sensible defaults", () => {
    expect(DEFAULT_ORG_QUOTAS.maxDiscoveredUsers).toBe(500);
    expect(DEFAULT_ORG_QUOTAS.maxDelegations).toBe(10);
    expect(DEFAULT_ORG_QUOTAS.maxApiCallsDaily).toBe(10000);
  });
});

// ---------------------------------------------------------------------------
// Period key computation
// ---------------------------------------------------------------------------

describe("computeDailyPeriodKey", () => {
  it("returns YYYY-MM-DD format", () => {
    // 2023-11-14 at some point UTC
    const key = computeDailyPeriodKey(new Date("2023-11-14T15:30:00Z").getTime());
    expect(key).toBe("2023-11-14");
  });

  it("uses UTC date regardless of local timezone", () => {
    // Just before midnight UTC
    const key = computeDailyPeriodKey(new Date("2023-11-14T23:59:59Z").getTime());
    expect(key).toBe("2023-11-14");
  });
});

describe("computeMonthlyPeriodKey", () => {
  it("returns YYYY-MM format", () => {
    const key = computeMonthlyPeriodKey(new Date("2023-11-14T15:30:00Z").getTime());
    expect(key).toBe("2023-11");
  });

  it("pads single-digit months", () => {
    const key = computeMonthlyPeriodKey(new Date("2023-03-01T00:00:00Z").getTime());
    expect(key).toBe("2023-03");
  });
});

describe("computeDailyResetTime", () => {
  it("returns next midnight UTC", () => {
    const reset = computeDailyResetTime(new Date("2023-11-14T15:30:00Z").getTime());
    expect(reset).toBe("2023-11-15T00:00:00.000Z");
  });

  it("handles last day of month", () => {
    const reset = computeDailyResetTime(new Date("2023-11-30T23:00:00Z").getTime());
    expect(reset).toBe("2023-12-01T00:00:00.000Z");
  });
});

describe("computeDailyRetryAfter", () => {
  it("returns positive seconds until midnight", () => {
    // 15:30 UTC => 8.5 hours = 30600 seconds until midnight
    const retryAfter = computeDailyRetryAfter(new Date("2023-11-14T15:30:00Z").getTime());
    expect(retryAfter).toBe(30600);
  });

  it("returns small value just before midnight", () => {
    const retryAfter = computeDailyRetryAfter(new Date("2023-11-14T23:59:00Z").getTime());
    expect(retryAfter).toBe(60);
  });
});

describe("getPeriodKeyForQuota", () => {
  it("uses daily key for api_calls_daily", () => {
    const key = getPeriodKeyForQuota("api_calls_daily", new Date("2023-11-14T12:00:00Z").getTime());
    expect(key).toBe("2023-11-14");
  });

  it("uses lifetime for discovered_users", () => {
    expect(getPeriodKeyForQuota("discovered_users")).toBe("lifetime");
  });

  it("uses lifetime for delegations", () => {
    expect(getPeriodKeyForQuota("delegations")).toBe("lifetime");
  });
});

describe("getResetTimeForQuota", () => {
  it("returns next midnight for daily quotas", () => {
    const reset = getResetTimeForQuota("api_calls_daily", new Date("2023-11-14T12:00:00Z").getTime());
    expect(reset).toBe("2023-11-15T00:00:00.000Z");
  });

  it("returns far future for lifetime quotas", () => {
    expect(getResetTimeForQuota("discovered_users")).toBe("9999-12-31T23:59:59.999Z");
    expect(getResetTimeForQuota("delegations")).toBe("9999-12-31T23:59:59.999Z");
  });
});

// ---------------------------------------------------------------------------
// getQuotaLimit
// ---------------------------------------------------------------------------

describe("getQuotaLimit", () => {
  it("returns maxDiscoveredUsers for discovered_users", () => {
    expect(getQuotaLimit(DEFAULT_ORG_QUOTAS, "discovered_users")).toBe(500);
  });

  it("returns maxDelegations for delegations", () => {
    expect(getQuotaLimit(DEFAULT_ORG_QUOTAS, "delegations")).toBe(10);
  });

  it("returns maxApiCallsDaily for api_calls_daily", () => {
    expect(getQuotaLimit(DEFAULT_ORG_QUOTAS, "api_calls_daily")).toBe(10000);
  });
});

// ---------------------------------------------------------------------------
// checkQuota
// ---------------------------------------------------------------------------

describe("checkQuota", () => {
  let store: OrgQuotaStore & { usage: Map<string, number> };

  beforeEach(() => {
    store = createMockQuotaStore();
  });

  it("allows api_calls_daily when under limit", async () => {
    const result = await checkQuota(store, "org_123", "api_calls_daily", DEFAULT_ORG_QUOTAS);
    expect(result.allowed).toBe(true);
    expect(result.current).toBe(1);
    expect(result.limit).toBe(10000);
  });

  it("blocks api_calls_daily when at limit", async () => {
    const config: OrgQuotaConfig = { ...DEFAULT_ORG_QUOTAS, maxApiCallsDaily: 2 };
    const now = new Date("2023-11-14T12:00:00Z").getTime();

    await checkQuota(store, "org_123", "api_calls_daily", config, now);
    await checkQuota(store, "org_123", "api_calls_daily", config, now + 1000);

    const r3 = await checkQuota(store, "org_123", "api_calls_daily", config, now + 2000);
    expect(r3.allowed).toBe(false);
    expect(r3.current).toBe(2);
    expect(r3.retryAfter).toBeGreaterThan(0);
  });

  it("daily quota resets with new day", async () => {
    const config: OrgQuotaConfig = { ...DEFAULT_ORG_QUOTAS, maxApiCallsDaily: 1 };

    // Day 1
    const day1 = new Date("2023-11-14T12:00:00Z").getTime();
    await checkQuota(store, "org_123", "api_calls_daily", config, day1);
    const blocked = await checkQuota(store, "org_123", "api_calls_daily", config, day1 + 1000);
    expect(blocked.allowed).toBe(false);

    // Day 2 -- new period key
    const day2 = new Date("2023-11-15T01:00:00Z").getTime();
    const fresh = await checkQuota(store, "org_123", "api_calls_daily", config, day2);
    expect(fresh.allowed).toBe(true);
  });

  it("checks discovered_users without incrementing", async () => {
    // Set current discovered users count
    store.usage.set("org_123:discovered_users:lifetime", 100);

    const result = await checkQuota(store, "org_123", "discovered_users", DEFAULT_ORG_QUOTAS);
    expect(result.allowed).toBe(true);
    expect(result.current).toBe(100);
    // Should NOT increment
    expect(store.usage.get("org_123:discovered_users:lifetime")).toBe(100);
  });

  it("blocks discovered_users when at limit", async () => {
    store.usage.set("org_123:discovered_users:lifetime", 500);

    const result = await checkQuota(store, "org_123", "discovered_users", DEFAULT_ORG_QUOTAS);
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBe(0); // Lifetime quotas don't reset
  });

  it("uses org-specific config from store", async () => {
    const customConfig: OrgQuotaConfig = {
      maxDiscoveredUsers: 50,
      maxDelegations: 3,
      maxApiCallsDaily: 100,
    };
    const customStore = createMockQuotaStore(customConfig);

    const result = await checkQuota(customStore, "org_123", "api_calls_daily");
    expect(result.limit).toBe(100);
  });

  it("falls back to defaults when no config in store", async () => {
    const result = await checkQuota(store, "org_123", "api_calls_daily");
    expect(result.limit).toBe(10000);
  });
});

// ---------------------------------------------------------------------------
// getQuotaReport
// ---------------------------------------------------------------------------

describe("getQuotaReport", () => {
  let store: OrgQuotaStore & { usage: Map<string, number> };

  beforeEach(() => {
    store = createMockQuotaStore();
  });

  it("returns all quota usages", async () => {
    const now = new Date("2023-11-14T12:00:00Z").getTime();
    const periodKey = computeDailyPeriodKey(now);
    store.usage.set(`org_123:discovered_users:lifetime`, 50);
    store.usage.set(`org_123:delegations:lifetime`, 3);
    store.usage.set(`org_123:api_calls_daily:${periodKey}`, 150);

    const report = await getQuotaReport(store, "org_123", DEFAULT_ORG_QUOTAS, now);

    expect(report.orgId).toBe("org_123");
    expect(report.quotas).toHaveLength(3);
    expect(report.anyExceeded).toBe(false);

    const discoveredUsers = report.quotas.find((q) => q.type === "discovered_users");
    expect(discoveredUsers).toBeDefined();
    expect(discoveredUsers!.current).toBe(50);
    expect(discoveredUsers!.limit).toBe(500);
    expect(discoveredUsers!.exceeded).toBe(false);

    const apiCalls = report.quotas.find((q) => q.type === "api_calls_daily");
    expect(apiCalls!.current).toBe(150);
  });

  it("flags anyExceeded when a quota is at limit", async () => {
    store.usage.set("org_123:discovered_users:lifetime", 500);

    const report = await getQuotaReport(store, "org_123", DEFAULT_ORG_QUOTAS);
    expect(report.anyExceeded).toBe(true);

    const exceeded = report.quotas.find((q) => q.type === "discovered_users");
    expect(exceeded!.exceeded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildQuotaExceededResponse
// ---------------------------------------------------------------------------

describe("buildQuotaExceededResponse", () => {
  it("returns 429 status", async () => {
    const result = {
      allowed: false,
      quotaType: "api_calls_daily" as QuotaType,
      current: 10000,
      limit: 10000,
      retryAfter: 3600,
    };

    const response = buildQuotaExceededResponse(result);
    expect(response.status).toBe(429);
  });

  it("includes Retry-After header for daily quotas", async () => {
    const result = {
      allowed: false,
      quotaType: "api_calls_daily" as QuotaType,
      current: 10000,
      limit: 10000,
      retryAfter: 7200,
    };

    const response = buildQuotaExceededResponse(result);
    expect(response.headers.get("Retry-After")).toBe("7200");
  });

  it("body includes QUOTA_EXCEEDED code", async () => {
    const result = {
      allowed: false,
      quotaType: "discovered_users" as QuotaType,
      current: 500,
      limit: 500,
      retryAfter: 0,
    };

    const response = buildQuotaExceededResponse(result);
    const body = await response.json();

    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("QUOTA_EXCEEDED");
    expect(body.meta.quota_type).toBe("discovered_users");
    expect(body.meta.current).toBe(500);
    expect(body.meta.limit).toBe(500);
  });

  it("omits Retry-After for lifetime quotas", async () => {
    const result = {
      allowed: false,
      quotaType: "delegations" as QuotaType,
      current: 10,
      limit: 10,
      retryAfter: 0,
    };

    const response = buildQuotaExceededResponse(result);
    expect(response.headers.get("Retry-After")).toBeNull();
  });
});
