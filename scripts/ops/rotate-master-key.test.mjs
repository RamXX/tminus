/**
 * Unit tests for master key rotation script.
 *
 * Tests the orchestration logic (validation, idempotency, error handling)
 * without requiring Cloudflare API access.
 */

import { describe, it, expect, vi } from "vitest";
import {
  validateMasterKey,
  generateRotationId,
  rotateAllAccounts,
} from "./rotate-master-key.mjs";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const VALID_OLD_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const VALID_NEW_KEY =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

const TEST_ACCOUNTS = [
  { account_id: "acct_001" },
  { account_id: "acct_002" },
  { account_id: "acct_003" },
];

// ---------------------------------------------------------------------------
// validateMasterKey
// ---------------------------------------------------------------------------

describe("validateMasterKey", () => {
  it("accepts a valid 64-char hex key", () => {
    expect(() => validateMasterKey(VALID_OLD_KEY, "TEST_KEY")).not.toThrow();
  });

  it("rejects null/undefined", () => {
    expect(() => validateMasterKey(null, "TEST_KEY")).toThrow(/required/);
    expect(() => validateMasterKey(undefined, "TEST_KEY")).toThrow(/required/);
  });

  it("rejects non-string", () => {
    expect(() => validateMasterKey(12345, "TEST_KEY")).toThrow(/must be a string/);
  });

  it("rejects short key", () => {
    expect(() => validateMasterKey("0123456789abcdef", "TEST_KEY")).toThrow(
      /must be 64 hex characters/,
    );
  });

  it("rejects long key", () => {
    expect(() => validateMasterKey(VALID_OLD_KEY + "aa", "TEST_KEY")).toThrow(
      /must be 64 hex characters/,
    );
  });

  it("rejects non-hex characters", () => {
    const badKey = "zz" + VALID_OLD_KEY.slice(2);
    expect(() => validateMasterKey(badKey, "TEST_KEY")).toThrow(
      /non-hex characters/,
    );
  });
});

// ---------------------------------------------------------------------------
// generateRotationId
// ---------------------------------------------------------------------------

describe("generateRotationId", () => {
  it("generates a string starting with rot_", () => {
    const id = generateRotationId();
    expect(id.startsWith("rot_")).toBe(true);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateRotationId()));
    expect(ids.size).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// rotateAllAccounts
// ---------------------------------------------------------------------------

describe("rotateAllAccounts", () => {
  /**
   * Create mock functions for rotation dependencies.
   * @param {Object} [overrides]
   * @param {Map<string, string>} [overrides.statusMap] - Pre-existing rotation statuses
   * @param {string[]} [overrides.failAccounts] - Account IDs that should fail
   */
  function createMocks(overrides = {}) {
    const { statusMap = new Map(), failAccounts = [] } = overrides;
    const rotationLogs = [];

    return {
      rotateAccountDek: vi.fn(async (accountId) => {
        if (failAccounts.includes(accountId)) {
          throw new Error(`Rotation failed for ${accountId}`);
        }
      }),

      logRotationStatus: vi.fn(async (rotationId, accountId, status, error) => {
        rotationLogs.push({ rotationId, accountId, status, error });
      }),

      checkRotationStatus: vi.fn(async (rotationId, accountId) => {
        return statusMap.get(`${rotationId}:${accountId}`) || null;
      }),

      rotationLogs,
    };
  }

  it("rotates all accounts successfully", async () => {
    const mocks = createMocks();

    const result = await rotateAllAccounts({
      oldMasterKeyHex: VALID_OLD_KEY,
      newMasterKeyHex: VALID_NEW_KEY,
      rotationId: "rot_test_001",
      accounts: TEST_ACCOUNTS,
      ...mocks,
    });

    expect(result.total).toBe(3);
    expect(result.completed).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Verify rotateAccountDek called for each account
    expect(mocks.rotateAccountDek).toHaveBeenCalledTimes(3);
    expect(mocks.rotateAccountDek).toHaveBeenCalledWith("acct_001", VALID_OLD_KEY, VALID_NEW_KEY);
    expect(mocks.rotateAccountDek).toHaveBeenCalledWith("acct_002", VALID_OLD_KEY, VALID_NEW_KEY);
    expect(mocks.rotateAccountDek).toHaveBeenCalledWith("acct_003", VALID_OLD_KEY, VALID_NEW_KEY);
  });

  it("skips already-completed accounts (idempotent) (AC 3)", async () => {
    const statusMap = new Map();
    statusMap.set("rot_test_002:acct_001", "completed");
    statusMap.set("rot_test_002:acct_003", "completed");

    const mocks = createMocks({ statusMap });

    const result = await rotateAllAccounts({
      oldMasterKeyHex: VALID_OLD_KEY,
      newMasterKeyHex: VALID_NEW_KEY,
      rotationId: "rot_test_002",
      accounts: TEST_ACCOUNTS,
      ...mocks,
    });

    expect(result.total).toBe(3);
    expect(result.completed).toBe(1); // Only acct_002
    expect(result.skipped).toBe(2);   // acct_001 and acct_003
    expect(result.failed).toBe(0);

    // Only acct_002 should have been rotated
    expect(mocks.rotateAccountDek).toHaveBeenCalledTimes(1);
    expect(mocks.rotateAccountDek).toHaveBeenCalledWith("acct_002", VALID_OLD_KEY, VALID_NEW_KEY);
  });

  it("handles partial failures gracefully", async () => {
    const mocks = createMocks({ failAccounts: ["acct_002"] });

    const result = await rotateAllAccounts({
      oldMasterKeyHex: VALID_OLD_KEY,
      newMasterKeyHex: VALID_NEW_KEY,
      rotationId: "rot_test_003",
      accounts: TEST_ACCOUNTS,
      ...mocks,
    });

    expect(result.total).toBe(3);
    expect(result.completed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].accountId).toBe("acct_002");
    expect(result.errors[0].error).toContain("Rotation failed");
  });

  it("logs started and completed/failed status for each account (AC 3)", async () => {
    const mocks = createMocks({ failAccounts: ["acct_003"] });

    await rotateAllAccounts({
      oldMasterKeyHex: VALID_OLD_KEY,
      newMasterKeyHex: VALID_NEW_KEY,
      rotationId: "rot_test_004",
      accounts: TEST_ACCOUNTS,
      ...mocks,
    });

    // Should have logged: started+completed for acct_001, started+completed for acct_002,
    // started+failed for acct_003
    expect(mocks.logRotationStatus).toHaveBeenCalledTimes(6);

    // Check specific log entries
    const logs = mocks.rotationLogs;
    expect(logs[0]).toEqual({
      rotationId: "rot_test_004", accountId: "acct_001", status: "started", error: undefined,
    });
    expect(logs[1]).toEqual({
      rotationId: "rot_test_004", accountId: "acct_001", status: "completed", error: undefined,
    });
    expect(logs[4]).toEqual({
      rotationId: "rot_test_004", accountId: "acct_003", status: "started", error: undefined,
    });
    expect(logs[5].status).toBe("failed");
    expect(logs[5].error).toContain("Rotation failed");
  });

  it("dry run mode does not call rotateAccountDek", async () => {
    const mocks = createMocks();

    const result = await rotateAllAccounts({
      oldMasterKeyHex: VALID_OLD_KEY,
      newMasterKeyHex: VALID_NEW_KEY,
      rotationId: "rot_test_005",
      accounts: TEST_ACCOUNTS,
      dryRun: true,
      ...mocks,
    });

    expect(result.total).toBe(3);
    expect(result.completed).toBe(3);
    expect(mocks.rotateAccountDek).not.toHaveBeenCalled();
    expect(mocks.logRotationStatus).not.toHaveBeenCalled();
  });

  it("rejects when old and new keys are the same", async () => {
    const mocks = createMocks();

    await expect(
      rotateAllAccounts({
        oldMasterKeyHex: VALID_OLD_KEY,
        newMasterKeyHex: VALID_OLD_KEY,
        rotationId: "rot_test_006",
        accounts: TEST_ACCOUNTS,
        ...mocks,
      }),
    ).rejects.toThrow(/must be different/);
  });

  it("rejects invalid old master key", async () => {
    const mocks = createMocks();

    await expect(
      rotateAllAccounts({
        oldMasterKeyHex: "too_short",
        newMasterKeyHex: VALID_NEW_KEY,
        rotationId: "rot_test_007",
        accounts: TEST_ACCOUNTS,
        ...mocks,
      }),
    ).rejects.toThrow(/must be 64 hex characters/);
  });

  it("handles empty account list", async () => {
    const mocks = createMocks();

    const result = await rotateAllAccounts({
      oldMasterKeyHex: VALID_OLD_KEY,
      newMasterKeyHex: VALID_NEW_KEY,
      rotationId: "rot_test_008",
      accounts: [],
      ...mocks,
    });

    expect(result.total).toBe(0);
    expect(result.completed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
  });
});
