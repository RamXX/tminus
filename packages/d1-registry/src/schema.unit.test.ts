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
      expect(migration).toMatch(/CREATE\s+(TABLE|INDEX)/i);
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
});
