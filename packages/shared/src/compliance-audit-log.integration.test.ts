/**
 * Integration tests for compliance audit log, rate limiting, and quotas (TM-9iu.5).
 *
 * Uses better-sqlite3 (same SQLite engine as D1) to validate the complete
 * rate limiting, quota, and compliance audit lifecycle against REAL database
 * operations:
 *
 * 1. Audit log entries persist in SQLite with hash chain integrity (AC-3)
 * 2. Hash chain verification detects tampering (AC-3, BR-3)
 * 3. JSON-lines export works with real data (AC-5)
 * 4. Rate limit counters persist and expire correctly (AC-1)
 * 5. Quota usage tracks across periods (AC-2)
 * 6. Compliance report aggregates real data (AC-4)
 *
 * All stores are REAL SQLite -- no mocks. This proves the SQL schema,
 * queries, and business logic work together end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { MIGRATION_0026_COMPLIANCE_AND_QUOTAS } from "@tminus/d1-registry";
import {
  appendAuditEntry,
  verifyHashChain,
  exportAuditLog,
  generateComplianceReport,
  GENESIS_HASH,
} from "./compliance-audit-log";
import type {
  ComplianceAuditStore,
  ComplianceAuditEntry,
  ComplianceAuditInput,
  AuditRetentionConfig,
} from "./compliance-audit-log";
import {
  checkOrgRateLimit,
  DEFAULT_ORG_RATE_LIMITS,
} from "./org-rate-limit";
import type { OrgRateLimitStore, OrgRateLimitConfig } from "./org-rate-limit";
import {
  checkQuota,
  getQuotaReport,
  DEFAULT_ORG_QUOTAS,
  computeDailyPeriodKey,
} from "./org-quota";
import type { OrgQuotaStore, OrgQuotaConfig, QuotaType } from "./org-quota";

// ---------------------------------------------------------------------------
// SQLite-backed ComplianceAuditStore
// ---------------------------------------------------------------------------

class D1ComplianceAuditStore implements ComplianceAuditStore {
  constructor(private readonly db: DatabaseType) {}

  async getLastEntryHash(orgId: string): Promise<string> {
    const row = this.db
      .prepare(
        "SELECT entry_hash FROM compliance_audit_log WHERE org_id = ? ORDER BY timestamp DESC, rowid DESC LIMIT 1",
      )
      .get(orgId) as { entry_hash: string } | undefined;
    return row?.entry_hash ?? GENESIS_HASH;
  }

  async appendEntry(entry: ComplianceAuditEntry): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO compliance_audit_log
         (entry_id, org_id, timestamp, actor, action, target, result,
          ip_address, user_agent, details, previous_hash, entry_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.entryId,
        entry.orgId,
        entry.timestamp,
        entry.actor,
        entry.action,
        entry.target,
        entry.result,
        entry.ipAddress,
        entry.userAgent,
        entry.details,
        entry.previousHash,
        entry.entryHash,
      );
  }

  async getEntries(
    orgId: string,
    startDate: string,
    endDate: string,
    limit?: number,
    offset?: number,
  ): Promise<ComplianceAuditEntry[]> {
    let sql = `SELECT * FROM compliance_audit_log
               WHERE org_id = ? AND timestamp >= ? AND timestamp <= ?
               ORDER BY timestamp ASC, rowid ASC`;
    const params: unknown[] = [orgId, startDate, endDate];

    if (limit) {
      sql += " LIMIT ?";
      params.push(limit);
    }
    if (offset) {
      sql += " OFFSET ?";
      params.push(offset);
    }

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToEntry(row));
  }

  async getEntryCount(orgId: string, startDate: string, endDate: string): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM compliance_audit_log
         WHERE org_id = ? AND timestamp >= ? AND timestamp <= ?`,
      )
      .get(orgId, startDate, endDate) as { cnt: number };
    return row.cnt;
  }

  async getEntriesForVerification(orgId: string, limit?: number): Promise<ComplianceAuditEntry[]> {
    let sql = `SELECT * FROM compliance_audit_log WHERE org_id = ?
               ORDER BY timestamp ASC, rowid ASC`;
    const params: unknown[] = [orgId];

    if (limit) {
      sql += " LIMIT ?";
      params.push(limit);
    }

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToEntry(row));
  }

  async getRetentionConfig(_orgId: string): Promise<AuditRetentionConfig | null> {
    return null;
  }

  private rowToEntry(row: Record<string, unknown>): ComplianceAuditEntry {
    return {
      entryId: row.entry_id as string,
      orgId: row.org_id as string,
      timestamp: row.timestamp as string,
      actor: row.actor as string,
      action: row.action as ComplianceAuditEntry["action"],
      target: row.target as string,
      result: row.result as ComplianceAuditEntry["result"],
      ipAddress: row.ip_address as string,
      userAgent: row.user_agent as string,
      details: row.details as string | null,
      previousHash: row.previous_hash as string,
      entryHash: row.entry_hash as string,
    };
  }
}

// ---------------------------------------------------------------------------
// SQLite-backed OrgRateLimitStore
// ---------------------------------------------------------------------------

class D1OrgRateLimitStore implements OrgRateLimitStore {
  constructor(private readonly db: DatabaseType) {}

  async getCount(key: string): Promise<number> {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        "SELECT count FROM org_rate_limit_counters WHERE counter_key = ? AND expires_at > ?",
      )
      .get(key, now) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  async incrementCount(key: string, ttlSeconds: number): Promise<number> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    // Upsert: increment if exists, insert if not
    const existing = this.db
      .prepare("SELECT count FROM org_rate_limit_counters WHERE counter_key = ?")
      .get(key) as { count: number } | undefined;

    if (existing) {
      const newCount = existing.count + 1;
      this.db
        .prepare(
          "UPDATE org_rate_limit_counters SET count = ?, expires_at = ? WHERE counter_key = ?",
        )
        .run(newCount, expiresAt, key);
      return newCount;
    }

    this.db
      .prepare(
        "INSERT INTO org_rate_limit_counters (counter_key, count, expires_at) VALUES (?, 1, ?)",
      )
      .run(key, expiresAt);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// SQLite-backed OrgQuotaStore
// ---------------------------------------------------------------------------

class D1OrgQuotaStore implements OrgQuotaStore {
  constructor(private readonly db: DatabaseType) {}

  async getUsage(orgId: string, quotaType: QuotaType, periodKey: string): Promise<number> {
    const row = this.db
      .prepare(
        "SELECT usage_count FROM org_quota_usage WHERE org_id = ? AND quota_type = ? AND period_key = ?",
      )
      .get(orgId, quotaType, periodKey) as { usage_count: number } | undefined;
    return row?.usage_count ?? 0;
  }

  async incrementUsage(orgId: string, quotaType: QuotaType, periodKey: string): Promise<number> {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(
        "SELECT usage_count FROM org_quota_usage WHERE org_id = ? AND quota_type = ? AND period_key = ?",
      )
      .get(orgId, quotaType, periodKey) as { usage_count: number } | undefined;

    if (existing) {
      const newCount = existing.usage_count + 1;
      this.db
        .prepare(
          `UPDATE org_quota_usage SET usage_count = ?, updated_at = ?
           WHERE org_id = ? AND quota_type = ? AND period_key = ?`,
        )
        .run(newCount, now, orgId, quotaType, periodKey);
      return newCount;
    }

    this.db
      .prepare(
        `INSERT INTO org_quota_usage (org_id, quota_type, period_key, usage_count, updated_at)
         VALUES (?, ?, ?, 1, ?)`,
      )
      .run(orgId, quotaType, periodKey, now);
    return 1;
  }

  async setUsage(orgId: string, quotaType: QuotaType, periodKey: string, value: number): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO org_quota_usage (org_id, quota_type, period_key, usage_count, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(orgId, quotaType, periodKey, value, now);
  }

  async getOrgQuotaConfig(orgId: string): Promise<OrgQuotaConfig | null> {
    const row = this.db
      .prepare("SELECT * FROM org_quota_config WHERE org_id = ?")
      .get(orgId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return {
      maxDiscoveredUsers: row.max_discovered_users as number,
      maxDelegations: row.max_delegations as number,
      maxApiCallsDaily: row.max_api_calls_daily as number,
    };
  }
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let db: DatabaseType;
let auditStore: D1ComplianceAuditStore;
let rateLimitStore: D1OrgRateLimitStore;
let quotaStore: D1OrgQuotaStore;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");

  // Apply migration 0026
  const statements = MIGRATION_0026_COMPLIANCE_AND_QUOTAS.split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    db.exec(stmt);
  }

  auditStore = new D1ComplianceAuditStore(db);
  rateLimitStore = new D1OrgRateLimitStore(db);
  quotaStore = new D1OrgQuotaStore(db);
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Compliance audit log with real SQLite
// ---------------------------------------------------------------------------

describe("Compliance audit log (real SQLite)", () => {
  it("persists entries and maintains hash chain", async () => {
    const entry1 = await appendAuditEntry(auditStore, {
      entryId: "entry_1",
      orgId: "org_test",
      timestamp: "2023-11-14T12:00:00Z",
      actor: "admin@corp.com",
      action: "delegation_created",
      target: "delegation_abc",
      result: "success",
      ipAddress: "10.0.0.1",
      userAgent: "TestAgent/1.0",
      details: '{"domain":"corp.com"}',
    });

    expect(entry1.previousHash).toBe(GENESIS_HASH);
    expect(entry1.entryHash).toHaveLength(64);

    const entry2 = await appendAuditEntry(auditStore, {
      entryId: "entry_2",
      orgId: "org_test",
      timestamp: "2023-11-14T12:01:00Z",
      actor: "admin@corp.com",
      action: "token_issued",
      target: "user1@corp.com",
      result: "success",
      ipAddress: "10.0.0.1",
      userAgent: "TestAgent/1.0",
      details: null,
    });

    // Second entry chains to first
    expect(entry2.previousHash).toBe(entry1.entryHash);

    // Verify chain integrity with real SQLite reads
    const verification = await verifyHashChain(auditStore, "org_test");
    expect(verification.valid).toBe(true);
    expect(verification.entriesChecked).toBe(2);
  });

  it("detects tampering in real SQLite store", async () => {
    // Insert legitimate chain
    for (let i = 0; i < 5; i++) {
      await appendAuditEntry(auditStore, {
        entryId: `entry_${i}`,
        orgId: "org_test",
        timestamp: `2023-11-14T12:0${i}:00Z`,
        actor: "admin@corp.com",
        action: "token_issued",
        target: `user${i}@corp.com`,
        result: "success",
        ipAddress: "10.0.0.1",
        userAgent: "TestAgent/1.0",
        details: null,
      });
    }

    // Tamper directly in SQLite (simulating a direct DB attack)
    db.prepare(
      "UPDATE compliance_audit_log SET actor = 'attacker@evil.com' WHERE entry_id = 'entry_2'",
    ).run();

    // Verification should detect the tampering
    const verification = await verifyHashChain(auditStore, "org_test");
    expect(verification.valid).toBe(false);
    expect(verification.firstInvalidIndex).toBe(2);
    expect(verification.error).toContain("entryHash mismatch");
  });

  it("exports to JSON-lines from real SQLite", async () => {
    for (let i = 0; i < 3; i++) {
      await appendAuditEntry(auditStore, {
        entryId: `entry_${i}`,
        orgId: "org_test",
        timestamp: `2023-11-14T12:0${i}:00Z`,
        actor: "admin@corp.com",
        action: i === 0 ? "delegation_created" : "token_issued",
        target: `target_${i}`,
        result: "success",
        ipAddress: "10.0.0.1",
        userAgent: "TestAgent/1.0",
        details: null,
      });
    }

    const exported = await exportAuditLog(
      auditStore,
      "org_test",
      "2023-11-14T00:00:00Z",
      "2023-11-14T23:59:59Z",
    );

    const lines = exported.split("\n");
    expect(lines).toHaveLength(3);

    // Each line is independently parseable
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.orgId).toBe("org_test");
      expect(parsed.entryHash).toHaveLength(64);
      expect(parsed.previousHash).toHaveLength(64);
    }
  });

  it("UNIQUE constraint prevents duplicate hashes per org", async () => {
    const entry = await appendAuditEntry(auditStore, {
      entryId: "entry_1",
      orgId: "org_test",
      timestamp: "2023-11-14T12:00:00Z",
      actor: "admin@corp.com",
      action: "delegation_created",
      target: "delegation_abc",
      result: "success",
      ipAddress: "10.0.0.1",
      userAgent: "TestAgent/1.0",
      details: null,
    });

    // Trying to insert same entry_hash for same org should fail
    expect(() => {
      db.prepare(
        `INSERT INTO compliance_audit_log
         (entry_id, org_id, timestamp, actor, action, target, result,
          ip_address, user_agent, details, previous_hash, entry_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "entry_dup",
        "org_test",
        "2023-11-14T12:01:00Z",
        "admin@corp.com",
        "token_issued",
        "user@corp.com",
        "success",
        "10.0.0.1",
        "TestAgent/1.0",
        null,
        "genesis",
        entry.entryHash, // same hash
      );
    }).toThrow();
  });

  it("generates compliance report from real data", async () => {
    // Create a mix of audit entries
    await appendAuditEntry(auditStore, {
      entryId: "entry_1",
      orgId: "org_test",
      timestamp: "2023-11-14T12:00:00Z",
      actor: "admin@corp.com",
      action: "delegation_created",
      target: "delegation_abc",
      result: "success",
      ipAddress: "10.0.0.1",
      userAgent: "TestAgent/1.0",
      details: null,
    });

    await appendAuditEntry(auditStore, {
      entryId: "entry_2",
      orgId: "org_test",
      timestamp: "2023-11-14T12:01:00Z",
      actor: "admin@corp.com",
      action: "token_issued",
      target: "user1@corp.com",
      result: "success",
      ipAddress: "10.0.0.1",
      userAgent: "TestAgent/1.0",
      details: null,
    });

    await appendAuditEntry(auditStore, {
      entryId: "entry_3",
      orgId: "org_test",
      timestamp: "2023-11-14T12:02:00Z",
      actor: "admin@corp.com",
      action: "delegation_rotated",
      target: "delegation_abc",
      result: "success",
      ipAddress: "10.0.0.1",
      userAgent: "TestAgent/1.0",
      details: null,
    });

    await appendAuditEntry(auditStore, {
      entryId: "entry_4",
      orgId: "org_test",
      timestamp: "2023-11-14T12:03:00Z",
      actor: "admin@corp.com",
      action: "config_updated",
      target: "rate_limit_config",
      result: "success",
      ipAddress: "10.0.0.1",
      userAgent: "TestAgent/1.0",
      details: null,
    });

    const report = await generateComplianceReport(
      auditStore,
      "org_test",
      "2023-11-14T00:00:00Z",
      "2023-11-14T23:59:59Z",
    );

    expect(report.totalEntries).toBe(4);
    expect(report.totalApiCalls).toBe(1);
    expect(report.uniqueUsers).toEqual(["user1@corp.com"]);
    expect(report.credentialRotations).toBe(1);
    expect(report.policyChanges).toBe(1);
    expect(report.chainIntegrity.valid).toBe(true);
    expect(report.chainIntegrity.entriesChecked).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Rate limit state persistence with real SQLite
// ---------------------------------------------------------------------------

describe("Org rate limit state (real SQLite)", () => {
  it("persists and reads counter state", async () => {
    const config: OrgRateLimitConfig = {
      ...DEFAULT_ORG_RATE_LIMITS,
      apiMaxRequests: 5,
    };
    const now = Date.now();

    // First request
    const r1 = await checkOrgRateLimit(rateLimitStore, "org_test", "api", config, now);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(4);

    // Second request -- counter should be persisted
    const r2 = await checkOrgRateLimit(rateLimitStore, "org_test", "api", config, now + 1000);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(3);

    // Verify counter is in SQLite
    const row = db.prepare(
      "SELECT count FROM org_rate_limit_counters WHERE counter_key LIKE 'org_rl:org_test:api:%'",
    ).get() as { count: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.count).toBe(2);
  });

  it("blocks when counter reaches limit", async () => {
    const config: OrgRateLimitConfig = {
      ...DEFAULT_ORG_RATE_LIMITS,
      apiMaxRequests: 2,
    };
    const now = Date.now();

    await checkOrgRateLimit(rateLimitStore, "org_test", "api", config, now);
    await checkOrgRateLimit(rateLimitStore, "org_test", "api", config, now + 100);

    const blocked = await checkOrgRateLimit(rateLimitStore, "org_test", "api", config, now + 200);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it("different buckets have independent counters in SQLite", async () => {
    const config: OrgRateLimitConfig = {
      ...DEFAULT_ORG_RATE_LIMITS,
      apiMaxRequests: 1,
      directoryMaxRequests: 1,
    };
    const now = Date.now();

    await checkOrgRateLimit(rateLimitStore, "org_test", "api", config, now);
    const apiBlocked = await checkOrgRateLimit(rateLimitStore, "org_test", "api", config, now + 100);
    expect(apiBlocked.allowed).toBe(false);

    // Directory bucket is independent
    const dirAllowed = await checkOrgRateLimit(rateLimitStore, "org_test", "directory", config, now + 100);
    expect(dirAllowed.allowed).toBe(true);

    // Verify separate rows in SQLite
    const rows = db.prepare(
      "SELECT counter_key FROM org_rate_limit_counters WHERE counter_key LIKE 'org_rl:org_test:%'",
    ).all() as { counter_key: string }[];
    expect(rows.length).toBe(2);
    expect(rows.some((r) => r.counter_key.includes(":api:"))).toBe(true);
    expect(rows.some((r) => r.counter_key.includes(":directory:"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Quota usage persistence with real SQLite
// ---------------------------------------------------------------------------

describe("Org quota tracking (real SQLite)", () => {
  it("tracks daily API calls with period key", async () => {
    const config: OrgQuotaConfig = { ...DEFAULT_ORG_QUOTAS, maxApiCallsDaily: 5 };
    const now = new Date("2023-11-14T12:00:00Z").getTime();

    const r1 = await checkQuota(quotaStore, "org_test", "api_calls_daily", config, now);
    expect(r1.allowed).toBe(true);
    expect(r1.current).toBe(1);

    const r2 = await checkQuota(quotaStore, "org_test", "api_calls_daily", config, now + 1000);
    expect(r2.allowed).toBe(true);
    expect(r2.current).toBe(2);

    // Verify row in SQLite
    const row = db.prepare(
      "SELECT usage_count, period_key FROM org_quota_usage WHERE org_id = 'org_test' AND quota_type = 'api_calls_daily'",
    ).get() as { usage_count: number; period_key: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.usage_count).toBe(2);
    expect(row!.period_key).toBe("2023-11-14");
  });

  it("blocks when daily quota exceeded", async () => {
    const config: OrgQuotaConfig = { ...DEFAULT_ORG_QUOTAS, maxApiCallsDaily: 2 };
    const now = new Date("2023-11-14T12:00:00Z").getTime();

    await checkQuota(quotaStore, "org_test", "api_calls_daily", config, now);
    await checkQuota(quotaStore, "org_test", "api_calls_daily", config, now + 1000);

    const blocked = await checkQuota(quotaStore, "org_test", "api_calls_daily", config, now + 2000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it("daily quota resets with new day", async () => {
    const config: OrgQuotaConfig = { ...DEFAULT_ORG_QUOTAS, maxApiCallsDaily: 1 };

    // Day 1
    const day1 = new Date("2023-11-14T12:00:00Z").getTime();
    await checkQuota(quotaStore, "org_test", "api_calls_daily", config, day1);
    const blocked = await checkQuota(quotaStore, "org_test", "api_calls_daily", config, day1 + 1000);
    expect(blocked.allowed).toBe(false);

    // Day 2 -- different period key
    const day2 = new Date("2023-11-15T01:00:00Z").getTime();
    const fresh = await checkQuota(quotaStore, "org_test", "api_calls_daily", config, day2);
    expect(fresh.allowed).toBe(true);
    expect(fresh.current).toBe(1);

    // Verify two period rows in SQLite
    const rows = db.prepare(
      "SELECT period_key, usage_count FROM org_quota_usage WHERE org_id = 'org_test' AND quota_type = 'api_calls_daily'",
    ).all() as { period_key: string; usage_count: number }[];
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.period_key === "2023-11-14")!.usage_count).toBe(1);
    expect(rows.find((r) => r.period_key === "2023-11-15")!.usage_count).toBe(1);
  });

  it("tracks discovered_users as absolute count", async () => {
    await quotaStore.setUsage("org_test", "discovered_users", "lifetime", 250);

    const result = await checkQuota(quotaStore, "org_test", "discovered_users", DEFAULT_ORG_QUOTAS);
    expect(result.allowed).toBe(true);
    expect(result.current).toBe(250);
    expect(result.limit).toBe(500);
  });

  it("generates quota report from real SQLite data", async () => {
    const now = new Date("2023-11-14T12:00:00Z").getTime();
    const periodKey = computeDailyPeriodKey(now);

    await quotaStore.setUsage("org_test", "discovered_users", "lifetime", 200);
    await quotaStore.setUsage("org_test", "delegations", "lifetime", 3);
    await quotaStore.setUsage("org_test", "api_calls_daily", periodKey, 5000);

    const report = await getQuotaReport(quotaStore, "org_test", DEFAULT_ORG_QUOTAS, now);

    expect(report.orgId).toBe("org_test");
    expect(report.quotas).toHaveLength(3);
    expect(report.anyExceeded).toBe(false);

    const discovered = report.quotas.find((q) => q.type === "discovered_users");
    expect(discovered!.current).toBe(200);
    expect(discovered!.limit).toBe(500);

    const apiCalls = report.quotas.find((q) => q.type === "api_calls_daily");
    expect(apiCalls!.current).toBe(5000);
    expect(apiCalls!.limit).toBe(10000);
  });

  it("reads org-specific quota config from SQLite", async () => {
    // Insert custom config
    db.prepare(
      `INSERT INTO org_quota_config (org_id, max_discovered_users, max_delegations, max_api_calls_daily)
       VALUES ('org_custom', 50, 2, 100)`,
    ).run();

    const config = await quotaStore.getOrgQuotaConfig("org_custom");
    expect(config).not.toBeNull();
    expect(config!.maxDiscoveredUsers).toBe(50);
    expect(config!.maxDelegations).toBe(2);
    expect(config!.maxApiCallsDaily).toBe(100);
  });
});
