/**
 * Unit tests for DEK restore script.
 *
 * Tests restore orchestration logic.
 */

import { describe, it, expect, vi } from "vitest";
import { restoreAllDeks } from "./restore-deks.mjs";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const VALID_MANIFEST = {
  version: 1,
  createdAt: "2026-02-14T12:00:00Z",
  rotationId: null,
  entries: [
    {
      accountId: "acct_001",
      encryptedDek: "base64_dek_1",
      dekIv: "base64_iv_1",
      backedUpAt: "2026-02-14T12:00:00Z",
    },
    {
      accountId: "acct_002",
      encryptedDek: "base64_dek_2",
      dekIv: "base64_iv_2",
      backedUpAt: "2026-02-14T12:00:00Z",
    },
    {
      accountId: "acct_003",
      encryptedDek: "base64_dek_3",
      dekIv: "base64_iv_3",
      backedUpAt: "2026-02-14T12:00:00Z",
    },
  ],
};

// ---------------------------------------------------------------------------
// restoreAllDeks
// ---------------------------------------------------------------------------

describe("restoreAllDeks", () => {
  it("restores all accounts successfully", async () => {
    const restoreAccountDek = vi.fn(async () => {});

    const result = await restoreAllDeks({
      manifest: VALID_MANIFEST,
      restoreAccountDek,
    });

    expect(result.total).toBe(3);
    expect(result.restored).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(0);

    expect(restoreAccountDek).toHaveBeenCalledTimes(3);
    expect(restoreAccountDek).toHaveBeenCalledWith("acct_001", VALID_MANIFEST.entries[0]);
    expect(restoreAccountDek).toHaveBeenCalledWith("acct_002", VALID_MANIFEST.entries[1]);
    expect(restoreAccountDek).toHaveBeenCalledWith("acct_003", VALID_MANIFEST.entries[2]);
  });

  it("handles partial failures gracefully", async () => {
    const restoreAccountDek = vi.fn(async (accountId) => {
      if (accountId === "acct_002") {
        throw new Error("Restore failed for acct_002");
      }
    });

    const result = await restoreAllDeks({
      manifest: VALID_MANIFEST,
      restoreAccountDek,
    });

    expect(result.total).toBe(3);
    expect(result.restored).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].accountId).toBe("acct_002");
    expect(result.errors[0].error).toContain("Restore failed");
  });

  it("dry run does not call restoreAccountDek", async () => {
    const restoreAccountDek = vi.fn(async () => {});

    const result = await restoreAllDeks({
      manifest: VALID_MANIFEST,
      restoreAccountDek,
      dryRun: true,
    });

    expect(result.total).toBe(3);
    expect(result.restored).toBe(3);
    expect(result.failed).toBe(0);
    expect(restoreAccountDek).not.toHaveBeenCalled();
  });

  it("rejects invalid manifest", async () => {
    const restoreAccountDek = vi.fn(async () => {});

    await expect(
      restoreAllDeks({
        manifest: { version: 99 },
        restoreAccountDek,
      }),
    ).rejects.toThrow(/Invalid backup manifest/);
  });

  it("handles empty manifest", async () => {
    const restoreAccountDek = vi.fn(async () => {});

    const result = await restoreAllDeks({
      manifest: {
        version: 1,
        createdAt: "2026-02-14T12:00:00Z",
        rotationId: null,
        entries: [],
      },
      restoreAccountDek,
    });

    expect(result.total).toBe(0);
    expect(result.restored).toBe(0);
    expect(result.failed).toBe(0);
    expect(restoreAccountDek).not.toHaveBeenCalled();
  });

  it("handles all accounts failing", async () => {
    const restoreAccountDek = vi.fn(async () => {
      throw new Error("System error");
    });

    const result = await restoreAllDeks({
      manifest: VALID_MANIFEST,
      restoreAccountDek,
    });

    expect(result.total).toBe(3);
    expect(result.restored).toBe(0);
    expect(result.failed).toBe(3);
    expect(result.errors).toHaveLength(3);
  });
});
