/**
 * Unit tests for SchedulingMixin.
 *
 * Verifies standalone instantiation with a mock SqlStorageLike.
 * These are unit tests -- mocks are acceptable here.
 */

import { describe, it, expect, vi } from "vitest";
import type { SqlStorageLike, SqlStorageCursorLike } from "@tminus/shared";
import { SchedulingMixin } from "./scheduling-mixin";

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

describe("SchedulingMixin", () => {
  describe("instantiation", () => {
    it("can be constructed with SqlStorageLike and ensureMigrated callback", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();

      const mixin = new SchedulingMixin(sql, ensureMigrated);
      expect(mixin).toBeDefined();
      expect(mixin).toBeInstanceOf(SchedulingMixin);
    });

    it("exposes all 14 scheduling methods", () => {
      const sql = createMockSql();
      const mixin = new SchedulingMixin(sql, vi.fn());

      // Session methods (6)
      expect(typeof mixin.storeSchedulingSession).toBe("function");
      expect(typeof mixin.getSchedulingSession).toBe("function");
      expect(typeof mixin.commitSchedulingSession).toBe("function");
      expect(typeof mixin.listSchedulingSessions).toBe("function");
      expect(typeof mixin.cancelSchedulingSession).toBe("function");
      expect(typeof mixin.expireStaleSchedulingSessions).toBe("function");

      // Hold methods (8)
      expect(typeof mixin.storeHolds).toBe("function");
      expect(typeof mixin.getHoldsBySession).toBe("function");
      expect(typeof mixin.updateHoldStatus).toBe("function");
      expect(typeof mixin.getExpiredHolds).toBe("function");
      expect(typeof mixin.commitSessionHolds).toBe("function");
      expect(typeof mixin.releaseSessionHolds).toBe("function");
      expect(typeof mixin.extendHolds).toBe("function");
      expect(typeof mixin.expireSessionIfAllHoldsTerminal).toBe("function");
    });
  });

  describe("ensureMigrated callback", () => {
    it("calls ensureMigrated before storeHolds", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();
      const mixin = new SchedulingMixin(sql, ensureMigrated);

      // storeHolds with empty array should still call ensureMigrated
      mixin.storeHolds([]);
      expect(ensureMigrated).toHaveBeenCalledTimes(1);
    });

    it("calls ensureMigrated before releaseSessionHolds", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();
      const mixin = new SchedulingMixin(sql, ensureMigrated);

      mixin.releaseSessionHolds("session-1");
      expect(ensureMigrated).toHaveBeenCalledTimes(1);
    });
  });
});
