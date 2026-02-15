/**
 * Unit tests for feature gate middleware.
 *
 * Tests:
 * - Tier comparison logic (isTierSufficient)
 * - Feature gate response format
 * - Integration with getUserTier (via enforceFeatureGate)
 */

import { describe, it, expect, vi } from "vitest";
import {
  isTierSufficient,
  featureGateResponse,
  checkFeatureGate,
  enforceFeatureGate,
} from "./feature-gate";
import type { FeatureTier } from "./feature-gate";

// ---------------------------------------------------------------------------
// Mock D1 helper
// ---------------------------------------------------------------------------

function createMockD1(tier: string | null = null): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first<T>(): Promise<T | null> {
              if (tier === null) return null;
              return { tier } as T;
            },
            async all<T>(): Promise<{ results: T[] }> {
              return { results: [] };
            },
            async run(): Promise<D1Result<unknown>> {
              return {
                success: true,
                results: [],
                meta: { duration: 0, rows_read: 0, rows_written: 0, last_row_id: 0, changed_db: false, size_after: 0, changes: 0 },
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
    [true, false, false],   // user: free
    [true, true, false],    // user: premium
    [true, true, true],     // user: enterprise
  ];

  tiers.forEach((userTier, i) => {
    tiers.forEach((requiredTier, j) => {
      it(`${userTier} -> ${requiredTier} = ${expectedMatrix[i][j]}`, () => {
        expect(isTierSufficient(userTier, requiredTier)).toBe(expectedMatrix[i][j]);
      });
    });
  });
});

describe("Feature gate: featureGateResponse", () => {
  it("returns 403 with FEATURE_GATE error code", async () => {
    const response = featureGateResponse("premium");
    expect(response.status).toBe(403);

    const body = await response.json() as {
      ok: boolean;
      error: { code: string; message: string };
      required_tier: string;
      meta: { request_id: string; timestamp: string };
    };

    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("FEATURE_GATE");
    expect(body.error.message).toContain("premium");
    expect(body.required_tier).toBe("premium");
    expect(body.meta.request_id).toMatch(/^req_/);
    expect(body.meta.timestamp).toBeTruthy();
  });

  it("includes the required tier in message for enterprise", async () => {
    const response = featureGateResponse("enterprise");
    const body = await response.json() as { error: { message: string }; required_tier: string };
    expect(body.error.message).toContain("enterprise");
    expect(body.required_tier).toBe("enterprise");
  });
});

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
});

describe("Feature gate: enforceFeatureGate", () => {
  it("returns null for allowed access", async () => {
    const db = createMockD1("premium");
    const result = await enforceFeatureGate("usr_test", "premium", db);
    expect(result).toBeNull();
  });

  it("returns 403 Response for denied access", async () => {
    const db = createMockD1(null);
    const result = await enforceFeatureGate("usr_test", "premium", db);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);

    const body = await result!.json() as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("FEATURE_GATE");
  });

  it("returns null for free tier requirement (always allowed)", async () => {
    const db = createMockD1(null);
    const result = await enforceFeatureGate("usr_test", "free", db);
    expect(result).toBeNull();
  });
});
