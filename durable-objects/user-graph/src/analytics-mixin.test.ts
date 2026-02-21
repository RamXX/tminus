/**
 * Unit tests for AnalyticsMixin.
 *
 * Verifies standalone instantiation with a mock SqlStorageLike.
 * These are unit tests -- mocks are acceptable here.
 */

import { describe, it, expect, vi } from "vitest";
import type { SqlStorageLike, SqlStorageCursorLike } from "@tminus/shared";
import { AnalyticsMixin } from "./analytics-mixin";

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

describe("AnalyticsMixin", () => {
  describe("instantiation", () => {
    it("can be constructed with SqlStorageLike and ensureMigrated callback", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();

      const mixin = new AnalyticsMixin(sql, ensureMigrated);
      expect(mixin).toBeDefined();
      expect(mixin).toBeInstanceOf(AnalyticsMixin);
    });

    it("exposes all 7 analytics methods", () => {
      const sql = createMockSql();
      const mixin = new AnalyticsMixin(sql, vi.fn());

      expect(typeof mixin.computeAvailability).toBe("function");
      expect(typeof mixin.getCognitiveLoad).toBe("function");
      expect(typeof mixin.getContextSwitches).toBe("function");
      expect(typeof mixin.getDeepWork).toBe("function");
      expect(typeof mixin.getRiskScores).toBe("function");
      expect(typeof mixin.getProbabilisticAvailability).toBe("function");
      expect(typeof mixin.buildSimulationSnapshot).toBe("function");
    });
  });

  describe("ensureMigrated callback", () => {
    it("calls ensureMigrated before computeAvailability", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();
      const mixin = new AnalyticsMixin(sql, ensureMigrated);

      mixin.computeAvailability({
        start: "2026-01-01T00:00:00Z",
        end: "2026-01-02T00:00:00Z",
      });
      expect(ensureMigrated).toHaveBeenCalled();
    });

    it("calls ensureMigrated before getCognitiveLoad", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();
      const mixin = new AnalyticsMixin(sql, ensureMigrated);

      mixin.getCognitiveLoad("2026-01-01", "day");
      expect(ensureMigrated).toHaveBeenCalled();
    });

    it("calls ensureMigrated before getContextSwitches", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();
      const mixin = new AnalyticsMixin(sql, ensureMigrated);

      mixin.getContextSwitches("2026-01-01", "day");
      expect(ensureMigrated).toHaveBeenCalled();
    });

    it("calls ensureMigrated before getRiskScores", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();
      const mixin = new AnalyticsMixin(sql, ensureMigrated);

      mixin.getRiskScores(4);
      expect(ensureMigrated).toHaveBeenCalled();
    });

    it("calls ensureMigrated before buildSimulationSnapshot", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();
      const mixin = new AnalyticsMixin(sql, ensureMigrated);

      mixin.buildSimulationSnapshot();
      // buildSimulationSnapshot calls ensureMigrated directly and also
      // invokes listConstraints/listCommitments which each call it too
      expect(ensureMigrated).toHaveBeenCalled();
    });
  });
});
