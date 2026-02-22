/**
 * Unit tests for GovernanceMixin.
 *
 * Verifies standalone instantiation with a mock SqlStorageLike.
 * These are unit tests -- mocks are acceptable here.
 */

import { describe, it, expect, vi } from "vitest";
import type { SqlStorageLike, SqlStorageCursorLike } from "@tminus/shared";
import { GovernanceMixin } from "./governance-mixin";

// ---------------------------------------------------------------------------
// Mock SqlStorageLike
// ---------------------------------------------------------------------------

function createMockSql(): SqlStorageLike {
  return {
    exec<T extends Record<string, unknown>>(
      _query: string,
      ..._bindings: unknown[]
    ): SqlStorageCursorLike<T> {
      return {
        toArray(): T[] {
          return [];
        },
        one(): T {
          throw new Error("No rows");
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GovernanceMixin", () => {
  describe("instantiation", () => {
    it("can be constructed with SqlStorageLike and ensureMigrated callback", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();

      const mixin = new GovernanceMixin(sql, ensureMigrated);
      expect(mixin).toBeDefined();
      expect(mixin).toBeInstanceOf(GovernanceMixin);
    });

    it("exposes all 16 governance methods", () => {
      const sql = createMockSql();
      const mixin = new GovernanceMixin(sql, vi.fn());

      // Allocation methods (5)
      expect(typeof mixin.createAllocation).toBe("function");
      expect(typeof mixin.getAllocation).toBe("function");
      expect(typeof mixin.updateAllocation).toBe("function");
      expect(typeof mixin.deleteAllocation).toBe("function");
      expect(typeof mixin.listAllocations).toBe("function");

      // VIP policy methods (4)
      expect(typeof mixin.createVipPolicy).toBe("function");
      expect(typeof mixin.listVipPolicies).toBe("function");
      expect(typeof mixin.getVipPolicy).toBe("function");
      expect(typeof mixin.deleteVipPolicy).toBe("function");

      // Commitment methods (6)
      expect(typeof mixin.createCommitment).toBe("function");
      expect(typeof mixin.getCommitment).toBe("function");
      expect(typeof mixin.listCommitments).toBe("function");
      expect(typeof mixin.deleteCommitment).toBe("function");
      expect(typeof mixin.getCommitmentStatus).toBe("function");
      expect(typeof mixin.getCommitmentProofData).toBe("function");

      // Helper (1)
      expect(typeof mixin.getEventClientId).toBe("function");

      // Bulk deletion (1)
      expect(typeof mixin.deleteAll).toBe("function");
    });
  });

  describe("ensureMigrated callback", () => {
    it("calls ensureMigrated before listAllocations", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();
      const mixin = new GovernanceMixin(sql, ensureMigrated);

      mixin.listAllocations();
      expect(ensureMigrated).toHaveBeenCalledTimes(1);
    });

    it("calls ensureMigrated before listVipPolicies", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();
      const mixin = new GovernanceMixin(sql, ensureMigrated);

      mixin.listVipPolicies();
      expect(ensureMigrated).toHaveBeenCalledTimes(1);
    });

    it("calls ensureMigrated before listCommitments", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();
      const mixin = new GovernanceMixin(sql, ensureMigrated);

      mixin.listCommitments();
      expect(ensureMigrated).toHaveBeenCalledTimes(1);
    });

    it("calls ensureMigrated before getAllocation", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();
      const mixin = new GovernanceMixin(sql, ensureMigrated);

      const result = mixin.getAllocation("evt-1");
      expect(ensureMigrated).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    });

    it("calls ensureMigrated before getVipPolicy", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();
      const mixin = new GovernanceMixin(sql, ensureMigrated);

      const result = mixin.getVipPolicy("vip-1");
      expect(ensureMigrated).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    });

    it("calls ensureMigrated before getCommitment", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();
      const mixin = new GovernanceMixin(sql, ensureMigrated);

      const result = mixin.getCommitment("cmt-1");
      expect(ensureMigrated).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    });
  });
});
