/**
 * Unit tests for feature gate middleware.
 *
 * Tests:
 * - Tier comparison logic (isTierSufficient)
 * - TIER_REQUIRED error response format with upgrade URL
 * - Account limit response format
 * - Account limit constants per tier
 * - Feature tier mapping
 * - Integration with getUserTier (via enforceFeatureGate)
 * - Account limit enforcement (via enforceAccountLimit)
 * - Tier lookup from D1
 */

import { describe, it, expect, vi } from "vitest";
import {
  isTierSufficient,
  featureGateResponse,
  tierRequiredResponse,
  accountLimitResponse,
  checkFeatureGate,
  enforceFeatureGate,
  checkAccountLimit,
  enforceAccountLimit,
  getAccountCount,
  ACCOUNT_LIMITS,
  FEATURE_TIERS,
} from "./feature-gate";
import type { FeatureTier } from "./feature-gate";

// ---------------------------------------------------------------------------
// Mock D1 helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock D1 database that returns a specific tier for subscription
 * lookups and a specific account count.
 */
function createMockD1(
  tier: string | null = null,
  accountCount = 0,
): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first<T>(): Promise<T | null> {
              // Subscription tier lookup
              if (sql.includes("FROM subscriptions")) {
                if (tier === null) return null;
                return { tier } as T;
              }
              // Account count lookup
              if (sql.includes("COUNT(*)")) {
                return { count: accountCount } as T;
              }
              return null;
            },
            async all<T>(): Promise<{ results: T[] }> {
              return { results: [] };
            },
            async run(): Promise<D1Result<unknown>> {
              return {
                success: true,
                results: [],
                meta: {
                  duration: 0,
                  rows_read: 0,
                  rows_written: 0,
                  last_row_id: 0,
                  changed_db: false,
                  size_after: 0,
                  changes: 0,
                },
              } as unknown as D1Result<unknown>;
            },
          };
        },
      };
    },
    exec: vi.fn(),
    batch: vi.fn(),
    dump: vi.fn(),
  } as unknown as D1Database;
}

// ===========================================================================
// Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// isTierSufficient (pure function)
// ---------------------------------------------------------------------------

describe("Feature gate: isTierSufficient", () => {
  it("free tier meets free requirement", () => {
    expect(isTierSufficient("free", "free")).toBe(true);
  });

  it("free tier does NOT meet premium requirement", () => {
    expect(isTierSufficient("free", "premium")).toBe(false);
  });

  it("free tier does NOT meet enterprise requirement", () => {
    expect(isTierSufficient("free", "enterprise")).toBe(false);
  });

  it("premium tier meets free requirement", () => {
    expect(isTierSufficient("premium", "free")).toBe(true);
  });

  it("premium tier meets premium requirement", () => {
    expect(isTierSufficient("premium", "premium")).toBe(true);
  });

  it("premium tier does NOT meet enterprise requirement", () => {
    expect(isTierSufficient("premium", "enterprise")).toBe(false);
  });

  it("enterprise tier meets all requirements", () => {
    expect(isTierSufficient("enterprise", "free")).toBe(true);
    expect(isTierSufficient("enterprise", "premium")).toBe(true);
    expect(isTierSufficient("enterprise", "enterprise")).toBe(true);
  });

  // Exhaustive matrix for confidence
  const tiers: FeatureTier[] = ["free", "premium", "enterprise"];
  const expectedMatrix: boolean[][] = [
    // required: free  premium  enterprise
    [true, false, false], // user: free
    [true, true, false], // user: premium
    [true, true, true], // user: enterprise
  ];

  tiers.forEach((userTier, i) => {
    tiers.forEach((requiredTier, j) => {
      it(`${userTier} -> ${requiredTier} = ${expectedMatrix[i][j]}`, () => {
        expect(isTierSufficient(userTier, requiredTier)).toBe(
          expectedMatrix[i][j],
        );
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Account limits constants
// ---------------------------------------------------------------------------

describe("Feature gate: ACCOUNT_LIMITS", () => {
  it("free tier limited to 2 accounts", () => {
    expect(ACCOUNT_LIMITS.free).toBe(2);
  });

  it("premium tier limited to 5 accounts", () => {
    expect(ACCOUNT_LIMITS.premium).toBe(5);
  });

  it("enterprise tier limited to 10 accounts", () => {
    expect(ACCOUNT_LIMITS.enterprise).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Feature tier mapping
// ---------------------------------------------------------------------------

describe("Feature gate: FEATURE_TIERS", () => {
  it("scheduling requires premium", () => {
    expect(FEATURE_TIERS["scheduling"]).toBe("premium");
  });

  it("constraints requires premium", () => {
    expect(FEATURE_TIERS["constraints"]).toBe("premium");
    expect(FEATURE_TIERS["constraints.create"]).toBe("premium");
    expect(FEATURE_TIERS["constraints.update"]).toBe("premium");
    expect(FEATURE_TIERS["constraints.delete"]).toBe("premium");
  });

  it("VIP requires enterprise", () => {
    expect(FEATURE_TIERS["vip"]).toBe("enterprise");
  });

  it("commitments requires enterprise", () => {
    expect(FEATURE_TIERS["commitments"]).toBe("enterprise");
  });

  it("MCP write requires premium", () => {
    expect(FEATURE_TIERS["mcp.write"]).toBe("premium");
  });

  it("listing accounts is free", () => {
    expect(FEATURE_TIERS["accounts.list"]).toBe("free");
  });
});

// ---------------------------------------------------------------------------
// tierRequiredResponse (TIER_REQUIRED error format)
// ---------------------------------------------------------------------------

describe("Feature gate: tierRequiredResponse", () => {
  it("returns 403 with TIER_REQUIRED error code", async () => {
    const response = tierRequiredResponse("premium");
    expect(response.status).toBe(403);

    const body = (await response.json()) as {
      ok: boolean;
      error: { code: string; message: string };
      required_tier: string;
      upgrade_url: string;
      meta: { request_id: string; timestamp: string };
    };

    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("TIER_REQUIRED");
    expect(body.error.message).toContain("premium");
    expect(body.required_tier).toBe("premium");
    expect(body.upgrade_url).toContain("https://app.tminus.ink/billing/upgrade");
    expect(body.upgrade_url).toContain("tier=premium");
    expect(body.meta.request_id).toMatch(/^req_/);
    expect(body.meta.timestamp).toBeTruthy();
  });

  it("includes upgrade URL with tier parameter for enterprise", async () => {
    const response = tierRequiredResponse("enterprise");
    const body = (await response.json()) as {
      error: { code: string; message: string };
      required_tier: string;
      upgrade_url: string;
    };
    expect(body.error.code).toBe("TIER_REQUIRED");
    expect(body.error.message).toContain("enterprise");
    expect(body.required_tier).toBe("enterprise");
    expect(body.upgrade_url).toContain("tier=enterprise");
  });

  it("includes current_tier when provided", async () => {
    const response = tierRequiredResponse("premium", "free");
    const body = (await response.json()) as {
      current_tier: string;
      required_tier: string;
    };
    expect(body.current_tier).toBe("free");
    expect(body.required_tier).toBe("premium");
  });

  it("omits current_tier when not provided", async () => {
    const response = tierRequiredResponse("premium");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("current_tier");
  });
});

// ---------------------------------------------------------------------------
// featureGateResponse (backward compatibility)
// ---------------------------------------------------------------------------

describe("Feature gate: featureGateResponse (deprecated)", () => {
  it("returns 403 with TIER_REQUIRED error code (same as tierRequiredResponse)", async () => {
    const response = featureGateResponse("premium");
    expect(response.status).toBe(403);

    const body = (await response.json()) as {
      ok: boolean;
      error: { code: string };
      upgrade_url: string;
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("TIER_REQUIRED");
    expect(body.upgrade_url).toContain("tier=premium");
  });
});

// ---------------------------------------------------------------------------
// accountLimitResponse
// ---------------------------------------------------------------------------

describe("Feature gate: accountLimitResponse", () => {
  it("returns 403 with TIER_REQUIRED error and usage details for free user", async () => {
    const response = accountLimitResponse("free", 2, 2);
    expect(response.status).toBe(403);

    const body = (await response.json()) as {
      ok: boolean;
      error: { code: string; message: string };
      required_tier: string;
      current_tier: string;
      upgrade_url: string;
      usage: { accounts: number; limit: number };
      meta: { request_id: string; timestamp: string };
    };

    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("TIER_REQUIRED");
    expect(body.error.message).toContain("Account limit reached");
    expect(body.error.message).toContain("2");
    expect(body.required_tier).toBe("premium");
    expect(body.current_tier).toBe("free");
    expect(body.upgrade_url).toContain("tier=premium");
    expect(body.usage.accounts).toBe(2);
    expect(body.usage.limit).toBe(2);
    expect(body.meta.request_id).toMatch(/^req_/);
  });

  it("suggests enterprise for premium users at limit", async () => {
    const response = accountLimitResponse("premium", 5, 5);
    const body = (await response.json()) as {
      error: { message: string };
      required_tier: string;
      current_tier: string;
      upgrade_url: string;
    };

    expect(body.error.message).toContain("5");
    expect(body.required_tier).toBe("enterprise");
    expect(body.current_tier).toBe("premium");
    expect(body.upgrade_url).toContain("tier=enterprise");
  });
});

// ---------------------------------------------------------------------------
// checkFeatureGate (with D1 lookup)
// ---------------------------------------------------------------------------

describe("Feature gate: checkFeatureGate", () => {
  it("allows free features for any user", async () => {
    const db = createMockD1(null); // no subscription = free tier
    const allowed = await checkFeatureGate("usr_test", "free", db);
    expect(allowed).toBe(true);
  });

  it("blocks premium features for free users", async () => {
    const db = createMockD1(null);
    const allowed = await checkFeatureGate("usr_test", "premium", db);
    expect(allowed).toBe(false);
  });

  it("allows premium features for premium users", async () => {
    const db = createMockD1("premium");
    const allowed = await checkFeatureGate("usr_test", "premium", db);
    expect(allowed).toBe(true);
  });

  it("allows premium features for enterprise users", async () => {
    const db = createMockD1("enterprise");
    const allowed = await checkFeatureGate("usr_test", "premium", db);
    expect(allowed).toBe(true);
  });

  it("blocks enterprise features for premium users", async () => {
    const db = createMockD1("premium");
    const allowed = await checkFeatureGate("usr_test", "enterprise", db);
    expect(allowed).toBe(false);
  });

  it("allows enterprise features for enterprise users", async () => {
    const db = createMockD1("enterprise");
    const allowed = await checkFeatureGate("usr_test", "enterprise", db);
    expect(allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// enforceFeatureGate (with D1 lookup + response)
// ---------------------------------------------------------------------------

describe("Feature gate: enforceFeatureGate", () => {
  it("returns null for allowed access", async () => {
    const db = createMockD1("premium");
    const result = await enforceFeatureGate("usr_test", "premium", db);
    expect(result).toBeNull();
  });

  it("returns 403 TIER_REQUIRED for denied access with upgrade URL", async () => {
    const db = createMockD1(null);
    const result = await enforceFeatureGate("usr_test", "premium", db);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);

    const body = (await result!.json()) as {
      ok: boolean;
      error: { code: string };
      required_tier: string;
      current_tier: string;
      upgrade_url: string;
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("TIER_REQUIRED");
    expect(body.required_tier).toBe("premium");
    expect(body.current_tier).toBe("free");
    expect(body.upgrade_url).toContain("tier=premium");
  });

  it("returns null for free tier requirement (always allowed)", async () => {
    const db = createMockD1(null);
    const result = await enforceFeatureGate("usr_test", "free", db);
    expect(result).toBeNull();
  });

  it("returns 403 for free user trying enterprise feature", async () => {
    const db = createMockD1(null);
    const result = await enforceFeatureGate("usr_test", "enterprise", db);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);

    const body = (await result!.json()) as {
      error: { code: string };
      required_tier: string;
      current_tier: string;
    };
    expect(body.error.code).toBe("TIER_REQUIRED");
    expect(body.required_tier).toBe("enterprise");
    expect(body.current_tier).toBe("free");
  });

  it("returns 403 for premium user trying enterprise feature", async () => {
    const db = createMockD1("premium");
    const result = await enforceFeatureGate("usr_test", "enterprise", db);
    expect(result).not.toBeNull();

    const body = (await result!.json()) as {
      current_tier: string;
      required_tier: string;
    };
    expect(body.current_tier).toBe("premium");
    expect(body.required_tier).toBe("enterprise");
  });
});

// ---------------------------------------------------------------------------
// getAccountCount
// ---------------------------------------------------------------------------

describe("Feature gate: getAccountCount", () => {
  it("returns 0 when no accounts exist", async () => {
    const db = createMockD1(null, 0);
    const count = await getAccountCount(db, "usr_test");
    expect(count).toBe(0);
  });

  it("returns correct count from D1", async () => {
    const db = createMockD1(null, 3);
    const count = await getAccountCount(db, "usr_test");
    expect(count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// checkAccountLimit
// ---------------------------------------------------------------------------

describe("Feature gate: checkAccountLimit", () => {
  it("allows free user with 0 accounts", async () => {
    const db = createMockD1(null, 0);
    const result = await checkAccountLimit("usr_test", db);
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe("free");
    expect(result.limit).toBe(2);
    expect(result.currentCount).toBe(0);
  });

  it("allows free user with 1 account", async () => {
    const db = createMockD1(null, 1);
    const result = await checkAccountLimit("usr_test", db);
    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(1);
  });

  it("blocks free user at 2 accounts (limit)", async () => {
    const db = createMockD1(null, 2);
    const result = await checkAccountLimit("usr_test", db);
    expect(result.allowed).toBe(false);
    expect(result.tier).toBe("free");
    expect(result.limit).toBe(2);
    expect(result.currentCount).toBe(2);
  });

  it("allows premium user with 4 accounts", async () => {
    const db = createMockD1("premium", 4);
    const result = await checkAccountLimit("usr_test", db);
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe("premium");
    expect(result.limit).toBe(5);
  });

  it("blocks premium user at 5 accounts (limit)", async () => {
    const db = createMockD1("premium", 5);
    const result = await checkAccountLimit("usr_test", db);
    expect(result.allowed).toBe(false);
    expect(result.tier).toBe("premium");
    expect(result.limit).toBe(5);
  });

  it("allows enterprise user with 9 accounts", async () => {
    const db = createMockD1("enterprise", 9);
    const result = await checkAccountLimit("usr_test", db);
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe("enterprise");
    expect(result.limit).toBe(10);
  });

  it("blocks enterprise user at 10 accounts (limit)", async () => {
    const db = createMockD1("enterprise", 10);
    const result = await checkAccountLimit("usr_test", db);
    expect(result.allowed).toBe(false);
    expect(result.tier).toBe("enterprise");
    expect(result.limit).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// enforceAccountLimit (convenience wrapper)
// ---------------------------------------------------------------------------

describe("Feature gate: enforceAccountLimit", () => {
  it("returns null when under limit", async () => {
    const db = createMockD1(null, 1); // free tier, 1 account
    const result = await enforceAccountLimit("usr_test", db);
    expect(result).toBeNull();
  });

  it("returns 403 when at limit", async () => {
    const db = createMockD1(null, 2); // free tier, 2 accounts (at limit)
    const result = await enforceAccountLimit("usr_test", db);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);

    const body = (await result!.json()) as {
      ok: boolean;
      error: { code: string; message: string };
      required_tier: string;
      current_tier: string;
      upgrade_url: string;
      usage: { accounts: number; limit: number };
    };

    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("TIER_REQUIRED");
    expect(body.error.message).toContain("Account limit reached");
    expect(body.required_tier).toBe("premium");
    expect(body.current_tier).toBe("free");
    expect(body.upgrade_url).toContain("tier=premium");
    expect(body.usage.accounts).toBe(2);
    expect(body.usage.limit).toBe(2);
  });

  it("returns null for premium user with 3 accounts", async () => {
    const db = createMockD1("premium", 3);
    const result = await enforceAccountLimit("usr_test", db);
    expect(result).toBeNull();
  });

  it("returns 403 for premium user at 5 accounts with enterprise upgrade", async () => {
    const db = createMockD1("premium", 5);
    const result = await enforceAccountLimit("usr_test", db);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);

    const body = (await result!.json()) as {
      required_tier: string;
      upgrade_url: string;
    };
    expect(body.required_tier).toBe("enterprise");
    expect(body.upgrade_url).toContain("tier=enterprise");
  });
});
