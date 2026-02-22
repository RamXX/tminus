/**
 * Unit tests for RelationshipMixin.
 *
 * Verifies standalone instantiation with a mock SqlStorageLike.
 * These are unit tests -- mocks are acceptable here.
 */

import { describe, it, expect, vi } from "vitest";
import type { SqlStorageLike, SqlStorageCursorLike } from "@tminus/shared";
import { RelationshipMixin } from "./relationship-mixin";

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

describe("RelationshipMixin", () => {
  describe("instantiation", () => {
    it("can be constructed with SqlStorageLike and ensureMigrated callback", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();

      const mixin = new RelationshipMixin(sql, ensureMigrated);
      expect(mixin).toBeDefined();
      expect(mixin).toBeInstanceOf(RelationshipMixin);
    });

    it("exposes all 25 relationship methods", () => {
      const sql = createMockSql();
      const mixin = new RelationshipMixin(sql, vi.fn());

      // Relationship CRUD (5)
      expect(typeof mixin.createRelationship).toBe("function");
      expect(typeof mixin.getRelationship).toBe("function");
      expect(typeof mixin.listRelationships).toBe("function");
      expect(typeof mixin.updateRelationship).toBe("function");
      expect(typeof mixin.deleteRelationship).toBe("function");

      // Interaction ledger (3)
      expect(typeof mixin.markOutcome).toBe("function");
      expect(typeof mixin.listOutcomes).toBe("function");
      expect(typeof mixin.getTimeline).toBe("function");

      // Reputation (3)
      expect(typeof mixin.getReputation).toBe("function");
      expect(typeof mixin.listRelationshipsWithReputation).toBe("function");
      expect(typeof mixin.getDriftReport).toBe("function");

      // Reconnection (1)
      expect(typeof mixin.getReconnectionSuggestions).toBe("function");

      // Milestones (5)
      expect(typeof mixin.createMilestone).toBe("function");
      expect(typeof mixin.listMilestones).toBe("function");
      expect(typeof mixin.deleteMilestone).toBe("function");
      expect(typeof mixin.listUpcomingMilestones).toBe("function");
      expect(typeof mixin.getAllMilestones).toBe("function");

      // Interaction detection (1)
      expect(typeof mixin.updateInteractions).toBe("function");

      // Event participants (2)
      expect(typeof mixin.storeEventParticipants).toBe("function");
      expect(typeof mixin.getEventParticipantHashes).toBe("function");

      // Scheduling history (2)
      expect(typeof mixin.recordSchedulingHistory).toBe("function");
      expect(typeof mixin.getSchedulingHistory).toBe("function");

      // Briefing (1)
      expect(typeof mixin.getEventBriefing).toBe("function");

      // Drift alerts (2)
      expect(typeof mixin.storeDriftAlerts).toBe("function");
      expect(typeof mixin.getDriftAlerts).toBe("function");

      // Bulk deletion (1)
      expect(typeof mixin.deleteAll).toBe("function");
    });
  });

  describe("ensureMigrated callback", () => {
    it("calls ensureMigrated before listRelationships", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();
      const mixin = new RelationshipMixin(sql, ensureMigrated);

      mixin.listRelationships();
      expect(ensureMigrated).toHaveBeenCalledTimes(1);
    });

    it("calls ensureMigrated before getDriftAlerts", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();
      const mixin = new RelationshipMixin(sql, ensureMigrated);

      mixin.getDriftAlerts();
      expect(ensureMigrated).toHaveBeenCalledTimes(1);
    });

    it("calls ensureMigrated before updateInteractions with empty array", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();
      const mixin = new RelationshipMixin(sql, ensureMigrated);

      // updateInteractions with empty array should still call ensureMigrated
      mixin.updateInteractions([], "2026-01-01T00:00:00Z");
      expect(ensureMigrated).toHaveBeenCalledTimes(1);
    });

    it("calls ensureMigrated before storeEventParticipants", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();
      const mixin = new RelationshipMixin(sql, ensureMigrated);

      mixin.storeEventParticipants("evt_test", []);
      expect(ensureMigrated).toHaveBeenCalledTimes(1);
    });

    it("calls ensureMigrated before getSchedulingHistory with empty array", () => {
      const sql = createMockSql();
      const ensureMigrated = vi.fn();
      const mixin = new RelationshipMixin(sql, ensureMigrated);

      mixin.getSchedulingHistory([]);
      expect(ensureMigrated).toHaveBeenCalledTimes(1);
    });
  });
});
