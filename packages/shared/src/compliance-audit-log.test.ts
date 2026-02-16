/**
 * Unit tests for compliance audit log with hash chain (TM-9iu.5).
 *
 * Tests cover:
 * - SHA-256 hashing
 * - Entry canonicalization (deterministic JSON)
 * - Hash chain: entry hash computation
 * - Append entry with hash chain linking
 * - Hash chain verification (positive and negative)
 * - Genesis hash for first entry
 * - Tamper detection (modified entry)
 * - JSON-lines export format
 * - Compliance report generation
 * - Anomaly detection
 * - Valid audit actions
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  sha256,
  canonicalizeEntry,
  computeEntryHash,
  appendAuditEntry,
  verifyHashChain,
  exportAuditLog,
  generateComplianceReport,
  GENESIS_HASH,
  DEFAULT_RETENTION_DAYS,
  COMPLIANCE_RETENTION_DAYS,
  VALID_AUDIT_ACTIONS,
} from "./compliance-audit-log";
import type {
  ComplianceAuditStore,
  ComplianceAuditEntry,
  ComplianceAuditInput,
  ComplianceAuditAction,
} from "./compliance-audit-log";

// ---------------------------------------------------------------------------
// In-memory compliance audit store for unit tests
// ---------------------------------------------------------------------------

function createMockAuditStore(): ComplianceAuditStore & {
  entries: ComplianceAuditEntry[];
} {
  const entries: ComplianceAuditEntry[] = [];

  return {
    entries,

    async getLastEntryHash(orgId: string): Promise<string> {
      const orgEntries = entries.filter((e) => e.orgId === orgId);
      if (orgEntries.length === 0) return GENESIS_HASH;
      return orgEntries[orgEntries.length - 1].entryHash;
    },

    async appendEntry(entry: ComplianceAuditEntry): Promise<void> {
      entries.push(entry);
    },

    async getEntries(
      orgId: string,
      startDate: string,
      endDate: string,
      limit?: number,
      _offset?: number,
    ): Promise<ComplianceAuditEntry[]> {
      const filtered = entries
        .filter(
          (e) =>
            e.orgId === orgId &&
            e.timestamp >= startDate &&
            e.timestamp <= endDate,
        )
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      return limit ? filtered.slice(0, limit) : filtered;
    },

    async getEntryCount(
      orgId: string,
      startDate: string,
      endDate: string,
    ): Promise<number> {
      return entries.filter(
        (e) =>
          e.orgId === orgId &&
          e.timestamp >= startDate &&
          e.timestamp <= endDate,
      ).length;
    },

    async getEntriesForVerification(
      orgId: string,
      limit?: number,
    ): Promise<ComplianceAuditEntry[]> {
      const orgEntries = entries
        .filter((e) => e.orgId === orgId)
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      return limit ? orgEntries.slice(0, limit) : orgEntries;
    },

    async getRetentionConfig() {
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("GENESIS_HASH", () => {
  it("is 64 zeros", () => {
    expect(GENESIS_HASH).toBe(
      "0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(GENESIS_HASH).toHaveLength(64);
  });
});

describe("retention constants", () => {
  it("default is 90 days", () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(90);
  });

  it("compliance is 7 years (2555 days)", () => {
    expect(COMPLIANCE_RETENTION_DAYS).toBe(2555);
  });
});

describe("VALID_AUDIT_ACTIONS", () => {
  it("includes all required actions", () => {
    const required: ComplianceAuditAction[] = [
      "delegation_created",
      "delegation_rotated",
      "user_discovered",
      "user_suspended",
      "user_removed",
      "config_updated",
      "token_issued",
      "admin_action",
    ];
    for (const action of required) {
      expect(VALID_AUDIT_ACTIONS).toContain(action);
    }
  });
});

// ---------------------------------------------------------------------------
// sha256
// ---------------------------------------------------------------------------

describe("sha256", () => {
  it("produces 64-character lowercase hex string", async () => {
    const hash = await sha256("hello");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces deterministic output", async () => {
    const h1 = await sha256("test data");
    const h2 = await sha256("test data");
    expect(h1).toBe(h2);
  });

  it("different inputs produce different hashes", async () => {
    const h1 = await sha256("input A");
    const h2 = await sha256("input B");
    expect(h1).not.toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// canonicalizeEntry
// ---------------------------------------------------------------------------

describe("canonicalizeEntry", () => {
  it("produces deterministic JSON string", () => {
    const input: ComplianceAuditInput = {
      entryId: "entry_1",
      orgId: "org_123",
      timestamp: "2023-11-14T12:00:00Z",
      actor: "admin@example.com",
      action: "delegation_created",
      target: "user@example.com",
      result: "success",
      ipAddress: "1.2.3.4",
      userAgent: "TestAgent/1.0",
      details: null,
    };

    const c1 = canonicalizeEntry(input, GENESIS_HASH);
    const c2 = canonicalizeEntry(input, GENESIS_HASH);
    expect(c1).toBe(c2);
  });

  it("includes previousHash in the canonical form", () => {
    const input: ComplianceAuditInput = {
      entryId: "entry_1",
      orgId: "org_123",
      timestamp: "2023-11-14T12:00:00Z",
      actor: "admin@example.com",
      action: "token_issued",
      target: "user@example.com",
      result: "success",
      ipAddress: "1.2.3.4",
      userAgent: "TestAgent/1.0",
      details: null,
    };

    const canonical = canonicalizeEntry(input, "abc123");
    const parsed = JSON.parse(canonical);
    expect(parsed.previousHash).toBe("abc123");
  });

  it("different previousHash produces different canonical form", () => {
    const input: ComplianceAuditInput = {
      entryId: "entry_1",
      orgId: "org_123",
      timestamp: "2023-11-14T12:00:00Z",
      actor: "admin@example.com",
      action: "delegation_created",
      target: "delegation_abc",
      result: "success",
      ipAddress: "1.2.3.4",
      userAgent: "TestAgent/1.0",
      details: null,
    };

    const c1 = canonicalizeEntry(input, "hash_A");
    const c2 = canonicalizeEntry(input, "hash_B");
    expect(c1).not.toBe(c2);
  });
});

// ---------------------------------------------------------------------------
// computeEntryHash
// ---------------------------------------------------------------------------

describe("computeEntryHash", () => {
  it("produces a valid SHA-256 hash", async () => {
    const input: ComplianceAuditInput = {
      entryId: "entry_1",
      orgId: "org_123",
      timestamp: "2023-11-14T12:00:00Z",
      actor: "admin@example.com",
      action: "delegation_created",
      target: "delegation_abc",
      result: "success",
      ipAddress: "1.2.3.4",
      userAgent: "TestAgent/1.0",
      details: null,
    };

    const hash = await computeEntryHash(input, GENESIS_HASH);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", async () => {
    const input: ComplianceAuditInput = {
      entryId: "entry_1",
      orgId: "org_123",
      timestamp: "2023-11-14T12:00:00Z",
      actor: "admin@example.com",
      action: "token_issued",
      target: "user@example.com",
      result: "success",
      ipAddress: "1.2.3.4",
      userAgent: "TestAgent/1.0",
      details: '{"scopes":"calendar"}',
    };

    const h1 = await computeEntryHash(input, "prev_hash");
    const h2 = await computeEntryHash(input, "prev_hash");
    expect(h1).toBe(h2);
  });

  it("changes with different previous hash", async () => {
    const input: ComplianceAuditInput = {
      entryId: "entry_1",
      orgId: "org_123",
      timestamp: "2023-11-14T12:00:00Z",
      actor: "admin@example.com",
      action: "delegation_created",
      target: "delegation_abc",
      result: "success",
      ipAddress: "1.2.3.4",
      userAgent: "TestAgent/1.0",
      details: null,
    };

    const h1 = await computeEntryHash(input, "hash_A");
    const h2 = await computeEntryHash(input, "hash_B");
    expect(h1).not.toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// appendAuditEntry
// ---------------------------------------------------------------------------

describe("appendAuditEntry", () => {
  let store: ComplianceAuditStore & { entries: ComplianceAuditEntry[] };

  beforeEach(() => {
    store = createMockAuditStore();
  });

  it("creates first entry with genesis previousHash", async () => {
    const input: ComplianceAuditInput = {
      entryId: "entry_1",
      orgId: "org_123",
      timestamp: "2023-11-14T12:00:00Z",
      actor: "admin@example.com",
      action: "delegation_created",
      target: "delegation_abc",
      result: "success",
      ipAddress: "1.2.3.4",
      userAgent: "TestAgent/1.0",
      details: null,
    };

    const entry = await appendAuditEntry(store, input);
    expect(entry.previousHash).toBe(GENESIS_HASH);
    expect(entry.entryHash).toHaveLength(64);
    expect(store.entries).toHaveLength(1);
  });

  it("links second entry to first entry's hash", async () => {
    const input1: ComplianceAuditInput = {
      entryId: "entry_1",
      orgId: "org_123",
      timestamp: "2023-11-14T12:00:00Z",
      actor: "admin@example.com",
      action: "delegation_created",
      target: "delegation_abc",
      result: "success",
      ipAddress: "1.2.3.4",
      userAgent: "TestAgent/1.0",
      details: null,
    };

    const entry1 = await appendAuditEntry(store, input1);

    const input2: ComplianceAuditInput = {
      entryId: "entry_2",
      orgId: "org_123",
      timestamp: "2023-11-14T12:01:00Z",
      actor: "admin@example.com",
      action: "token_issued",
      target: "user@example.com",
      result: "success",
      ipAddress: "1.2.3.4",
      userAgent: "TestAgent/1.0",
      details: null,
    };

    const entry2 = await appendAuditEntry(store, input2);
    expect(entry2.previousHash).toBe(entry1.entryHash);
    expect(entry2.entryHash).not.toBe(entry1.entryHash);
  });

  it("rejects invalid action", async () => {
    const input = {
      entryId: "entry_1",
      orgId: "org_123",
      timestamp: "2023-11-14T12:00:00Z",
      actor: "admin@example.com",
      action: "invalid_action" as ComplianceAuditAction,
      target: "target",
      result: "success" as const,
      ipAddress: "1.2.3.4",
      userAgent: "TestAgent/1.0",
      details: null,
    };

    await expect(appendAuditEntry(store, input)).rejects.toThrow(
      "Invalid audit action",
    );
  });

  it("preserves all input fields in stored entry", async () => {
    const input: ComplianceAuditInput = {
      entryId: "entry_abc",
      orgId: "org_xyz",
      timestamp: "2023-11-14T12:00:00Z",
      actor: "admin@corp.com",
      action: "user_discovered",
      target: "newuser@corp.com",
      result: "success",
      ipAddress: "192.168.1.1",
      userAgent: "Mozilla/5.0",
      details: '{"ou":"/Engineering"}',
    };

    const entry = await appendAuditEntry(store, input);
    expect(entry.entryId).toBe("entry_abc");
    expect(entry.orgId).toBe("org_xyz");
    expect(entry.actor).toBe("admin@corp.com");
    expect(entry.action).toBe("user_discovered");
    expect(entry.target).toBe("newuser@corp.com");
    expect(entry.result).toBe("success");
    expect(entry.ipAddress).toBe("192.168.1.1");
    expect(entry.userAgent).toBe("Mozilla/5.0");
    expect(entry.details).toBe('{"ou":"/Engineering"}');
  });
});

// ---------------------------------------------------------------------------
// verifyHashChain
// ---------------------------------------------------------------------------

describe("verifyHashChain", () => {
  let store: ComplianceAuditStore & { entries: ComplianceAuditEntry[] };

  beforeEach(() => {
    store = createMockAuditStore();
  });

  it("returns valid for empty chain", async () => {
    const result = await verifyHashChain(store, "org_123");
    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(0);
  });

  it("verifies single entry chain", async () => {
    await appendAuditEntry(store, {
      entryId: "entry_1",
      orgId: "org_123",
      timestamp: "2023-11-14T12:00:00Z",
      actor: "admin@example.com",
      action: "delegation_created",
      target: "delegation_abc",
      result: "success",
      ipAddress: "1.2.3.4",
      userAgent: "TestAgent/1.0",
      details: null,
    });

    const result = await verifyHashChain(store, "org_123");
    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(1);
    expect(result.firstInvalidIndex).toBe(-1);
  });

  it("verifies multi-entry chain", async () => {
    for (let i = 0; i < 5; i++) {
      await appendAuditEntry(store, {
        entryId: `entry_${i}`,
        orgId: "org_123",
        timestamp: `2023-11-14T12:0${i}:00Z`,
        actor: "admin@example.com",
        action: "token_issued",
        target: `user${i}@example.com`,
        result: "success",
        ipAddress: "1.2.3.4",
        userAgent: "TestAgent/1.0",
        details: null,
      });
    }

    const result = await verifyHashChain(store, "org_123");
    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(5);
  });

  it("detects tampered entry (modified actor)", async () => {
    for (let i = 0; i < 3; i++) {
      await appendAuditEntry(store, {
        entryId: `entry_${i}`,
        orgId: "org_123",
        timestamp: `2023-11-14T12:0${i}:00Z`,
        actor: "admin@example.com",
        action: "token_issued",
        target: `user${i}@example.com`,
        result: "success",
        ipAddress: "1.2.3.4",
        userAgent: "TestAgent/1.0",
        details: null,
      });
    }

    // Tamper with the second entry's actor
    store.entries[1] = { ...store.entries[1], actor: "hacker@evil.com" };

    const result = await verifyHashChain(store, "org_123");
    expect(result.valid).toBe(false);
    expect(result.firstInvalidIndex).toBe(1);
    expect(result.error).toContain("entryHash mismatch");
  });

  it("detects broken chain (modified previousHash)", async () => {
    for (let i = 0; i < 3; i++) {
      await appendAuditEntry(store, {
        entryId: `entry_${i}`,
        orgId: "org_123",
        timestamp: `2023-11-14T12:0${i}:00Z`,
        actor: "admin@example.com",
        action: "delegation_created",
        target: "delegation_abc",
        result: "success",
        ipAddress: "1.2.3.4",
        userAgent: "TestAgent/1.0",
        details: null,
      });
    }

    // Break the chain by modifying the previousHash of entry 2
    store.entries[2] = { ...store.entries[2], previousHash: "tampered_hash" };

    const result = await verifyHashChain(store, "org_123");
    expect(result.valid).toBe(false);
    expect(result.firstInvalidIndex).toBe(2);
    expect(result.error).toContain("previousHash mismatch");
  });

  it("detects invalid genesis reference", async () => {
    // Manually insert an entry with wrong genesis hash
    const badEntry: ComplianceAuditEntry = {
      entryId: "entry_0",
      orgId: "org_123",
      timestamp: "2023-11-14T12:00:00Z",
      actor: "admin@example.com",
      action: "delegation_created",
      target: "delegation_abc",
      result: "success",
      ipAddress: "1.2.3.4",
      userAgent: "TestAgent/1.0",
      details: null,
      previousHash: "not_the_genesis_hash",
      entryHash: "fake_hash",
    };
    store.entries.push(badEntry);

    const result = await verifyHashChain(store, "org_123");
    expect(result.valid).toBe(false);
    expect(result.firstInvalidIndex).toBe(0);
    expect(result.error).toContain("genesis hash");
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 10; i++) {
      await appendAuditEntry(store, {
        entryId: `entry_${i}`,
        orgId: "org_123",
        timestamp: `2023-11-14T12:${String(i).padStart(2, "0")}:00Z`,
        actor: "admin@example.com",
        action: "token_issued",
        target: `user${i}@example.com`,
        result: "success",
        ipAddress: "1.2.3.4",
        userAgent: "TestAgent/1.0",
        details: null,
      });
    }

    const result = await verifyHashChain(store, "org_123", 5);
    expect(result.valid).toBe(true);
    expect(result.entriesChecked).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// exportAuditLog
// ---------------------------------------------------------------------------

describe("exportAuditLog", () => {
  let store: ComplianceAuditStore & { entries: ComplianceAuditEntry[] };

  beforeEach(() => {
    store = createMockAuditStore();
  });

  it("returns empty string for no entries", async () => {
    const result = await exportAuditLog(store, "org_123", "2023-01-01", "2023-12-31");
    expect(result).toBe("");
  });

  it("exports entries in JSON-lines format", async () => {
    await appendAuditEntry(store, {
      entryId: "entry_1",
      orgId: "org_123",
      timestamp: "2023-11-14T12:00:00Z",
      actor: "admin@example.com",
      action: "delegation_created",
      target: "delegation_abc",
      result: "success",
      ipAddress: "1.2.3.4",
      userAgent: "TestAgent/1.0",
      details: null,
    });

    await appendAuditEntry(store, {
      entryId: "entry_2",
      orgId: "org_123",
      timestamp: "2023-11-14T12:01:00Z",
      actor: "admin@example.com",
      action: "token_issued",
      target: "user@example.com",
      result: "success",
      ipAddress: "1.2.3.4",
      userAgent: "TestAgent/1.0",
      details: null,
    });

    const exported = await exportAuditLog(
      store,
      "org_123",
      "2023-11-14T00:00:00Z",
      "2023-11-14T23:59:59Z",
    );

    // Should be newline-separated JSON
    const lines = exported.split("\n");
    expect(lines).toHaveLength(2);

    // Each line is valid JSON
    const line1 = JSON.parse(lines[0]);
    expect(line1.entryId).toBe("entry_1");
    expect(line1.action).toBe("delegation_created");

    const line2 = JSON.parse(lines[1]);
    expect(line2.entryId).toBe("entry_2");
    expect(line2.action).toBe("token_issued");
  });

  it("filters by date range", async () => {
    await appendAuditEntry(store, {
      entryId: "entry_1",
      orgId: "org_123",
      timestamp: "2023-11-13T12:00:00Z",
      actor: "admin@example.com",
      action: "delegation_created",
      target: "delegation_abc",
      result: "success",
      ipAddress: "1.2.3.4",
      userAgent: "TestAgent/1.0",
      details: null,
    });

    await appendAuditEntry(store, {
      entryId: "entry_2",
      orgId: "org_123",
      timestamp: "2023-11-14T12:00:00Z",
      actor: "admin@example.com",
      action: "token_issued",
      target: "user@example.com",
      result: "success",
      ipAddress: "1.2.3.4",
      userAgent: "TestAgent/1.0",
      details: null,
    });

    // Only entries from Nov 14
    const exported = await exportAuditLog(
      store,
      "org_123",
      "2023-11-14T00:00:00Z",
      "2023-11-14T23:59:59Z",
    );

    const lines = exported.split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.entryId).toBe("entry_2");
  });
});

// ---------------------------------------------------------------------------
// generateComplianceReport
// ---------------------------------------------------------------------------

describe("generateComplianceReport", () => {
  let store: ComplianceAuditStore & { entries: ComplianceAuditEntry[] };

  beforeEach(() => {
    store = createMockAuditStore();
  });

  it("generates report for empty period", async () => {
    const report = await generateComplianceReport(
      store,
      "org_123",
      "2023-11-14T00:00:00Z",
      "2023-11-14T23:59:59Z",
    );

    expect(report.orgId).toBe("org_123");
    expect(report.totalEntries).toBe(0);
    expect(report.totalApiCalls).toBe(0);
    expect(report.uniqueUsers).toEqual([]);
    expect(report.credentialRotations).toBe(0);
    expect(report.policyChanges).toBe(0);
    expect(report.chainIntegrity.valid).toBe(true);
    expect(report.generatedAt).toBeTruthy();
  });

  it("counts token_issued as API calls", async () => {
    for (let i = 0; i < 5; i++) {
      await appendAuditEntry(store, {
        entryId: `entry_${i}`,
        orgId: "org_123",
        timestamp: `2023-11-14T12:0${i}:00Z`,
        actor: "admin@example.com",
        action: "token_issued",
        target: `user${i % 2}@example.com`,
        result: "success",
        ipAddress: "1.2.3.4",
        userAgent: "TestAgent/1.0",
        details: null,
      });
    }

    const report = await generateComplianceReport(
      store,
      "org_123",
      "2023-11-14T00:00:00Z",
      "2023-11-14T23:59:59Z",
    );

    expect(report.totalEntries).toBe(5);
    expect(report.totalApiCalls).toBe(5);
    expect(report.uniqueUsers).toHaveLength(2);
    expect(report.uniqueUsers).toContain("user0@example.com");
    expect(report.uniqueUsers).toContain("user1@example.com");
  });

  it("counts credential rotations", async () => {
    await appendAuditEntry(store, {
      entryId: "entry_1",
      orgId: "org_123",
      timestamp: "2023-11-14T12:00:00Z",
      actor: "admin@example.com",
      action: "delegation_rotated",
      target: "delegation_abc",
      result: "success",
      ipAddress: "1.2.3.4",
      userAgent: "TestAgent/1.0",
      details: null,
    });

    const report = await generateComplianceReport(
      store,
      "org_123",
      "2023-11-14T00:00:00Z",
      "2023-11-14T23:59:59Z",
    );

    expect(report.credentialRotations).toBe(1);
  });

  it("counts policy/config changes", async () => {
    await appendAuditEntry(store, {
      entryId: "entry_1",
      orgId: "org_123",
      timestamp: "2023-11-14T12:00:00Z",
      actor: "admin@example.com",
      action: "config_updated",
      target: "rate_limit_config",
      result: "success",
      ipAddress: "1.2.3.4",
      userAgent: "TestAgent/1.0",
      details: null,
    });

    const report = await generateComplianceReport(
      store,
      "org_123",
      "2023-11-14T00:00:00Z",
      "2023-11-14T23:59:59Z",
    );

    expect(report.policyChanges).toBe(1);
  });

  it("detects multiple failures anomaly", async () => {
    for (let i = 0; i < 15; i++) {
      await appendAuditEntry(store, {
        entryId: `entry_${i}`,
        orgId: "org_123",
        timestamp: `2023-11-14T12:${String(i).padStart(2, "0")}:00Z`,
        actor: "admin@example.com",
        action: "token_issued",
        target: `user${i}@example.com`,
        result: "failure",
        ipAddress: "1.2.3.4",
        userAgent: "TestAgent/1.0",
        details: null,
      });
    }

    const report = await generateComplianceReport(
      store,
      "org_123",
      "2023-11-14T00:00:00Z",
      "2023-11-14T23:59:59Z",
    );

    expect(report.anomalies.length).toBeGreaterThan(0);
    const failureAnomaly = report.anomalies.find(
      (a) => a.type === "multiple_failures",
    );
    expect(failureAnomaly).toBeDefined();
    expect(failureAnomaly!.count).toBe(15);
  });

  it("includes hash chain integrity result", async () => {
    await appendAuditEntry(store, {
      entryId: "entry_1",
      orgId: "org_123",
      timestamp: "2023-11-14T12:00:00Z",
      actor: "admin@example.com",
      action: "delegation_created",
      target: "delegation_abc",
      result: "success",
      ipAddress: "1.2.3.4",
      userAgent: "TestAgent/1.0",
      details: null,
    });

    const report = await generateComplianceReport(
      store,
      "org_123",
      "2023-11-14T00:00:00Z",
      "2023-11-14T23:59:59Z",
    );

    expect(report.chainIntegrity.valid).toBe(true);
    expect(report.chainIntegrity.entriesChecked).toBe(1);
  });
});
