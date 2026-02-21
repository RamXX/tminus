/**
 * Unit tests for ConstraintMixin.
 *
 * Verifies standalone instantiation with a mock SqlStorageLike and
 * mock ConstraintDeps. These are unit tests -- mocks are acceptable here.
 */

import { describe, it, expect, vi } from "vitest";
import type { SqlStorageLike, SqlStorageCursorLike } from "@tminus/shared";
import { ConstraintMixin } from "./constraint-mixin";
import type { ConstraintDeps } from "./constraint-mixin";

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
// Mock ConstraintDeps
// ---------------------------------------------------------------------------

function createMockDeps(): ConstraintDeps {
  return {
    writeJournal: vi.fn(),
    enqueueDeleteMirror: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConstraintMixin", () => {
  describe("instantiation", () => {
    it("can be constructed with SqlStorageLike, ensureMigrated callback, and deps", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();
      const deps = createMockDeps();

      const mixin = new ConstraintMixin(sql, ensureMigrated, deps);
      expect(mixin).toBeDefined();
      expect(mixin).toBeInstanceOf(ConstraintMixin);
    });

    it("exposes all 5 public constraint CRUD methods", () => {
      const sql = createMockSql();
      const mixin = new ConstraintMixin(sql, vi.fn(), createMockDeps());

      expect(typeof mixin.addConstraint).toBe("function");
      expect(typeof mixin.deleteConstraint).toBe("function");
      expect(typeof mixin.updateConstraint).toBe("function");
      expect(typeof mixin.listConstraints).toBe("function");
      expect(typeof mixin.getConstraint).toBe("function");
    });
  });

  describe("VALID_CONSTRAINT_KINDS", () => {
    it("contains exactly 5 constraint kinds", () => {
      expect(ConstraintMixin.VALID_CONSTRAINT_KINDS.size).toBe(5);
      expect(ConstraintMixin.VALID_CONSTRAINT_KINDS.has("trip")).toBe(true);
      expect(ConstraintMixin.VALID_CONSTRAINT_KINDS.has("working_hours")).toBe(true);
      expect(ConstraintMixin.VALID_CONSTRAINT_KINDS.has("buffer")).toBe(true);
      expect(ConstraintMixin.VALID_CONSTRAINT_KINDS.has("no_meetings_after")).toBe(true);
      expect(ConstraintMixin.VALID_CONSTRAINT_KINDS.has("override")).toBe(true);
    });

    it("rejects unknown kinds", () => {
      expect(ConstraintMixin.VALID_CONSTRAINT_KINDS.has("invalid")).toBe(false);
    });
  });

  describe("ensureMigrated callback", () => {
    it("calls ensureMigrated before listConstraints", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();
      const mixin = new ConstraintMixin(sql, ensureMigrated, createMockDeps());

      mixin.listConstraints();
      expect(ensureMigrated).toHaveBeenCalled();
    });

    it("calls ensureMigrated before getConstraint", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();
      const mixin = new ConstraintMixin(sql, ensureMigrated, createMockDeps());

      mixin.getConstraint("constraint_123");
      expect(ensureMigrated).toHaveBeenCalled();
    });

    it("calls ensureMigrated before addConstraint", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();
      const mixin = new ConstraintMixin(sql, ensureMigrated, createMockDeps());

      // addConstraint will throw due to invalid kind with empty mock,
      // but ensureMigrated should still be called first
      expect(() =>
        mixin.addConstraint("invalid_kind", {}, null, null),
      ).toThrow();
      expect(ensureMigrated).toHaveBeenCalled();
    });

    it("calls ensureMigrated before deleteConstraint", async () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();
      const mixin = new ConstraintMixin(sql, ensureMigrated, createMockDeps());

      const result = await mixin.deleteConstraint("constraint_123");
      expect(result).toBe(false); // not found in mock
      expect(ensureMigrated).toHaveBeenCalled();
    });

    it("calls ensureMigrated before updateConstraint", async () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();
      const mixin = new ConstraintMixin(sql, ensureMigrated, createMockDeps());

      const result = await mixin.updateConstraint("constraint_123", {}, null, null);
      expect(result).toBeNull(); // not found in mock
      expect(ensureMigrated).toHaveBeenCalled();
    });
  });

  describe("static validators", () => {
    describe("validateWorkingHoursConfig", () => {
      it("accepts valid working hours config", () => {
        expect(() =>
          ConstraintMixin.validateWorkingHoursConfig({
            days: [1, 2, 3, 4, 5],
            start_time: "09:00",
            end_time: "17:00",
            timezone: "America/New_York",
          }),
        ).not.toThrow();
      });

      it("rejects empty days array", () => {
        expect(() =>
          ConstraintMixin.validateWorkingHoursConfig({
            days: [],
            start_time: "09:00",
            end_time: "17:00",
            timezone: "America/New_York",
          }),
        ).toThrow("non-empty 'days' array");
      });

      it("rejects invalid day values", () => {
        expect(() =>
          ConstraintMixin.validateWorkingHoursConfig({
            days: [1, 7],
            start_time: "09:00",
            end_time: "17:00",
            timezone: "America/New_York",
          }),
        ).toThrow("integers 0-6");
      });

      it("rejects duplicate days", () => {
        expect(() =>
          ConstraintMixin.validateWorkingHoursConfig({
            days: [1, 1, 2],
            start_time: "09:00",
            end_time: "17:00",
            timezone: "America/New_York",
          }),
        ).toThrow("duplicates");
      });

      it("rejects end_time before start_time", () => {
        expect(() =>
          ConstraintMixin.validateWorkingHoursConfig({
            days: [1],
            start_time: "17:00",
            end_time: "09:00",
            timezone: "America/New_York",
          }),
        ).toThrow("end_time must be after start_time");
      });
    });

    describe("validateBufferConfig", () => {
      it("accepts valid buffer config", () => {
        expect(() =>
          ConstraintMixin.validateBufferConfig({
            type: "travel",
            minutes: 15,
            applies_to: "all",
          }),
        ).not.toThrow();
      });

      it("rejects invalid type", () => {
        expect(() =>
          ConstraintMixin.validateBufferConfig({
            type: "invalid",
            minutes: 15,
            applies_to: "all",
          }),
        ).toThrow("must be one of");
      });

      it("rejects zero minutes", () => {
        expect(() =>
          ConstraintMixin.validateBufferConfig({
            type: "travel",
            minutes: 0,
            applies_to: "all",
          }),
        ).toThrow("positive integer");
      });
    });

    describe("validateNoMeetingsAfterConfig", () => {
      it("accepts valid no_meetings_after config", () => {
        expect(() =>
          ConstraintMixin.validateNoMeetingsAfterConfig({
            time: "18:00",
            timezone: "America/New_York",
          }),
        ).not.toThrow();
      });

      it("rejects invalid time format", () => {
        expect(() =>
          ConstraintMixin.validateNoMeetingsAfterConfig({
            time: "25:00",
            timezone: "America/New_York",
          }),
        ).toThrow("HH:MM 24-hour format");
      });
    });

    describe("validateOverrideConfig", () => {
      it("accepts valid override config", () => {
        expect(() =>
          ConstraintMixin.validateOverrideConfig({
            reason: "Holiday exception",
          }),
        ).not.toThrow();
      });

      it("rejects empty reason", () => {
        expect(() =>
          ConstraintMixin.validateOverrideConfig({
            reason: "",
          }),
        ).toThrow("non-empty 'reason'");
      });

      it("rejects slot_start after slot_end", () => {
        expect(() =>
          ConstraintMixin.validateOverrideConfig({
            reason: "test",
            slot_start: "2026-02-20T18:00:00Z",
            slot_end: "2026-02-20T09:00:00Z",
          }),
        ).toThrow("slot_start must be before slot_end");
      });
    });

    describe("validateConstraintConfig", () => {
      it("validates trip constraints require name, timezone, block_policy, and dates", () => {
        expect(() =>
          ConstraintMixin.validateConstraintConfig(
            "trip",
            { name: "Paris", timezone: "Europe/Paris", block_policy: "BUSY" },
            "2026-03-01T00:00:00Z",
            "2026-03-08T00:00:00Z",
          ),
        ).not.toThrow();
      });

      it("rejects trip without active_from/active_to", () => {
        expect(() =>
          ConstraintMixin.validateConstraintConfig(
            "trip",
            { name: "Paris", timezone: "Europe/Paris", block_policy: "BUSY" },
            null,
            null,
          ),
        ).toThrow("active_from and active_to");
      });

      it("rejects trip with invalid block_policy", () => {
        expect(() =>
          ConstraintMixin.validateConstraintConfig(
            "trip",
            { name: "Paris", timezone: "Europe/Paris", block_policy: "INVALID" },
            "2026-03-01T00:00:00Z",
            "2026-03-08T00:00:00Z",
          ),
        ).toThrow("block_policy must be one of");
      });
    });
  });

  describe("addConstraint kind validation", () => {
    it("rejects invalid constraint kinds", () => {
      const sql = createMockSql();
      const mixin = new ConstraintMixin(sql, vi.fn(), createMockDeps());

      expect(() =>
        mixin.addConstraint("unknown_kind", {}, null, null),
      ).toThrow('Invalid constraint kind "unknown_kind"');
    });
  });
});
