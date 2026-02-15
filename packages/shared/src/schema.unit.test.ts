/**
 * Unit tests for DO SQLite schema definitions.
 *
 * Validates:
 * - Schema SQL strings are non-empty and syntactically valid
 * - Migration lists are correctly structured
 * - All expected tables are present in each schema
 * - Migration type contracts are satisfied
 *
 * Uses better-sqlite3 (same SQLite engine as Cloudflare DO SqlStorage)
 * to validate SQL syntax without requiring the Cloudflare runtime.
 */

import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  USER_GRAPH_DO_MIGRATION_V1,
  USER_GRAPH_DO_MIGRATION_V2,
  USER_GRAPH_DO_MIGRATION_V3,
  USER_GRAPH_DO_MIGRATION_V4,
  ACCOUNT_DO_MIGRATION_V1,
  ACCOUNT_DO_MIGRATION_V2,
  ACCOUNT_DO_MIGRATION_V3,
  USER_GRAPH_DO_MIGRATIONS,
  ACCOUNT_DO_MIGRATIONS,
} from "./schema";
import type { Migration } from "./schema";

// ---------------------------------------------------------------------------
// UserGraphDO schema SQL validation
// ---------------------------------------------------------------------------

describe("UserGraphDO schema SQL", () => {
  let db: DatabaseType;

  afterEach(() => {
    if (db) db.close();
  });

  it("is a non-empty string", () => {
    expect(typeof USER_GRAPH_DO_MIGRATION_V1).toBe("string");
    expect(USER_GRAPH_DO_MIGRATION_V1.trim().length).toBeGreaterThan(0);
  });

  it("is valid SQLite", () => {
    db = new Database(":memory:");
    expect(() => db.exec(USER_GRAPH_DO_MIGRATION_V1)).not.toThrow();
  });

  it("creates all Phase 1 tables", () => {
    db = new Database(":memory:");
    db.exec(USER_GRAPH_DO_MIGRATION_V1);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    const names = tables.map((t) => t.name);

    // Phase 1 active tables
    expect(names).toContain("calendars");
    expect(names).toContain("canonical_events");
    expect(names).toContain("event_mirrors");
    expect(names).toContain("event_journal");
    expect(names).toContain("policies");
    expect(names).toContain("policy_edges");
    expect(names).toContain("constraints");
  });

  it("creates all Phase 2+ tables (empty, for forward stability)", () => {
    db = new Database(":memory:");
    db.exec(USER_GRAPH_DO_MIGRATION_V1);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    const names = tables.map((t) => t.name);

    // Phase 3 tables
    expect(names).toContain("time_allocations");
    expect(names).toContain("time_commitments");
    expect(names).toContain("commitment_reports");
    expect(names).toContain("vip_policies");
    expect(names).toContain("schedule_sessions");
    expect(names).toContain("schedule_candidates");
    expect(names).toContain("schedule_holds");

    // Phase 4 tables
    expect(names).toContain("relationships");
    expect(names).toContain("interaction_ledger");
    expect(names).toContain("milestones");
  });

  it("creates exactly 17 tables", () => {
    db = new Database(":memory:");
    db.exec(USER_GRAPH_DO_MIGRATION_V1);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    expect(tables).toHaveLength(17);
  });

  it("creates all expected indexes", () => {
    db = new Database(":memory:");
    db.exec(USER_GRAPH_DO_MIGRATION_V1);

    const indexes = db
      .prepare(
        "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
      )
      .all() as Array<{ name: string; tbl_name: string }>;

    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).toContain("idx_events_time");
    expect(indexNames).toContain("idx_events_origin");
    expect(indexNames).toContain("idx_journal_event");
    expect(indexNames).toContain("idx_journal_ts");
    expect(indexNames).toContain("idx_ledger_participant");
  });

  it("canonical_events has correct columns", () => {
    db = new Database(":memory:");
    db.exec(USER_GRAPH_DO_MIGRATION_V1);

    const columns = db
      .prepare("PRAGMA table_info(canonical_events)")
      .all() as Array<{ name: string; type: string; notnull: number }>;

    const colNames = columns.map((c) => c.name);
    expect(colNames).toEqual([
      "canonical_event_id",
      "origin_account_id",
      "origin_event_id",
      "title",
      "description",
      "location",
      "start_ts",
      "end_ts",
      "timezone",
      "all_day",
      "status",
      "visibility",
      "transparency",
      "recurrence_rule",
      "source",
      "version",
      "created_at",
      "updated_at",
    ]);

    // Verify NOT NULL constraints on required columns
    const required = columns.filter((c) => c.notnull === 1);
    const requiredNames = required.map((c) => c.name);
    expect(requiredNames).toContain("origin_account_id");
    expect(requiredNames).toContain("origin_event_id");
    expect(requiredNames).toContain("start_ts");
    expect(requiredNames).toContain("end_ts");
    expect(requiredNames).toContain("all_day");
    expect(requiredNames).toContain("source");
    expect(requiredNames).toContain("version");
  });

  it("event_mirrors has composite primary key", () => {
    db = new Database(":memory:");
    db.exec(USER_GRAPH_DO_MIGRATION_V1);

    // Insert a mirror row, then try to insert a duplicate
    db.pragma("foreign_keys = OFF"); // skip FK for this structural test
    db.prepare(
      "INSERT INTO event_mirrors (canonical_event_id, target_account_id, target_calendar_id) VALUES (?, ?, ?)",
    ).run("evt_1", "acc_1", "cal_1");

    expect(() =>
      db
        .prepare(
          "INSERT INTO event_mirrors (canonical_event_id, target_account_id, target_calendar_id) VALUES (?, ?, ?)",
        )
        .run("evt_1", "acc_1", "cal_2"),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("policy_edges has composite primary key", () => {
    db = new Database(":memory:");
    db.exec(USER_GRAPH_DO_MIGRATION_V1);

    db.pragma("foreign_keys = OFF");
    db.prepare(
      "INSERT INTO policy_edges (policy_id, from_account_id, to_account_id) VALUES (?, ?, ?)",
    ).run("pol_1", "acc_1", "acc_2");

    expect(() =>
      db
        .prepare(
          "INSERT INTO policy_edges (policy_id, from_account_id, to_account_id) VALUES (?, ?, ?)",
        )
        .run("pol_1", "acc_1", "acc_2"),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("calendars has UNIQUE(account_id, provider_calendar_id)", () => {
    db = new Database(":memory:");
    db.exec(USER_GRAPH_DO_MIGRATION_V1);

    db.prepare(
      "INSERT INTO calendars (calendar_id, account_id, provider_calendar_id) VALUES (?, ?, ?)",
    ).run("cal_1", "acc_1", "google_cal_1");

    // Same account + provider calendar should fail
    expect(() =>
      db
        .prepare(
          "INSERT INTO calendars (calendar_id, account_id, provider_calendar_id) VALUES (?, ?, ?)",
        )
        .run("cal_2", "acc_1", "google_cal_1"),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("relationships has UNIQUE participant_hash", () => {
    db = new Database(":memory:");
    db.exec(USER_GRAPH_DO_MIGRATION_V1);

    db.prepare(
      "INSERT INTO relationships (relationship_id, participant_hash, category) VALUES (?, ?, ?)",
    ).run("rel_1", "hash_abc", "COLLEAGUE");

    expect(() =>
      db
        .prepare(
          "INSERT INTO relationships (relationship_id, participant_hash, category) VALUES (?, ?, ?)",
        )
        .run("rel_2", "hash_abc", "FRIEND"),
    ).toThrow(/UNIQUE constraint failed/);
  });
});

// ---------------------------------------------------------------------------
// AccountDO schema SQL validation
// ---------------------------------------------------------------------------

describe("AccountDO schema SQL", () => {
  let db: DatabaseType;

  afterEach(() => {
    if (db) db.close();
  });

  it("is a non-empty string", () => {
    expect(typeof ACCOUNT_DO_MIGRATION_V1).toBe("string");
    expect(ACCOUNT_DO_MIGRATION_V1.trim().length).toBeGreaterThan(0);
  });

  it("is valid SQLite", () => {
    db = new Database(":memory:");
    expect(() => db.exec(ACCOUNT_DO_MIGRATION_V1)).not.toThrow();
  });

  it("creates exactly 3 tables", () => {
    db = new Database(":memory:");
    db.exec(ACCOUNT_DO_MIGRATION_V1);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    const names = tables.map((t) => t.name);
    expect(names).toEqual(["auth", "sync_state", "watch_channels"]);
  });

  it("auth table has correct columns", () => {
    db = new Database(":memory:");
    db.exec(ACCOUNT_DO_MIGRATION_V1);

    const columns = db
      .prepare("PRAGMA table_info(auth)")
      .all() as Array<{ name: string; type: string; notnull: number }>;

    const colNames = columns.map((c) => c.name);
    expect(colNames).toEqual([
      "account_id",
      "encrypted_tokens",
      "scopes",
      "updated_at",
    ]);

    // encrypted_tokens and scopes are NOT NULL
    const notNull = columns.filter((c) => c.notnull === 1);
    expect(notNull.map((c) => c.name)).toContain("encrypted_tokens");
    expect(notNull.map((c) => c.name)).toContain("scopes");
  });

  it("sync_state table has correct columns", () => {
    db = new Database(":memory:");
    db.exec(ACCOUNT_DO_MIGRATION_V1);

    const columns = db
      .prepare("PRAGMA table_info(sync_state)")
      .all() as Array<{ name: string; type: string; notnull: number }>;

    const colNames = columns.map((c) => c.name);
    expect(colNames).toEqual([
      "account_id",
      "sync_token",
      "last_sync_ts",
      "last_success_ts",
      "full_sync_needed",
      "updated_at",
    ]);

    // full_sync_needed defaults to 1
    const fullSync = columns.find((c) => c.name === "full_sync_needed");
    expect(fullSync!.notnull).toBe(1);
  });

  it("watch_channels table has correct columns", () => {
    db = new Database(":memory:");
    db.exec(ACCOUNT_DO_MIGRATION_V1);

    const columns = db
      .prepare("PRAGMA table_info(watch_channels)")
      .all() as Array<{ name: string; type: string; notnull: number }>;

    const colNames = columns.map((c) => c.name);
    expect(colNames).toEqual([
      "channel_id",
      "account_id",
      "resource_id",
      "expiry_ts",
      "calendar_id",
      "status",
      "created_at",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Migration list structure validation
// ---------------------------------------------------------------------------

describe("migration lists", () => {
  it("USER_GRAPH_DO_MIGRATIONS has correct structure", () => {
    expect(USER_GRAPH_DO_MIGRATIONS).toHaveLength(4);

    const m1 = USER_GRAPH_DO_MIGRATIONS[0];
    expect(m1.version).toBe(1);
    expect(m1.sql).toBe(USER_GRAPH_DO_MIGRATION_V1);
    expect(typeof m1.description).toBe("string");
    expect(m1.description.length).toBeGreaterThan(0);

    const m2 = USER_GRAPH_DO_MIGRATIONS[1];
    expect(m2.version).toBe(2);
    expect(m2.sql).toBe(USER_GRAPH_DO_MIGRATION_V2);
    expect(typeof m2.description).toBe("string");
    expect(m2.description.length).toBeGreaterThan(0);

    const m3 = USER_GRAPH_DO_MIGRATIONS[2];
    expect(m3.version).toBe(3);
    expect(m3.sql).toBe(USER_GRAPH_DO_MIGRATION_V3);
    expect(typeof m3.description).toBe("string");
    expect(m3.description.length).toBeGreaterThan(0);

    const m4 = USER_GRAPH_DO_MIGRATIONS[3];
    expect(m4.version).toBe(4);
    expect(m4.sql).toBe(USER_GRAPH_DO_MIGRATION_V4);
    expect(typeof m4.description).toBe("string");
    expect(m4.description.length).toBeGreaterThan(0);
  });

  it("ACCOUNT_DO_MIGRATIONS has correct structure", () => {
    // Assert content-based: each migration includes expected DDL
    const m1 = ACCOUNT_DO_MIGRATIONS[0];
    expect(m1.version).toBe(1);
    expect(m1.sql).toBe(ACCOUNT_DO_MIGRATION_V1);
    expect(m1.sql).toContain("CREATE TABLE auth");
    expect(m1.sql).toContain("CREATE TABLE sync_state");
    expect(m1.sql).toContain("CREATE TABLE watch_channels");
    expect(typeof m1.description).toBe("string");
    expect(m1.description.length).toBeGreaterThan(0);

    const m2 = ACCOUNT_DO_MIGRATIONS[1];
    expect(m2.version).toBe(2);
    expect(m2.sql).toBe(ACCOUNT_DO_MIGRATION_V2);
    expect(m2.sql).toContain("ALTER TABLE auth ADD COLUMN provider");
    expect(typeof m2.description).toBe("string");
    expect(m2.description.length).toBeGreaterThan(0);

    const m3 = ACCOUNT_DO_MIGRATIONS[2];
    expect(m3.version).toBe(3);
    expect(m3.sql).toBe(ACCOUNT_DO_MIGRATION_V3);
    expect(m3.sql).toContain("CREATE TABLE ms_subscriptions");
    expect(m3.sql).toContain("client_state");
    expect(m3.sql).toContain("expiration");
    expect(typeof m3.description).toBe("string");
    expect(m3.description.length).toBeGreaterThan(0);
  });

  it("migration versions are monotonically increasing", () => {
    const checkMonotonic = (migrations: readonly Migration[]) => {
      for (let i = 1; i < migrations.length; i++) {
        expect(migrations[i].version).toBeGreaterThan(
          migrations[i - 1].version,
        );
      }
    };

    checkMonotonic(USER_GRAPH_DO_MIGRATIONS);
    checkMonotonic(ACCOUNT_DO_MIGRATIONS);
  });

  it("migration versions start at 1", () => {
    expect(USER_GRAPH_DO_MIGRATIONS[0].version).toBe(1);
    expect(ACCOUNT_DO_MIGRATIONS[0].version).toBe(1);
  });
});
