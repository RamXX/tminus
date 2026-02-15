/**
 * Unit tests for D1 registry schema.
 *
 * Validates that the migration SQL is syntactically valid and contains
 * all expected DDL statements. Uses better-sqlite3 as the validation
 * engine (same SQLite engine that D1 uses under the hood).
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  MIGRATION_0001_INITIAL_SCHEMA,
  MIGRATION_0002_MS_SUBSCRIPTIONS,
  MIGRATION_0004_AUTH_FIELDS,
  MIGRATION_0005_DELETION_REQUESTS,
  MIGRATION_0007_DELETION_CERTIFICATE_SUMMARY,
  ALL_MIGRATIONS,
} from "./schema";

describe("schema unit tests", () => {
  it("migration SQL is a non-empty string", () => {
    expect(typeof MIGRATION_0001_INITIAL_SCHEMA).toBe("string");
    expect(MIGRATION_0001_INITIAL_SCHEMA.trim().length).toBeGreaterThan(0);
  });

  it("ALL_MIGRATIONS contains all registered migrations in order", () => {
    expect(ALL_MIGRATIONS.length).toBeGreaterThanOrEqual(2);
    expect(ALL_MIGRATIONS[0]).toBe(MIGRATION_0001_INITIAL_SCHEMA);
    expect(ALL_MIGRATIONS[1]).toBe(MIGRATION_0002_MS_SUBSCRIPTIONS);
    // Content-based: verify each migration contains SQL DDL
    for (const migration of ALL_MIGRATIONS) {
      expect(typeof migration).toBe("string");
      expect(migration.trim().length).toBeGreaterThan(0);
      expect(migration).toMatch(/(CREATE|ALTER)\s+(TABLE|INDEX)/i);
    }
  });

  it("migration SQL is valid SQLite", () => {
    const db = new Database(":memory:");
    // If SQL is invalid, this will throw
    expect(() => db.exec(MIGRATION_0001_INITIAL_SCHEMA)).not.toThrow();
    db.close();
  });

  it("creates all four expected tables", () => {
    const db = new Database(":memory:");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("orgs");
    expect(tableNames).toContain("users");
    expect(tableNames).toContain("accounts");
    expect(tableNames).toContain("deletion_certificates");

    db.close();
  });

  it("creates expected indexes", () => {
    const db = new Database(":memory:");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_accounts_user");
    expect(indexNames).toContain("idx_accounts_channel");

    db.close();
  });

  it("accounts table includes channel_token column", () => {
    const db = new Database(":memory:");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);

    const columns = db.prepare("PRAGMA table_info(accounts)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;

    const channelTokenCol = columns.find((c) => c.name === "channel_token");
    expect(channelTokenCol).toBeDefined();
    expect(channelTokenCol!.type).toBe("TEXT");
    // channel_token is nullable (not required on initial creation)
    expect(channelTokenCol!.notnull).toBe(0);

    db.close();
  });

  it("MIGRATION_0002 SQL is valid SQLite and creates ms_subscriptions", () => {
    const db = new Database(":memory:");
    // Apply 0001 first (ms_subscriptions may reference accounts)
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    expect(() => db.exec(MIGRATION_0002_MS_SUBSCRIPTIONS)).not.toThrow();

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("ms_subscriptions");

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain(
      "idx_ms_subscriptions_account",
    );

    db.close();
  });

  it("migration SQL in file matches embedded constant", async () => {
    // Read the actual migration file and compare to the constant.
    // This ensures the file and the code stay in sync.
    const fs = await import("fs");
    const path = await import("path");
    const migrationPath = path.resolve(
      __dirname,
      "../../../migrations/d1-registry/0001_initial_schema.sql",
    );

    const fileContent = fs.readFileSync(migrationPath, "utf-8");

    // Normalize: strip SQL comments and collapse whitespace for comparison.
    // The file has inline comments; the constant does not.
    const normalize = (sql: string): string =>
      sql
        .split("\n")
        .map((line) => line.replace(/--.*$/, "").trim())
        .filter((line) => line.length > 0)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

    expect(normalize(MIGRATION_0001_INITIAL_SCHEMA)).toBe(
      normalize(fileContent),
    );
  });

  it("MIGRATION_0004 adds auth fields to users table", () => {
    const db = new Database(":memory:");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0002_MS_SUBSCRIPTIONS);

    // Apply auth fields migration statement by statement (SQLite requires this for ALTER TABLE)
    const statements = MIGRATION_0004_AUTH_FIELDS.trim().split(";").filter(Boolean);
    for (const stmt of statements) {
      expect(() => db.exec(stmt.trim() + ";")).not.toThrow();
    }

    // Verify new columns exist
    const columns = db.prepare("PRAGMA table_info(users)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const columnNames = columns.map((c) => c.name);

    expect(columnNames).toContain("password_hash");
    expect(columnNames).toContain("password_version");
    expect(columnNames).toContain("failed_login_attempts");
    expect(columnNames).toContain("locked_until");

    // Verify defaults
    const pwVerCol = columns.find((c) => c.name === "password_version");
    expect(pwVerCol!.dflt_value).toBe("1");
    expect(pwVerCol!.notnull).toBe(1);

    const failedCol = columns.find((c) => c.name === "failed_login_attempts");
    expect(failedCol!.dflt_value).toBe("0");
    expect(failedCol!.notnull).toBe(1);

    // password_hash is nullable (for legacy OAuth-only users)
    const pwHashCol = columns.find((c) => c.name === "password_hash");
    expect(pwHashCol!.notnull).toBe(0);

    // locked_until is nullable
    const lockedCol = columns.find((c) => c.name === "locked_until");
    expect(lockedCol!.notnull).toBe(0);

    db.close();
  });

  it("MIGRATION_0005 creates deletion_requests table with status CHECK constraint", () => {
    const db = new Database(":memory:");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0002_MS_SUBSCRIPTIONS);
    // Apply auth fields
    const authStatements = MIGRATION_0004_AUTH_FIELDS.trim().split(";").filter(Boolean);
    for (const stmt of authStatements) {
      db.exec(stmt.trim() + ";");
    }
    // Apply deletion requests migration
    expect(() => db.exec(MIGRATION_0005_DELETION_REQUESTS)).not.toThrow();

    // Verify table exists
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("deletion_requests");

    // Verify columns
    const columns = db.prepare("PRAGMA table_info(deletion_requests)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).toContain("request_id");
    expect(columnNames).toContain("user_id");
    expect(columnNames).toContain("status");
    expect(columnNames).toContain("requested_at");
    expect(columnNames).toContain("scheduled_at");
    expect(columnNames).toContain("completed_at");
    expect(columnNames).toContain("cancelled_at");

    // Verify primary key
    const pkCol = columns.find((c) => c.name === "request_id");
    expect(pkCol!.pk).toBe(1);

    // Verify indexes
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_deletion_requests_user");
    expect(indexNames).toContain("idx_deletion_requests_status");

    // Verify CHECK constraint: valid statuses should INSERT without error
    const orgId = "org_test";
    const userId = "usr_test";
    db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(orgId, "Test Org");
    db.prepare("INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)").run(userId, orgId, "test@test.com");

    for (const status of ["pending", "processing", "completed", "cancelled"]) {
      expect(() => {
        db.prepare(
          "INSERT INTO deletion_requests (request_id, user_id, status, requested_at, scheduled_at) VALUES (?, ?, ?, ?, ?)",
        ).run(`delreq_${status}`, userId, status, "2026-01-01T00:00:00Z", "2026-01-04T00:00:00Z");
      }).not.toThrow();
    }

    // Invalid status should throw (CHECK constraint)
    expect(() => {
      db.prepare(
        "INSERT INTO deletion_requests (request_id, user_id, status, requested_at, scheduled_at) VALUES (?, ?, ?, ?, ?)",
      ).run("delreq_invalid", userId, "invalid_status", "2026-01-01T00:00:00Z", "2026-01-04T00:00:00Z");
    }).toThrow();

    db.close();
  });

  it("ALL_MIGRATIONS includes MIGRATION_0005_DELETION_REQUESTS", () => {
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0005_DELETION_REQUESTS);
    expect(ALL_MIGRATIONS.length).toBe(7);
  });

  it("MIGRATION_0007 adds deletion_summary column to deletion_certificates", () => {
    const db = new Database(":memory:");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0002_MS_SUBSCRIPTIONS);
    // Apply auth fields
    const authStatements = MIGRATION_0004_AUTH_FIELDS.trim().split(";").filter(Boolean);
    for (const stmt of authStatements) {
      db.exec(stmt.trim() + ";");
    }
    db.exec(MIGRATION_0005_DELETION_REQUESTS);
    // Apply deletion certificate summary migration
    const summaryStatements = MIGRATION_0007_DELETION_CERTIFICATE_SUMMARY.trim().split(";").filter(Boolean);
    for (const stmt of summaryStatements) {
      expect(() => db.exec(stmt.trim() + ";")).not.toThrow();
    }

    // Verify deletion_summary column exists
    const columns = db.prepare("PRAGMA table_info(deletion_certificates)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).toContain("deletion_summary");

    // deletion_summary should be nullable (TEXT)
    const summaryCol = columns.find((c) => c.name === "deletion_summary");
    expect(summaryCol!.type).toBe("TEXT");
    expect(summaryCol!.notnull).toBe(0);

    db.close();
  });
});
