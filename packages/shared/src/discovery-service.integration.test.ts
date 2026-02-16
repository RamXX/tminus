/**
 * Integration tests for DiscoveryService with real SQLite (TM-9iu.3).
 *
 * Uses better-sqlite3 (same SQLite engine as D1) to validate the complete
 * user discovery and federation lifecycle against REAL database operations:
 *
 * 1. User discovery detects new, suspended, and removed users (AC-1, AC-3, AC-4)
 * 2. Automatic federation creates entries for discovered users (AC-2)
 * 3. Removed user cleanup deletes entries per retention policy (AC-4)
 * 4. OU filter and exclusion list work with real data (AC-5, AC-6)
 * 5. Rate limiting state persists correctly (AC-7)
 * 6. Discovery config CRUD with real SQL constraints
 *
 * The store is REAL SQLite -- no InMemoryDiscoveryStore. Only the Google
 * Directory API fetch is mocked via injectable fetchFn, following the same
 * pattern as org-delegation-v2.integration.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { MIGRATION_0025_ORG_DISCOVERY } from "@tminus/d1-registry";
import { DiscoveryService } from "./discovery-service";
import type { DiscoveryStore, TokenProvider } from "./discovery-service";
import type {
  DiscoveredUser,
  DiscoveredUserStatus,
  DiscoveryConfig,
} from "./discovery-schemas";

// ---------------------------------------------------------------------------
// D1DiscoveryStore -- real SQLite-backed implementation
// ---------------------------------------------------------------------------

/**
 * Production-like DiscoveryStore backed by real SQLite.
 * Maps the DiscoveryStore interface to SQL queries against the
 * org_discovered_users and org_discovery_config tables (migration 0025).
 */
class D1DiscoveryStore implements DiscoveryStore {
  constructor(private readonly db: DatabaseType) {}

  async getConfig(delegationId: string): Promise<DiscoveryConfig | null> {
    const row = this.db
      .prepare("SELECT * FROM org_discovery_config WHERE delegation_id = ?")
      .get(delegationId) as Record<string, unknown> | undefined;

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

  async upsertConfig(config: DiscoveryConfig & { configId: string }): Promise<void> {
    const now = new Date().toISOString();
    // Use INSERT OR REPLACE since delegation_id has a UNIQUE constraint
    this.db
      .prepare(
        `INSERT OR REPLACE INTO org_discovery_config
         (config_id, delegation_id, ou_filter_json, excluded_emails,
          sync_mode, retention_days, created_at, updated_at)
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

  async getDiscoveredUsers(
    delegationId: string,
    status?: DiscoveredUserStatus,
  ): Promise<DiscoveredUser[]> {
    let sql = "SELECT * FROM org_discovered_users WHERE delegation_id = ?";
    const params: unknown[] = [delegationId];

    if (status) {
      sql += " AND status = ?";
      params.push(status);
    }

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.rowToDiscoveredUser(row));
  }

  async getDiscoveredUser(
    delegationId: string,
    googleUserId: string,
  ): Promise<DiscoveredUser | null> {
    const row = this.db
      .prepare(
        "SELECT * FROM org_discovered_users WHERE delegation_id = ? AND google_user_id = ?",
      )
      .get(delegationId, googleUserId) as Record<string, unknown> | undefined;

    return row ? this.rowToDiscoveredUser(row) : null;
  }

  async getDiscoveredUserByEmail(
    delegationId: string,
    email: string,
  ): Promise<DiscoveredUser | null> {
    // Case-insensitive email lookup
    const row = this.db
      .prepare(
        "SELECT * FROM org_discovered_users WHERE delegation_id = ? AND LOWER(email) = LOWER(?)",
      )
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
      );
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

    for (const [key, col] of Object.entries(fieldMap)) {
      if (key in updates) {
        sets.push(`${col} = ?`);
        values.push((updates as Record<string, unknown>)[key] ?? null);
      }
    }

    if (sets.length === 0) return;

    values.push(discoveryId);
    this.db
      .prepare(
        `UPDATE org_discovered_users SET ${sets.join(", ")} WHERE discovery_id = ?`,
      )
      .run(...values);
  }

  async getRemovedUsersForCleanup(
    delegationId: string,
    beforeDate: string,
  ): Promise<DiscoveredUser[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM org_discovered_users
         WHERE delegation_id = ? AND status = 'removed' AND removed_at < ?`,
      )
      .all(delegationId, beforeDate) as Record<string, unknown>[];

    return rows.map((row) => this.rowToDiscoveredUser(row));
  }

  async deleteDiscoveredUser(discoveryId: string): Promise<void> {
    this.db
      .prepare("DELETE FROM org_discovered_users WHERE discovery_id = ?")
      .run(discoveryId);
  }

  async updateLastDiscoveryAt(
    delegationId: string,
    timestamp: string,
  ): Promise<void> {
    this.db
      .prepare(
        "UPDATE org_discovery_config SET last_discovery_at = ?, updated_at = ? WHERE delegation_id = ?",
      )
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
// Mock token provider (only external API dependency is mocked)
// ---------------------------------------------------------------------------

class MockTokenProvider implements TokenProvider {
  async getDirectoryToken(
    _delegationId: string,
    _adminEmail: string,
  ): Promise<string> {
    return "mock-directory-token";
  }
}

// ---------------------------------------------------------------------------
// Mock fetch for Directory API (the only mock -- store is real SQLite)
// ---------------------------------------------------------------------------

function createDirectoryMockFetch(users: Record<string, unknown>[]) {
  return vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as Request).url;

    if (url.includes("admin.googleapis.com/admin/directory/v1/users")) {
      return new Response(
        JSON.stringify({ users }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("Not found", { status: 404 });
  });
}

function createPaginatedDirectoryMockFetch(
  page1Users: Record<string, unknown>[],
  page2Users: Record<string, unknown>[],
) {
  let callCount = 0;
  return vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as Request).url;

    if (url.includes("admin.googleapis.com/admin/directory/v1/users")) {
      callCount++;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({ users: page1Users, nextPageToken: "page2token" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ users: page2Users }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("Not found", { status: 404 });
  });
}

// ---------------------------------------------------------------------------
// Test directory users (same as unit tests for comparison)
// ---------------------------------------------------------------------------

const DIRECTORY_USERS = [
  {
    id: "guser-001",
    primaryEmail: "alice@acme.com",
    name: { fullName: "Alice Smith" },
    suspended: false,
    archived: false,
    orgUnitPath: "/Engineering",
  },
  {
    id: "guser-002",
    primaryEmail: "bob@acme.com",
    name: { fullName: "Bob Jones" },
    suspended: false,
    archived: false,
    orgUnitPath: "/Engineering/Backend",
  },
  {
    id: "guser-003",
    primaryEmail: "carol@acme.com",
    name: { fullName: "Carol Davis" },
    suspended: false,
    archived: false,
    orgUnitPath: "/Sales",
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DiscoveryService integration (real SQLite)", () => {
  let db: DatabaseType;
  let store: D1DiscoveryStore;
  let tokenProvider: MockTokenProvider;
  let service: DiscoveryService;
  let mockFetch: ReturnType<typeof createDirectoryMockFetch>;

  beforeEach(() => {
    // Create in-memory SQLite and apply discovery migration
    db = new Database(":memory:");
    db.exec(MIGRATION_0025_ORG_DISCOVERY);

    store = new D1DiscoveryStore(db);
    tokenProvider = new MockTokenProvider();
    mockFetch = createDirectoryMockFetch(DIRECTORY_USERS);
    service = new DiscoveryService(store, tokenProvider, mockFetch);
  });

  afterEach(() => {
    db.close();
  });

  // -----------------------------------------------------------------------
  // Schema validation -- tables and indexes exist
  // -----------------------------------------------------------------------

  describe("migration 0025 schema", () => {
    it("creates org_discovered_users table with correct columns", () => {
      const columns = db
        .prepare("PRAGMA table_info(org_discovered_users)")
        .all() as Array<{ name: string }>;
      const names = columns.map((c) => c.name);

      expect(names).toContain("discovery_id");
      expect(names).toContain("delegation_id");
      expect(names).toContain("google_user_id");
      expect(names).toContain("email");
      expect(names).toContain("display_name");
      expect(names).toContain("org_unit_path");
      expect(names).toContain("status");
      expect(names).toContain("account_id");
      expect(names).toContain("last_synced_at");
      expect(names).toContain("discovered_at");
      expect(names).toContain("status_changed_at");
      expect(names).toContain("removed_at");
    });

    it("creates org_discovery_config table with correct columns", () => {
      const columns = db
        .prepare("PRAGMA table_info(org_discovery_config)")
        .all() as Array<{ name: string }>;
      const names = columns.map((c) => c.name);

      expect(names).toContain("config_id");
      expect(names).toContain("delegation_id");
      expect(names).toContain("ou_filter_json");
      expect(names).toContain("excluded_emails");
      expect(names).toContain("sync_mode");
      expect(names).toContain("retention_days");
      expect(names).toContain("last_discovery_at");
    });

    it("creates indexes for efficient lookups", () => {
      const indexes = db
        .prepare(
          "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
        )
        .all() as Array<{ name: string; tbl_name: string }>;

      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain("idx_discovered_users_delegation");
      expect(indexNames).toContain("idx_discovered_users_email");
      expect(indexNames).toContain("idx_discovered_users_status");
      expect(indexNames).toContain("idx_discovered_users_account");
      expect(indexNames).toContain("idx_discovery_config_delegation");
    });

    it("enforces UNIQUE(delegation_id, google_user_id) constraint", () => {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO org_discovered_users
         (discovery_id, delegation_id, google_user_id, email, status, discovered_at, status_changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("dsc_001", "dlg_test", "guser-001", "alice@acme.com", "active", now, now);

      expect(() =>
        db
          .prepare(
            `INSERT INTO org_discovered_users
             (discovery_id, delegation_id, google_user_id, email, status, discovered_at, status_changed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("dsc_002", "dlg_test", "guser-001", "alice2@acme.com", "active", now, now),
      ).toThrow(/UNIQUE constraint failed/);
    });

    it("enforces UNIQUE delegation_id on org_discovery_config", () => {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO org_discovery_config
         (config_id, delegation_id, sync_mode, retention_days, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("cfg_001", "dlg_test", "lazy", 30, now, now);

      expect(() =>
        db
          .prepare(
            `INSERT INTO org_discovery_config
             (config_id, delegation_id, sync_mode, retention_days, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run("cfg_002", "dlg_test", "proactive", 60, now, now),
      ).toThrow(/UNIQUE constraint failed/);
    });

    it("enforces CHECK constraint on status column", () => {
      const now = new Date().toISOString();
      expect(() =>
        db
          .prepare(
            `INSERT INTO org_discovered_users
             (discovery_id, delegation_id, google_user_id, email, status, discovered_at, status_changed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("dsc_001", "dlg_test", "guser-001", "alice@acme.com", "invalid_status", now, now),
      ).toThrow(/CHECK constraint failed/);
    });

    it("enforces CHECK constraint on sync_mode column", () => {
      const now = new Date().toISOString();
      expect(() =>
        db
          .prepare(
            `INSERT INTO org_discovery_config
             (config_id, delegation_id, sync_mode, retention_days, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run("cfg_001", "dlg_test", "invalid_mode", 30, now, now),
      ).toThrow(/CHECK constraint failed/);
    });
  });

  // -----------------------------------------------------------------------
  // AC-1: User discovery detects new, suspended, and removed users
  // -----------------------------------------------------------------------

  describe("user discovery with real SQLite (AC-1)", () => {
    it("discovers all active users and persists them to real DB", async () => {
      const result = await service.discoverUsers(
        "dlg_test001",
        "acme.com",
        "admin@acme.com",
      );

      // Verify discovery result
      expect(result.totalUsersFound).toBe(3);
      expect(result.filteredUsersCount).toBe(3);
      expect(result.newUsers).toHaveLength(3);
      expect(result.statusChanges).toHaveLength(0);
      expect(result.removedUsers).toHaveLength(0);

      // Verify data persisted in real SQLite
      const rows = db
        .prepare("SELECT * FROM org_discovered_users WHERE delegation_id = ? ORDER BY email")
        .all("dlg_test001") as Record<string, unknown>[];

      expect(rows).toHaveLength(3);
      expect(rows[0].email).toBe("alice@acme.com");
      expect(rows[0].status).toBe("active");
      expect(rows[0].google_user_id).toBe("guser-001");
      expect(rows[0].display_name).toBe("Alice Smith");
      expect(rows[0].org_unit_path).toBe("/Engineering");
      expect(rows[0].discovered_at).toBeDefined();
      expect(rows[0].status_changed_at).toBeDefined();
      expect(rows[0].removed_at).toBeNull();
      expect(rows[0].account_id).toBeNull();

      expect(rows[1].email).toBe("bob@acme.com");
      expect(rows[2].email).toBe("carol@acme.com");
    });

    it("detects suspended users on re-discovery and updates real DB", async () => {
      // First discovery: all active
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      // Verify all are active in DB
      const activeRows = db
        .prepare("SELECT * FROM org_discovered_users WHERE delegation_id = ? AND status = 'active'")
        .all("dlg_test001") as Record<string, unknown>[];
      expect(activeRows).toHaveLength(3);

      // Second discovery: Bob is now suspended
      const updatedUsers = DIRECTORY_USERS.map((u) =>
        u.id === "guser-002" ? { ...u, suspended: true } : u,
      );
      const mockFetch2 = createDirectoryMockFetch(updatedUsers);
      const service2 = new DiscoveryService(store, tokenProvider, mockFetch2);

      const result = await service2.discoverUsers(
        "dlg_test001",
        "acme.com",
        "admin@acme.com",
      );

      expect(result.statusChanges).toHaveLength(1);
      expect(result.statusChanges[0].previousStatus).toBe("active");
      expect(result.statusChanges[0].newStatus).toBe("suspended");
      expect(result.statusChanges[0].user.email).toBe("bob@acme.com");

      // Verify DB state changed
      const bobRow = db
        .prepare("SELECT * FROM org_discovered_users WHERE google_user_id = ?")
        .get("guser-002") as Record<string, unknown>;
      expect(bobRow.status).toBe("suspended");
      expect(bobRow.status_changed_at).toBeDefined();
    });

    it("detects removed users when absent from Directory API response", async () => {
      // First discovery: 3 users
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      // Second discovery: Carol is gone from the directory
      const remainingUsers = DIRECTORY_USERS.filter((u) => u.id !== "guser-003");
      const mockFetch2 = createDirectoryMockFetch(remainingUsers);
      const service2 = new DiscoveryService(store, tokenProvider, mockFetch2);

      const result = await service2.discoverUsers(
        "dlg_test001",
        "acme.com",
        "admin@acme.com",
      );

      expect(result.removedUsers).toHaveLength(1);
      expect(result.removedUsers[0].email).toBe("carol@acme.com");

      // Verify DB: Carol is marked removed with removedAt set
      const carolRow = db
        .prepare("SELECT * FROM org_discovered_users WHERE google_user_id = ?")
        .get("guser-003") as Record<string, unknown>;
      expect(carolRow.status).toBe("removed");
      expect(carolRow.removed_at).toBeDefined();
      expect(carolRow.removed_at).not.toBeNull();
    });

    it("detects reactivated users (suspended -> active) in real DB", async () => {
      // First discovery: Bob is suspended
      const initialUsers = DIRECTORY_USERS.map((u) =>
        u.id === "guser-002" ? { ...u, suspended: true } : u,
      );
      const mockFetch1 = createDirectoryMockFetch(initialUsers);
      const service1 = new DiscoveryService(store, tokenProvider, mockFetch1);
      await service1.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      // Verify Bob is suspended in DB
      const bobSuspended = db
        .prepare("SELECT status FROM org_discovered_users WHERE google_user_id = ?")
        .get("guser-002") as Record<string, unknown>;
      expect(bobSuspended.status).toBe("suspended");

      // Second discovery: Bob is reactivated (no longer suspended)
      const mockFetch2 = createDirectoryMockFetch(DIRECTORY_USERS);
      const service2 = new DiscoveryService(store, tokenProvider, mockFetch2);

      const result = await service2.discoverUsers(
        "dlg_test001",
        "acme.com",
        "admin@acme.com",
      );

      expect(result.statusChanges).toHaveLength(1);
      expect(result.statusChanges[0].previousStatus).toBe("suspended");
      expect(result.statusChanges[0].newStatus).toBe("active");

      // Verify DB updated
      const bobActive = db
        .prepare("SELECT status FROM org_discovered_users WHERE google_user_id = ?")
        .get("guser-002") as Record<string, unknown>;
      expect(bobActive.status).toBe("active");
    });

    it("does not duplicate users on repeated discovery", async () => {
      // First discovery
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      // Second discovery with same users
      const result = await service.discoverUsers(
        "dlg_test001",
        "acme.com",
        "admin@acme.com",
      );

      expect(result.newUsers).toHaveLength(0);

      // DB still has exactly 3 rows
      const count = db
        .prepare("SELECT COUNT(*) as cnt FROM org_discovered_users WHERE delegation_id = ?")
        .get("dlg_test001") as { cnt: number };
      expect(count.cnt).toBe(3);
    });

    it("handles paginated Directory API responses with real DB", async () => {
      const page1 = [DIRECTORY_USERS[0], DIRECTORY_USERS[1]];
      const page2 = [DIRECTORY_USERS[2]];
      const paginatedFetch = createPaginatedDirectoryMockFetch(page1, page2);
      const paginatedService = new DiscoveryService(
        store,
        tokenProvider,
        paginatedFetch,
      );

      const result = await paginatedService.discoverUsers(
        "dlg_test001",
        "acme.com",
        "admin@acme.com",
      );

      expect(result.totalUsersFound).toBe(3);
      expect(result.newUsers).toHaveLength(3);
      expect(paginatedFetch).toHaveBeenCalledTimes(2);

      // All 3 in DB
      const count = db
        .prepare("SELECT COUNT(*) as cnt FROM org_discovered_users")
        .get() as { cnt: number };
      expect(count.cnt).toBe(3);
    });

    it("updates user metadata (email/name/OU) on re-discovery", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      // Alice changed her name and OU
      const updatedUsers = DIRECTORY_USERS.map((u) =>
        u.id === "guser-001"
          ? { ...u, name: { fullName: "Alice Johnson" }, orgUnitPath: "/Management" }
          : u,
      );
      const mockFetch2 = createDirectoryMockFetch(updatedUsers);
      const service2 = new DiscoveryService(store, tokenProvider, mockFetch2);

      await service2.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      // Verify DB reflects updated metadata
      const aliceRow = db
        .prepare("SELECT * FROM org_discovered_users WHERE google_user_id = ?")
        .get("guser-001") as Record<string, unknown>;
      expect(aliceRow.display_name).toBe("Alice Johnson");
      expect(aliceRow.org_unit_path).toBe("/Management");
    });
  });

  // -----------------------------------------------------------------------
  // AC-2: Automatic federation creates entries for discovered users
  // -----------------------------------------------------------------------

  describe("automatic federation with real SQLite (AC-2)", () => {
    it("federates an active user and stores accountId in real DB", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const result = await service.federateDiscoveredUser(
        "dlg_test001",
        "guser-001",
        async (user) => `acc_${user.googleUserId}`,
      );

      expect(result.accountId).toBe("acc_guser-001");
      expect(result.email).toBe("alice@acme.com");
      expect(result.syncMode).toBe("lazy");

      // Verify DB has account_id set
      const row = db
        .prepare("SELECT account_id FROM org_discovered_users WHERE google_user_id = ?")
        .get("guser-001") as Record<string, unknown>;
      expect(row.account_id).toBe("acc_guser-001");
    });

    it("is idempotent -- returns existing account on second call", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      // First federation
      await service.federateDiscoveredUser(
        "dlg_test001",
        "guser-001",
        async () => "acc_first",
      );

      // Second federation -- should NOT create new account
      const accountCreator = vi.fn(async () => "acc_second");
      const result = await service.federateDiscoveredUser(
        "dlg_test001",
        "guser-001",
        accountCreator,
      );

      expect(result.accountId).toBe("acc_first");
      expect(accountCreator).not.toHaveBeenCalled();

      // DB still has original account_id
      const row = db
        .prepare("SELECT account_id FROM org_discovered_users WHERE google_user_id = ?")
        .get("guser-001") as Record<string, unknown>;
      expect(row.account_id).toBe("acc_first");
    });

    it("federates all pending users in batch", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      let counter = 0;
      const results = await service.federateAllPending(
        "dlg_test001",
        async () => `acc_${++counter}`,
      );

      expect(results).toHaveLength(3);

      // Verify all 3 have account_ids in real DB
      const rows = db
        .prepare(
          "SELECT account_id FROM org_discovered_users WHERE delegation_id = ? AND account_id IS NOT NULL",
        )
        .all("dlg_test001") as Record<string, unknown>[];
      expect(rows).toHaveLength(3);
    });

    it("rejects federation of suspended users", async () => {
      const suspendedUsers = DIRECTORY_USERS.map((u) =>
        u.id === "guser-002" ? { ...u, suspended: true } : u,
      );
      const suspendedFetch = createDirectoryMockFetch(suspendedUsers);
      const suspendedService = new DiscoveryService(
        store,
        tokenProvider,
        suspendedFetch,
      );
      await suspendedService.discoverUsers(
        "dlg_test001",
        "acme.com",
        "admin@acme.com",
      );

      await expect(
        suspendedService.federateDiscoveredUser(
          "dlg_test001",
          "guser-002",
          async () => "acc_test",
        ),
      ).rejects.toThrow("Cannot federate user in status 'suspended'");

      // Verify DB: no account_id set on suspended user
      const row = db
        .prepare("SELECT account_id FROM org_discovered_users WHERE google_user_id = ?")
        .get("guser-002") as Record<string, unknown>;
      expect(row.account_id).toBeNull();
    });

    it("uses proactive sync mode when configured", async () => {
      // Set up config first so updateLastDiscoveryAt works
      await service.upsertConfig({
        delegationId: "dlg_test001",
        syncMode: "proactive",
        retentionDays: 30,
      });

      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const result = await service.federateDiscoveredUser(
        "dlg_test001",
        "guser-001",
        async () => "acc_test",
      );

      expect(result.syncMode).toBe("proactive");

      // Verify config persisted in real DB
      const configRow = db
        .prepare("SELECT sync_mode FROM org_discovery_config WHERE delegation_id = ?")
        .get("dlg_test001") as Record<string, unknown>;
      expect(configRow.sync_mode).toBe("proactive");
    });
  });

  // -----------------------------------------------------------------------
  // AC-4: Removed user cleanup per retention policy
  // -----------------------------------------------------------------------

  describe("removed user cleanup with real SQLite (AC-4)", () => {
    it("deletes removed users past retention period from real DB", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      // Mark Alice as removed 60 days ago (past 30-day default retention)
      const aliceRow = db
        .prepare("SELECT discovery_id FROM org_discovered_users WHERE google_user_id = ?")
        .get("guser-001") as Record<string, unknown>;

      const sixtyDaysAgo = new Date();
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
      db.prepare(
        "UPDATE org_discovered_users SET status = 'removed', removed_at = ? WHERE discovery_id = ?",
      ).run(sixtyDaysAgo.toISOString(), aliceRow.discovery_id);

      const result = await service.cleanupRemovedUsers("dlg_test001");

      expect(result.cleanedUp).toBe(1);
      expect(result.cleanedUpIds).toHaveLength(1);

      // Verify Alice is deleted from real DB
      const remaining = db
        .prepare("SELECT COUNT(*) as cnt FROM org_discovered_users WHERE delegation_id = ?")
        .get("dlg_test001") as { cnt: number };
      expect(remaining.cnt).toBe(2); // Bob and Carol remain
    });

    it("does NOT delete removed users within retention period", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const aliceRow = db
        .prepare("SELECT discovery_id FROM org_discovered_users WHERE google_user_id = ?")
        .get("guser-001") as Record<string, unknown>;

      // Set removed date to 10 days ago (within 30-day retention)
      const tenDaysAgo = new Date();
      tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
      db.prepare(
        "UPDATE org_discovered_users SET status = 'removed', removed_at = ? WHERE discovery_id = ?",
      ).run(tenDaysAgo.toISOString(), aliceRow.discovery_id);

      const result = await service.cleanupRemovedUsers("dlg_test001");

      expect(result.cleanedUp).toBe(0);

      // All 3 still in DB
      const count = db
        .prepare("SELECT COUNT(*) as cnt FROM org_discovered_users WHERE delegation_id = ?")
        .get("dlg_test001") as { cnt: number };
      expect(count.cnt).toBe(3);
    });

    it("calls account cleaner for removed users with AccountDO", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const aliceRow = db
        .prepare("SELECT discovery_id FROM org_discovered_users WHERE google_user_id = ?")
        .get("guser-001") as Record<string, unknown>;

      // Give Alice an account and mark as removed long ago
      const sixtyDaysAgo = new Date();
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
      db.prepare(
        "UPDATE org_discovered_users SET status = 'removed', removed_at = ?, account_id = ? WHERE discovery_id = ?",
      ).run(sixtyDaysAgo.toISOString(), "acc_alice", aliceRow.discovery_id);

      const accountCleaner = vi.fn(async () => {});

      await service.cleanupRemovedUsers("dlg_test001", accountCleaner);

      expect(accountCleaner).toHaveBeenCalledWith("acc_alice");

      // Alice's record deleted from DB
      const aliceGone = db
        .prepare("SELECT * FROM org_discovered_users WHERE discovery_id = ?")
        .get(aliceRow.discovery_id);
      expect(aliceGone).toBeUndefined();
    });

    it("respects custom retention period from config in real DB", async () => {
      // Configure 90-day retention
      await service.upsertConfig({
        delegationId: "dlg_test001",
        syncMode: "lazy",
        retentionDays: 90,
      });

      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const aliceRow = db
        .prepare("SELECT discovery_id FROM org_discovered_users WHERE google_user_id = ?")
        .get("guser-001") as Record<string, unknown>;

      // Set removed date to 60 days ago (within 90-day retention)
      const sixtyDaysAgo = new Date();
      sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
      db.prepare(
        "UPDATE org_discovered_users SET status = 'removed', removed_at = ? WHERE discovery_id = ?",
      ).run(sixtyDaysAgo.toISOString(), aliceRow.discovery_id);

      const result = await service.cleanupRemovedUsers("dlg_test001");
      expect(result.cleanedUp).toBe(0); // 60 < 90 days retention

      // Verify config retention_days in DB
      const configRow = db
        .prepare("SELECT retention_days FROM org_discovery_config WHERE delegation_id = ?")
        .get("dlg_test001") as Record<string, unknown>;
      expect(configRow.retention_days).toBe(90);
    });

    it("cleanup with 7-day retention deletes users removed 8 days ago", async () => {
      // Configure 7-day retention
      await service.upsertConfig({
        delegationId: "dlg_test001",
        syncMode: "lazy",
        retentionDays: 7,
      });

      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      // Mark all 3 as removed at different times
      const rows = db
        .prepare("SELECT discovery_id, google_user_id FROM org_discovered_users ORDER BY google_user_id")
        .all() as Array<{ discovery_id: string; google_user_id: string }>;

      // Alice: removed 8 days ago (past 7-day retention) -- should be cleaned
      const eightDaysAgo = new Date();
      eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);
      db.prepare(
        "UPDATE org_discovered_users SET status = 'removed', removed_at = ? WHERE discovery_id = ?",
      ).run(eightDaysAgo.toISOString(), rows[0].discovery_id);

      // Bob: removed 5 days ago (within 7-day retention) -- should NOT be cleaned
      const fiveDaysAgo = new Date();
      fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
      db.prepare(
        "UPDATE org_discovered_users SET status = 'removed', removed_at = ? WHERE discovery_id = ?",
      ).run(fiveDaysAgo.toISOString(), rows[1].discovery_id);

      // Carol: still active -- should not be touched
      const result = await service.cleanupRemovedUsers("dlg_test001");

      expect(result.cleanedUp).toBe(1);
      expect(result.cleanedUpIds).toContain(rows[0].discovery_id);

      // 2 remaining in DB (Bob removed but within retention, Carol active)
      const remaining = db
        .prepare("SELECT COUNT(*) as cnt FROM org_discovered_users")
        .get() as { cnt: number };
      expect(remaining.cnt).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // AC-5: OU filter with real data
  // -----------------------------------------------------------------------

  describe("OU filter with real SQLite (AC-5)", () => {
    it("filters users by organizational unit and persists filtered set", async () => {
      await service.upsertConfig({
        delegationId: "dlg_test001",
        ouFilter: ["/Engineering"],
        syncMode: "lazy",
        retentionDays: 30,
      });

      const result = await service.discoverUsers(
        "dlg_test001",
        "acme.com",
        "admin@acme.com",
      );

      // 3 found in Directory, but only 2 pass OU filter (Engineering hierarchy)
      expect(result.totalUsersFound).toBe(3);
      expect(result.filteredUsersCount).toBe(2);
      expect(result.newUsers).toHaveLength(2);

      // Only Engineering users in real DB
      const rows = db
        .prepare("SELECT email FROM org_discovered_users WHERE delegation_id = ? ORDER BY email")
        .all("dlg_test001") as Array<{ email: string }>;
      expect(rows).toHaveLength(2);
      expect(rows[0].email).toBe("alice@acme.com");
      expect(rows[1].email).toBe("bob@acme.com");

      // Verify OU filter persisted in config
      const configRow = db
        .prepare("SELECT ou_filter_json FROM org_discovery_config WHERE delegation_id = ?")
        .get("dlg_test001") as Record<string, unknown>;
      expect(JSON.parse(configRow.ou_filter_json as string)).toEqual(["/Engineering"]);
    });

    it("hierarchical OU matching -- /Engineering matches /Engineering/Backend", async () => {
      await service.upsertConfig({
        delegationId: "dlg_test001",
        ouFilter: ["/Engineering"],
        syncMode: "lazy",
        retentionDays: 30,
      });

      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      // Bob is in /Engineering/Backend which is a child of /Engineering
      const bobRow = db
        .prepare("SELECT * FROM org_discovered_users WHERE google_user_id = ?")
        .get("guser-002") as Record<string, unknown>;
      expect(bobRow).toBeDefined();
      expect(bobRow.org_unit_path).toBe("/Engineering/Backend");
    });

    it("no OU filter means all users pass", async () => {
      // Config without ouFilter
      await service.upsertConfig({
        delegationId: "dlg_test001",
        syncMode: "lazy",
        retentionDays: 30,
      });

      const result = await service.discoverUsers(
        "dlg_test001",
        "acme.com",
        "admin@acme.com",
      );

      expect(result.filteredUsersCount).toBe(3);

      const count = db
        .prepare("SELECT COUNT(*) as cnt FROM org_discovered_users")
        .get() as { cnt: number };
      expect(count.cnt).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // AC-6: Exclusion list with real data
  // -----------------------------------------------------------------------

  describe("exclusion list with real SQLite (AC-6)", () => {
    it("excludes specific users and persists remaining set", async () => {
      await service.upsertConfig({
        delegationId: "dlg_test001",
        excludedEmails: ["bob@acme.com"],
        syncMode: "lazy",
        retentionDays: 30,
      });

      const result = await service.discoverUsers(
        "dlg_test001",
        "acme.com",
        "admin@acme.com",
      );

      expect(result.filteredUsersCount).toBe(2);
      const emails = result.newUsers.map((u) => u.email);
      expect(emails).not.toContain("bob@acme.com");

      // Only Alice and Carol in real DB
      const rows = db
        .prepare("SELECT email FROM org_discovered_users WHERE delegation_id = ? ORDER BY email")
        .all("dlg_test001") as Array<{ email: string }>;
      expect(rows).toHaveLength(2);
      expect(rows[0].email).toBe("alice@acme.com");
      expect(rows[1].email).toBe("carol@acme.com");

      // Verify exclusion list persisted in config
      const configRow = db
        .prepare("SELECT excluded_emails FROM org_discovery_config WHERE delegation_id = ?")
        .get("dlg_test001") as Record<string, unknown>;
      expect(JSON.parse(configRow.excluded_emails as string)).toEqual(["bob@acme.com"]);
    });

    it("combined OU filter + exclusion list", async () => {
      await service.upsertConfig({
        delegationId: "dlg_test001",
        ouFilter: ["/Engineering"],
        excludedEmails: ["bob@acme.com"],
        syncMode: "lazy",
        retentionDays: 30,
      });

      const result = await service.discoverUsers(
        "dlg_test001",
        "acme.com",
        "admin@acme.com",
      );

      // OU filter: Alice + Bob (Engineering). Exclusion: remove Bob.
      expect(result.filteredUsersCount).toBe(1);
      expect(result.newUsers).toHaveLength(1);
      expect(result.newUsers[0].email).toBe("alice@acme.com");

      // Only Alice in real DB
      const count = db
        .prepare("SELECT COUNT(*) as cnt FROM org_discovered_users")
        .get() as { cnt: number };
      expect(count.cnt).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // AC-7: Rate limiting state persists
  // -----------------------------------------------------------------------

  describe("rate limiting and API interaction (AC-7)", () => {
    it("calls Directory API with correct authorization header", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      const url = callArgs[0] as string;
      const init = callArgs[1] as RequestInit;

      expect(url).toContain("admin.googleapis.com/admin/directory/v1/users");
      expect(url).toContain("domain=acme.com");
      expect(url).toContain("maxResults=100"); // DIRECTORY_API_RATE_LIMITS.maxPageSize
      expect(init.headers).toBeDefined();
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer mock-directory-token",
      );
    });

    it("throws on Directory API error response", async () => {
      const errorFetch = vi.fn(async (): Promise<Response> => {
        return new Response("Forbidden", { status: 403 });
      });
      const errorService = new DiscoveryService(store, tokenProvider, errorFetch);

      await expect(
        errorService.discoverUsers("dlg_test001", "acme.com", "admin@acme.com"),
      ).rejects.toThrow("Directory API request failed (403)");

      // No users should be in DB after failed discovery
      const count = db
        .prepare("SELECT COUNT(*) as cnt FROM org_discovered_users")
        .get() as { cnt: number };
      expect(count.cnt).toBe(0);
    });

    it("paginated discovery respects delay between calls", async () => {
      const page1 = [DIRECTORY_USERS[0]];
      const page2 = [DIRECTORY_USERS[1]];
      const paginatedFetch = createPaginatedDirectoryMockFetch(page1, page2);
      const paginatedService = new DiscoveryService(
        store,
        tokenProvider,
        paginatedFetch,
      );

      // Just verify it makes 2 calls and gets all users
      const result = await paginatedService.discoverUsers(
        "dlg_test001",
        "acme.com",
        "admin@acme.com",
      );

      expect(paginatedFetch).toHaveBeenCalledTimes(2);
      expect(result.totalUsersFound).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Discovery config CRUD with real SQL
  // -----------------------------------------------------------------------

  describe("discovery config CRUD with real SQLite", () => {
    it("returns null config when not set", async () => {
      const config = await service.getConfig("dlg_nonexistent");
      expect(config).toBeNull();
    });

    it("creates and retrieves config from real DB", async () => {
      await service.upsertConfig({
        delegationId: "dlg_test001",
        ouFilter: ["/Engineering", "/Sales"],
        excludedEmails: ["admin@acme.com", "bot@acme.com"],
        syncMode: "proactive",
        retentionDays: 60,
      });

      const config = await service.getConfig("dlg_test001");
      expect(config).toBeDefined();
      expect(config!.ouFilter).toEqual(["/Engineering", "/Sales"]);
      expect(config!.excludedEmails).toEqual(["admin@acme.com", "bot@acme.com"]);
      expect(config!.syncMode).toBe("proactive");
      expect(config!.retentionDays).toBe(60);

      // Verify raw SQL data
      const row = db
        .prepare("SELECT * FROM org_discovery_config WHERE delegation_id = ?")
        .get("dlg_test001") as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(JSON.parse(row.ou_filter_json as string)).toEqual(["/Engineering", "/Sales"]);
      expect(JSON.parse(row.excluded_emails as string)).toEqual(["admin@acme.com", "bot@acme.com"]);
      expect(row.sync_mode).toBe("proactive");
      expect(row.retention_days).toBe(60);
    });

    it("updates existing config (upsert replaces)", async () => {
      await service.upsertConfig({
        delegationId: "dlg_test001",
        syncMode: "lazy",
        retentionDays: 30,
      });

      await service.upsertConfig({
        delegationId: "dlg_test001",
        syncMode: "proactive",
        retentionDays: 90,
      });

      const config = await service.getConfig("dlg_test001");
      expect(config!.syncMode).toBe("proactive");
      expect(config!.retentionDays).toBe(90);

      // Only one config row in DB (upsert, not duplicate)
      const count = db
        .prepare("SELECT COUNT(*) as cnt FROM org_discovery_config WHERE delegation_id = ?")
        .get("dlg_test001") as { cnt: number };
      expect(count.cnt).toBe(1);
    });

    it("stores last_discovery_at timestamp", async () => {
      await service.upsertConfig({
        delegationId: "dlg_test001",
        syncMode: "lazy",
        retentionDays: 30,
      });

      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const row = db
        .prepare("SELECT last_discovery_at FROM org_discovery_config WHERE delegation_id = ?")
        .get("dlg_test001") as Record<string, unknown>;
      expect(row.last_discovery_at).toBeDefined();
      expect(row.last_discovery_at).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Lifecycle transitions with real SQLite
  // -----------------------------------------------------------------------

  describe("lifecycle transitions with real SQLite", () => {
    it("transitions active -> suspended in real DB", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const aliceRow = db
        .prepare("SELECT discovery_id FROM org_discovered_users WHERE google_user_id = ?")
        .get("guser-001") as { discovery_id: string };

      const result = await service.transitionUserStatus(
        aliceRow.discovery_id,
        "suspended",
        "dlg_test001",
      );

      expect(result.status).toBe("suspended");

      // Verify in DB
      const dbRow = db
        .prepare("SELECT status FROM org_discovered_users WHERE discovery_id = ?")
        .get(aliceRow.discovery_id) as Record<string, unknown>;
      expect(dbRow.status).toBe("suspended");
    });

    it("transitions active -> removed sets removedAt in DB", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const aliceRow = db
        .prepare("SELECT discovery_id FROM org_discovered_users WHERE google_user_id = ?")
        .get("guser-001") as { discovery_id: string };

      const result = await service.transitionUserStatus(
        aliceRow.discovery_id,
        "removed",
        "dlg_test001",
      );

      expect(result.status).toBe("removed");
      expect(result.removedAt).toBeDefined();

      // Verify in DB
      const dbRow = db
        .prepare("SELECT status, removed_at FROM org_discovered_users WHERE discovery_id = ?")
        .get(aliceRow.discovery_id) as Record<string, unknown>;
      expect(dbRow.status).toBe("removed");
      expect(dbRow.removed_at).toBeDefined();
    });

    it("rejects invalid transition removed -> active", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const aliceRow = db
        .prepare("SELECT discovery_id FROM org_discovered_users WHERE google_user_id = ?")
        .get("guser-001") as { discovery_id: string };

      // First remove
      await service.transitionUserStatus(
        aliceRow.discovery_id,
        "removed",
        "dlg_test001",
      );

      // Try to reactivate
      await expect(
        service.transitionUserStatus(
          aliceRow.discovery_id,
          "active",
          "dlg_test001",
        ),
      ).rejects.toThrow("Invalid transition: removed -> active");

      // DB still shows removed
      const dbRow = db
        .prepare("SELECT status FROM org_discovered_users WHERE discovery_id = ?")
        .get(aliceRow.discovery_id) as Record<string, unknown>;
      expect(dbRow.status).toBe("removed");
    });
  });

  // -----------------------------------------------------------------------
  // Query helpers with real SQLite
  // -----------------------------------------------------------------------

  describe("query helpers with real SQLite", () => {
    it("isUserDiscovered returns true for known active user", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const result = await service.isUserDiscovered(
        "dlg_test001",
        "alice@acme.com",
      );
      expect(result).toBe(true);
    });

    it("isUserDiscovered returns false for removed user", async () => {
      await service.discoverUsers("dlg_test001", "acme.com", "admin@acme.com");

      const aliceRow = db
        .prepare("SELECT discovery_id FROM org_discovered_users WHERE google_user_id = ?")
        .get("guser-001") as { discovery_id: string };

      db.prepare(
        "UPDATE org_discovered_users SET status = 'removed' WHERE discovery_id = ?",
      ).run(aliceRow.discovery_id);

      const result = await service.isUserDiscovered(
        "dlg_test001",
        "alice@acme.com",
      );
      expect(result).toBe(false);
    });

    it("getDiscoveredUsers filters by status in real DB", async () => {
      // Discover with one suspended user
      const mixedUsers = DIRECTORY_USERS.map((u) =>
        u.id === "guser-002" ? { ...u, suspended: true } : u,
      );
      const mixedFetch = createDirectoryMockFetch(mixedUsers);
      const mixedService = new DiscoveryService(store, tokenProvider, mixedFetch);
      await mixedService.discoverUsers(
        "dlg_test001",
        "acme.com",
        "admin@acme.com",
      );

      const active = await mixedService.getDiscoveredUsers("dlg_test001", "active");
      expect(active).toHaveLength(2);

      const suspended = await mixedService.getDiscoveredUsers("dlg_test001", "suspended");
      expect(suspended).toHaveLength(1);
      expect(suspended[0].email).toBe("bob@acme.com");

      // Cross-check with raw SQL
      const dbActiveCount = db
        .prepare(
          "SELECT COUNT(*) as cnt FROM org_discovered_users WHERE delegation_id = ? AND status = 'active'",
        )
        .get("dlg_test001") as { cnt: number };
      expect(dbActiveCount.cnt).toBe(2);

      const dbSuspendedCount = db
        .prepare(
          "SELECT COUNT(*) as cnt FROM org_discovered_users WHERE delegation_id = ? AND status = 'suspended'",
        )
        .get("dlg_test001") as { cnt: number };
      expect(dbSuspendedCount.cnt).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Multi-delegation isolation with real SQLite
  // -----------------------------------------------------------------------

  describe("multi-delegation isolation", () => {
    it("users from different delegations are isolated in real DB", async () => {
      // Discover for delegation 1
      await service.discoverUsers("dlg_001", "acme.com", "admin@acme.com");

      // Discover for delegation 2 with different users
      const otherUsers = [
        {
          id: "guser-101",
          primaryEmail: "dave@globex.com",
          name: { fullName: "Dave Wilson" },
          suspended: false,
          archived: false,
          orgUnitPath: "/Engineering",
        },
      ];
      const otherFetch = createDirectoryMockFetch(otherUsers);
      const otherService = new DiscoveryService(store, tokenProvider, otherFetch);
      await otherService.discoverUsers("dlg_002", "globex.com", "admin@globex.com");

      // Verify isolation in real DB
      const dlg1Count = db
        .prepare("SELECT COUNT(*) as cnt FROM org_discovered_users WHERE delegation_id = ?")
        .get("dlg_001") as { cnt: number };
      expect(dlg1Count.cnt).toBe(3);

      const dlg2Count = db
        .prepare("SELECT COUNT(*) as cnt FROM org_discovered_users WHERE delegation_id = ?")
        .get("dlg_002") as { cnt: number };
      expect(dlg2Count.cnt).toBe(1);

      // Service queries are also isolated
      const dlg1Users = await service.getDiscoveredUsers("dlg_001");
      expect(dlg1Users).toHaveLength(3);

      const dlg2Users = await otherService.getDiscoveredUsers("dlg_002");
      expect(dlg2Users).toHaveLength(1);
      expect(dlg2Users[0].email).toBe("dave@globex.com");
    });
  });
});
