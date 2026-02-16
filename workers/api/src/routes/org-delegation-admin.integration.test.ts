/**
 * Integration tests for delegation admin dashboard endpoints (TM-9iu.4).
 *
 * Tests all admin dashboard route handlers against real SQLite (via better-sqlite3):
 * 1. Dashboard overview returns delegation + user stats + audit + config (AC-1)
 * 2. User list endpoint with filtering and pagination (AC-2)
 * 3. Discovery config read and update (AC-3)
 * 4. Credential health check and rotation endpoints (AC-4)
 * 5. Audit log endpoint with pagination (AC-5)
 * 6. Non-admin gets 403 (AC-6, BR-1)
 * 7. All existing tests pass unchanged (AC-7)
 *
 * Uses real SQLite via better-sqlite3 with all relevant migrations applied.
 * Google API calls are mocked via injectable fetchFn.
 * DelegationService and DiscoveryService use real store implementations.
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  MIGRATION_0001_INITIAL_SCHEMA,
  MIGRATION_0004_AUTH_FIELDS,
  MIGRATION_0022_ORG_DELEGATIONS,
  MIGRATION_0023_DELEGATION_INFRASTRUCTURE,
  MIGRATION_0024_DELEGATION_CACHE_AND_AUDIT,
  MIGRATION_0025_ORG_DISCOVERY,
} from "@tminus/d1-registry";
import {
  DelegationService,
  DiscoveryService,
  generateId,
  parseEncryptedEnvelope,
  decryptServiceAccountKey,
  importMasterKeyForServiceAccount,
} from "@tminus/shared";
import type {
  DelegationStore,
  DelegationRecord,
  CachedTokenRecord,
  AuditLogEntry,
  ServiceAccountKey,
  DiscoveryStore,
  DiscoveredUser,
  DiscoveredUserStatus,
  DiscoveryConfig,
  TokenProvider,
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
} from "./org-delegation-admin";
import type { AdminAuthContext, AdminDeps, AuditPage, AuditQueryOptions } from "./org-delegation-admin";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_MASTER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { privateKey: KEY_1 } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const { privateKey: KEY_2 } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const SA_KEY_1: ServiceAccountKey = {
  type: "service_account",
  project_id: "tminus-test",
  private_key_id: "key-alpha",
  private_key: KEY_1,
  client_email: "sa@tminus-test.iam.gserviceaccount.com",
  client_id: "111111111111",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
};

const SA_KEY_2: ServiceAccountKey = {
  type: "service_account",
  project_id: "tminus-test",
  private_key_id: "key-beta",
  private_key: KEY_2,
  client_email: "sa@tminus-test.iam.gserviceaccount.com",
  client_id: "111111111111",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
};

const ADMIN_AUTH: AdminAuthContext = { userId: "usr_admin_01", isAdmin: true };
const NON_ADMIN_AUTH: AdminAuthContext = { userId: "usr_member_01", isAdmin: false };

// ---------------------------------------------------------------------------
// D1DelegationStore (real SQLite -- same pattern as v2 integration tests)
// ---------------------------------------------------------------------------

class D1DelegationStore implements DelegationStore {
  constructor(private readonly db: DatabaseType) {}

  async getDelegation(domain: string): Promise<DelegationRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM org_delegations WHERE domain = ?")
      .get(domain) as Record<string, unknown> | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  async getDelegationById(delegationId: string): Promise<DelegationRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM org_delegations WHERE delegation_id = ?")
      .get(delegationId) as Record<string, unknown> | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  async getActiveDelegations(): Promise<DelegationRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM org_delegations WHERE delegation_status = 'active'")
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToRecord(r));
  }

  async createDelegation(record: DelegationRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO org_delegations
         (delegation_id, domain, admin_email, delegation_status, encrypted_sa_key,
          sa_client_email, sa_client_id, validated_at, active_users_count,
          registration_date, sa_key_created_at, sa_key_last_used_at,
          sa_key_rotation_due_at, previous_encrypted_sa_key, previous_sa_key_id,
          last_health_check_at, health_check_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );
  }

  async updateDelegation(delegationId: string, updates: Partial<DelegationRecord>): Promise<void> {
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
    for (const [key, col] of Object.entries(fieldMap)) {
      if (key in updates) {
        sets.push(`${col} = ?`);
        values.push((updates as Record<string, unknown>)[key]);
      }
    }
    if (sets.length === 0) return;
    values.push(delegationId);
    this.db
      .prepare(`UPDATE org_delegations SET ${sets.join(", ")} WHERE delegation_id = ?`)
      .run(...values);
  }

  async getCachedToken(delegationId: string, userEmail: string): Promise<CachedTokenRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM impersonation_token_cache WHERE delegation_id = ? AND user_email = ?")
      .get(delegationId, userEmail) as Record<string, unknown> | undefined;
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
    this.db
      .prepare(
        `INSERT OR REPLACE INTO impersonation_token_cache
         (cache_id, delegation_id, user_email, encrypted_token, token_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(record.cacheId, record.delegationId, record.userEmail, record.encryptedToken, record.tokenExpiresAt, record.createdAt, record.updatedAt);
  }

  async writeAuditLog(entry: AuditLogEntry): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO delegation_audit_log
         (audit_id, delegation_id, domain, user_email, action, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(entry.auditId, entry.delegationId, entry.domain, entry.userEmail, entry.action, entry.details, entry.createdAt);
  }

  private rowToRecord(row: Record<string, unknown>): DelegationRecord {
    return {
      delegationId: row.delegation_id as string,
      domain: row.domain as string,
      adminEmail: row.admin_email as string,
      delegationStatus: row.delegation_status as "pending" | "active" | "revoked",
      encryptedSaKey: row.encrypted_sa_key as string,
      saClientEmail: row.sa_client_email as string,
      saClientId: row.sa_client_id as string,
      validatedAt: row.validated_at as string | null,
      activeUsersCount: (row.active_users_count as number) ?? 0,
      registrationDate: row.registration_date as string | null,
      saKeyCreatedAt: row.sa_key_created_at as string | null,
      saKeyLastUsedAt: row.sa_key_last_used_at as string | null,
      saKeyRotationDueAt: row.sa_key_rotation_due_at as string | null,
      previousEncryptedSaKey: row.previous_encrypted_sa_key as string | null,
      previousSaKeyId: row.previous_sa_key_id as string | null,
      lastHealthCheckAt: row.last_health_check_at as string | null,
      healthCheckStatus: (row.health_check_status as "healthy" | "degraded" | "revoked" | "unknown") ?? "unknown",
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}

// ---------------------------------------------------------------------------
// D1DiscoveryStore (real SQLite -- same pattern as discovery integration tests)
// ---------------------------------------------------------------------------

class D1DiscoveryStore implements DiscoveryStore {
  constructor(private readonly db: DatabaseType) {}

  async getConfig(delegationId: string): Promise<DiscoveryConfig | null> {
    const row = this.db
      .prepare("SELECT * FROM org_discovery_config WHERE delegation_id = ?")
      .get(delegationId) as Record<string, unknown> | undefined;
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
    this.db
      .prepare(
        `INSERT OR REPLACE INTO org_discovery_config
         (config_id, delegation_id, ou_filter_json, excluded_emails, sync_mode, retention_days, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        config.configId,
        config.delegationId,
        config.ouFilter ? JSON.stringify(config.ouFilter) : null,
        config.excludedEmails ? JSON.stringify(config.excludedEmails) : null,
        config.syncMode ?? "lazy",
        config.retentionDays ?? 30,
        now,
        now,
      );
  }

  async getDiscoveredUsers(delegationId: string, status?: DiscoveredUserStatus): Promise<DiscoveredUser[]> {
    let sql = "SELECT * FROM org_discovered_users WHERE delegation_id = ?";
    const params: unknown[] = [delegationId];
    if (status) {
      sql += " AND status = ?";
      params.push(status);
    }
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToDiscoveredUser(row));
  }

  async getDiscoveredUser(delegationId: string, googleUserId: string): Promise<DiscoveredUser | null> {
    const row = this.db
      .prepare("SELECT * FROM org_discovered_users WHERE delegation_id = ? AND google_user_id = ?")
      .get(delegationId, googleUserId) as Record<string, unknown> | undefined;
    return row ? this.rowToDiscoveredUser(row) : null;
  }

  async getDiscoveredUserByEmail(delegationId: string, email: string): Promise<DiscoveredUser | null> {
    const row = this.db
      .prepare("SELECT * FROM org_discovered_users WHERE delegation_id = ? AND LOWER(email) = LOWER(?)")
      .get(delegationId, email) as Record<string, unknown> | undefined;
    return row ? this.rowToDiscoveredUser(row) : null;
  }

  async createDiscoveredUser(user: DiscoveredUser): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO org_discovered_users
         (discovery_id, delegation_id, google_user_id, email, display_name,
          org_unit_path, status, account_id, last_synced_at,
          discovered_at, status_changed_at, removed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        user.discoveryId, user.delegationId, user.googleUserId, user.email,
        user.displayName, user.orgUnitPath, user.status, user.accountId,
        user.lastSyncedAt, user.discoveredAt, user.statusChangedAt, user.removedAt,
      );
  }

  async updateDiscoveredUser(discoveryId: string, updates: Partial<DiscoveredUser>): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const fieldMap: Record<string, string> = {
      email: "email", displayName: "display_name", orgUnitPath: "org_unit_path",
      status: "status", accountId: "account_id", lastSyncedAt: "last_synced_at",
      statusChangedAt: "status_changed_at", removedAt: "removed_at",
    };
    for (const [key, col] of Object.entries(fieldMap)) {
      if (key in updates) {
        sets.push(`${col} = ?`);
        values.push((updates as Record<string, unknown>)[key] ?? null);
      }
    }
    if (sets.length === 0) return;
    values.push(discoveryId);
    this.db.prepare(`UPDATE org_discovered_users SET ${sets.join(", ")} WHERE discovery_id = ?`).run(...values);
  }

  async getRemovedUsersForCleanup(delegationId: string, beforeDate: string): Promise<DiscoveredUser[]> {
    const rows = this.db
      .prepare("SELECT * FROM org_discovered_users WHERE delegation_id = ? AND status = 'removed' AND removed_at < ?")
      .all(delegationId, beforeDate) as Record<string, unknown>[];
    return rows.map((row) => this.rowToDiscoveredUser(row));
  }

  async deleteDiscoveredUser(discoveryId: string): Promise<void> {
    this.db.prepare("DELETE FROM org_discovered_users WHERE discovery_id = ?").run(discoveryId);
  }

  async updateLastDiscoveryAt(delegationId: string, timestamp: string): Promise<void> {
    this.db
      .prepare("UPDATE org_discovery_config SET last_discovery_at = ?, updated_at = ? WHERE delegation_id = ?")
      .run(timestamp, timestamp, delegationId);
  }

  private rowToDiscoveredUser(row: Record<string, unknown>): DiscoveredUser {
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
      statusChangedAt: row.status_changed_at as string,
      removedAt: (row.removed_at as string) ?? null,
    };
  }
}

// ---------------------------------------------------------------------------
// Mock token provider
// ---------------------------------------------------------------------------

class MockTokenProvider implements TokenProvider {
  async getDirectoryToken(): Promise<string> {
    return "mock-directory-token";
  }
}

// ---------------------------------------------------------------------------
// Mock fetch for Google APIs
// ---------------------------------------------------------------------------

function createSuccessFetch() {
  return vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({ access_token: "ya29.test-token", token_type: "Bearer", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/calendarList")) {
      return new Response(
        JSON.stringify({ items: [{ id: "primary", summary: "Work", primary: true, accessRole: "owner" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("admin.googleapis.com/admin/directory/v1/users")) {
      return new Response(JSON.stringify({ users: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("Not found", { status: 404 });
  });
}

// ---------------------------------------------------------------------------
// Apply migrations
// ---------------------------------------------------------------------------

function applyMigrations(db: DatabaseType): void {
  db.exec(MIGRATION_0001_INITIAL_SCHEMA);
  const alterStatements = MIGRATION_0004_AUTH_FIELDS.trim().split(";").filter(Boolean);
  for (const stmt of alterStatements) {
    db.exec(stmt.trim() + ";");
  }
  db.exec(MIGRATION_0022_ORG_DELEGATIONS);
  const infraStatements = MIGRATION_0023_DELEGATION_INFRASTRUCTURE.trim().split(";").filter(Boolean);
  for (const stmt of infraStatements) {
    db.exec(stmt.trim() + ";");
  }
  db.exec(MIGRATION_0024_DELEGATION_CACHE_AND_AUDIT);
  db.exec(MIGRATION_0025_ORG_DISCOVERY);
}

// ---------------------------------------------------------------------------
// Audit log query helper (used as AdminDeps.queryAuditLog)
// ---------------------------------------------------------------------------

function createAuditLogQuerier(db: DatabaseType) {
  return async (delegationId: string, options: AuditQueryOptions): Promise<AuditPage> => {
    let countSql = "SELECT COUNT(*) as total FROM delegation_audit_log WHERE delegation_id = ?";
    let dataSql = "SELECT * FROM delegation_audit_log WHERE delegation_id = ?";
    const params: unknown[] = [delegationId];

    if (options.action) {
      countSql += " AND action = ?";
      dataSql += " AND action = ?";
      params.push(options.action);
    }

    const countRow = db.prepare(countSql).get(...params) as { total: number };
    const total = countRow.total;

    dataSql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    const dataParams = [...params, options.limit, options.offset];
    const rows = db.prepare(dataSql).all(...dataParams) as Record<string, unknown>[];

    const entries: AuditLogEntry[] = rows.map((row) => ({
      auditId: row.audit_id as string,
      delegationId: row.delegation_id as string,
      domain: row.domain as string,
      userEmail: row.user_email as string,
      action: row.action as AuditLogEntry["action"],
      details: (row.details as string) ?? null,
      createdAt: row.created_at as string,
    }));

    return { entries, total, limit: options.limit, offset: options.offset };
  };
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function makeGetRequest(path: string): Request {
  return new Request(`https://api.tminus.ink${path}`, { method: "GET" });
}

function makePatchRequest(path: string, body: unknown): Request {
  return new Request(`https://api.tminus.ink${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makePutRequest(path: string, body: unknown): Request {
  return new Request(`https://api.tminus.ink${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makePostRequest(path: string, body: unknown): Request {
  return new Request(`https://api.tminus.ink${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Test data seeding helper
// ---------------------------------------------------------------------------

function seedDiscoveredUsers(db: DatabaseType, delegationId: string): void {
  const now = new Date().toISOString();
  const users = [
    { id: "dsc_001", gid: "g001", email: "alice@acme.com", name: "Alice Smith", ou: "/Engineering", status: "active" },
    { id: "dsc_002", gid: "g002", email: "bob@acme.com", name: "Bob Jones", ou: "/Engineering/Backend", status: "active" },
    { id: "dsc_003", gid: "g003", email: "carol@acme.com", name: "Carol Davis", ou: "/Sales", status: "suspended" },
    { id: "dsc_004", gid: "g004", email: "dave@acme.com", name: "Dave Wilson", ou: "/Marketing", status: "removed" },
  ];

  for (const u of users) {
    db.prepare(
      `INSERT INTO org_discovered_users
       (discovery_id, delegation_id, google_user_id, email, display_name,
        org_unit_path, status, discovered_at, status_changed_at, removed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      u.id, delegationId, u.gid, u.email, u.name,
      u.ou, u.status, now, now, u.status === "removed" ? now : null,
    );
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("delegation admin dashboard integration (TM-9iu.4)", () => {
  let db: DatabaseType;
  let delegationStore: D1DelegationStore;
  let discoveryStore: D1DiscoveryStore;
  let delegationService: DelegationService;
  let discoveryService: DiscoveryService;
  let mockFetch: ReturnType<typeof createSuccessFetch>;
  let orgId: string; // delegation_id of the test org
  let deps: AdminDeps;

  beforeEach(async () => {
    db = new Database(":memory:");
    applyMigrations(db);

    delegationStore = new D1DelegationStore(db);
    discoveryStore = new D1DiscoveryStore(db);
    mockFetch = createSuccessFetch();
    delegationService = new DelegationService(delegationStore, TEST_MASTER_KEY, mockFetch);
    discoveryService = new DiscoveryService(discoveryStore, new MockTokenProvider(), mockFetch);

    // Register an org to get a delegation_id
    const org = await delegationService.registerDelegation("acme.com", "admin@acme.com", SA_KEY_1);
    orgId = org.delegationId;

    // Seed discovered users
    seedDiscoveredUsers(db, orgId);

    // Set up deps
    deps = {
      delegationService,
      discoveryService,
      queryAuditLog: createAuditLogQuerier(db),
      getDelegation: async (id: string) => delegationStore.getDelegationById(id),
    };
  });

  // -------------------------------------------------------------------------
  // AC-6 / BR-1: Admin authorization
  // -------------------------------------------------------------------------

  describe("admin authorization (BR-1)", () => {
    it("returns 403 for non-admin on dashboard", async () => {
      const req = makeGetRequest(`/api/orgs/${orgId}/dashboard`);
      const resp = await handleOrgDashboard(req, NON_ADMIN_AUTH, orgId, deps);
      expect(resp.status).toBe(403);

      const body = await resp.json() as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Forbidden");
    });

    it("returns 403 for non-admin on user list", async () => {
      const req = makeGetRequest(`/api/orgs/${orgId}/users`);
      const resp = await handleListDiscoveredUsers(req, NON_ADMIN_AUTH, orgId, deps);
      expect(resp.status).toBe(403);
    });

    it("returns 403 for non-admin on user update", async () => {
      const req = makePatchRequest(`/api/orgs/${orgId}/users/dsc_001`, { status: "suspended" });
      const resp = await handleUpdateDiscoveredUser(req, NON_ADMIN_AUTH, orgId, "dsc_001", deps);
      expect(resp.status).toBe(403);
    });

    it("returns 403 for non-admin on discovery config", async () => {
      const req = makeGetRequest(`/api/orgs/${orgId}/discovery/config`);
      const resp = await handleGetDiscoveryConfig(req, NON_ADMIN_AUTH, orgId, deps);
      expect(resp.status).toBe(403);
    });

    it("returns 403 for non-admin on health check", async () => {
      const req = makeGetRequest(`/api/orgs/${orgId}/delegation/health`);
      const resp = await handleDelegationHealth(req, NON_ADMIN_AUTH, orgId, deps);
      expect(resp.status).toBe(403);
    });

    it("returns 403 for non-admin on credential rotation", async () => {
      const req = makePostRequest(`/api/orgs/${orgId}/delegation/rotate`, { service_account_key: SA_KEY_2 });
      const resp = await handleDelegationRotate(req, NON_ADMIN_AUTH, orgId, deps);
      expect(resp.status).toBe(403);
    });

    it("returns 403 for non-admin on audit log", async () => {
      const req = makeGetRequest(`/api/orgs/${orgId}/audit`);
      const resp = await handleAuditLog(req, NON_ADMIN_AUTH, orgId, deps);
      expect(resp.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // AC-1: Dashboard overview
  // -------------------------------------------------------------------------

  describe("dashboard overview (AC-1)", () => {
    it("returns delegation status + user stats + audit + config", async () => {
      const req = makeGetRequest(`/api/orgs/${orgId}/dashboard`);
      const resp = await handleOrgDashboard(req, ADMIN_AUTH, orgId, deps);
      expect(resp.status).toBe(200);

      const body = await resp.json() as { ok: boolean; data: Record<string, unknown> };
      expect(body.ok).toBe(true);

      const data = body.data;

      // Delegation status
      const delegation = data.delegation as Record<string, unknown>;
      expect(delegation.delegation_id).toBe(orgId);
      expect(delegation.domain).toBe("acme.com");
      expect(delegation.admin_email).toBe("admin@acme.com");
      expect(delegation.delegation_status).toBe("active");
      expect(delegation.sa_client_email).toBe("sa@tminus-test.iam.gserviceaccount.com");
      expect(delegation.registration_date).toBeDefined();

      // User stats
      const stats = data.user_stats as Record<string, number>;
      expect(stats.total).toBe(4);
      expect(stats.active).toBe(2);
      expect(stats.suspended).toBe(1);
      expect(stats.removed).toBe(1);

      // Config is null until explicitly set
      expect(data.discovery_config).toBeNull();
    });

    it("shows needs-rotation status when key rotation is overdue", async () => {
      // Set rotation due to past date
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);
      db.prepare("UPDATE org_delegations SET sa_key_rotation_due_at = ? WHERE delegation_id = ?")
        .run(pastDate.toISOString(), orgId);

      const req = makeGetRequest(`/api/orgs/${orgId}/dashboard`);
      const resp = await handleOrgDashboard(req, ADMIN_AUTH, orgId, deps);
      const body = await resp.json() as { ok: boolean; data: Record<string, unknown> };

      const delegation = body.data.delegation as Record<string, unknown>;
      expect(delegation.status).toBe("needs-rotation");
      // Raw delegation_status remains "active"
      expect(delegation.delegation_status).toBe("active");
    });

    it("includes recent audit entries in dashboard", async () => {
      // Generate some audit entries
      await delegationService.checkDelegationHealth(orgId);

      const req = makeGetRequest(`/api/orgs/${orgId}/dashboard`);
      const resp = await handleOrgDashboard(req, ADMIN_AUTH, orgId, deps);
      const body = await resp.json() as { ok: boolean; data: Record<string, unknown> };

      const audit = body.data.recent_audit as Array<Record<string, unknown>>;
      expect(audit.length).toBeGreaterThan(0);
      // Health check generates an audit entry
      const healthEntry = audit.find((e) => e.action === "health_check");
      expect(healthEntry).toBeDefined();
    });

    it("returns 404 for non-existent org", async () => {
      const req = makeGetRequest("/api/orgs/nonexistent/dashboard");
      const resp = await handleOrgDashboard(req, ADMIN_AUTH, "nonexistent", deps);
      expect(resp.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // AC-2: User list endpoint
  // -------------------------------------------------------------------------

  describe("user list endpoint (AC-2)", () => {
    it("returns all discovered users", async () => {
      const req = makeGetRequest(`/api/orgs/${orgId}/users`);
      const resp = await handleListDiscoveredUsers(req, ADMIN_AUTH, orgId, deps);
      expect(resp.status).toBe(200);

      const body = await resp.json() as { ok: boolean; data: { users: Array<Record<string, unknown>>; pagination: Record<string, number> } };
      expect(body.ok).toBe(true);
      expect(body.data.users).toHaveLength(4);
      expect(body.data.pagination.total).toBe(4);
    });

    it("filters users by status", async () => {
      const req = makeGetRequest(`/api/orgs/${orgId}/users?status=active`);
      const resp = await handleListDiscoveredUsers(req, ADMIN_AUTH, orgId, deps);
      const body = await resp.json() as { ok: boolean; data: { users: Array<Record<string, unknown>>; pagination: Record<string, number> } };

      expect(body.data.users).toHaveLength(2);
      expect(body.data.pagination.total).toBe(2);
      for (const user of body.data.users) {
        expect(user.status).toBe("active");
      }
    });

    it("paginates results", async () => {
      const req = makeGetRequest(`/api/orgs/${orgId}/users?limit=2&offset=0`);
      const resp = await handleListDiscoveredUsers(req, ADMIN_AUTH, orgId, deps);
      const body = await resp.json() as { ok: boolean; data: { users: Array<Record<string, unknown>>; pagination: Record<string, number> } };

      expect(body.data.users).toHaveLength(2);
      expect(body.data.pagination.total).toBe(4);
      expect(body.data.pagination.limit).toBe(2);
      expect(body.data.pagination.offset).toBe(0);

      // Page 2
      const req2 = makeGetRequest(`/api/orgs/${orgId}/users?limit=2&offset=2`);
      const resp2 = await handleListDiscoveredUsers(req2, ADMIN_AUTH, orgId, deps);
      const body2 = await resp2.json() as { ok: boolean; data: { users: Array<Record<string, unknown>>; pagination: Record<string, number> } };

      expect(body2.data.users).toHaveLength(2);
      expect(body2.data.pagination.offset).toBe(2);
    });

    it("returns user details for a specific user", async () => {
      const req = makeGetRequest(`/api/orgs/${orgId}/users/dsc_001`);
      const resp = await handleGetDiscoveredUser(req, ADMIN_AUTH, orgId, "dsc_001", deps);
      expect(resp.status).toBe(200);

      const body = await resp.json() as { ok: boolean; data: Record<string, unknown> };
      expect(body.data.discovery_id).toBe("dsc_001");
      expect(body.data.email).toBe("alice@acme.com");
      expect(body.data.display_name).toBe("Alice Smith");
      expect(body.data.status).toBe("active");
    });

    it("returns 404 for non-existent user", async () => {
      const req = makeGetRequest(`/api/orgs/${orgId}/users/dsc_nonexistent`);
      const resp = await handleGetDiscoveredUser(req, ADMIN_AUTH, orgId, "dsc_nonexistent", deps);
      expect(resp.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // User status update
  // -------------------------------------------------------------------------

  describe("user status update", () => {
    it("transitions active user to suspended", async () => {
      const req = makePatchRequest(`/api/orgs/${orgId}/users/dsc_001`, { status: "suspended" });
      const resp = await handleUpdateDiscoveredUser(req, ADMIN_AUTH, orgId, "dsc_001", deps);
      expect(resp.status).toBe(200);

      const body = await resp.json() as { ok: boolean; data: Record<string, unknown> };
      expect(body.data.status).toBe("suspended");

      // Verify in real DB
      const row = db.prepare("SELECT status FROM org_discovered_users WHERE discovery_id = 'dsc_001'").get() as { status: string };
      expect(row.status).toBe("suspended");
    });

    it("rejects invalid state transition (removed -> active)", async () => {
      const req = makePatchRequest(`/api/orgs/${orgId}/users/dsc_004`, { status: "active" });
      const resp = await handleUpdateDiscoveredUser(req, ADMIN_AUTH, orgId, "dsc_004", deps);
      expect(resp.status).toBe(422);

      const body = await resp.json() as { ok: boolean; error: string };
      expect(body.error).toContain("Invalid transition");
    });

    it("returns 400 for invalid status value", async () => {
      const req = makePatchRequest(`/api/orgs/${orgId}/users/dsc_001`, { status: "deleted" });
      const resp = await handleUpdateDiscoveredUser(req, ADMIN_AUTH, orgId, "dsc_001", deps);
      expect(resp.status).toBe(400);
    });

    it("returns 404 for non-existent user", async () => {
      const req = makePatchRequest(`/api/orgs/${orgId}/users/dsc_nonexistent`, { status: "suspended" });
      const resp = await handleUpdateDiscoveredUser(req, ADMIN_AUTH, orgId, "dsc_nonexistent", deps);
      expect(resp.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // AC-3: Discovery config read and update
  // -------------------------------------------------------------------------

  describe("discovery config (AC-3)", () => {
    it("returns default config when none is set", async () => {
      const req = makeGetRequest(`/api/orgs/${orgId}/discovery/config`);
      const resp = await handleGetDiscoveryConfig(req, ADMIN_AUTH, orgId, deps);
      expect(resp.status).toBe(200);

      const body = await resp.json() as { ok: boolean; data: Record<string, unknown> };
      expect(body.data.delegation_id).toBe(orgId);
      expect(body.data.sync_mode).toBe("lazy");
      expect(body.data.ou_filter).toBeNull();
      expect(body.data.excluded_emails).toBeNull();
      expect(body.data.retention_days).toBe(30);
    });

    it("updates discovery config and persists in real DB", async () => {
      const req = makePutRequest(`/api/orgs/${orgId}/discovery/config`, {
        sync_mode: "proactive",
        ou_filter: ["/Engineering"],
        excluded_emails: ["noreply@acme.com"],
        retention_days: 60,
      });
      const resp = await handleUpdateDiscoveryConfig(req, ADMIN_AUTH, orgId, deps);
      expect(resp.status).toBe(200);

      const body = await resp.json() as { ok: boolean; data: Record<string, unknown> };
      expect(body.data.sync_mode).toBe("proactive");
      expect(body.data.ou_filter).toEqual(["/Engineering"]);
      expect(body.data.excluded_emails).toEqual(["noreply@acme.com"]);
      expect(body.data.retention_days).toBe(60);

      // Verify persisted in real SQLite
      const row = db.prepare("SELECT * FROM org_discovery_config WHERE delegation_id = ?").get(orgId) as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.sync_mode).toBe("proactive");
      expect(JSON.parse(row.ou_filter_json as string)).toEqual(["/Engineering"]);
      expect(JSON.parse(row.excluded_emails as string)).toEqual(["noreply@acme.com"]);
      expect(row.retention_days).toBe(60);
    });

    it("reads back updated config", async () => {
      // First update
      const putReq = makePutRequest(`/api/orgs/${orgId}/discovery/config`, {
        sync_mode: "proactive",
        retention_days: 90,
      });
      await handleUpdateDiscoveryConfig(putReq, ADMIN_AUTH, orgId, deps);

      // Then read
      const getReq = makeGetRequest(`/api/orgs/${orgId}/discovery/config`);
      const resp = await handleGetDiscoveryConfig(getReq, ADMIN_AUTH, orgId, deps);
      const body = await resp.json() as { ok: boolean; data: Record<string, unknown> };

      expect(body.data.sync_mode).toBe("proactive");
      expect(body.data.retention_days).toBe(90);
    });

    it("rejects invalid sync_mode", async () => {
      const req = makePutRequest(`/api/orgs/${orgId}/discovery/config`, { sync_mode: "turbo" });
      const resp = await handleUpdateDiscoveryConfig(req, ADMIN_AUTH, orgId, deps);
      expect(resp.status).toBe(400);
    });

    it("clears ou_filter when set to null", async () => {
      // First set a filter
      const putReq1 = makePutRequest(`/api/orgs/${orgId}/discovery/config`, {
        ou_filter: ["/Engineering"],
      });
      await handleUpdateDiscoveryConfig(putReq1, ADMIN_AUTH, orgId, deps);

      // Then clear it
      const putReq2 = makePutRequest(`/api/orgs/${orgId}/discovery/config`, {
        ou_filter: null,
      });
      await handleUpdateDiscoveryConfig(putReq2, ADMIN_AUTH, orgId, deps);

      const getReq = makeGetRequest(`/api/orgs/${orgId}/discovery/config`);
      const resp = await handleGetDiscoveryConfig(getReq, ADMIN_AUTH, orgId, deps);
      const body = await resp.json() as { ok: boolean; data: Record<string, unknown> };
      expect(body.data.ou_filter).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // AC-4: Credential health check and rotation
  // -------------------------------------------------------------------------

  describe("delegation health check (AC-4)", () => {
    it("returns healthy status for active delegation", async () => {
      const req = makeGetRequest(`/api/orgs/${orgId}/delegation/health`);
      const resp = await handleDelegationHealth(req, ADMIN_AUTH, orgId, deps);
      expect(resp.status).toBe(200);

      const body = await resp.json() as { ok: boolean; data: Record<string, unknown> };
      expect(body.data.status).toBe("healthy");
      expect(body.data.can_impersonate_admin).toBe(true);
      expect(body.data.scopes_valid).toBe(true);
      expect(body.data.domain).toBe("acme.com");
      expect(body.data.checked_at).toBeDefined();
      expect(body.data.error).toBeNull();
    });

    it("updates health check status in DB", async () => {
      const req = makeGetRequest(`/api/orgs/${orgId}/delegation/health`);
      await handleDelegationHealth(req, ADMIN_AUTH, orgId, deps);

      const row = db.prepare("SELECT health_check_status, last_health_check_at FROM org_delegations WHERE delegation_id = ?")
        .get(orgId) as Record<string, unknown>;
      expect(row.health_check_status).toBe("healthy");
      expect(row.last_health_check_at).toBeDefined();
    });
  });

  describe("credential rotation (AC-4)", () => {
    it("rotates credentials and returns new/old key IDs", async () => {
      const req = makePostRequest(`/api/orgs/${orgId}/delegation/rotate`, {
        service_account_key: SA_KEY_2,
      });
      const resp = await handleDelegationRotate(req, ADMIN_AUTH, orgId, deps);
      expect(resp.status).toBe(200);

      const body = await resp.json() as { ok: boolean; data: Record<string, unknown> };
      expect(body.data.success).toBe(true);
      expect(body.data.old_key_id).toBe("key-alpha");
      expect(body.data.new_key_id).toBe("key-beta");
      expect(body.data.rotated_at).toBeDefined();
    });

    it("rotation is audited in DB (BR-2)", async () => {
      const req = makePostRequest(`/api/orgs/${orgId}/delegation/rotate`, {
        service_account_key: SA_KEY_2,
      });
      await handleDelegationRotate(req, ADMIN_AUTH, orgId, deps);

      const auditRow = db.prepare("SELECT * FROM delegation_audit_log WHERE action = 'key_rotated' AND delegation_id = ?")
        .get(orgId) as Record<string, unknown>;
      expect(auditRow).toBeDefined();
      expect(auditRow.domain).toBe("acme.com");

      const details = JSON.parse(auditRow.details as string);
      expect(details.oldKeyId).toBe("key-alpha");
      expect(details.newKeyId).toBe("key-beta");
    });

    it("returns 400 when service_account_key is missing", async () => {
      const req = makePostRequest(`/api/orgs/${orgId}/delegation/rotate`, {});
      const resp = await handleDelegationRotate(req, ADMIN_AUTH, orgId, deps);
      expect(resp.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // AC-5: Audit log endpoint
  // -------------------------------------------------------------------------

  describe("audit log endpoint (AC-5)", () => {
    it("returns paginated audit entries", async () => {
      // Generate some audit events
      await delegationService.checkDelegationHealth(orgId);
      await delegationService.rotateCredential(orgId, SA_KEY_2);

      const req = makeGetRequest(`/api/orgs/${orgId}/audit`);
      const resp = await handleAuditLog(req, ADMIN_AUTH, orgId, deps);
      expect(resp.status).toBe(200);

      const body = await resp.json() as { ok: boolean; data: { entries: Array<Record<string, unknown>>; pagination: Record<string, number> } };
      expect(body.data.entries.length).toBeGreaterThanOrEqual(2);
      expect(body.data.pagination.total).toBeGreaterThanOrEqual(2);

      // Entries have expected shape
      for (const entry of body.data.entries) {
        expect(entry.audit_id).toBeDefined();
        expect(entry.delegation_id).toBe(orgId);
        expect(entry.action).toBeDefined();
        expect(entry.created_at).toBeDefined();
      }
    });

    it("filters audit log by action", async () => {
      await delegationService.checkDelegationHealth(orgId);
      await delegationService.rotateCredential(orgId, SA_KEY_2);

      const req = makeGetRequest(`/api/orgs/${orgId}/audit?action=key_rotated`);
      const resp = await handleAuditLog(req, ADMIN_AUTH, orgId, deps);
      const body = await resp.json() as { ok: boolean; data: { entries: Array<Record<string, unknown>>; pagination: Record<string, number> } };

      expect(body.data.entries.length).toBeGreaterThanOrEqual(1);
      for (const entry of body.data.entries) {
        expect(entry.action).toBe("key_rotated");
      }
    });

    it("paginates audit entries", async () => {
      // Generate several audit events
      await delegationService.checkDelegationHealth(orgId);
      await delegationService.checkDelegationHealth(orgId);
      await delegationService.checkDelegationHealth(orgId);

      const req = makeGetRequest(`/api/orgs/${orgId}/audit?limit=2&offset=0`);
      const resp = await handleAuditLog(req, ADMIN_AUTH, orgId, deps);
      const body = await resp.json() as { ok: boolean; data: { entries: Array<Record<string, unknown>>; pagination: Record<string, number> } };

      expect(body.data.entries).toHaveLength(2);
      expect(body.data.pagination.limit).toBe(2);
      expect(body.data.pagination.offset).toBe(0);
      expect(body.data.pagination.total).toBeGreaterThanOrEqual(3);
    });
  });

  // -------------------------------------------------------------------------
  // End-to-end lifecycle
  // -------------------------------------------------------------------------

  describe("full admin lifecycle", () => {
    it("dashboard -> list users -> configure -> health check -> rotate -> audit", async () => {
      // 1. Dashboard
      const dashReq = makeGetRequest(`/api/orgs/${orgId}/dashboard`);
      const dashResp = await handleOrgDashboard(dashReq, ADMIN_AUTH, orgId, deps);
      expect(dashResp.status).toBe(200);

      // 2. List active users
      const listReq = makeGetRequest(`/api/orgs/${orgId}/users?status=active`);
      const listResp = await handleListDiscoveredUsers(listReq, ADMIN_AUTH, orgId, deps);
      const listBody = await listResp.json() as { data: { users: Array<Record<string, unknown>> } };
      expect(listBody.data.users).toHaveLength(2);

      // 3. Update discovery config
      const configReq = makePutRequest(`/api/orgs/${orgId}/discovery/config`, {
        sync_mode: "proactive",
        ou_filter: ["/Engineering"],
        retention_days: 90,
      });
      const configResp = await handleUpdateDiscoveryConfig(configReq, ADMIN_AUTH, orgId, deps);
      expect(configResp.status).toBe(200);

      // 4. Health check
      const healthReq = makeGetRequest(`/api/orgs/${orgId}/delegation/health`);
      const healthResp = await handleDelegationHealth(healthReq, ADMIN_AUTH, orgId, deps);
      expect(healthResp.status).toBe(200);

      // 5. Rotate credentials
      const rotateReq = makePostRequest(`/api/orgs/${orgId}/delegation/rotate`, {
        service_account_key: SA_KEY_2,
      });
      const rotateResp = await handleDelegationRotate(rotateReq, ADMIN_AUTH, orgId, deps);
      expect(rotateResp.status).toBe(200);

      // 6. Audit log shows all actions
      const auditReq = makeGetRequest(`/api/orgs/${orgId}/audit`);
      const auditResp = await handleAuditLog(auditReq, ADMIN_AUTH, orgId, deps);
      const auditBody = await auditResp.json() as { data: { entries: Array<Record<string, unknown>> } };

      const actions = auditBody.data.entries.map((e) => e.action);
      expect(actions).toContain("health_check");
      expect(actions).toContain("key_rotated");
    });
  });
});
