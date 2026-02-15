/**
 * Unit tests for DEK backup script.
 *
 * Tests backup manifest creation, validation, and key generation.
 */

import { describe, it, expect } from "vitest";
import {
  createBackupManifest,
  validateBackupManifest,
  generateBackupKey,
} from "./backup-deks.mjs";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const VALID_ENTRIES = [
  {
    accountId: "acct_001",
    encryptedDek: "base64_encrypted_dek_1",
    dekIv: "base64_iv_1",
    backedUpAt: "2026-02-14T12:00:00Z",
  },
  {
    accountId: "acct_002",
    encryptedDek: "base64_encrypted_dek_2",
    dekIv: "base64_iv_2",
    backedUpAt: "2026-02-14T12:00:00Z",
  },
];

// ---------------------------------------------------------------------------
// createBackupManifest
// ---------------------------------------------------------------------------

describe("createBackupManifest", () => {
  it("creates a valid manifest with version 1", () => {
    const manifest = createBackupManifest(VALID_ENTRIES);

    expect(manifest.version).toBe(1);
    expect(manifest.createdAt).toBeDefined();
    expect(new Date(manifest.createdAt).getTime()).toBeGreaterThan(0);
    expect(manifest.rotationId).toBeNull();
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entries[0].accountId).toBe("acct_001");
  });

  it("includes rotationId when provided", () => {
    const manifest = createBackupManifest(VALID_ENTRIES, "rot_abc123");

    expect(manifest.rotationId).toBe("rot_abc123");
  });

  it("creates manifest with empty entries", () => {
    const manifest = createBackupManifest([]);

    expect(manifest.entries).toHaveLength(0);
  });

  it("manifest can be serialized to JSON and back (R2 round-trip)", () => {
    const manifest = createBackupManifest(VALID_ENTRIES, "rot_test");
    const json = JSON.stringify(manifest);
    const parsed = JSON.parse(json);

    expect(parsed.version).toBe(1);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.rotationId).toBe("rot_test");
  });
});

// ---------------------------------------------------------------------------
// validateBackupManifest
// ---------------------------------------------------------------------------

describe("validateBackupManifest", () => {
  it("accepts a valid manifest", () => {
    const manifest = createBackupManifest(VALID_ENTRIES);
    const result = validateBackupManifest(manifest);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("rejects null", () => {
    const result = validateBackupManifest(null);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("must be an object");
  });

  it("rejects non-object", () => {
    const result = validateBackupManifest("not an object");
    expect(result.valid).toBe(false);
  });

  it("rejects wrong version", () => {
    const result = validateBackupManifest({ version: 2, createdAt: "x", entries: [] });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unsupported backup version");
  });

  it("rejects missing createdAt", () => {
    const result = validateBackupManifest({ version: 1, entries: [] });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("createdAt");
  });

  it("rejects non-array entries", () => {
    const result = validateBackupManifest({
      version: 1,
      createdAt: "2026-02-14T12:00:00Z",
      entries: "not-array",
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("entries must be an array");
  });

  it("rejects entry missing accountId", () => {
    const result = validateBackupManifest({
      version: 1,
      createdAt: "2026-02-14T12:00:00Z",
      entries: [{ encryptedDek: "x", dekIv: "y" }],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Entry 0 missing required fields");
  });

  it("rejects entry missing encryptedDek", () => {
    const result = validateBackupManifest({
      version: 1,
      createdAt: "2026-02-14T12:00:00Z",
      entries: [{ accountId: "acct_1", dekIv: "y" }],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Entry 0 missing required fields");
  });

  it("rejects entry missing dekIv", () => {
    const result = validateBackupManifest({
      version: 1,
      createdAt: "2026-02-14T12:00:00Z",
      entries: [{ accountId: "acct_1", encryptedDek: "x" }],
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Entry 0 missing required fields");
  });

  it("accepts manifest after JSON round-trip", () => {
    const manifest = createBackupManifest(VALID_ENTRIES);
    const parsed = JSON.parse(JSON.stringify(manifest));
    const result = validateBackupManifest(parsed);

    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// generateBackupKey
// ---------------------------------------------------------------------------

describe("generateBackupKey", () => {
  it("generates key in expected format", () => {
    const key = generateBackupKey(new Date("2026-02-14T15:30:00Z"));
    expect(key.startsWith("dek-backups/2026-02-14/")).toBe(true);
    expect(key.endsWith(".json")).toBe(true);
  });

  it("generates different keys for different timestamps", () => {
    const key1 = generateBackupKey(new Date("2026-02-14T15:30:00.000Z"));
    const key2 = generateBackupKey(new Date("2026-02-14T15:30:01.000Z"));
    expect(key1).not.toBe(key2);
  });

  it("uses current date when no argument provided", () => {
    const key = generateBackupKey();
    const today = new Date().toISOString().slice(0, 10);
    expect(key.startsWith(`dek-backups/${today}/`)).toBe(true);
  });
});
