/**
 * Unit tests for enterprise billing tier integration.
 *
 * Story: TM-nt8 -- Enterprise Billing Tier Integration
 *
 * Tests:
 * - Seat limit validation (validateSeatInput)
 * - Seat limit enforcement logic (checkSeatLimit)
 * - SEAT_LIMIT error response format with upgrade prompt
 * - Enterprise tier gate for org creation (TIER_REQUIRED)
 * - Seat count update triggers Stripe subscription quantity update
 * - Stripe webhook handling for seat-related events
 * - Default included seats constant
 */

import { describe, it, expect, vi } from "vitest";
import {
  validateSeatInput,
  checkSeatLimit,
  seatLimitResponse,
  DEFAULT_INCLUDED_SEATS,
  buildStripeQuantityUpdateBody,
  handleSeatQuantityUpdated,
} from "./enterprise-billing";

// ---------------------------------------------------------------------------
// Mock D1 helpers
// ---------------------------------------------------------------------------

interface MockRow {
  [key: string]: unknown;
}

/**
 * Create a mock D1 database that returns pre-configured data
 * for org member count and org seat limit lookups.
 */
function createMockD1(opts: {
  memberCount?: number;
  seatLimit?: number;
  orgExists?: boolean;
  subscriptionTier?: string | null;
  stripeSubscriptionId?: string | null;
} = {}): D1Database & { _getQueries(): string[] } {
  const queries: string[] = [];
  const {
    memberCount = 0,
    seatLimit = 5,
    orgExists = true,
    subscriptionTier = "enterprise",
    stripeSubscriptionId = null,
  } = opts;

  return {
    prepare(sql: string) {
      queries.push(sql);
      return {
        bind(..._params: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              // Member count query
              if (sql.includes("COUNT(*)") && sql.includes("org_members")) {
                return { count: memberCount } as T;
              }
              // Org lookup with seat_limit
              if (sql.includes("FROM organizations")) {
                if (!orgExists) return null;
                return {
                  org_id: "org_test_01",
                  name: "Test Org",
                  seat_limit: seatLimit,
                  stripe_subscription_id: stripeSubscriptionId,
                } as T;
              }
              // Subscription tier lookup
              if (sql.includes("FROM subscriptions")) {
                if (subscriptionTier === null) return null;
                return { tier: subscriptionTier } as T;
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
                  rows_written: 1,
                  last_row_id: 1,
                  changed_db: true,
                  size_after: 0,
                  changes: 1,
                },
              } as unknown as D1Result<unknown>;
            },
          };
        },
      };
    },
    _getQueries(): string[] { return queries; },
    exec: vi.fn(),
    batch: vi.fn(),
    dump: vi.fn(),
  } as unknown as D1Database & { _getQueries(): string[] };
}

// ===========================================================================
// Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("Enterprise billing: DEFAULT_INCLUDED_SEATS", () => {
  it("is 5 seats included with enterprise base price", () => {
    expect(DEFAULT_INCLUDED_SEATS).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// validateSeatInput (pure validation)
// ---------------------------------------------------------------------------

describe("Enterprise billing: validateSeatInput", () => {
  it("returns null for valid seat count", () => {
    expect(validateSeatInput({ seat_count: 10 })).toBeNull();
  });

  it("returns error when seat_count is missing", () => {
    expect(validateSeatInput({})).toBe("seat_count is required");
  });

  it("returns error when seat_count is not a number", () => {
    expect(validateSeatInput({ seat_count: "ten" })).toBe("seat_count must be a positive integer");
  });

  it("returns error when seat_count is zero", () => {
    expect(validateSeatInput({ seat_count: 0 })).toBe("seat_count must be a positive integer");
  });

  it("returns error when seat_count is negative", () => {
    expect(validateSeatInput({ seat_count: -5 })).toBe("seat_count must be a positive integer");
  });

  it("returns error when seat_count is not an integer", () => {
    expect(validateSeatInput({ seat_count: 5.5 })).toBe("seat_count must be a positive integer");
  });

  it("returns error when seat_count is below minimum (1)", () => {
    // Minimum is 1 seat (the admin). Cannot set to 0.
    expect(validateSeatInput({ seat_count: 0 })).toBe("seat_count must be a positive integer");
  });

  it("returns null for seat_count of 1 (minimum)", () => {
    expect(validateSeatInput({ seat_count: 1 })).toBeNull();
  });

  it("returns null for large seat_count", () => {
    expect(validateSeatInput({ seat_count: 1000 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkSeatLimit (D1 lookup)
// ---------------------------------------------------------------------------

describe("Enterprise billing: checkSeatLimit", () => {
  it("allows adding member when under seat limit", async () => {
    const db = createMockD1({ memberCount: 3, seatLimit: 5 });
    const result = await checkSeatLimit("org_test_01", db);
    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(3);
    expect(result.seatLimit).toBe(5);
  });

  it("blocks adding member when at seat limit", async () => {
    const db = createMockD1({ memberCount: 5, seatLimit: 5 });
    const result = await checkSeatLimit("org_test_01", db);
    expect(result.allowed).toBe(false);
    expect(result.currentCount).toBe(5);
    expect(result.seatLimit).toBe(5);
  });

  it("blocks adding member when over seat limit", async () => {
    const db = createMockD1({ memberCount: 6, seatLimit: 5 });
    const result = await checkSeatLimit("org_test_01", db);
    expect(result.allowed).toBe(false);
    expect(result.currentCount).toBe(6);
    expect(result.seatLimit).toBe(5);
  });

  it("allows adding member when at limit minus one", async () => {
    const db = createMockD1({ memberCount: 4, seatLimit: 5 });
    const result = await checkSeatLimit("org_test_01", db);
    expect(result.allowed).toBe(true);
  });

  it("returns orgNotFound when org does not exist", async () => {
    const db = createMockD1({ orgExists: false });
    const result = await checkSeatLimit("org_nonexistent", db);
    expect(result.allowed).toBe(false);
    expect(result.orgNotFound).toBe(true);
  });

  it("uses default seat limit when org has null seat_limit", async () => {
    const db = createMockD1({ memberCount: 0, seatLimit: 0 });
    // When seat_limit is 0/null, we use DEFAULT_INCLUDED_SEATS
    const result = await checkSeatLimit("org_test_01", db);
    // With 0 members and 0 seat_limit (using default of 5), should be allowed
    expect(result.seatLimit).toBe(DEFAULT_INCLUDED_SEATS);
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// seatLimitResponse (SEAT_LIMIT error format)
// ---------------------------------------------------------------------------

describe("Enterprise billing: seatLimitResponse", () => {
  it("returns 403 with SEAT_LIMIT error code", async () => {
    const response = seatLimitResponse(5, 5);
    expect(response.status).toBe(403);

    const body = (await response.json()) as {
      ok: boolean;
      error: string;
      error_code: string;
      current_seats: number;
      seat_limit: number;
      upgrade_url: string;
      meta: { request_id: string; timestamp: string };
    };

    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("SEAT_LIMIT");
    expect(body.error).toContain("Seat limit reached");
    expect(body.current_seats).toBe(5);
    expect(body.seat_limit).toBe(5);
    expect(body.upgrade_url).toContain("seats");
    expect(body.meta.request_id).toMatch(/^req_/);
    expect(body.meta.timestamp).toBeTruthy();
  });

  it("includes upgrade prompt with billing URL", async () => {
    const response = seatLimitResponse(10, 10);
    const body = (await response.json()) as {
      error: string;
      upgrade_url: string;
    };
    expect(body.error).toContain("add more seats");
    expect(body.upgrade_url).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// buildStripeQuantityUpdateBody (Stripe API helper)
// ---------------------------------------------------------------------------

describe("Enterprise billing: buildStripeQuantityUpdateBody", () => {
  it("builds correct form-encoded body for Stripe subscription update", () => {
    const body = buildStripeQuantityUpdateBody("si_test_item_id", 10);
    // URLSearchParams encodes brackets as %5B/%5D -- Stripe accepts both forms
    const decoded = decodeURIComponent(body);
    expect(decoded).toContain("items[0][id]=si_test_item_id");
    expect(decoded).toContain("items[0][quantity]=10");
  });

  it("encodes quantity as integer string", () => {
    const body = buildStripeQuantityUpdateBody("si_item_1", 25);
    const decoded = decodeURIComponent(body);
    expect(decoded).toContain("items[0][quantity]=25");
  });
});

// ---------------------------------------------------------------------------
// handleSeatQuantityUpdated (webhook handler for seat events)
// ---------------------------------------------------------------------------

describe("Enterprise billing: handleSeatQuantityUpdated", () => {
  it("updates org seat_limit when subscription quantity changes", async () => {
    const db = createMockD1({
      orgExists: true,
      stripeSubscriptionId: "sub_ent_123",
    });

    const result = await handleSeatQuantityUpdated(db, {
      stripe_subscription_id: "sub_ent_123",
      new_quantity: 15,
      org_id: "org_test_01",
    });

    expect(result.success).toBe(true);

    // Verify UPDATE query was issued for seat_limit
    const queries = (db as unknown as { _getQueries(): string[] })._getQueries();
    const updateQueries = queries.filter(q =>
      q.includes("UPDATE") && q.includes("seat_limit"),
    );
    expect(updateQueries.length).toBeGreaterThan(0);
  });

  it("returns error when org not found", async () => {
    const db = createMockD1({ orgExists: false });

    const result = await handleSeatQuantityUpdated(db, {
      stripe_subscription_id: "sub_nonexistent",
      new_quantity: 10,
      org_id: "org_nonexistent",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });
});
