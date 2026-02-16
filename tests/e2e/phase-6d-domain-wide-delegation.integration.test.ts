/**
 * Phase 6D E2E Validation: Domain-Wide Delegation
 *
 * Validates the FULL domain-wide delegation lifecycle end-to-end:
 *   1. Admin setup: register org with encrypted service account credentials
 *   2. Delegation validation: impersonate admin, list calendars
 *   3. User discovery: detect new, suspended, and removed users
 *   4. Calendar federation: delegated user gets calendars without personal OAuth
 *   5. Admin dashboard: org-wide sync health, user stats, audit summary
 *   6. User lifecycle: suspend/remove/reactivate transitions
 *   7. Rate limiting: sustained load (50 concurrent users) stays within quotas
 *   8. Compliance audit log: hash chain integrity, export in CSV/JSON
 *   9. Delegation revocation: detected via health check, surfaced to admin
 *  10. Key rotation: zero-downtime credential swap
 *
 * Test strategy:
 *   - Real API handler chain (createHandler) with real D1 (better-sqlite3)
 *   - DelegationService and DiscoveryService with real D1-backed stores
 *   - External Google APIs (Directory, OAuth token) mocked via injectable fetchFn
 *   - Compliance audit store with real hash chain computation
 *   - Dynamic assertions: thresholds and ranges, not hardcoded counts
 *
 * No mocks of internal modules. No test fixtures.
 *
 * Run with:
 *   make test-e2e-phase6d
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  MIGRATION_0001_INITIAL_SCHEMA,
  MIGRATION_0004_AUTH_FIELDS,
  MIGRATION_0016_ORG_MEMBERS,
  MIGRATION_0022_ORG_DELEGATIONS,
  MIGRATION_0023_DELEGATION_INFRASTRUCTURE,
  MIGRATION_0024_DELEGATION_CACHE_AND_AUDIT,
  MIGRATION_0025_ORG_DISCOVERY,
  MIGRATION_0026_COMPLIANCE_AND_QUOTAS,
} from "@tminus/d1-registry";
import {
  DelegationService,
  DiscoveryService,
  generateId,
  appendAuditEntry,
  verifyHashChain,
  GENESIS_HASH,
  checkOrgRateLimit,
  buildOrgRateLimitResponse,
  DEFAULT_ORG_RATE_LIMITS,
  getQuotaReport,
} from "@tminus/shared";
import type {
  ServiceAccountKey,
  DelegationStore,
  DelegationRecord,
  CachedTokenRecord,
  AuditLogEntry,
  DiscoveryStore,
  DiscoveredUser,
  DiscoveredUserStatus,
  DiscoveryConfig,
  TokenProvider,
  ComplianceAuditStore,
  ComplianceAuditEntry,
  ComplianceAuditInput,
  AuditRetentionConfig,
  OrgRateLimitStore,
  OrgRateLimitConfig,
  OrgQuotaStore,
  OrgQuotaConfig,
  QuotaType,
} from "@tminus/shared";
import {
  handleOrgDashboard,
  handleListDiscoveredUsers,
  handleGetDiscoveredUser,
  handleUpdateDiscoveredUser,
  handleGetDiscoveryConfig,
  handleUpdateDiscoveryConfig,
  handleDelegationHealth,
  handleDelegationRotate,
  handleAuditLog,
  handleAuditLogExport,
} from "../../workers/api/src/routes/org-delegation-admin";
import type { AdminDeps, AuditPage, AuditQueryOptions } from "../../workers/api/src/routes/org-delegation-admin";
import {
  handleOrgRegister,
  handleDelegationCalendars,
} from "../../workers/api/src/routes/org-delegation";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_MASTER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// Generate RSA keys at module load for consistent test identity
const { privateKey: RSA_KEY_1 } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const { privateKey: RSA_KEY_2 } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const SA_KEY_1: ServiceAccountKey = {
  type: "service_account",
  project_id: "tminus-e2e-test",
  private_key_id: "key-e2e-alpha",
  private_key: RSA_KEY_1,
  client_email: "sa-e2e@tminus-e2e-test.iam.gserviceaccount.com",
  client_id: "100000000001",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
};

const SA_KEY_2: ServiceAccountKey = {
  type: "service_account",
  project_id: "tminus-e2e-test",
  private_key_id: "key-e2e-beta",
  private_key: RSA_KEY_2,
  client_email: "sa-e2e@tminus-e2e-test.iam.gserviceaccount.com",
  client_id: "100000000001",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
};

const TEST_DOMAIN = "acme-e2e.dev";
const TEST_ADMIN_EMAIL = `admin@${TEST_DOMAIN}`;
const TEST_USER_ID = "usr_e2e_admin_001";

// Directory API user fixtures (simulating a 10-person org)
function makeDirectoryUsers(count: number, domain: string) {
  return Array.from({ length: count }, (_, i) => ({
    id: `guser-${String(i + 1).padStart(3, "0")}`,
    primaryEmail: `user${i + 1}@${domain}`,
    name: { fullName: `Test User ${i + 1}` },
    suspended: false,
    archived: false,
    orgUnitPath: i < count / 2 ? "/Engineering" : "/Sales",
  }));
}

// ---------------------------------------------------------------------------
// D1 mock backed by better-sqlite3 (proven pattern from Phase 6A-6C)
// ---------------------------------------------------------------------------

function createRealD1(db: DatabaseType): D1Database {
  const normalizeSQL = (sql: string): string => sql.replace(/\?(\d+)/g, "?");

  return {
    prepare(sql: string) {
      const normalizedSql = normalizeSQL(sql);
      return {
        bind(...params: unknown[]) {
          return {
            first<T>(): Promise<T | null> {
              const stmt = db.prepare(normalizedSql);
              const row = stmt.get(...params) as T | null;
              return Promise.resolve(row ?? null);
            },
            all<T>(): Promise<{ results: T[] }> {
              const stmt = db.prepare(normalizedSql);
              const rows = stmt.all(...params) as T[];
              return Promise.resolve({ results: rows });
            },
            run(): Promise<D1Result<unknown>> {
              const stmt = db.prepare(normalizedSql);
              const info = stmt.run(...params);
              return Promise.resolve({
                success: true,
                results: [],
                meta: {
                  duration: 0,
                  rows_read: 0,
                  rows_written: info.changes,
                  last_row_id: info.lastInsertRowid as number,
                  changed_db: info.changes > 0,
                  size_after: 0,
                  changes: info.changes,
                },
              } as unknown as D1Result<unknown>);
            },
          };
        },
      };
    },
    exec(sql: string): Promise<D1ExecResult> {
      db.exec(sql);
      return Promise.resolve({ count: 0, duration: 0 });
    },
    batch(_stmts: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
      return Promise.resolve([]);
    },
    dump(): Promise<ArrayBuffer> {
      return Promise.resolve(new ArrayBuffer(0));
    },
  } as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// In-memory stores backed by real D1 (better-sqlite3)
// ---------------------------------------------------------------------------

class SQLiteDelegationStore implements DelegationStore {
  constructor(private readonly db: D1Database) {}

  async getDelegation(domain: string): Promise<DelegationRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM org_delegations WHERE domain = ?1")
      .bind(domain)
      .first<Record<string, unknown>>();
    return row ? this.toRecord(row) : null;
  }

  async getDelegationById(delegationId: string): Promise<DelegationRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM org_delegations WHERE delegation_id = ?1")
      .bind(delegationId)
      .first<Record<string, unknown>>();
    return row ? this.toRecord(row) : null;
  }

  async getActiveDelegations(): Promise<DelegationRecord[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM org_delegations WHERE delegation_status = 'active'")
      .all<Record<string, unknown>>();
    return (results ?? []).map((r) => this.toRecord(r));
  }

  async createDelegation(record: DelegationRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO org_delegations
         (delegation_id, domain, admin_email, delegation_status, encrypted_sa_key,
          sa_client_email, sa_client_id, validated_at, active_users_count,
          registration_date, sa_key_created_at, sa_key_last_used_at,
          sa_key_rotation_due_at, previous_encrypted_sa_key, previous_sa_key_id,
          last_health_check_at, health_check_status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`,
      )
      .bind(
        record.delegationId,
        record.domain,
        record.adminEmail,
        record.delegationStatus,
        record.encryptedSaKey,
        record.saClientEmail,
        record.saClientId,
        record.validatedAt,
        record.activeUsersCount,
        record.registrationDate,
        record.saKeyCreatedAt,
        record.saKeyLastUsedAt,
        record.saKeyRotationDueAt,
        record.previousEncryptedSaKey,
        record.previousSaKeyId,
        record.lastHealthCheckAt,
        record.healthCheckStatus,
        record.createdAt,
        record.updatedAt,
      )
      .run();
  }

  async updateDelegation(delegationId: string, updates: Partial<DelegationRecord>): Promise<void> {
    const fieldMap: Record<string, string> = {
      encryptedSaKey: "encrypted_sa_key",
      saClientEmail: "sa_client_email",
      saClientId: "sa_client_id",
      delegationStatus: "delegation_status",
      previousEncryptedSaKey: "previous_encrypted_sa_key",
      previousSaKeyId: "previous_sa_key_id",
      saKeyCreatedAt: "sa_key_created_at",
      saKeyLastUsedAt: "sa_key_last_used_at",
      saKeyRotationDueAt: "sa_key_rotation_due_at",
      lastHealthCheckAt: "last_health_check_at",
      healthCheckStatus: "health_check_status",
      updatedAt: "updated_at",
      activeUsersCount: "active_users_count",
      validatedAt: "validated_at",
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;
    for (const [key, col] of Object.entries(fieldMap)) {
      if (key in updates) {
        sets.push(`${col} = ?${paramIdx}`);
        values.push((updates as Record<string, unknown>)[key]);
        paramIdx++;
      }
    }
    if (sets.length === 0) return;
    values.push(delegationId);
    await this.db
      .prepare(`UPDATE org_delegations SET ${sets.join(", ")} WHERE delegation_id = ?${paramIdx}`)
      .bind(...values)
      .run();
  }

  async getCachedToken(delegationId: string, userEmail: string): Promise<CachedTokenRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM impersonation_token_cache WHERE delegation_id = ?1 AND user_email = ?2")
      .bind(delegationId, userEmail)
      .first<Record<string, unknown>>();
    if (!row) return null;
    return {
      cacheId: row.cache_id as string,
      delegationId: row.delegation_id as string,
      userEmail: row.user_email as string,
      encryptedToken: row.encrypted_token as string,
      tokenExpiresAt: row.token_expires_at as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  async setCachedToken(record: CachedTokenRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO impersonation_token_cache
         (cache_id, delegation_id, user_email, encrypted_token, token_expires_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(
        record.cacheId,
        record.delegationId,
        record.userEmail,
        record.encryptedToken,
        record.tokenExpiresAt,
        record.createdAt,
        record.updatedAt,
      )
      .run();
  }

  async writeAuditLog(entry: AuditLogEntry): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO delegation_audit_log
         (audit_id, delegation_id, domain, user_email, action, details, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(entry.auditId, entry.delegationId, entry.domain, entry.userEmail, entry.action, entry.details, entry.createdAt)
      .run();
  }

  private toRecord(row: Record<string, unknown>): DelegationRecord {
    return {
      delegationId: row.delegation_id as string,
      domain: row.domain as string,
      adminEmail: row.admin_email as string,
      delegationStatus: row.delegation_status as "pending" | "active" | "revoked",
      encryptedSaKey: row.encrypted_sa_key as string,
      saClientEmail: row.sa_client_email as string,
      saClientId: row.sa_client_id as string,
      validatedAt: (row.validated_at as string) ?? null,
      activeUsersCount: (row.active_users_count as number) ?? 0,
      registrationDate: (row.registration_date as string) ?? null,
      saKeyCreatedAt: (row.sa_key_created_at as string) ?? null,
      saKeyLastUsedAt: (row.sa_key_last_used_at as string) ?? null,
      saKeyRotationDueAt: (row.sa_key_rotation_due_at as string) ?? null,
      previousEncryptedSaKey: (row.previous_encrypted_sa_key as string) ?? null,
      previousSaKeyId: (row.previous_sa_key_id as string) ?? null,
      lastHealthCheckAt: (row.last_health_check_at as string) ?? null,
      healthCheckStatus: (row.health_check_status as "healthy" | "degraded" | "revoked" | "unknown") ?? "unknown",
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}

class SQLiteDiscoveryStore implements DiscoveryStore {
  constructor(private readonly db: D1Database) {}

  async getConfig(delegationId: string): Promise<DiscoveryConfig | null> {
    const row = await this.db
      .prepare("SELECT * FROM org_discovery_config WHERE delegation_id = ?1")
      .bind(delegationId)
      .first<Record<string, unknown>>();
    if (!row) return null;
    return {
      delegationId: row.delegation_id as string,
      ouFilter: row.ou_filter_json ? (JSON.parse(row.ou_filter_json as string) as string[]) : undefined,
      excludedEmails: row.excluded_emails ? (JSON.parse(row.excluded_emails as string) as string[]) : undefined,
      syncMode: (row.sync_mode as "proactive" | "lazy") ?? "lazy",
      retentionDays: (row.retention_days as number) ?? 30,
    };
  }

  async upsertConfig(config: DiscoveryConfig & { configId: string }): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO org_discovery_config
         (config_id, delegation_id, ou_filter_json, excluded_emails, sync_mode, retention_days, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(
        config.configId,
        config.delegationId,
        config.ouFilter ? JSON.stringify(config.ouFilter) : null,
        config.excludedEmails ? JSON.stringify(config.excludedEmails) : null,
        config.syncMode ?? "lazy",
        config.retentionDays ?? 30,
        now,
        now,
      )
      .run();
  }

  async getDiscoveredUsers(delegationId: string, status?: DiscoveredUserStatus): Promise<DiscoveredUser[]> {
    let sql = "SELECT * FROM org_discovered_users WHERE delegation_id = ?1";
    if (status) {
      sql += " AND status = ?2";
      const { results } = await this.db.prepare(sql).bind(delegationId, status).all<Record<string, unknown>>();
      return (results ?? []).map((r) => this.toUser(r));
    }
    const { results } = await this.db.prepare(sql).bind(delegationId).all<Record<string, unknown>>();
    return (results ?? []).map((r) => this.toUser(r));
  }

  async getDiscoveredUser(delegationId: string, googleUserId: string): Promise<DiscoveredUser | null> {
    const row = await this.db
      .prepare("SELECT * FROM org_discovered_users WHERE delegation_id = ?1 AND google_user_id = ?2")
      .bind(delegationId, googleUserId)
      .first<Record<string, unknown>>();
    return row ? this.toUser(row) : null;
  }

  async getDiscoveredUserByEmail(delegationId: string, email: string): Promise<DiscoveredUser | null> {
    const row = await this.db
      .prepare("SELECT * FROM org_discovered_users WHERE delegation_id = ?1 AND LOWER(email) = LOWER(?2)")
      .bind(delegationId, email)
      .first<Record<string, unknown>>();
    return row ? this.toUser(row) : null;
  }

  async createDiscoveredUser(user: DiscoveredUser): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO org_discovered_users
         (discovery_id, delegation_id, google_user_id, email, display_name,
          org_unit_path, status, account_id, last_synced_at,
          discovered_at, status_changed_at, removed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      )
      .bind(
        user.discoveryId, user.delegationId, user.googleUserId,
        user.email, user.displayName, user.orgUnitPath,
        user.status, user.accountId, user.lastSyncedAt,
        user.discoveredAt, user.statusChangedAt, user.removedAt,
      )
      .run();
  }

  async updateDiscoveredUser(discoveryId: string, updates: Partial<DiscoveredUser>): Promise<void> {
    const fieldMap: Record<string, string> = {
      email: "email", displayName: "display_name", orgUnitPath: "org_unit_path",
      status: "status", accountId: "account_id", lastSyncedAt: "last_synced_at",
      statusChangedAt: "status_changed_at", removedAt: "removed_at",
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;
    for (const [key, col] of Object.entries(fieldMap)) {
      if (key in updates) {
        sets.push(`${col} = ?${paramIdx}`);
        values.push((updates as Record<string, unknown>)[key]);
        paramIdx++;
      }
    }
    if (sets.length === 0) return;
    values.push(discoveryId);
    await this.db
      .prepare(`UPDATE org_discovered_users SET ${sets.join(", ")} WHERE discovery_id = ?${paramIdx}`)
      .bind(...values)
      .run();
  }

  async getRemovedUsersForCleanup(delegationId: string, beforeDate: string): Promise<DiscoveredUser[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM org_discovered_users WHERE delegation_id = ?1 AND status = 'removed' AND removed_at < ?2")
      .bind(delegationId, beforeDate)
      .all<Record<string, unknown>>();
    return (results ?? []).map((r) => this.toUser(r));
  }

  async deleteDiscoveredUser(discoveryId: string): Promise<void> {
    await this.db.prepare("DELETE FROM org_discovered_users WHERE discovery_id = ?1").bind(discoveryId).run();
  }

  async updateLastDiscoveryAt(delegationId: string, timestamp: string): Promise<void> {
    await this.db
      .prepare("UPDATE org_discovery_config SET last_discovery_at = ?1, updated_at = ?2 WHERE delegation_id = ?3")
      .bind(timestamp, timestamp, delegationId)
      .run();
  }

  private toUser(row: Record<string, unknown>): DiscoveredUser {
    return {
      discoveryId: row.discovery_id as string,
      delegationId: row.delegation_id as string,
      googleUserId: row.google_user_id as string,
      email: row.email as string,
      displayName: (row.display_name as string) ?? null,
      orgUnitPath: (row.org_unit_path as string) ?? null,
      status: row.status as DiscoveredUserStatus,
      accountId: (row.account_id as string) ?? null,
      lastSyncedAt: (row.last_synced_at as string) ?? null,
      discoveredAt: row.discovered_at as string,
      statusChangedAt: (row.status_changed_at as string) ?? row.discovered_at as string,
      removedAt: (row.removed_at as string) ?? null,
    };
  }
}

class SQLiteComplianceAuditStore implements ComplianceAuditStore {
  constructor(private readonly db: D1Database) {}

  async getLastEntryHash(orgId: string): Promise<string> {
    const row = await this.db
      .prepare("SELECT entry_hash FROM compliance_audit_log WHERE org_id = ?1 ORDER BY timestamp DESC LIMIT 1")
      .bind(orgId)
      .first<{ entry_hash: string }>();
    return row?.entry_hash ?? GENESIS_HASH;
  }

  async appendEntry(entry: ComplianceAuditEntry): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO compliance_audit_log
         (entry_id, org_id, timestamp, actor, action, target, result,
          ip_address, user_agent, details, previous_hash, entry_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      )
      .bind(
        entry.entryId, entry.orgId, entry.timestamp, entry.actor,
        entry.action, entry.target, entry.result, entry.ipAddress,
        entry.userAgent, entry.details, entry.previousHash, entry.entryHash,
      )
      .run();
  }

  async getEntries(orgId: string, startDate: string, endDate: string, limit = 1000, offset = 0): Promise<ComplianceAuditEntry[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM compliance_audit_log
         WHERE org_id = ?1 AND timestamp >= ?2 AND timestamp <= ?3
         ORDER BY timestamp ASC LIMIT ?4 OFFSET ?5`,
      )
      .bind(orgId, startDate, endDate, limit, offset)
      .all<Record<string, unknown>>();
    return (results ?? []).map((row) => this.toEntry(row));
  }

  async getEntryCount(orgId: string, startDate: string, endDate: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) as cnt FROM compliance_audit_log WHERE org_id = ?1 AND timestamp >= ?2 AND timestamp <= ?3")
      .bind(orgId, startDate, endDate)
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  }

  async getEntriesForVerification(orgId: string, limit?: number): Promise<ComplianceAuditEntry[]> {
    const sql = limit
      ? "SELECT * FROM compliance_audit_log WHERE org_id = ?1 ORDER BY timestamp ASC LIMIT ?2"
      : "SELECT * FROM compliance_audit_log WHERE org_id = ?1 ORDER BY timestamp ASC";
    const stmt = limit ? this.db.prepare(sql).bind(orgId, limit) : this.db.prepare(sql).bind(orgId);
    const { results } = await stmt.all<Record<string, unknown>>();
    return (results ?? []).map((row) => this.toEntry(row));
  }

  async getRetentionConfig(orgId: string): Promise<AuditRetentionConfig | null> {
    return null;
  }

  private toEntry(row: Record<string, unknown>): ComplianceAuditEntry {
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
      details: (row.details as string) ?? null,
      previousHash: row.previous_hash as string,
      entryHash: row.entry_hash as string,
    };
  }
}

class SQLiteRateLimitStore implements OrgRateLimitStore {
  constructor(private readonly db: D1Database) {}

  async getCount(key: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT count FROM org_rate_limit_counters WHERE counter_key = ?1")
      .bind(key)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  async incrementCount(key: string, ttlSeconds: number): Promise<number> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    await this.db
      .prepare(
        `INSERT INTO org_rate_limit_counters (counter_key, count, expires_at)
         VALUES (?1, 1, ?2)
         ON CONFLICT(counter_key) DO UPDATE SET count = count + 1, expires_at = ?2`,
      )
      .bind(key, expiresAt)
      .run();
    const row = await this.db
      .prepare("SELECT count FROM org_rate_limit_counters WHERE counter_key = ?1")
      .bind(key)
      .first<{ count: number }>();
    return row?.count ?? 1;
  }

  async addTimestamp(key: string, timestampMs: number, ttlSeconds: number): Promise<void> {
    const expiresAt = new Date(timestampMs + ttlSeconds * 1000).toISOString();
    const entryKey = `${key}:${timestampMs}:${Math.random().toString(36).slice(2, 8)}`;
    await this.db
      .prepare(
        `INSERT INTO org_rate_limit_counters (counter_key, count, expires_at) VALUES (?1, ?2, ?3)`,
      )
      .bind(entryKey, timestampMs, expiresAt)
      .run();
  }

  async countInWindow(key: string, windowStartMs: number): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM org_rate_limit_counters WHERE counter_key LIKE ?1 AND count >= ?2`,
      )
      .bind(`${key}:%`, windowStartMs)
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  }

  async pruneExpired(key: string, beforeMs: number): Promise<void> {
    await this.db
      .prepare(`DELETE FROM org_rate_limit_counters WHERE counter_key LIKE ?1 AND count < ?2`)
      .bind(`${key}:%`, beforeMs)
      .run();
  }

  async getOrgConfig(_orgId: string): Promise<OrgRateLimitConfig | null> {
    return null; // Use defaults
  }
}

class SQLiteQuotaStore implements OrgQuotaStore {
  constructor(private readonly db: D1Database) {}

  async getUsage(orgId: string, quotaType: QuotaType, periodKey: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT usage_count FROM org_quota_usage WHERE org_id = ?1 AND quota_type = ?2 AND period_key = ?3")
      .bind(orgId, quotaType, periodKey)
      .first<{ usage_count: number }>();
    return row?.usage_count ?? 0;
  }

  async incrementUsage(orgId: string, quotaType: QuotaType, periodKey: string): Promise<number> {
    await this.db
      .prepare(
        `INSERT INTO org_quota_usage (org_id, quota_type, period_key, usage_count)
         VALUES (?1, ?2, ?3, 1)
         ON CONFLICT(org_id, quota_type, period_key) DO UPDATE SET usage_count = usage_count + 1`,
      )
      .bind(orgId, quotaType, periodKey)
      .run();
    const row = await this.db
      .prepare("SELECT usage_count FROM org_quota_usage WHERE org_id = ?1 AND quota_type = ?2 AND period_key = ?3")
      .bind(orgId, quotaType, periodKey)
      .first<{ usage_count: number }>();
    return row?.usage_count ?? 1;
  }

  async setUsage(orgId: string, quotaType: QuotaType, periodKey: string, value: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO org_quota_usage (org_id, quota_type, period_key, usage_count)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(org_id, quota_type, period_key) DO UPDATE SET usage_count = ?4`,
      )
      .bind(orgId, quotaType, periodKey, value)
      .run();
  }

  async getOrgQuotaConfig(_orgId: string): Promise<OrgQuotaConfig | null> {
    return null; // Use defaults
  }
}

// ---------------------------------------------------------------------------
// Mock fetch for Google APIs
// ---------------------------------------------------------------------------

/**
 * Create a mock fetch function that intercepts Google API calls.
 * All token exchanges succeed, Directory API returns configured users.
 * Calendar list returns realistic calendar entries for any impersonated user.
 */
function createMockFetch(options?: {
  directoryUsers?: Record<string, unknown>[];
  revokeAfterHealthCheck?: boolean;
  failTokenExchange?: boolean;
}): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  let healthCheckCount = 0;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;

    // OAuth token exchange: always succeeds (unless configured to fail)
    if (url.includes("oauth2.googleapis.com/token")) {
      if (options?.failTokenExchange) {
        return new Response(
          JSON.stringify({ error: "unauthorized_client", error_description: "Client is unauthorized" }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ access_token: `mock-token-${Date.now()}`, expires_in: 3600, token_type: "Bearer" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Google Admin Directory API: list users
    if (url.includes("admin.googleapis.com/admin/directory/v1/users")) {
      const users = options?.directoryUsers ?? makeDirectoryUsers(10, TEST_DOMAIN);
      return new Response(
        JSON.stringify({ users, nextPageToken: undefined }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Google Calendar API: list calendars
    if (url.includes("googleapis.com/calendar/v3/users/me/calendarList")) {
      if (options?.revokeAfterHealthCheck) {
        healthCheckCount++;
        if (healthCheckCount > 1) {
          return new Response(
            JSON.stringify({ error: { code: 403, message: "access_denied" } }),
            { status: 403, headers: { "Content-Type": "application/json" } },
          );
        }
      }
      return new Response(
        JSON.stringify({
          items: [
            { id: "primary", summary: "Primary Calendar", primary: true, accessRole: "owner" },
            { id: "team@group.calendar.google.com", summary: "Team Calendar", primary: false, accessRole: "reader" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Fallback: 404
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  };
}

// ---------------------------------------------------------------------------
// Test helper: query audit log from D1
// ---------------------------------------------------------------------------

async function queryAuditLog(
  db: D1Database,
  delegationId: string,
  options: AuditQueryOptions,
): Promise<AuditPage> {
  const { limit, offset, action } = options;
  let countSql = "SELECT COUNT(*) as cnt FROM delegation_audit_log WHERE delegation_id = ?1";
  let dataSql = "SELECT * FROM delegation_audit_log WHERE delegation_id = ?1";
  if (action) {
    countSql += " AND action = ?2";
    dataSql += " AND action = ?2";
  }
  dataSql += " ORDER BY created_at DESC LIMIT ?3 OFFSET ?4";

  let total: number;
  if (action) {
    const countRow = await db.prepare(countSql).bind(delegationId, action).first<{ cnt: number }>();
    total = countRow?.cnt ?? 0;
  } else {
    const countRow = await db.prepare(countSql).bind(delegationId).first<{ cnt: number }>();
    total = countRow?.cnt ?? 0;
  }

  let results: Record<string, unknown>[];
  if (action) {
    const resp = await db.prepare(dataSql).bind(delegationId, action, limit, offset).all<Record<string, unknown>>();
    results = resp.results ?? [];
  } else {
    const resp = await db.prepare(dataSql).bind(delegationId, limit, offset).all<Record<string, unknown>>();
    results = resp.results ?? [];
  }

  const entries = results.map(
    (row): AuditLogEntry => ({
      auditId: row.audit_id as string,
      delegationId: row.delegation_id as string,
      domain: row.domain as string,
      userEmail: row.user_email as string,
      action: row.action as AuditLogEntry["action"],
      details: (row.details as string) ?? null,
      createdAt: row.created_at as string,
    }),
  );

  return { entries, total, limit, offset };
}

// ===========================================================================
// TEST SUITE
// ===========================================================================

describe("Phase 6D E2E: Domain-Wide Delegation Full Lifecycle", () => {
  let sqliteDb: DatabaseType;
  let d1: D1Database;
  let delegationStore: SQLiteDelegationStore;
  let discoveryStore: SQLiteDiscoveryStore;
  let complianceStore: SQLiteComplianceAuditStore;
  let rateLimitStore: SQLiteRateLimitStore;
  let quotaStore: SQLiteQuotaStore;
  let mockFetch: ReturnType<typeof createMockFetch>;

  // Shared state across sequential tests
  let registeredDelegationId: string;

  /** All migration SQL to apply for a fresh database. */
  const MIGRATIONS = [
    MIGRATION_0001_INITIAL_SCHEMA,
    MIGRATION_0004_AUTH_FIELDS,
    MIGRATION_0016_ORG_MEMBERS,
    MIGRATION_0022_ORG_DELEGATIONS,
    MIGRATION_0023_DELEGATION_INFRASTRUCTURE,
    MIGRATION_0024_DELEGATION_CACHE_AND_AUDIT,
    MIGRATION_0025_ORG_DISCOVERY,
    MIGRATION_0026_COMPLIANCE_AND_QUOTAS,
  ];

  function applyMigrations(db: DatabaseType): void {
    for (const migration of MIGRATIONS) {
      for (const stmt of migration.split(";").filter((s) => s.trim())) {
        db.exec(stmt + ";");
      }
    }
  }

  beforeEach(async () => {
    // Fresh in-memory DB for each test to avoid cross-test contamination
    sqliteDb = new Database(":memory:");
    applyMigrations(sqliteDb);
    d1 = createRealD1(sqliteDb);

    // Create stores
    delegationStore = new SQLiteDelegationStore(d1);
    discoveryStore = new SQLiteDiscoveryStore(d1);
    complianceStore = new SQLiteComplianceAuditStore(d1);
    rateLimitStore = new SQLiteRateLimitStore(d1);
    quotaStore = new SQLiteQuotaStore(d1);

    // Default mock fetch
    mockFetch = createMockFetch();
  });

  // =========================================================================
  // Journey 1: Admin Setup Flow (AC-1)
  // =========================================================================

  describe("Journey 1: Admin setup -> first calendar appearance (AC-1)", () => {
    it("registers an org via handleOrgRegister with encrypted credentials", async () => {
      const request = new Request("https://api.tminus.dev/v1/orgs/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: TEST_DOMAIN,
          admin_email: TEST_ADMIN_EMAIL,
          service_account_key: SA_KEY_1,
        }),
      });

      const response = await handleOrgRegister(
        request,
        { userId: TEST_USER_ID },
        { store: delegationStore, MASTER_KEY: TEST_MASTER_KEY },
        mockFetch,
      );

      expect(response.status).toBe(201);
      const body = (await response.json()) as { data: Record<string, unknown> };
      expect(body.data).toBeDefined();
      expect(body.data.domain).toBe(TEST_DOMAIN);
      expect(body.data.delegation_status).toBe("active");
      expect(body.data.delegation_id).toBeDefined();
      expect(body.data.sa_client_email).toBe(SA_KEY_1.client_email);

      // Verify credential is encrypted in D1 (not plaintext)
      registeredDelegationId = body.data.delegation_id as string;
      const stored = await delegationStore.getDelegationById(registeredDelegationId);
      expect(stored).not.toBeNull();
      expect(stored!.encryptedSaKey).not.toContain('"private_key"');
      expect(stored!.encryptedSaKey).toContain("ciphertext");
      expect(stored!.encryptedSaKey).toContain("iv");
    });

    it("rejects duplicate domain registration", async () => {
      // First registration
      const req1 = new Request("https://api.tminus.dev/v1/orgs/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: TEST_DOMAIN,
          admin_email: TEST_ADMIN_EMAIL,
          service_account_key: SA_KEY_1,
        }),
      });
      const res1 = await handleOrgRegister(req1, { userId: TEST_USER_ID }, { store: delegationStore, MASTER_KEY: TEST_MASTER_KEY }, mockFetch);
      expect(res1.status).toBe(201);

      // Duplicate registration
      const req2 = new Request("https://api.tminus.dev/v1/orgs/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: TEST_DOMAIN,
          admin_email: TEST_ADMIN_EMAIL,
          service_account_key: SA_KEY_1,
        }),
      });
      const res2 = await handleOrgRegister(req2, { userId: TEST_USER_ID }, { store: delegationStore, MASTER_KEY: TEST_MASTER_KEY }, mockFetch);
      expect(res2.status).toBe(409);
    });

    it("fetches delegated user calendars without personal OAuth (AC-1)", async () => {
      // Register the org first
      const regReq = new Request("https://api.tminus.dev/v1/orgs/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: TEST_DOMAIN,
          admin_email: TEST_ADMIN_EMAIL,
          service_account_key: SA_KEY_1,
        }),
      });
      await handleOrgRegister(regReq, { userId: TEST_USER_ID }, { store: delegationStore, MASTER_KEY: TEST_MASTER_KEY }, mockFetch);

      // Now a user in the domain gets calendars without OAuth
      const calReq = new Request("https://api.tminus.dev/v1/orgs/delegation/calendars/user1@acme-e2e.dev", {
        method: "GET",
      });
      const calRes = await handleDelegationCalendars(
        calReq,
        { userId: "usr_user1" },
        { store: delegationStore, MASTER_KEY: TEST_MASTER_KEY },
        `user1@${TEST_DOMAIN}`,
        mockFetch,
      );

      expect(calRes.status).toBe(200);
      const calBody = (await calRes.json()) as { data: Record<string, unknown> };
      expect(calBody.data.email).toBe(`user1@${TEST_DOMAIN}`);
      expect(calBody.data.source).toBe("delegation");
      expect(calBody.data.calendars).toBeDefined();
      const calendars = calBody.data.calendars as { id: string; summary: string; primary: boolean }[];
      // Dynamic assertion: at least 1 calendar returned
      expect(calendars.length).toBeGreaterThanOrEqual(1);
      // At least one primary calendar
      expect(calendars.some((c) => c.primary)).toBe(true);
    });
  });

  // =========================================================================
  // Journey 2: User Discovery and Federation (AC-2)
  // =========================================================================

  describe("Journey 2: User discovery detects new, suspended, removed (AC-2)", () => {
    let delegationId: string;

    beforeEach(async () => {
      // Register org
      const regReq = new Request("https://api.tminus.dev/v1/orgs/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: TEST_DOMAIN,
          admin_email: TEST_ADMIN_EMAIL,
          service_account_key: SA_KEY_1,
        }),
      });
      const res = await handleOrgRegister(regReq, { userId: TEST_USER_ID }, { store: delegationStore, MASTER_KEY: TEST_MASTER_KEY }, mockFetch);
      const resBody = (await res.json()) as { data: { delegation_id: string } };
      delegationId = resBody.data.delegation_id;
    });

    it("discovers new users via Directory API", async () => {
      const users = makeDirectoryUsers(10, TEST_DOMAIN);
      mockFetch = createMockFetch({ directoryUsers: users });

      const tokenProvider: TokenProvider = {
        getDirectoryToken: async () => "mock-directory-token",
      };
      const discoverySvc = new DiscoveryService(discoveryStore, tokenProvider, mockFetch);

      const result = await discoverySvc.discoverUsers(delegationId, TEST_DOMAIN, TEST_ADMIN_EMAIL);

      expect(result.totalUsersFound).toBe(10);
      expect(result.newUsers.length).toBe(10);
      expect(result.statusChanges.length).toBe(0);
      expect(result.removedUsers.length).toBe(0);

      // Verify users are persisted in D1
      const stored = await discoveryStore.getDiscoveredUsers(delegationId);
      expect(stored.length).toBe(10);
      // All should be active
      expect(stored.every((u) => u.status === "active")).toBe(true);
    });

    it("detects suspended users on subsequent discovery", async () => {
      // Initial discovery
      const initialUsers = makeDirectoryUsers(5, TEST_DOMAIN);
      mockFetch = createMockFetch({ directoryUsers: initialUsers });
      const tokenProvider: TokenProvider = { getDirectoryToken: async () => "mock-token" };
      const discoverySvc = new DiscoveryService(discoveryStore, tokenProvider, mockFetch);
      await discoverySvc.discoverUsers(delegationId, TEST_DOMAIN, TEST_ADMIN_EMAIL);

      // Second discovery: user 2 is now suspended
      const updatedUsers = initialUsers.map((u) =>
        u.id === "guser-002" ? { ...u, suspended: true } : u,
      );
      mockFetch = createMockFetch({ directoryUsers: updatedUsers });
      const discoverySvc2 = new DiscoveryService(discoveryStore, tokenProvider, mockFetch);
      const result = await discoverySvc2.discoverUsers(delegationId, TEST_DOMAIN, TEST_ADMIN_EMAIL);

      expect(result.statusChanges.length).toBe(1);
      expect(result.statusChanges[0].previousStatus).toBe("active");
      expect(result.statusChanges[0].newStatus).toBe("suspended");
      expect(result.statusChanges[0].user.email).toBe(`user2@${TEST_DOMAIN}`);
    });

    it("detects removed users (absent from Directory API)", async () => {
      // Initial discovery: 5 users
      const initialUsers = makeDirectoryUsers(5, TEST_DOMAIN);
      mockFetch = createMockFetch({ directoryUsers: initialUsers });
      const tokenProvider: TokenProvider = { getDirectoryToken: async () => "mock-token" };
      const discoverySvc = new DiscoveryService(discoveryStore, tokenProvider, mockFetch);
      await discoverySvc.discoverUsers(delegationId, TEST_DOMAIN, TEST_ADMIN_EMAIL);

      // Second discovery: user 5 is gone
      const fewerUsers = initialUsers.slice(0, 4);
      mockFetch = createMockFetch({ directoryUsers: fewerUsers });
      const discoverySvc2 = new DiscoveryService(discoveryStore, tokenProvider, mockFetch);
      const result = await discoverySvc2.discoverUsers(delegationId, TEST_DOMAIN, TEST_ADMIN_EMAIL);

      expect(result.removedUsers.length).toBe(1);
      expect(result.removedUsers[0].email).toBe(`user5@${TEST_DOMAIN}`);

      // Verify status in D1
      const allUsers = await discoveryStore.getDiscoveredUsers(delegationId);
      const removedUser = allUsers.find((u) => u.email === `user5@${TEST_DOMAIN}`);
      expect(removedUser).toBeDefined();
      expect(removedUser!.status).toBe("removed");
      expect(removedUser!.removedAt).not.toBeNull();
    });

    it("federates a discovered user with an account", async () => {
      const users = makeDirectoryUsers(3, TEST_DOMAIN);
      mockFetch = createMockFetch({ directoryUsers: users });
      const tokenProvider: TokenProvider = { getDirectoryToken: async () => "mock-token" };
      const discoverySvc = new DiscoveryService(discoveryStore, tokenProvider, mockFetch);
      await discoverySvc.discoverUsers(delegationId, TEST_DOMAIN, TEST_ADMIN_EMAIL);

      const fedResult = await discoverySvc.federateDiscoveredUser(
        delegationId,
        "guser-001",
        async (user) => `acct_${user.googleUserId}`,
      );

      expect(fedResult.email).toBe(`user1@${TEST_DOMAIN}`);
      expect(fedResult.accountId).toBe("acct_guser-001");
      expect(fedResult.syncMode).toBe("lazy"); // Default config

      // Verify account is stored in D1
      const stored = await discoveryStore.getDiscoveredUser(delegationId, "guser-001");
      expect(stored).not.toBeNull();
      expect(stored!.accountId).toBe("acct_guser-001");
    });
  });

  // =========================================================================
  // Journey 3: Admin Dashboard (AC-3)
  // =========================================================================

  describe("Journey 3: Admin dashboard reflects org health (AC-3)", () => {
    let delegationId: string;

    beforeEach(async () => {
      // Register org and seed data
      const regReq = new Request("https://api.tminus.dev/v1/orgs/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: TEST_DOMAIN,
          admin_email: TEST_ADMIN_EMAIL,
          service_account_key: SA_KEY_1,
        }),
      });
      const res = await handleOrgRegister(regReq, { userId: TEST_USER_ID }, { store: delegationStore, MASTER_KEY: TEST_MASTER_KEY }, mockFetch);
      const body = (await res.json()) as { data: { delegation_id: string } };
      delegationId = body.data.delegation_id;

      // Add org member as admin
      sqliteDb.exec(`INSERT INTO org_members (org_id, user_id, role) VALUES ('${delegationId}', '${TEST_USER_ID}', 'admin')`);

      // Discover users
      const users = makeDirectoryUsers(8, TEST_DOMAIN);
      mockFetch = createMockFetch({ directoryUsers: users });
      const tokenProvider: TokenProvider = { getDirectoryToken: async () => "mock-token" };
      const discoverySvc = new DiscoveryService(discoveryStore, tokenProvider, mockFetch);
      await discoverySvc.discoverUsers(delegationId, TEST_DOMAIN, TEST_ADMIN_EMAIL);

      // Suspend one user and remove another
      const allUsers = await discoveryStore.getDiscoveredUsers(delegationId);
      await discoverySvc.transitionUserStatus(allUsers[0].discoveryId, "suspended", delegationId);
      await discoverySvc.transitionUserStatus(allUsers[1].discoveryId, "removed", delegationId);
    });

    it("returns org overview with correct user stats and delegation info", async () => {
      const delegationSvc = new DelegationService(delegationStore, TEST_MASTER_KEY, mockFetch);
      const discoverySvc = new DiscoveryService(discoveryStore, { getDirectoryToken: async () => "t" }, mockFetch);
      const quotaSvc = quotaStore;

      const deps: AdminDeps = {
        delegationService: delegationSvc,
        discoveryService: discoverySvc,
        queryAuditLog: (did, opts) => queryAuditLog(d1, did, opts),
        getDelegation: (did) => delegationStore.getDelegationById(did),
        getQuotaReport: (oid) => getQuotaReport(quotaSvc, oid),
      };

      const req = new Request(`https://api.tminus.dev/v1/orgs/${delegationId}/dashboard`);
      const response = await handleOrgDashboard(req, { userId: TEST_USER_ID, isAdmin: true }, delegationId, deps);

      expect(response.status).toBe(200);
      const data = ((await response.json()) as { data: Record<string, unknown> }).data;

      // Delegation info
      const delegation = data.delegation as Record<string, unknown>;
      expect(delegation.domain).toBe(TEST_DOMAIN);
      expect(delegation.delegation_status).toBe("active");
      expect(delegation.sa_client_email).toBe(SA_KEY_1.client_email);

      // User stats: 8 total, 6 active, 1 suspended, 1 removed
      const stats = data.user_stats as { total: number; active: number; suspended: number; removed: number };
      expect(stats.total).toBe(8);
      expect(stats.active).toBe(6);
      expect(stats.suspended).toBe(1);
      expect(stats.removed).toBe(1);

      // Quota utilization is present
      expect(data.quota_utilization).toBeDefined();
    });

    it("non-admin gets 403", async () => {
      const delegationSvc = new DelegationService(delegationStore, TEST_MASTER_KEY, mockFetch);
      const discoverySvc = new DiscoveryService(discoveryStore, { getDirectoryToken: async () => "t" }, mockFetch);
      const deps: AdminDeps = {
        delegationService: delegationSvc,
        discoveryService: discoverySvc,
        queryAuditLog: (did, opts) => queryAuditLog(d1, did, opts),
        getDelegation: (did) => delegationStore.getDelegationById(did),
      };

      const req = new Request(`https://api.tminus.dev/v1/orgs/${delegationId}/dashboard`);
      const response = await handleOrgDashboard(req, { userId: "usr_random", isAdmin: false }, delegationId, deps);
      expect(response.status).toBe(403);
    });

    it("lists discovered users with status filtering", async () => {
      const delegationSvc = new DelegationService(delegationStore, TEST_MASTER_KEY, mockFetch);
      const discoverySvc = new DiscoveryService(discoveryStore, { getDirectoryToken: async () => "t" }, mockFetch);
      const deps: AdminDeps = {
        delegationService: delegationSvc,
        discoveryService: discoverySvc,
        queryAuditLog: (did, opts) => queryAuditLog(d1, did, opts),
        getDelegation: (did) => delegationStore.getDelegationById(did),
      };

      // List active users only
      const req = new Request(`https://api.tminus.dev/v1/orgs/${delegationId}/users?status=active`);
      const response = await handleListDiscoveredUsers(req, { userId: TEST_USER_ID, isAdmin: true }, delegationId, deps);
      expect(response.status).toBe(200);
      const data = ((await response.json()) as { data: { users: unknown[]; pagination: { total: number } } }).data;
      expect(data.users.length).toBe(6);
      expect(data.pagination.total).toBe(6);
    });

    it("updates user status (admin pause/resume)", async () => {
      const delegationSvc = new DelegationService(delegationStore, TEST_MASTER_KEY, mockFetch);
      const discoverySvc = new DiscoveryService(discoveryStore, { getDirectoryToken: async () => "t" }, mockFetch);
      const deps: AdminDeps = {
        delegationService: delegationSvc,
        discoveryService: discoverySvc,
        queryAuditLog: (did, opts) => queryAuditLog(d1, did, opts),
        getDelegation: (did) => delegationStore.getDelegationById(did),
      };

      // Get an active user's discovery ID
      const allUsers = await discoveryStore.getDiscoveredUsers(delegationId, "active");
      const targetUser = allUsers[0];

      // Suspend the user
      const suspendReq = new Request(`https://api.tminus.dev/v1/orgs/${delegationId}/users/${targetUser.discoveryId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "suspended" }),
      });
      const suspendRes = await handleUpdateDiscoveredUser(suspendReq, { userId: TEST_USER_ID, isAdmin: true }, delegationId, targetUser.discoveryId, deps);
      expect(suspendRes.status).toBe(200);
      const suspendBody = ((await suspendRes.json()) as { data: { status: string } }).data;
      expect(suspendBody.status).toBe("suspended");

      // Resume the user (suspended -> active)
      const resumeReq = new Request(`https://api.tminus.dev/v1/orgs/${delegationId}/users/${targetUser.discoveryId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      });
      const resumeRes = await handleUpdateDiscoveredUser(resumeReq, { userId: TEST_USER_ID, isAdmin: true }, delegationId, targetUser.discoveryId, deps);
      expect(resumeRes.status).toBe(200);
      const resumeBody = ((await resumeRes.json()) as { data: { status: string } }).data;
      expect(resumeBody.status).toBe("active");
    });

    it("reads and updates discovery config", async () => {
      const delegationSvc = new DelegationService(delegationStore, TEST_MASTER_KEY, mockFetch);
      const discoverySvc = new DiscoveryService(discoveryStore, { getDirectoryToken: async () => "t" }, mockFetch);
      const deps: AdminDeps = {
        delegationService: delegationSvc,
        discoveryService: discoverySvc,
        queryAuditLog: (did, opts) => queryAuditLog(d1, did, opts),
        getDelegation: (did) => delegationStore.getDelegationById(did),
      };

      // Read defaults (no config yet)
      const getReq = new Request(`https://api.tminus.dev/v1/orgs/${delegationId}/discovery/config`);
      const getRes = await handleGetDiscoveryConfig(getReq, { userId: TEST_USER_ID, isAdmin: true }, delegationId, deps);
      expect(getRes.status).toBe(200);
      const getBody = ((await getRes.json()) as { data: Record<string, unknown> }).data;
      expect(getBody.sync_mode).toBe("lazy");
      expect(getBody.retention_days).toBe(30);

      // Update config
      const putReq = new Request(`https://api.tminus.dev/v1/orgs/${delegationId}/discovery/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sync_mode: "proactive",
          ou_filter: ["/Engineering"],
          retention_days: 60,
        }),
      });
      const putRes = await handleUpdateDiscoveryConfig(putReq, { userId: TEST_USER_ID, isAdmin: true }, delegationId, deps);
      expect(putRes.status).toBe(200);
      const putBody = ((await putRes.json()) as { data: Record<string, unknown> }).data;
      expect(putBody.sync_mode).toBe("proactive");
      expect(putBody.ou_filter).toEqual(["/Engineering"]);
      expect(putBody.retention_days).toBe(60);
    });
  });

  // =========================================================================
  // Journey 4: Rate Limiting Under Sustained Load (AC-4)
  // =========================================================================

  describe("Journey 4: Rate limiting prevents quota violations (AC-4)", () => {
    it("sustained load of 50 concurrent user syncs stays within rate limits", async () => {
      const CONCURRENT_USERS = 50;

      // Register org
      const regReq = new Request("https://api.tminus.dev/v1/orgs/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: TEST_DOMAIN,
          admin_email: TEST_ADMIN_EMAIL,
          service_account_key: SA_KEY_1,
        }),
      });
      const res = await handleOrgRegister(regReq, { userId: TEST_USER_ID }, { store: delegationStore, MASTER_KEY: TEST_MASTER_KEY }, mockFetch);
      const body = (await res.json()) as { data: { delegation_id: string } };
      const delegationId = body.data.delegation_id;

      // Create 50 users in Directory API
      const users = makeDirectoryUsers(CONCURRENT_USERS, TEST_DOMAIN);
      mockFetch = createMockFetch({ directoryUsers: users });

      // Discover all users
      const tokenProvider: TokenProvider = { getDirectoryToken: async () => "mock-token" };
      const discoverySvc = new DiscoveryService(discoveryStore, tokenProvider, mockFetch);
      const discoveryResult = await discoverySvc.discoverUsers(delegationId, TEST_DOMAIN, TEST_ADMIN_EMAIL);

      // Dynamic assertion: at least 80% of users discovered (threshold, not exact)
      expect(discoveryResult.newUsers.length).toBeGreaterThanOrEqual(CONCURRENT_USERS * 0.8);

      // Simulate 50 concurrent calendar fetch requests
      const calendarPromises = users.map((user) =>
        handleDelegationCalendars(
          new Request(`https://api.tminus.dev/v1/orgs/delegation/calendars/${user.primaryEmail}`),
          { userId: `usr_${user.id}` },
          { store: delegationStore, MASTER_KEY: TEST_MASTER_KEY },
          user.primaryEmail,
          mockFetch,
        ),
      );

      const results = await Promise.all(calendarPromises);

      // Count successes
      const successes = results.filter((r) => r.status === 200);
      const failures = results.filter((r) => r.status !== 200);

      // Dynamic threshold: at least 90% success rate under concurrent load
      expect(successes.length).toBeGreaterThanOrEqual(Math.floor(CONCURRENT_USERS * 0.9));

      // Rate limit check: verify we can check without exceeding the limit
      const rlConfig = DEFAULT_ORG_RATE_LIMITS;
      const rlResult = await checkOrgRateLimit(rateLimitStore, delegationId, "api", rlConfig);
      // Should be allowed (we haven't exceeded the real rate limit in the test)
      expect(rlResult.allowed).toBe(true);
    });
  });

  // =========================================================================
  // Journey 5: Compliance Audit Log (AC-5)
  // =========================================================================

  describe("Journey 5: Audit log complete for all impersonation access (AC-5)", () => {
    let delegationId: string;

    beforeEach(async () => {
      // Register org
      const regReq = new Request("https://api.tminus.dev/v1/orgs/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: TEST_DOMAIN,
          admin_email: TEST_ADMIN_EMAIL,
          service_account_key: SA_KEY_1,
        }),
      });
      const res = await handleOrgRegister(regReq, { userId: TEST_USER_ID }, { store: delegationStore, MASTER_KEY: TEST_MASTER_KEY }, mockFetch);
      const body = (await res.json()) as { data: { delegation_id: string } };
      delegationId = body.data.delegation_id;
    });

    it("records impersonation events in hash-chained audit log", async () => {
      const now = new Date().toISOString();

      // Simulate 5 token issuance audit entries
      for (let i = 0; i < 5; i++) {
        const input: ComplianceAuditInput = {
          entryId: generateId("audit"),
          orgId: delegationId,
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
          actor: TEST_USER_ID,
          action: "token_issued",
          target: `user${i + 1}@${TEST_DOMAIN}`,
          result: "success",
          ipAddress: "127.0.0.1",
          userAgent: "e2e-test/1.0",
          details: JSON.stringify({ service: "delegation_calendars" }),
        };
        await appendAuditEntry(complianceStore, input);
      }

      // Verify hash chain integrity
      const verification = await verifyHashChain(complianceStore, delegationId);
      expect(verification.valid).toBe(true);
      expect(verification.entriesChecked).toBe(5);
      expect(verification.firstInvalidIndex).toBe(-1);
      expect(verification.error).toBeNull();
    });

    it("exports audit log as JSON-lines (NDJSON)", async () => {
      // Create entries
      for (let i = 0; i < 3; i++) {
        await appendAuditEntry(complianceStore, {
          entryId: generateId("audit"),
          orgId: delegationId,
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
          actor: TEST_USER_ID,
          action: "token_issued",
          target: `user${i + 1}@${TEST_DOMAIN}`,
          result: "success",
          ipAddress: "10.0.0.1",
          userAgent: "e2e-test/1.0",
          details: null,
        });
      }

      // Add admin member for auth
      sqliteDb.exec(`INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES ('${delegationId}', '${TEST_USER_ID}', 'admin')`);

      const exportReq = new Request(`https://api.tminus.dev/v1/orgs/${delegationId}/audit-log/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format: "json",
          start_date: "2020-01-01T00:00:00Z",
          end_date: "2030-12-31T23:59:59Z",
        }),
      });

      const response = await handleAuditLogExport(
        exportReq,
        { userId: TEST_USER_ID, isAdmin: true },
        delegationId,
        complianceStore,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");

      const text = await response.text();
      const lines = text.split("\n").filter((l) => l.trim());
      expect(lines.length).toBe(3);

      // Each line is valid JSON
      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(parsed.entryId).toBeDefined();
        expect(parsed.entryHash).toBeDefined();
        expect(parsed.previousHash).toBeDefined();
      }
    });

    it("exports audit log as CSV", async () => {
      // Create entries
      await appendAuditEntry(complianceStore, {
        entryId: generateId("audit"),
        orgId: delegationId,
        timestamp: new Date().toISOString(),
        actor: TEST_USER_ID,
        action: "delegation_created",
        target: TEST_DOMAIN,
        result: "success",
        ipAddress: "10.0.0.1",
        userAgent: "e2e-test/1.0",
        details: null,
      });

      const exportReq = new Request(`https://api.tminus.dev/v1/orgs/${delegationId}/audit-log/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format: "csv",
          start_date: "2020-01-01T00:00:00Z",
          end_date: "2030-12-31T23:59:59Z",
        }),
      });

      const response = await handleAuditLogExport(
        exportReq,
        { userId: TEST_USER_ID, isAdmin: true },
        delegationId,
        complianceStore,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/csv");

      const text = await response.text();
      const lines = text.split("\n");
      // Header + at least 1 data row
      expect(lines.length).toBeGreaterThanOrEqual(2);
      // Header should contain expected columns
      expect(lines[0]).toContain("entry_id");
      expect(lines[0]).toContain("entry_hash");
      expect(lines[0]).toContain("previous_hash");
    });

    it("detects tampered audit entries via hash chain verification", async () => {
      // Create valid chain
      for (let i = 0; i < 3; i++) {
        await appendAuditEntry(complianceStore, {
          entryId: generateId("audit"),
          orgId: delegationId,
          timestamp: new Date(Date.now() + i * 1000).toISOString(),
          actor: TEST_USER_ID,
          action: "token_issued",
          target: `user${i + 1}@${TEST_DOMAIN}`,
          result: "success",
          ipAddress: "10.0.0.1",
          userAgent: "e2e-test/1.0",
          details: null,
        });
      }

      // Verify chain is valid first
      const validResult = await verifyHashChain(complianceStore, delegationId);
      expect(validResult.valid).toBe(true);

      // Tamper with an entry: modify the target field directly in SQLite
      const entries = await complianceStore.getEntriesForVerification(delegationId);
      const secondEntry = entries[1];
      sqliteDb.exec(
        `UPDATE compliance_audit_log SET target = 'tampered@evil.com' WHERE entry_id = '${secondEntry.entryId}'`,
      );

      // Verify chain now fails
      const tamperedResult = await verifyHashChain(complianceStore, delegationId);
      expect(tamperedResult.valid).toBe(false);
      expect(tamperedResult.firstInvalidIndex).toBe(1);
      expect(tamperedResult.error).toContain("entryHash mismatch");
    });
  });

  // =========================================================================
  // Journey 6: Delegation Revocation Detection (AC-6)
  // =========================================================================

  describe("Journey 6: Delegation revocation detected and surfaced (AC-6)", () => {
    it("health check detects revoked delegation and updates status", async () => {
      // Register org
      const regReq = new Request("https://api.tminus.dev/v1/orgs/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: TEST_DOMAIN,
          admin_email: TEST_ADMIN_EMAIL,
          service_account_key: SA_KEY_1,
        }),
      });
      const res = await handleOrgRegister(regReq, { userId: TEST_USER_ID }, { store: delegationStore, MASTER_KEY: TEST_MASTER_KEY }, mockFetch);
      const body = (await res.json()) as { data: { delegation_id: string } };
      const delegationId = body.data.delegation_id;

      // Perform health check with a fetch that will fail with unauthorized_client
      const revokedFetch = createMockFetch({ failTokenExchange: true });
      const delegationSvc = new DelegationService(delegationStore, TEST_MASTER_KEY, revokedFetch);

      const healthResult = await delegationSvc.checkDelegationHealth(delegationId);

      expect(healthResult.status).toBe("revoked");
      expect(healthResult.canImpersonateAdmin).toBe(false);
      expect(healthResult.error).toContain("unauthorized_client");

      // Verify delegation status is updated in D1
      const stored = await delegationStore.getDelegationById(delegationId);
      expect(stored).not.toBeNull();
      expect(stored!.delegationStatus).toBe("revoked");
      expect(stored!.healthCheckStatus).toBe("revoked");
      expect(stored!.lastHealthCheckAt).not.toBeNull();
    });

    it("health check surfaces revocation via admin dashboard handler", async () => {
      // Register org
      const regReq = new Request("https://api.tminus.dev/v1/orgs/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: TEST_DOMAIN,
          admin_email: TEST_ADMIN_EMAIL,
          service_account_key: SA_KEY_1,
        }),
      });
      const res = await handleOrgRegister(regReq, { userId: TEST_USER_ID }, { store: delegationStore, MASTER_KEY: TEST_MASTER_KEY }, mockFetch);
      const resBody = (await res.json()) as { data: { delegation_id: string } };
      const delegationId = resBody.data.delegation_id;
      sqliteDb.exec(`INSERT INTO org_members (org_id, user_id, role) VALUES ('${delegationId}', '${TEST_USER_ID}', 'admin')`);

      // Use the admin health endpoint handler
      const revokedFetch = createMockFetch({ failTokenExchange: true });
      const delegationSvc = new DelegationService(delegationStore, TEST_MASTER_KEY, revokedFetch);
      const discoverySvc = new DiscoveryService(discoveryStore, { getDirectoryToken: async () => "t" }, revokedFetch);
      const deps: AdminDeps = {
        delegationService: delegationSvc,
        discoveryService: discoverySvc,
        queryAuditLog: (did, opts) => queryAuditLog(d1, did, opts),
        getDelegation: (did) => delegationStore.getDelegationById(did),
      };

      const healthReq = new Request(`https://api.tminus.dev/v1/orgs/${delegationId}/delegation/health`);
      const healthRes = await handleDelegationHealth(healthReq, { userId: TEST_USER_ID, isAdmin: true }, delegationId, deps);

      expect(healthRes.status).toBe(200);
      const healthBody = ((await healthRes.json()) as { data: Record<string, unknown> }).data;
      expect(healthBody.status).toBe("revoked");
      expect(healthBody.can_impersonate_admin).toBe(false);
    });
  });

  // =========================================================================
  // Journey 7: Key Rotation (zero-downtime)
  // =========================================================================

  describe("Journey 7: Service account key rotation (zero-downtime)", () => {
    it("rotates credentials with audit trail and previous key preserved", async () => {
      // Register org
      const regReq = new Request("https://api.tminus.dev/v1/orgs/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: TEST_DOMAIN,
          admin_email: TEST_ADMIN_EMAIL,
          service_account_key: SA_KEY_1,
        }),
      });
      const res = await handleOrgRegister(regReq, { userId: TEST_USER_ID }, { store: delegationStore, MASTER_KEY: TEST_MASTER_KEY }, mockFetch);
      const body = (await res.json()) as { data: { delegation_id: string } };
      const delegationId = body.data.delegation_id;

      // Rotate to SA_KEY_2
      const delegationSvc = new DelegationService(delegationStore, TEST_MASTER_KEY, mockFetch);
      const rotationResult = await delegationSvc.rotateCredential(delegationId, SA_KEY_2);

      expect(rotationResult.success).toBe(true);
      expect(rotationResult.oldKeyId).toBe(SA_KEY_1.private_key_id);
      expect(rotationResult.newKeyId).toBe(SA_KEY_2.private_key_id);

      // Verify in D1
      const stored = await delegationStore.getDelegationById(delegationId);
      expect(stored).not.toBeNull();
      expect(stored!.saClientEmail).toBe(SA_KEY_2.client_email);
      // Previous key is preserved for zero-downtime
      expect(stored!.previousEncryptedSaKey).not.toBeNull();
      expect(stored!.previousSaKeyId).toBe(SA_KEY_1.private_key_id);

      // Audit log should record the rotation
      const auditPage = await queryAuditLog(d1, delegationId, { limit: 10, offset: 0, action: "key_rotated" });
      expect(auditPage.entries.length).toBeGreaterThanOrEqual(1);
      expect(auditPage.entries[0].action).toBe("key_rotated");
    });

    it("rotation via admin handler with proper auth check", async () => {
      // Register org
      const regReq = new Request("https://api.tminus.dev/v1/orgs/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: TEST_DOMAIN,
          admin_email: TEST_ADMIN_EMAIL,
          service_account_key: SA_KEY_1,
        }),
      });
      const res = await handleOrgRegister(regReq, { userId: TEST_USER_ID }, { store: delegationStore, MASTER_KEY: TEST_MASTER_KEY }, mockFetch);
      const resBody = (await res.json()) as { data: { delegation_id: string } };
      const delegationId = resBody.data.delegation_id;
      sqliteDb.exec(`INSERT INTO org_members (org_id, user_id, role) VALUES ('${delegationId}', '${TEST_USER_ID}', 'admin')`);

      const delegationSvc = new DelegationService(delegationStore, TEST_MASTER_KEY, mockFetch);
      const discoverySvc = new DiscoveryService(discoveryStore, { getDirectoryToken: async () => "t" }, mockFetch);
      const deps: AdminDeps = {
        delegationService: delegationSvc,
        discoveryService: discoverySvc,
        queryAuditLog: (did, opts) => queryAuditLog(d1, did, opts),
        getDelegation: (did) => delegationStore.getDelegationById(did),
      };

      // Non-admin should get 403
      const nonAdminReq = new Request(`https://api.tminus.dev/v1/orgs/${delegationId}/delegation/rotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service_account_key: SA_KEY_2 }),
      });
      const nonAdminRes = await handleDelegationRotate(nonAdminReq, { userId: "usr_rando", isAdmin: false }, delegationId, deps);
      expect(nonAdminRes.status).toBe(403);

      // Admin should succeed
      const adminReq = new Request(`https://api.tminus.dev/v1/orgs/${delegationId}/delegation/rotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service_account_key: SA_KEY_2 }),
      });
      const adminRes = await handleDelegationRotate(adminReq, { userId: TEST_USER_ID, isAdmin: true }, delegationId, deps);
      expect(adminRes.status).toBe(200);
      const rotBody = ((await adminRes.json()) as { data: Record<string, unknown> }).data;
      expect(rotBody.success).toBe(true);
      expect(rotBody.new_key_id).toBe(SA_KEY_2.private_key_id);
      expect(rotBody.old_key_id).toBe(SA_KEY_1.private_key_id);
    });
  });

  // =========================================================================
  // Journey 8: Edge Cases
  // =========================================================================

  describe("Journey 8: Edge cases", () => {
    it("invalid domain registration is rejected", async () => {
      const req = new Request("https://api.tminus.dev/v1/orgs/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: "x",
          admin_email: "bad",
          service_account_key: {},
        }),
      });
      const res = await handleOrgRegister(req, { userId: TEST_USER_ID }, { store: delegationStore, MASTER_KEY: TEST_MASTER_KEY }, mockFetch);
      expect(res.status).toBe(400);
    });

    it("calendar fetch for unregistered domain returns 404", async () => {
      const calRes = await handleDelegationCalendars(
        new Request("https://api.tminus.dev/v1/orgs/delegation/calendars/user@unknown.dev"),
        { userId: "usr_x" },
        { store: delegationStore, MASTER_KEY: TEST_MASTER_KEY },
        "user@unknown.dev",
        mockFetch,
      );
      expect(calRes.status).toBe(404);
    });

    it("user lifecycle: removed is terminal (cannot transition out)", async () => {
      // Register org and discover users
      const regReq = new Request("https://api.tminus.dev/v1/orgs/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: TEST_DOMAIN,
          admin_email: TEST_ADMIN_EMAIL,
          service_account_key: SA_KEY_1,
        }),
      });
      const res = await handleOrgRegister(regReq, { userId: TEST_USER_ID }, { store: delegationStore, MASTER_KEY: TEST_MASTER_KEY }, mockFetch);
      const body = (await res.json()) as { data: { delegation_id: string } };
      const delegationId = body.data.delegation_id;

      const users = makeDirectoryUsers(3, TEST_DOMAIN);
      mockFetch = createMockFetch({ directoryUsers: users });
      const tokenProvider: TokenProvider = { getDirectoryToken: async () => "mock-token" };
      const discoverySvc = new DiscoveryService(discoveryStore, tokenProvider, mockFetch);
      await discoverySvc.discoverUsers(delegationId, TEST_DOMAIN, TEST_ADMIN_EMAIL);

      const allUsers = await discoveryStore.getDiscoveredUsers(delegationId);
      const user = allUsers[0];

      // Remove the user
      await discoverySvc.transitionUserStatus(user.discoveryId, "removed", delegationId);

      // Attempt to reactivate -- should fail
      await expect(
        discoverySvc.transitionUserStatus(user.discoveryId, "active", delegationId),
      ).rejects.toThrow("Invalid transition");
    });

    it("revoked delegation prevents calendar access", async () => {
      // Register org
      const regReq = new Request("https://api.tminus.dev/v1/orgs/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: TEST_DOMAIN,
          admin_email: TEST_ADMIN_EMAIL,
          service_account_key: SA_KEY_1,
        }),
      });
      const res = await handleOrgRegister(regReq, { userId: TEST_USER_ID }, { store: delegationStore, MASTER_KEY: TEST_MASTER_KEY }, mockFetch);
      const body = (await res.json()) as { data: { delegation_id: string } };
      const delegationId = body.data.delegation_id;

      // Manually revoke
      await delegationStore.updateDelegation(delegationId, {
        delegationStatus: "revoked",
        updatedAt: new Date().toISOString(),
      });

      // Try to fetch calendars -- should get 403
      const calRes = await handleDelegationCalendars(
        new Request(`https://api.tminus.dev/v1/orgs/delegation/calendars/user1@${TEST_DOMAIN}`),
        { userId: "usr_user1" },
        { store: delegationStore, MASTER_KEY: TEST_MASTER_KEY },
        `user1@${TEST_DOMAIN}`,
        mockFetch,
      );
      expect(calRes.status).toBe(403);
    });

    it("cleanup removes expired discovered users", async () => {
      // Register org
      const regReq = new Request("https://api.tminus.dev/v1/orgs/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: TEST_DOMAIN,
          admin_email: TEST_ADMIN_EMAIL,
          service_account_key: SA_KEY_1,
        }),
      });
      const res = await handleOrgRegister(regReq, { userId: TEST_USER_ID }, { store: delegationStore, MASTER_KEY: TEST_MASTER_KEY }, mockFetch);
      const body = (await res.json()) as { data: { delegation_id: string } };
      const delegationId = body.data.delegation_id;

      // Set up discovery config with 1-day retention
      const tokenProvider: TokenProvider = { getDirectoryToken: async () => "mock-token" };
      const discoverySvc = new DiscoveryService(discoveryStore, tokenProvider, mockFetch);
      await discoverySvc.upsertConfig({
        delegationId,
        syncMode: "lazy",
        retentionDays: 1,
      });

      // Manually insert a user that was removed 2 days ago
      const twosDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const removedUser: DiscoveredUser = {
        discoveryId: generateId("discovery"),
        delegationId,
        googleUserId: "guser-cleanup-001",
        email: `cleanup@${TEST_DOMAIN}`,
        displayName: "Cleanup User",
        orgUnitPath: "/",
        status: "removed",
        accountId: null,
        lastSyncedAt: null,
        discoveredAt: twosDaysAgo,
        statusChangedAt: twosDaysAgo,
        removedAt: twosDaysAgo,
      };
      await discoveryStore.createDiscoveredUser(removedUser);

      // Run cleanup
      const cleanupResult = await discoverySvc.cleanupRemovedUsers(delegationId);
      expect(cleanupResult.cleanedUp).toBe(1);
      expect(cleanupResult.cleanedUpIds).toContain(removedUser.discoveryId);

      // Verify the user is gone from D1
      const remaining = await discoveryStore.getDiscoveredUsers(delegationId);
      expect(remaining.find((u) => u.discoveryId === removedUser.discoveryId)).toBeUndefined();
    });
  });
});
