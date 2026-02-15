/**
 * Unit tests for the policy management library.
 *
 * Tests cover:
 * - buildMatrixCells: correct grid generation from accounts + edges
 * - nextDetailLevel: cycling BUSY -> TITLE -> FULL -> BUSY
 * - findCell: lookup by from/to account IDs
 * - Default BUSY highlighting (isDefault flag)
 * - Self-edge exclusion
 */

import { describe, it, expect } from "vitest";
import {
  buildMatrixCells,
  nextDetailLevel,
  findCell,
  DEFAULT_DETAIL_LEVEL,
  DETAIL_LEVELS,
  type PolicyAccount,
  type PolicyEdgeData,
} from "./policies";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const ACCOUNTS: PolicyAccount[] = [
  { account_id: "acc-work", email: "work@example.com" },
  { account_id: "acc-personal", email: "personal@example.com" },
  { account_id: "acc-side", email: "side@example.com" },
];

const TWO_ACCOUNTS: PolicyAccount[] = [
  { account_id: "acc-a", email: "a@example.com" },
  { account_id: "acc-b", email: "b@example.com" },
];

const EDGES: PolicyEdgeData[] = [
  {
    policy_id: "pol-1",
    from_account_id: "acc-work",
    to_account_id: "acc-personal",
    detail_level: "TITLE",
  },
  {
    policy_id: "pol-2",
    from_account_id: "acc-personal",
    to_account_id: "acc-work",
    detail_level: "FULL",
  },
];

// ---------------------------------------------------------------------------
// buildMatrixCells
// ---------------------------------------------------------------------------

describe("buildMatrixCells", () => {
  it("generates correct number of cells (n*(n-1) excluding self-edges)", () => {
    const cells = buildMatrixCells(ACCOUNTS, []);
    // 3 accounts => 3*2 = 6 cells (no self-edges)
    expect(cells.length).toBe(6);
  });

  it("excludes self-edges", () => {
    const cells = buildMatrixCells(ACCOUNTS, []);
    const selfEdges = cells.filter((c) => c.fromAccountId === c.toAccountId);
    expect(selfEdges.length).toBe(0);
  });

  it("uses DEFAULT_DETAIL_LEVEL when no edge exists", () => {
    const cells = buildMatrixCells(ACCOUNTS, []);
    for (const cell of cells) {
      expect(cell.detailLevel).toBe(DEFAULT_DETAIL_LEVEL);
      expect(cell.isDefault).toBe(true);
      expect(cell.policyId).toBeNull();
    }
  });

  it("picks up edge detail_level when edge exists", () => {
    const cells = buildMatrixCells(ACCOUNTS, EDGES);

    const workToPersonal = findCell(cells, "acc-work", "acc-personal");
    expect(workToPersonal).toBeDefined();
    expect(workToPersonal!.detailLevel).toBe("TITLE");
    expect(workToPersonal!.policyId).toBe("pol-1");
    expect(workToPersonal!.isDefault).toBe(false);

    const personalToWork = findCell(cells, "acc-personal", "acc-work");
    expect(personalToWork).toBeDefined();
    expect(personalToWork!.detailLevel).toBe("FULL");
    expect(personalToWork!.policyId).toBe("pol-2");
    expect(personalToWork!.isDefault).toBe(false);
  });

  it("marks cells without edges as isDefault=true", () => {
    const cells = buildMatrixCells(ACCOUNTS, EDGES);

    // work -> side has no edge
    const workToSide = findCell(cells, "acc-work", "acc-side");
    expect(workToSide).toBeDefined();
    expect(workToSide!.isDefault).toBe(true);
    expect(workToSide!.detailLevel).toBe("BUSY");
    expect(workToSide!.policyId).toBeNull();
  });

  it("returns empty array for single account (no cross-edges possible)", () => {
    const cells = buildMatrixCells(
      [{ account_id: "acc-solo", email: "solo@example.com" }],
      [],
    );
    expect(cells.length).toBe(0);
  });

  it("returns empty array for empty accounts list", () => {
    const cells = buildMatrixCells([], []);
    expect(cells.length).toBe(0);
  });

  it("generates cells for two accounts (2 cells)", () => {
    const cells = buildMatrixCells(TWO_ACCOUNTS, []);
    expect(cells.length).toBe(2);
    expect(cells[0].fromAccountId).toBe("acc-a");
    expect(cells[0].toAccountId).toBe("acc-b");
    expect(cells[1].fromAccountId).toBe("acc-b");
    expect(cells[1].toAccountId).toBe("acc-a");
  });
});

// ---------------------------------------------------------------------------
// nextDetailLevel
// ---------------------------------------------------------------------------

describe("nextDetailLevel", () => {
  it("cycles BUSY -> TITLE", () => {
    expect(nextDetailLevel("BUSY")).toBe("TITLE");
  });

  it("cycles TITLE -> FULL", () => {
    expect(nextDetailLevel("TITLE")).toBe("FULL");
  });

  it("cycles FULL -> BUSY (wraps around)", () => {
    expect(nextDetailLevel("FULL")).toBe("BUSY");
  });

  it("cycles through all levels and returns to start", () => {
    let level = DETAIL_LEVELS[0];
    for (let i = 0; i < DETAIL_LEVELS.length; i++) {
      expect(level).toBe(DETAIL_LEVELS[i]);
      level = nextDetailLevel(level);
    }
    expect(level).toBe(DETAIL_LEVELS[0]);
  });
});

// ---------------------------------------------------------------------------
// findCell
// ---------------------------------------------------------------------------

describe("findCell", () => {
  const cells = buildMatrixCells(ACCOUNTS, EDGES);

  it("returns the matching cell for valid from/to pair", () => {
    const cell = findCell(cells, "acc-work", "acc-personal");
    expect(cell).toBeDefined();
    expect(cell!.fromAccountId).toBe("acc-work");
    expect(cell!.toAccountId).toBe("acc-personal");
  });

  it("returns undefined for self-edge (excluded from matrix)", () => {
    const cell = findCell(cells, "acc-work", "acc-work");
    expect(cell).toBeUndefined();
  });

  it("returns undefined for non-existent account pair", () => {
    const cell = findCell(cells, "acc-work", "acc-nonexistent");
    expect(cell).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("DEFAULT_DETAIL_LEVEL is BUSY", () => {
    expect(DEFAULT_DETAIL_LEVEL).toBe("BUSY");
  });

  it("DETAIL_LEVELS contains exactly BUSY, TITLE, FULL", () => {
    expect(DETAIL_LEVELS).toEqual(["BUSY", "TITLE", "FULL"]);
  });
});
