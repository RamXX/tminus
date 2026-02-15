/**
 * Integration tests for DO SQLite schema and migration runner.
 *
 * Uses better-sqlite3 with a SqlStorage adapter to simulate the real
 * Cloudflare DO SqlStorage interface. These tests prove:
 *
 * - Schema creates all tables and indexes correctly on fresh DO
 * - Migration runner tracks version and applies incrementally
 * - Re-running migrations is idempotent
 * - Data can be inserted and queried after migration
 * - Foreign key constraints work correctly
 * - Multi-step migration sequences work
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  USER_GRAPH_DO_MIGRATIONS,
  ACCOUNT_DO_MIGRATIONS,
  applyMigrations,
  getSchemaVersion,
} from "./schema";
import type { Migration, SqlStorageLike, SqlStorageCursorLike } from "./schema";

// ---------------------------------------------------------------------------
// SqlStorage adapter for better-sqlite3
// ---------------------------------------------------------------------------

/**
 * Wraps a better-sqlite3 Database to match the Cloudflare DO SqlStorage
 * interface (exec + cursor with toArray/one).
 *
 * This adapter is the bridge between our test environment and production.
 * In production, Cloudflare provides SqlStorage natively on `this.ctx.storage.sql`.
 */
function createSqlStorageAdapter(db: DatabaseType): SqlStorageLike {
  return {
    exec<T extends Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): SqlStorageCursorLike<T> {
      // Determine if this is a statement that returns rows (SELECT, PRAGMA, etc.)
      const trimmed = query.trim().toUpperCase();
      const isSelect =
        trimmed.startsWith("SELECT") ||
        trimmed.startsWith("PRAGMA") ||
        trimmed.startsWith("EXPLAIN");

      if (isSelect) {
        const stmt = db.prepare(query);
        const rows = stmt.all(...bindings) as T[];
        return {
          toArray(): T[] {
            return rows;
          },
          one(): T {
            if (rows.length === 0) {
              throw new Error("Expected at least one row, got none");
            }
            return rows[0];
          },
        };
      }

      // For non-SELECT statements (CREATE, INSERT, UPDATE, DELETE),
      // check if the query contains multiple statements (DDL scripts).
      // better-sqlite3's prepare() only handles single statements,
      // so we use exec() for multi-statement SQL.
      if (bindings.length === 0) {
        db.exec(query);
      } else {
        db.prepare(query).run(...bindings);
      }

      return {
        toArray(): T[] {
          return [];
        },
        one(): T {
          throw new Error("No rows returned from non-SELECT statement");
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// UserGraphDO schema integration tests
// ---------------------------------------------------------------------------

describe("UserGraphDO schema via migration runner", () => {
  let db: DatabaseType;
  let sql: SqlStorageLike;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    sql = createSqlStorageAdapter(db);
  });

  afterEach(() => {
    db.close();
  });

  it("applies cleanly on fresh database", () => {
    applyMigrations(sql, USER_GRAPH_DO_MIGRATIONS, "user_graph");

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_schema%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    expect(tables.map((t) => t.name)).toEqual([
      "calendars",
      "canonical_events",
      "commitment_reports",
      "constraints",
      "drift_alerts",
      "event_journal",
      "event_mirrors",
      "event_participants",
      "interaction_ledger",
      "milestones",
      "onboarding_sessions",
      "policies",
      "policy_edges",
      "relationships",
      "schedule_candidates",
      "schedule_holds",
      "schedule_sessions",
      "scheduling_history",
      "time_allocations",
      "time_commitments",
      "vip_policies",
    ]);
  });

  it("sets schema version to latest after all migrations", () => {
    applyMigrations(sql, USER_GRAPH_DO_MIGRATIONS, "user_graph");
    expect(getSchemaVersion(sql, "user_graph")).toBe(
      USER_GRAPH_DO_MIGRATIONS[USER_GRAPH_DO_MIGRATIONS.length - 1].version,
    );
  });

  it("creates _schema_meta table", () => {
    applyMigrations(sql, USER_GRAPH_DO_MIGRATIONS, "user_graph");

    const meta = db
      .prepare("SELECT * FROM _schema_meta")
      .all() as Array<{ key: string; value: string }>;

    expect(meta).toHaveLength(1);
    expect(meta[0].key).toBe("user_graph_version");
    expect(meta[0].value).toBe(
      String(USER_GRAPH_DO_MIGRATIONS[USER_GRAPH_DO_MIGRATIONS.length - 1].version),
    );
  });

  it("INSERT and SELECT on canonical_events works after migration", () => {
    applyMigrations(sql, USER_GRAPH_DO_MIGRATIONS, "user_graph");

    db.prepare(
      `INSERT INTO canonical_events
       (canonical_event_id, origin_account_id, origin_event_id,
        title, start_ts, end_ts, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "evt_01TEST00000000000000001",
      "acc_01TEST00000000000000001",
      "google_event_123",
      "Team Standup",
      "2026-02-14T09:00:00Z",
      "2026-02-14T09:30:00Z",
      "provider",
    );

    const row = db
      .prepare("SELECT * FROM canonical_events WHERE canonical_event_id = ?")
      .get("evt_01TEST00000000000000001") as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row.title).toBe("Team Standup");
    expect(row.status).toBe("confirmed"); // DEFAULT
    expect(row.visibility).toBe("default"); // DEFAULT
    expect(row.transparency).toBe("opaque"); // DEFAULT
    expect(row.all_day).toBe(0); // DEFAULT
    expect(row.version).toBe(1); // DEFAULT
    expect(typeof row.created_at).toBe("string");
    expect(typeof row.updated_at).toBe("string");
  });

  it("enforces UNIQUE(origin_account_id, origin_event_id) on canonical_events", () => {
    applyMigrations(sql, USER_GRAPH_DO_MIGRATIONS, "user_graph");

    db.prepare(
      `INSERT INTO canonical_events
       (canonical_event_id, origin_account_id, origin_event_id, start_ts, end_ts, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("evt_1", "acc_1", "ge_1", "2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z", "provider");

    expect(() =>
      db
        .prepare(
          `INSERT INTO canonical_events
           (canonical_event_id, origin_account_id, origin_event_id, start_ts, end_ts, source)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("evt_2", "acc_1", "ge_1", "2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z", "provider"),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("event_mirrors FK to canonical_events is enforced", () => {
    applyMigrations(sql, USER_GRAPH_DO_MIGRATIONS, "user_graph");

    // Insert mirror without parent canonical event should fail
    expect(() =>
      db
        .prepare(
          `INSERT INTO event_mirrors
           (canonical_event_id, target_account_id, target_calendar_id)
           VALUES (?, ?, ?)`,
        )
        .run("evt_nonexistent", "acc_1", "cal_1"),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("event_journal records append-only changes", () => {
    applyMigrations(sql, USER_GRAPH_DO_MIGRATIONS, "user_graph");

    // Insert canonical event first
    db.prepare(
      `INSERT INTO canonical_events
       (canonical_event_id, origin_account_id, origin_event_id, start_ts, end_ts, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("evt_1", "acc_1", "ge_1", "2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z", "provider");

    // Append journal entries
    db.prepare(
      `INSERT INTO event_journal
       (journal_id, canonical_event_id, actor, change_type, patch_json)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "jrn_1",
      "evt_1",
      "provider:acc_1",
      "created",
      '{"title":"Team Standup"}',
    );

    db.prepare(
      `INSERT INTO event_journal
       (journal_id, canonical_event_id, actor, change_type, patch_json, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "jrn_2",
      "evt_1",
      "ui:usr_1",
      "updated",
      '{"title":"Daily Standup"}',
      "User rename",
    );

    const entries = db
      .prepare(
        "SELECT * FROM event_journal WHERE canonical_event_id = ? ORDER BY journal_id",
      )
      .all("evt_1") as Array<Record<string, unknown>>;

    expect(entries).toHaveLength(2);
    expect(entries[0].change_type).toBe("created");
    expect(entries[1].change_type).toBe("updated");
    expect(entries[1].reason).toBe("User rename");
  });

  it("policy graph supports edge creation with detail levels", () => {
    applyMigrations(sql, USER_GRAPH_DO_MIGRATIONS, "user_graph");

    // Create policy
    db.prepare(
      "INSERT INTO policies (policy_id, name) VALUES (?, ?)",
    ).run("pol_1", "Default Policy");

    // Create edge
    db.prepare(
      `INSERT INTO policy_edges
       (policy_id, from_account_id, to_account_id, detail_level, calendar_kind)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("pol_1", "acc_personal", "acc_work", "BUSY", "BUSY_OVERLAY");

    const edge = db
      .prepare("SELECT * FROM policy_edges WHERE policy_id = ?")
      .get("pol_1") as Record<string, unknown>;

    expect(edge.from_account_id).toBe("acc_personal");
    expect(edge.to_account_id).toBe("acc_work");
    expect(edge.detail_level).toBe("BUSY");
    expect(edge.calendar_kind).toBe("BUSY_OVERLAY");
  });

  it("indexes are used for time range queries on canonical_events", () => {
    applyMigrations(sql, USER_GRAPH_DO_MIGRATIONS, "user_graph");

    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM canonical_events WHERE start_ts >= ? AND end_ts <= ?",
      )
      .all("2026-01-01", "2026-12-31") as Array<{ detail: string }>;

    const usesIndex = plan.some((row) =>
      row.detail.includes("idx_events_time"),
    );
    expect(usesIndex).toBe(true);
  });

  it("indexes are used for journal lookups by event", () => {
    applyMigrations(sql, USER_GRAPH_DO_MIGRATIONS, "user_graph");

    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM event_journal WHERE canonical_event_id = ?",
      )
      .all("evt_1") as Array<{ detail: string }>;

    const usesIndex = plan.some((row) =>
      row.detail.includes("idx_journal_event"),
    );
    expect(usesIndex).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AccountDO schema integration tests
// ---------------------------------------------------------------------------

describe("AccountDO schema via migration runner", () => {
  let db: DatabaseType;
  let sql: SqlStorageLike;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    sql = createSqlStorageAdapter(db);
  });

  afterEach(() => {
    db.close();
  });

  it("applies cleanly on fresh database", () => {
    applyMigrations(sql, ACCOUNT_DO_MIGRATIONS, "account");

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_schema%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    expect(tables.map((t) => t.name)).toEqual([
      "auth",
      "caldav_calendar_state",
      "encryption_monitor",
      "ms_subscriptions",
      "sync_state",
      "watch_channels",
    ]);
  });

  it("sets schema version to latest after all migrations", () => {
    applyMigrations(sql, ACCOUNT_DO_MIGRATIONS, "account");
    expect(getSchemaVersion(sql, "account")).toBe(
      ACCOUNT_DO_MIGRATIONS[ACCOUNT_DO_MIGRATIONS.length - 1].version,
    );
  });

  it("auth table INSERT and SELECT works", () => {
    applyMigrations(sql, ACCOUNT_DO_MIGRATIONS, "account");

    db.prepare(
      "INSERT INTO auth (account_id, encrypted_tokens, scopes) VALUES (?, ?, ?)",
    ).run("acc_01TEST001", "encrypted_blob_abc", "calendar.readonly");

    const row = db
      .prepare("SELECT * FROM auth WHERE account_id = ?")
      .get("acc_01TEST001") as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row.encrypted_tokens).toBe("encrypted_blob_abc");
    expect(row.scopes).toBe("calendar.readonly");
    expect(typeof row.updated_at).toBe("string");
  });

  it("auth table has provider column with default 'google' after migration v2", () => {
    applyMigrations(sql, ACCOUNT_DO_MIGRATIONS, "account");

    db.prepare(
      "INSERT INTO auth (account_id, encrypted_tokens, scopes) VALUES (?, ?, ?)",
    ).run("acc_01TEST_PROV", "encrypted_blob", "calendar");

    const row = db
      .prepare("SELECT provider FROM auth WHERE account_id = ?")
      .get("acc_01TEST_PROV") as { provider: string };

    expect(row.provider).toBe("google");
  });

  it("auth table allows explicit provider value", () => {
    applyMigrations(sql, ACCOUNT_DO_MIGRATIONS, "account");

    db.prepare(
      "INSERT INTO auth (account_id, encrypted_tokens, scopes, provider) VALUES (?, ?, ?, ?)",
    ).run("acc_01TEST_MS", "encrypted_blob", "calendar", "microsoft");

    const row = db
      .prepare("SELECT provider FROM auth WHERE account_id = ?")
      .get("acc_01TEST_MS") as { provider: string };

    expect(row.provider).toBe("microsoft");
  });

  it("auth table rejects null encrypted_tokens", () => {
    applyMigrations(sql, ACCOUNT_DO_MIGRATIONS, "account");

    expect(() =>
      db
        .prepare(
          "INSERT INTO auth (account_id, encrypted_tokens, scopes) VALUES (?, ?, ?)",
        )
        .run("acc_bad", null, "calendar.readonly"),
    ).toThrow(/NOT NULL constraint failed/);
  });

  it("sync_state defaults full_sync_needed to 1", () => {
    applyMigrations(sql, ACCOUNT_DO_MIGRATIONS, "account");

    db.prepare(
      "INSERT INTO sync_state (account_id) VALUES (?)",
    ).run("acc_01TEST001");

    const row = db
      .prepare("SELECT * FROM sync_state WHERE account_id = ?")
      .get("acc_01TEST001") as Record<string, unknown>;

    expect(row.full_sync_needed).toBe(1);
    expect(row.sync_token).toBeNull();
    expect(row.last_sync_ts).toBeNull();
  });

  it("sync_state can store and update sync tokens", () => {
    applyMigrations(sql, ACCOUNT_DO_MIGRATIONS, "account");

    db.prepare(
      "INSERT INTO sync_state (account_id) VALUES (?)",
    ).run("acc_01TEST001");

    db.prepare(
      "UPDATE sync_state SET sync_token = ?, last_sync_ts = ?, full_sync_needed = 0 WHERE account_id = ?",
    ).run("next_sync_token_abc", "2026-02-14T10:00:00Z", "acc_01TEST001");

    const row = db
      .prepare("SELECT * FROM sync_state WHERE account_id = ?")
      .get("acc_01TEST001") as Record<string, unknown>;

    expect(row.sync_token).toBe("next_sync_token_abc");
    expect(row.last_sync_ts).toBe("2026-02-14T10:00:00Z");
    expect(row.full_sync_needed).toBe(0);
  });

  it("watch_channels CRUD works with defaults", () => {
    applyMigrations(sql, ACCOUNT_DO_MIGRATIONS, "account");

    db.prepare(
      `INSERT INTO watch_channels
       (channel_id, account_id, expiry_ts, calendar_id)
       VALUES (?, ?, ?, ?)`,
    ).run("ch_001", "acc_01TEST001", "2026-02-21T10:00:00Z", "primary");

    const row = db
      .prepare("SELECT * FROM watch_channels WHERE channel_id = ?")
      .get("ch_001") as Record<string, unknown>;

    expect(row.account_id).toBe("acc_01TEST001");
    expect(row.status).toBe("active"); // DEFAULT
    expect(row.resource_id).toBeNull();
    expect(typeof row.created_at).toBe("string");
  });

  it("watch_channels can be updated to expired", () => {
    applyMigrations(sql, ACCOUNT_DO_MIGRATIONS, "account");

    db.prepare(
      `INSERT INTO watch_channels
       (channel_id, account_id, resource_id, expiry_ts, calendar_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("ch_001", "acc_01TEST001", "res_abc", "2026-02-21T10:00:00Z", "primary");

    db.prepare(
      "UPDATE watch_channels SET status = ? WHERE channel_id = ?",
    ).run("expired", "ch_001");

    const row = db
      .prepare("SELECT status FROM watch_channels WHERE channel_id = ?")
      .get("ch_001") as Record<string, unknown>;

    expect(row.status).toBe("expired");
  });
});

// ---------------------------------------------------------------------------
// Migration runner behavior tests
// ---------------------------------------------------------------------------

describe("migration runner", () => {
  let db: DatabaseType;
  let sql: SqlStorageLike;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    sql = createSqlStorageAdapter(db);
  });

  afterEach(() => {
    db.close();
  });

  it("is idempotent: re-running migrations does not error", () => {
    applyMigrations(sql, USER_GRAPH_DO_MIGRATIONS, "user_graph");
    expect(() =>
      applyMigrations(sql, USER_GRAPH_DO_MIGRATIONS, "user_graph"),
    ).not.toThrow();
  });

  it("is idempotent: re-running does not change version", () => {
    const expectedVersion = USER_GRAPH_DO_MIGRATIONS[USER_GRAPH_DO_MIGRATIONS.length - 1].version;
    applyMigrations(sql, USER_GRAPH_DO_MIGRATIONS, "user_graph");
    expect(getSchemaVersion(sql, "user_graph")).toBe(expectedVersion);

    applyMigrations(sql, USER_GRAPH_DO_MIGRATIONS, "user_graph");
    expect(getSchemaVersion(sql, "user_graph")).toBe(expectedVersion);
  });

  it("is idempotent: re-running preserves existing data", () => {
    applyMigrations(sql, ACCOUNT_DO_MIGRATIONS, "account");

    db.prepare(
      "INSERT INTO auth (account_id, encrypted_tokens, scopes) VALUES (?, ?, ?)",
    ).run("acc_1", "encrypted_blob", "calendar.readonly");

    // Re-run migrations
    applyMigrations(sql, ACCOUNT_DO_MIGRATIONS, "account");

    // Data should still be there
    const row = db
      .prepare("SELECT * FROM auth WHERE account_id = ?")
      .get("acc_1") as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row.encrypted_tokens).toBe("encrypted_blob");
  });

  it("handles multi-step migrations incrementally", () => {
    // Simulate a two-migration sequence
    const migration1: Migration = {
      version: 1,
      sql: "CREATE TABLE test_v1 (id TEXT PRIMARY KEY, name TEXT);",
      description: "Create test_v1 table",
    };

    const migration2: Migration = {
      version: 2,
      sql: "CREATE TABLE test_v2 (id TEXT PRIMARY KEY, value TEXT);",
      description: "Create test_v2 table",
    };

    // Apply only v1
    applyMigrations(sql, [migration1], "test_schema");
    expect(getSchemaVersion(sql, "test_schema")).toBe(1);

    // Verify only v1 table exists
    const tablesAfterV1 = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'test_v%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    expect(tablesAfterV1.map((t) => t.name)).toEqual(["test_v1"]);

    // Now apply both v1 and v2 -- v1 should be skipped, only v2 applied
    applyMigrations(sql, [migration1, migration2], "test_schema");
    expect(getSchemaVersion(sql, "test_schema")).toBe(2);

    // Both tables should now exist
    const tablesAfterV2 = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'test_v%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    expect(tablesAfterV2.map((t) => t.name)).toEqual(["test_v1", "test_v2"]);
  });

  it("tracks different schemas independently", () => {
    applyMigrations(sql, USER_GRAPH_DO_MIGRATIONS, "user_graph");
    applyMigrations(sql, ACCOUNT_DO_MIGRATIONS, "account");

    expect(getSchemaVersion(sql, "user_graph")).toBe(
      USER_GRAPH_DO_MIGRATIONS[USER_GRAPH_DO_MIGRATIONS.length - 1].version,
    );
    expect(getSchemaVersion(sql, "account")).toBe(
      ACCOUNT_DO_MIGRATIONS[ACCOUNT_DO_MIGRATIONS.length - 1].version,
    );

    // Both schemas share the same _schema_meta table
    const meta = db
      .prepare("SELECT * FROM _schema_meta ORDER BY key")
      .all() as Array<{ key: string; value: string }>;

    expect(meta).toHaveLength(2);
    expect(meta[0].key).toBe("account_version");
    expect(meta[1].key).toBe("user_graph_version");
  });

  it("getSchemaVersion returns 0 for uninitialized database", () => {
    expect(getSchemaVersion(sql, "nonexistent")).toBe(0);
  });

  it("getSchemaVersion returns 0 when meta table exists but schema is unknown", () => {
    applyMigrations(sql, ACCOUNT_DO_MIGRATIONS, "account");
    expect(getSchemaVersion(sql, "unknown_schema")).toBe(0);
  });

  it("handles empty migration list gracefully", () => {
    expect(() => applyMigrations(sql, [], "empty")).not.toThrow();

    // _schema_meta should be created even with no migrations
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='_schema_meta'",
      )
      .all() as Array<{ name: string }>;

    expect(tables).toHaveLength(1);
    expect(getSchemaVersion(sql, "empty")).toBe(0);
  });

  it("migration failure does not corrupt version tracking", () => {
    const goodMigration: Migration = {
      version: 1,
      sql: "CREATE TABLE good_table (id TEXT PRIMARY KEY);",
      description: "Good migration",
    };

    const badMigration: Migration = {
      version: 2,
      sql: "CREATE TABLE bad_table (id INVALID_TYPE PRIMARY KEY); THIS IS NOT VALID SQL; SELECT FROM;",
      description: "Bad migration",
    };

    // Apply good migration first
    applyMigrations(sql, [goodMigration], "test");
    expect(getSchemaVersion(sql, "test")).toBe(1);

    // Bad migration should throw
    // NOTE: SQLite is permissive about column types, so we use truly invalid SQL
    expect(() =>
      applyMigrations(sql, [goodMigration, badMigration], "test"),
    ).toThrow();

    // Version should still be at 1 (the bad migration failed before updating)
    expect(getSchemaVersion(sql, "test")).toBe(1);

    // Good table should still exist
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='good_table'",
      )
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
  });
});
