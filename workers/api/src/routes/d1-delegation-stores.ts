/**
 * D1-backed DelegationStore and DiscoveryStore for production use (TM-9iu.4).
 *
 * These adapters wrap a Cloudflare D1Database binding and implement the
 * DelegationStore / DiscoveryStore interfaces expected by DelegationService
 * and DiscoveryService. They are used at request time in the API worker to
 * construct AdminDeps for the admin dashboard handlers.
 *
 * Design:
 * - Thin adapters: translate camelCase <-> snake_case between service types and D1 rows
 * - No caching: D1 is fast enough for admin dashboard queries
 * - JSON column parsing for array fields (ou_filter_json, excluded_emails)
 */

import type {
  DelegationStore,
  DelegationRecord,
  CachedTokenRecord,
  AuditLogEntry,
  DiscoveryStore,
  DiscoveredUser,
  DiscoveredUserStatus,
  DiscoveryConfig,
  OrgRateLimitStore,
  OrgRateLimitConfig,
  OrgQuotaStore,
  OrgQuotaConfig,
  QuotaType,
  ComplianceAuditStore,
  ComplianceAuditEntry,
  AuditRetentionConfig,
} from "@tminus/shared";
import { DEFAULT_ORG_RATE_LIMITS, DEFAULT_ORG_QUOTAS, GENESIS_HASH, DEFAULT_RETENTION_DAYS } from "@tminus/shared";
import type { AuditPage, AuditQueryOptions } from "./org-delegation-admin";

// ---------------------------------------------------------------------------
// D1DelegationStore
// ---------------------------------------------------------------------------

export class D1DelegationStore implements DelegationStore {
  constructor(private readonly db: D1Database) {}

  async getDelegation(domain: string): Promise<DelegationRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM org_delegations WHERE domain = ?1")
      .bind(domain)
      .first<Record<string, unknown>>();
    return row ? this.rowToRecord(row) : null;
  }

  async getDelegationById(
    delegationId: string,
  ): Promise<DelegationRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM org_delegations WHERE delegation_id = ?1")
      .bind(delegationId)
      .first<Record<string, unknown>>();
    return row ? this.rowToRecord(row) : null;
  }

  async getActiveDelegations(): Promise<DelegationRecord[]> {
    const { results } = await this.db
      .prepare(
        "SELECT * FROM org_delegations WHERE delegation_status = 'active'",
      )
      .all<Record<string, unknown>>();
    return (results ?? []).map((r) => this.rowToRecord(r));
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

  async updateDelegation(
    delegationId: string,
    updates: Partial<DelegationRecord>,
  ): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
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
    const stmt = this.db.prepare(
      `UPDATE org_delegations SET ${sets.join(", ")} WHERE delegation_id = ?${paramIdx}`,
    );
    await stmt.bind(...values).run();
  }

  async getCachedToken(
    delegationId: string,
    userEmail: string,
  ): Promise<CachedTokenRecord | null> {
    const row = await this.db
      .prepare(
        "SELECT * FROM impersonation_token_cache WHERE delegation_id = ?1 AND user_email = ?2",
      )
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
      .bind(
        entry.auditId,
        entry.delegationId,
        entry.domain,
        entry.userEmail,
        entry.action,
        entry.details,
        entry.createdAt,
      )
      .run();
  }

  private rowToRecord(row: Record<string, unknown>): DelegationRecord {
    return {
      delegationId: row.delegation_id as string,
      domain: row.domain as string,
      adminEmail: row.admin_email as string,
      delegationStatus: row.delegation_status as
        | "pending"
        | "active"
        | "revoked",
      encryptedSaKey: row.encrypted_sa_key as string,
      saClientEmail: row.sa_client_email as string,
      saClientId: row.sa_client_id as string,
      validatedAt: (row.validated_at as string) ?? null,
      activeUsersCount: (row.active_users_count as number) ?? 0,
      registrationDate: (row.registration_date as string) ?? null,
      saKeyCreatedAt: (row.sa_key_created_at as string) ?? null,
      saKeyLastUsedAt: (row.sa_key_last_used_at as string) ?? null,
      saKeyRotationDueAt: (row.sa_key_rotation_due_at as string) ?? null,
      previousEncryptedSaKey:
        (row.previous_encrypted_sa_key as string) ?? null,
      previousSaKeyId: (row.previous_sa_key_id as string) ?? null,
      lastHealthCheckAt: (row.last_health_check_at as string) ?? null,
      healthCheckStatus:
        (row.health_check_status as
          | "healthy"
          | "degraded"
          | "revoked"
          | "unknown") ?? "unknown",
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}

// ---------------------------------------------------------------------------
// D1DiscoveryStore
// ---------------------------------------------------------------------------

export class D1DiscoveryStore implements DiscoveryStore {
  constructor(private readonly db: D1Database) {}

  async getConfig(delegationId: string): Promise<DiscoveryConfig | null> {
    const row = await this.db
      .prepare("SELECT * FROM org_discovery_config WHERE delegation_id = ?1")
      .bind(delegationId)
      .first<Record<string, unknown>>();
    if (!row) return null;
    return {
      delegationId: row.delegation_id as string,
      ouFilter: row.ou_filter_json
        ? (JSON.parse(row.ou_filter_json as string) as string[])
        : undefined,
      excludedEmails: row.excluded_emails
        ? (JSON.parse(row.excluded_emails as string) as string[])
        : undefined,
      syncMode: (row.sync_mode as "proactive" | "lazy") ?? "lazy",
      retentionDays: (row.retention_days as number) ?? 30,
    };
  }

  async upsertConfig(
    config: DiscoveryConfig & { configId: string },
  ): Promise<void> {
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
        config.excludedEmails
          ? JSON.stringify(config.excludedEmails)
          : null,
        config.syncMode ?? "lazy",
        config.retentionDays ?? 30,
        now,
        now,
      )
      .run();
  }

  async getDiscoveredUsers(
    delegationId: string,
    status?: DiscoveredUserStatus,
  ): Promise<DiscoveredUser[]> {
    let sql = "SELECT * FROM org_discovered_users WHERE delegation_id = ?1";
    if (status) {
      sql += " AND status = ?2";
      const { results } = await this.db
        .prepare(sql)
        .bind(delegationId, status)
        .all<Record<string, unknown>>();
      return (results ?? []).map((r) => this.rowToDiscoveredUser(r));
    }
    const { results } = await this.db
      .prepare(sql)
      .bind(delegationId)
      .all<Record<string, unknown>>();
    return (results ?? []).map((r) => this.rowToDiscoveredUser(r));
  }

  async getDiscoveredUser(
    delegationId: string,
    googleUserId: string,
  ): Promise<DiscoveredUser | null> {
    const row = await this.db
      .prepare(
        "SELECT * FROM org_discovered_users WHERE delegation_id = ?1 AND google_user_id = ?2",
      )
      .bind(delegationId, googleUserId)
      .first<Record<string, unknown>>();
    return row ? this.rowToDiscoveredUser(row) : null;
  }

  async getDiscoveredUserByEmail(
    delegationId: string,
    email: string,
  ): Promise<DiscoveredUser | null> {
    const row = await this.db
      .prepare(
        "SELECT * FROM org_discovered_users WHERE delegation_id = ?1 AND LOWER(email) = LOWER(?2)",
      )
      .bind(delegationId, email)
      .first<Record<string, unknown>>();
    return row ? this.rowToDiscoveredUser(row) : null;
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
        user.discoveryId,
        user.delegationId,
        user.googleUserId,
        user.email,
        user.displayName,
        user.orgUnitPath,
        user.status,
        user.accountId,
        user.lastSyncedAt,
        user.discoveredAt,
        user.statusChangedAt,
        user.removedAt,
      )
      .run();
  }

  async updateDiscoveredUser(
    discoveryId: string,
    updates: Partial<DiscoveredUser>,
  ): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const fieldMap: Record<string, string> = {
      email: "email",
      displayName: "display_name",
      orgUnitPath: "org_unit_path",
      status: "status",
      accountId: "account_id",
      lastSyncedAt: "last_synced_at",
      statusChangedAt: "status_changed_at",
      removedAt: "removed_at",
    };
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
      .prepare(
        `UPDATE org_discovered_users SET ${sets.join(", ")} WHERE discovery_id = ?${paramIdx}`,
      )
      .bind(...values)
      .run();
  }

  async deleteRemovedUsers(
    delegationId: string,
    olderThan: Date,
  ): Promise<number> {
    const result = await this.db
      .prepare(
        "DELETE FROM org_discovered_users WHERE delegation_id = ?1 AND status = 'removed' AND removed_at < ?2",
      )
      .bind(delegationId, olderThan.toISOString())
      .run();
    return result.meta?.changes ?? 0;
  }

  async getRemovedUsersForCleanup(
    delegationId: string,
    beforeDate: string,
  ): Promise<DiscoveredUser[]> {
    const { results } = await this.db
      .prepare(
        "SELECT * FROM org_discovered_users WHERE delegation_id = ?1 AND status = 'removed' AND removed_at < ?2",
      )
      .bind(delegationId, beforeDate)
      .all<Record<string, unknown>>();
    return (results ?? []).map((r) => this.rowToDiscoveredUser(r));
  }

  async deleteDiscoveredUser(discoveryId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM org_discovered_users WHERE discovery_id = ?1")
      .bind(discoveryId)
      .run();
  }

  async updateLastDiscoveryAt(
    delegationId: string,
    timestamp: string,
  ): Promise<void> {
    await this.db
      .prepare(
        "UPDATE org_discovery_config SET last_discovery_at = ?1, updated_at = ?1 WHERE delegation_id = ?2",
      )
      .bind(timestamp, delegationId)
      .run();
  }

  private rowToDiscoveredUser(
    row: Record<string, unknown>,
  ): DiscoveredUser {
    return {
      discoveryId: row.discovery_id as string,
      delegationId: row.delegation_id as string,
      googleUserId: row.google_user_id as string,
      email: row.email as string,
      displayName: (row.display_name as string) ?? "",
      orgUnitPath: (row.org_unit_path as string) ?? "/",
      status: row.status as DiscoveredUserStatus,
      accountId: (row.account_id as string) ?? null,
      lastSyncedAt: (row.last_synced_at as string) ?? null,
      discoveredAt: row.discovered_at as string,
      statusChangedAt: (row.status_changed_at as string) ?? null,
      removedAt: (row.removed_at as string) ?? null,
    };
  }
}

// ---------------------------------------------------------------------------
// Audit log query helper (used by AdminDeps.queryAuditLog)
// ---------------------------------------------------------------------------

/**
 * Query audit log entries from D1 with pagination and optional action filter.
 */
export async function queryAuditLogFromD1(
  db: D1Database,
  delegationId: string,
  options: AuditQueryOptions,
): Promise<AuditPage> {
  const { limit, offset, action } = options;

  // Get total count
  let countSql =
    "SELECT COUNT(*) as cnt FROM delegation_audit_log WHERE delegation_id = ?1";
  let dataSql =
    "SELECT * FROM delegation_audit_log WHERE delegation_id = ?1";

  if (action) {
    countSql += " AND action = ?2";
    dataSql += " AND action = ?2";
  }
  dataSql += " ORDER BY created_at DESC LIMIT ?3 OFFSET ?4";

  let total: number;
  if (action) {
    const countRow = await db
      .prepare(countSql)
      .bind(delegationId, action)
      .first<{ cnt: number }>();
    total = countRow?.cnt ?? 0;
  } else {
    const countRow = await db
      .prepare(countSql)
      .bind(delegationId)
      .first<{ cnt: number }>();
    total = countRow?.cnt ?? 0;
  }

  let results: Record<string, unknown>[];
  if (action) {
    const resp = await db
      .prepare(dataSql)
      .bind(delegationId, action, limit, offset)
      .all<Record<string, unknown>>();
    results = resp.results ?? [];
  } else {
    const resp = await db
      .prepare(dataSql)
      .bind(delegationId, limit, offset)
      .all<Record<string, unknown>>();
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

// ---------------------------------------------------------------------------
// getDelegation helper (used by AdminDeps.getDelegation)
// ---------------------------------------------------------------------------

/**
 * Look up a delegation record by its delegation ID (which is used as orgId
 * in admin routes).
 */
export async function getDelegationFromD1(
  db: D1Database,
  delegationId: string,
): Promise<DelegationRecord | null> {
  const store = new D1DelegationStore(db);
  return store.getDelegationById(delegationId);
}

// ---------------------------------------------------------------------------
// D1OrgRateLimitStore (sliding window log backed by D1)
// ---------------------------------------------------------------------------

/**
 * D1-backed rate limit store implementing the sliding window log pattern.
 *
 * Uses the org_rate_limit_counters table to store individual request
 * timestamps. Each row represents a single request event with an
 * expiration time for cleanup.
 */
export class D1OrgRateLimitStore implements OrgRateLimitStore {
  constructor(private readonly db: D1Database) {}

  // Legacy fixed-window methods (kept for interface compliance)
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

  // Sliding-window methods
  async addTimestamp(key: string, timestampMs: number, ttlSeconds: number): Promise<void> {
    const expiresAt = new Date(timestampMs + ttlSeconds * 1000).toISOString();
    const entryKey = `${key}:${timestampMs}:${Math.random().toString(36).slice(2, 8)}`;
    await this.db
      .prepare(
        `INSERT INTO org_rate_limit_counters (counter_key, count, expires_at)
         VALUES (?1, ?2, ?3)`,
      )
      .bind(entryKey, timestampMs, expiresAt)
      .run();
  }

  async countInWindow(key: string, windowStartMs: number): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM org_rate_limit_counters
         WHERE counter_key LIKE ?1 AND count >= ?2`,
      )
      .bind(`${key}:%`, windowStartMs)
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  }

  async pruneExpired(key: string, beforeMs: number): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM org_rate_limit_counters
         WHERE counter_key LIKE ?1 AND count < ?2`,
      )
      .bind(`${key}:%`, beforeMs)
      .run();
  }

  /**
   * Get per-org rate limit configuration from D1.
   * Returns null if the org uses default limits.
   */
  async getOrgConfig(orgId: string): Promise<OrgRateLimitConfig | null> {
    const row = await this.db
      .prepare("SELECT * FROM org_rate_limit_config WHERE org_id = ?1")
      .bind(orgId)
      .first<Record<string, unknown>>();
    if (!row) return null;
    return {
      apiMaxRequests: (row.api_max_requests as number) ?? DEFAULT_ORG_RATE_LIMITS.apiMaxRequests,
      apiWindowSeconds: (row.api_window_seconds as number) ?? DEFAULT_ORG_RATE_LIMITS.apiWindowSeconds,
      directoryMaxRequests: (row.directory_max_requests as number) ?? DEFAULT_ORG_RATE_LIMITS.directoryMaxRequests,
      directoryWindowSeconds: (row.directory_window_seconds as number) ?? DEFAULT_ORG_RATE_LIMITS.directoryWindowSeconds,
      impersonationMaxRequests: (row.impersonation_max_requests as number) ?? DEFAULT_ORG_RATE_LIMITS.impersonationMaxRequests,
      impersonationWindowSeconds: (row.impersonation_window_seconds as number) ?? DEFAULT_ORG_RATE_LIMITS.impersonationWindowSeconds,
    };
  }
}

// ---------------------------------------------------------------------------
// D1OrgQuotaStore
// ---------------------------------------------------------------------------

/**
 * D1-backed quota store for org-level quota tracking.
 */
export class D1OrgQuotaStore implements OrgQuotaStore {
  constructor(private readonly db: D1Database) {}

  async getUsage(orgId: string, quotaType: QuotaType, periodKey: string): Promise<number> {
    const row = await this.db
      .prepare(
        "SELECT usage_count FROM org_quota_usage WHERE org_id = ?1 AND quota_type = ?2 AND period_key = ?3",
      )
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
      .prepare(
        "SELECT usage_count FROM org_quota_usage WHERE org_id = ?1 AND quota_type = ?2 AND period_key = ?3",
      )
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

  async getOrgQuotaConfig(orgId: string): Promise<OrgQuotaConfig | null> {
    const row = await this.db
      .prepare("SELECT * FROM org_quota_config WHERE org_id = ?1")
      .bind(orgId)
      .first<Record<string, unknown>>();
    if (!row) return null;
    return {
      maxDiscoveredUsers: (row.max_discovered_users as number) ?? DEFAULT_ORG_QUOTAS.maxDiscoveredUsers,
      maxDelegations: (row.max_delegations as number) ?? DEFAULT_ORG_QUOTAS.maxDelegations,
      maxApiCallsDaily: (row.max_api_calls_daily as number) ?? DEFAULT_ORG_QUOTAS.maxApiCallsDaily,
    };
  }
}

// ---------------------------------------------------------------------------
// D1ComplianceAuditStore
// ---------------------------------------------------------------------------

/**
 * D1-backed compliance audit log store with hash chain integrity.
 */
export class D1ComplianceAuditStore implements ComplianceAuditStore {
  constructor(private readonly db: D1Database) {}

  async getLastEntryHash(orgId: string): Promise<string> {
    const row = await this.db
      .prepare(
        "SELECT entry_hash FROM compliance_audit_log WHERE org_id = ?1 ORDER BY timestamp DESC LIMIT 1",
      )
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
      )
      .run();
  }

  async getEntries(
    orgId: string,
    startDate: string,
    endDate: string,
    limit: number = 1000,
    offset: number = 0,
  ): Promise<ComplianceAuditEntry[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM compliance_audit_log
         WHERE org_id = ?1 AND timestamp >= ?2 AND timestamp <= ?3
         ORDER BY timestamp ASC
         LIMIT ?4 OFFSET ?5`,
      )
      .bind(orgId, startDate, endDate, limit, offset)
      .all<Record<string, unknown>>();
    return (results ?? []).map((row) => this.rowToEntry(row));
  }

  async getEntryCount(orgId: string, startDate: string, endDate: string): Promise<number> {
    const row = await this.db
      .prepare(
        "SELECT COUNT(*) as cnt FROM compliance_audit_log WHERE org_id = ?1 AND timestamp >= ?2 AND timestamp <= ?3",
      )
      .bind(orgId, startDate, endDate)
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  }

  async getEntriesForVerification(orgId: string, limit?: number): Promise<ComplianceAuditEntry[]> {
    const sql = limit
      ? "SELECT * FROM compliance_audit_log WHERE org_id = ?1 ORDER BY timestamp ASC LIMIT ?2"
      : "SELECT * FROM compliance_audit_log WHERE org_id = ?1 ORDER BY timestamp ASC";
    const stmt = limit
      ? this.db.prepare(sql).bind(orgId, limit)
      : this.db.prepare(sql).bind(orgId);
    const { results } = await stmt.all<Record<string, unknown>>();
    return (results ?? []).map((row) => this.rowToEntry(row));
  }

  async getRetentionConfig(orgId: string): Promise<AuditRetentionConfig | null> {
    // Reuse org_quota_config or discovery_config for retention settings
    // For now, return null (use defaults)
    const row = await this.db
      .prepare("SELECT retention_days FROM org_discovery_config WHERE delegation_id = ?1")
      .bind(orgId)
      .first<{ retention_days: number }>();
    if (!row) return null;
    return { retentionDays: row.retention_days ?? DEFAULT_RETENTION_DAYS };
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
      details: (row.details as string) ?? null,
      previousHash: row.previous_hash as string,
      entryHash: row.entry_hash as string,
    };
  }
}
