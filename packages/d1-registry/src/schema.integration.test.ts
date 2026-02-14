/**
 * Integration tests for D1 registry schema.
 *
 * Uses better-sqlite3 (same SQLite engine as D1) to validate:
 * - Migration applies successfully
 * - INSERT/SELECT/UPDATE on all tables
 * - UNIQUE constraints are enforced
 * - Foreign key constraints work
 * - channel_token column is writable and queryable
 *
 * better-sqlite3 is the correct test engine here because Cloudflare D1
 * runs SQLite under the hood. These tests prove the SQL works against
 * real SQLite, which is a genuine integration test of the schema.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { MIGRATION_0001_INITIAL_SCHEMA } from "./schema";

// Re-usable test fixtures
const TEST_ORG = {
  org_id: "org_01HXYZ000000000000000001",
  name: "Test Organization",
} as const;

const TEST_USER = {
  user_id: "usr_01HXYZ000000000000000001",
  org_id: TEST_ORG.org_id,
  email: "alice@example.com",
  display_name: "Alice Test",
} as const;

const TEST_ACCOUNT = {
  account_id: "acc_01HXYZ000000000000000001",
  user_id: TEST_USER.user_id,
  provider: "google",
  provider_subject: "google-sub-12345",
  email: "alice@gmail.com",
  status: "active",
  channel_id: "ch-uuid-001",
  channel_token: "secret-webhook-token-abc123",
  channel_expiry_ts: "2025-12-31T23:59:59Z",
} as const;

const TEST_DELETION_CERT = {
  cert_id: "cert_01HXYZ000000000000000001",
  entity_type: "user",
  entity_id: TEST_USER.user_id,
  proof_hash: "sha256:abc123def456",
  signature: "sig_system_001",
} as const;

describe("D1 registry schema integration tests", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new Database(":memory:");
    // Enable foreign key enforcement (D1 has this on by default)
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // Migration applies successfully
  // -------------------------------------------------------------------------

  describe("migration applies successfully", () => {
    it("creates all four tables", () => {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all() as Array<{ name: string }>;

      const names = tables.map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "orgs",
          "users",
          "accounts",
          "deletion_certificates",
        ]),
      );
    });

    it("creates both indexes on accounts", () => {
      const indexes = db
        .prepare(
          "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
        )
        .all() as Array<{ name: string; tbl_name: string }>;

      expect(indexes).toEqual(
        expect.arrayContaining([
          { name: "idx_accounts_channel", tbl_name: "accounts" },
          { name: "idx_accounts_user", tbl_name: "accounts" },
        ]),
      );
    });

    it("is idempotent-safe (re-applying fails gracefully)", () => {
      // D1 migrations are applied once; re-applying CREATE TABLE should fail
      // which is expected behavior (wrangler tracks applied migrations)
      expect(() => db.exec(MIGRATION_0001_INITIAL_SCHEMA)).toThrow(
        /already exists/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // orgs table CRUD
  // -------------------------------------------------------------------------

  describe("orgs table", () => {
    it("INSERT and SELECT", () => {
      db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
        TEST_ORG.org_id,
        TEST_ORG.name,
      );

      const row = db
        .prepare("SELECT * FROM orgs WHERE org_id = ?")
        .get(TEST_ORG.org_id) as Record<string, unknown>;

      expect(row).toBeDefined();
      expect(row.org_id).toBe(TEST_ORG.org_id);
      expect(row.name).toBe(TEST_ORG.name);
      // DEFAULT (datetime('now')) should populate created_at and updated_at
      expect(typeof row.created_at).toBe("string");
      expect(typeof row.updated_at).toBe("string");
    });

    it("UPDATE changes fields", () => {
      db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
        TEST_ORG.org_id,
        TEST_ORG.name,
      );

      db.prepare(
        "UPDATE orgs SET name = ?, updated_at = datetime('now') WHERE org_id = ?",
      ).run("Updated Org Name", TEST_ORG.org_id);

      const row = db
        .prepare("SELECT name FROM orgs WHERE org_id = ?")
        .get(TEST_ORG.org_id) as Record<string, unknown>;

      expect(row.name).toBe("Updated Org Name");
    });

    it("DELETE removes row", () => {
      db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
        TEST_ORG.org_id,
        TEST_ORG.name,
      );

      db.prepare("DELETE FROM orgs WHERE org_id = ?").run(TEST_ORG.org_id);

      const row = db
        .prepare("SELECT * FROM orgs WHERE org_id = ?")
        .get(TEST_ORG.org_id);

      expect(row).toBeUndefined();
    });

    it("rejects duplicate org_id (PRIMARY KEY)", () => {
      db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
        TEST_ORG.org_id,
        TEST_ORG.name,
      );

      expect(() =>
        db
          .prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)")
          .run(TEST_ORG.org_id, "Dupe"),
      ).toThrow(/UNIQUE constraint failed/);
    });

    it("rejects null name (NOT NULL)", () => {
      expect(() =>
        db
          .prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)")
          .run("org_test", null),
      ).toThrow(/NOT NULL constraint failed/);
    });
  });

  // -------------------------------------------------------------------------
  // users table CRUD
  // -------------------------------------------------------------------------

  describe("users table", () => {
    beforeEach(() => {
      // Users FK to orgs, so insert org first
      db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
        TEST_ORG.org_id,
        TEST_ORG.name,
      );
    });

    it("INSERT and SELECT", () => {
      db.prepare(
        "INSERT INTO users (user_id, org_id, email, display_name) VALUES (?, ?, ?, ?)",
      ).run(
        TEST_USER.user_id,
        TEST_USER.org_id,
        TEST_USER.email,
        TEST_USER.display_name,
      );

      const row = db
        .prepare("SELECT * FROM users WHERE user_id = ?")
        .get(TEST_USER.user_id) as Record<string, unknown>;

      expect(row).toBeDefined();
      expect(row.user_id).toBe(TEST_USER.user_id);
      expect(row.org_id).toBe(TEST_USER.org_id);
      expect(row.email).toBe(TEST_USER.email);
      expect(row.display_name).toBe(TEST_USER.display_name);
      expect(typeof row.created_at).toBe("string");
    });

    it("UPDATE changes fields", () => {
      db.prepare(
        "INSERT INTO users (user_id, org_id, email, display_name) VALUES (?, ?, ?, ?)",
      ).run(
        TEST_USER.user_id,
        TEST_USER.org_id,
        TEST_USER.email,
        TEST_USER.display_name,
      );

      db.prepare(
        "UPDATE users SET display_name = ? WHERE user_id = ?",
      ).run("Alice Updated", TEST_USER.user_id);

      const row = db
        .prepare("SELECT display_name FROM users WHERE user_id = ?")
        .get(TEST_USER.user_id) as Record<string, unknown>;

      expect(row.display_name).toBe("Alice Updated");
    });

    it("allows null display_name", () => {
      db.prepare(
        "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
      ).run(TEST_USER.user_id, TEST_USER.org_id, TEST_USER.email);

      const row = db
        .prepare("SELECT display_name FROM users WHERE user_id = ?")
        .get(TEST_USER.user_id) as Record<string, unknown>;

      expect(row.display_name).toBeNull();
    });

    it("enforces UNIQUE email constraint", () => {
      db.prepare(
        "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
      ).run(TEST_USER.user_id, TEST_USER.org_id, TEST_USER.email);

      expect(() =>
        db
          .prepare(
            "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
          )
          .run("usr_02", TEST_USER.org_id, TEST_USER.email),
      ).toThrow(/UNIQUE constraint failed/);
    });

    it("enforces foreign key to orgs", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
          )
          .run("usr_orphan", "org_nonexistent", "orphan@example.com"),
      ).toThrow(/FOREIGN KEY constraint failed/);
    });
  });

  // -------------------------------------------------------------------------
  // accounts table CRUD
  // -------------------------------------------------------------------------

  describe("accounts table", () => {
    beforeEach(() => {
      // accounts -> users -> orgs
      db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
        TEST_ORG.org_id,
        TEST_ORG.name,
      );
      db.prepare(
        "INSERT INTO users (user_id, org_id, email, display_name) VALUES (?, ?, ?, ?)",
      ).run(
        TEST_USER.user_id,
        TEST_USER.org_id,
        TEST_USER.email,
        TEST_USER.display_name,
      );
    });

    it("INSERT and SELECT with all columns", () => {
      db.prepare(
        `INSERT INTO accounts
         (account_id, user_id, provider, provider_subject, email, status,
          channel_id, channel_token, channel_expiry_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        TEST_ACCOUNT.account_id,
        TEST_ACCOUNT.user_id,
        TEST_ACCOUNT.provider,
        TEST_ACCOUNT.provider_subject,
        TEST_ACCOUNT.email,
        TEST_ACCOUNT.status,
        TEST_ACCOUNT.channel_id,
        TEST_ACCOUNT.channel_token,
        TEST_ACCOUNT.channel_expiry_ts,
      );

      const row = db
        .prepare("SELECT * FROM accounts WHERE account_id = ?")
        .get(TEST_ACCOUNT.account_id) as Record<string, unknown>;

      expect(row).toBeDefined();
      expect(row.account_id).toBe(TEST_ACCOUNT.account_id);
      expect(row.user_id).toBe(TEST_ACCOUNT.user_id);
      expect(row.provider).toBe("google");
      expect(row.provider_subject).toBe(TEST_ACCOUNT.provider_subject);
      expect(row.email).toBe(TEST_ACCOUNT.email);
      expect(row.status).toBe("active");
      expect(row.channel_id).toBe(TEST_ACCOUNT.channel_id);
      expect(row.channel_token).toBe(TEST_ACCOUNT.channel_token);
      expect(row.channel_expiry_ts).toBe(TEST_ACCOUNT.channel_expiry_ts);
      expect(typeof row.created_at).toBe("string");
    });

    it("INSERT with defaults (provider, status, nullable columns)", () => {
      db.prepare(
        `INSERT INTO accounts
         (account_id, user_id, provider_subject, email)
         VALUES (?, ?, ?, ?)`,
      ).run(
        TEST_ACCOUNT.account_id,
        TEST_ACCOUNT.user_id,
        TEST_ACCOUNT.provider_subject,
        TEST_ACCOUNT.email,
      );

      const row = db
        .prepare("SELECT * FROM accounts WHERE account_id = ?")
        .get(TEST_ACCOUNT.account_id) as Record<string, unknown>;

      expect(row.provider).toBe("google"); // DEFAULT 'google'
      expect(row.status).toBe("active"); // DEFAULT 'active'
      expect(row.channel_id).toBeNull();
      expect(row.channel_token).toBeNull();
      expect(row.channel_expiry_ts).toBeNull();
    });

    it("UPDATE changes fields", () => {
      db.prepare(
        `INSERT INTO accounts
         (account_id, user_id, provider_subject, email)
         VALUES (?, ?, ?, ?)`,
      ).run(
        TEST_ACCOUNT.account_id,
        TEST_ACCOUNT.user_id,
        TEST_ACCOUNT.provider_subject,
        TEST_ACCOUNT.email,
      );

      db.prepare(
        "UPDATE accounts SET status = ?, channel_token = ? WHERE account_id = ?",
      ).run("revoked", "new-token-xyz", TEST_ACCOUNT.account_id);

      const row = db
        .prepare(
          "SELECT status, channel_token FROM accounts WHERE account_id = ?",
        )
        .get(TEST_ACCOUNT.account_id) as Record<string, unknown>;

      expect(row.status).toBe("revoked");
      expect(row.channel_token).toBe("new-token-xyz");
    });

    it("DELETE removes row", () => {
      db.prepare(
        `INSERT INTO accounts
         (account_id, user_id, provider_subject, email)
         VALUES (?, ?, ?, ?)`,
      ).run(
        TEST_ACCOUNT.account_id,
        TEST_ACCOUNT.user_id,
        TEST_ACCOUNT.provider_subject,
        TEST_ACCOUNT.email,
      );

      db.prepare("DELETE FROM accounts WHERE account_id = ?").run(
        TEST_ACCOUNT.account_id,
      );

      const row = db
        .prepare("SELECT * FROM accounts WHERE account_id = ?")
        .get(TEST_ACCOUNT.account_id);

      expect(row).toBeUndefined();
    });

    it("enforces UNIQUE(provider, provider_subject) constraint", () => {
      db.prepare(
        `INSERT INTO accounts
         (account_id, user_id, provider_subject, email)
         VALUES (?, ?, ?, ?)`,
      ).run(
        TEST_ACCOUNT.account_id,
        TEST_ACCOUNT.user_id,
        TEST_ACCOUNT.provider_subject,
        TEST_ACCOUNT.email,
      );

      // Same provider + provider_subject but different account_id should fail
      expect(() =>
        db
          .prepare(
            `INSERT INTO accounts
           (account_id, user_id, provider_subject, email)
           VALUES (?, ?, ?, ?)`,
          )
          .run(
            "acc_02_different",
            TEST_ACCOUNT.user_id,
            TEST_ACCOUNT.provider_subject, // same provider_subject
            "other@gmail.com",
          ),
      ).toThrow(/UNIQUE constraint failed/);
    });

    it("allows same provider_subject with different providers", () => {
      db.prepare(
        `INSERT INTO accounts
         (account_id, user_id, provider, provider_subject, email)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        "acc_google",
        TEST_ACCOUNT.user_id,
        "google",
        "sub-shared-123",
        "user@gmail.com",
      );

      // Same provider_subject but different provider should succeed
      expect(() =>
        db
          .prepare(
            `INSERT INTO accounts
           (account_id, user_id, provider, provider_subject, email)
           VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            "acc_microsoft",
            TEST_ACCOUNT.user_id,
            "microsoft",
            "sub-shared-123",
            "user@outlook.com",
          ),
      ).not.toThrow();

      const count = db
        .prepare("SELECT COUNT(*) as cnt FROM accounts")
        .get() as { cnt: number };
      expect(count.cnt).toBe(2);
    });

    it("enforces foreign key to users", () => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO accounts
           (account_id, user_id, provider_subject, email)
           VALUES (?, ?, ?, ?)`,
          )
          .run(
            "acc_orphan",
            "usr_nonexistent",
            "sub-orphan",
            "orphan@gmail.com",
          ),
      ).toThrow(/FOREIGN KEY constraint failed/);
    });

    it("idx_accounts_user index is used for user_id lookups", () => {
      db.prepare(
        `INSERT INTO accounts
         (account_id, user_id, provider_subject, email)
         VALUES (?, ?, ?, ?)`,
      ).run(
        TEST_ACCOUNT.account_id,
        TEST_ACCOUNT.user_id,
        TEST_ACCOUNT.provider_subject,
        TEST_ACCOUNT.email,
      );

      // EXPLAIN QUERY PLAN should mention the index
      const plan = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT * FROM accounts WHERE user_id = ?",
        )
        .all(TEST_ACCOUNT.user_id) as Array<{ detail: string }>;

      const usesIndex = plan.some((row) =>
        row.detail.includes("idx_accounts_user"),
      );
      expect(usesIndex).toBe(true);
    });

    it("idx_accounts_channel index is used for channel_id lookups", () => {
      db.prepare(
        `INSERT INTO accounts
         (account_id, user_id, provider_subject, email, channel_id)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        TEST_ACCOUNT.account_id,
        TEST_ACCOUNT.user_id,
        TEST_ACCOUNT.provider_subject,
        TEST_ACCOUNT.email,
        TEST_ACCOUNT.channel_id,
      );

      const plan = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT * FROM accounts WHERE channel_id = ?",
        )
        .all(TEST_ACCOUNT.channel_id) as Array<{ detail: string }>;

      const usesIndex = plan.some((row) =>
        row.detail.includes("idx_accounts_channel"),
      );
      expect(usesIndex).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // channel_token column specifically (CRITICAL per story)
  // -------------------------------------------------------------------------

  describe("channel_token column", () => {
    beforeEach(() => {
      db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
        TEST_ORG.org_id,
        TEST_ORG.name,
      );
      db.prepare(
        "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
      ).run(TEST_USER.user_id, TEST_USER.org_id, TEST_USER.email);
    });

    it("is writable on INSERT", () => {
      const token = "webhook-secret-token-12345";
      db.prepare(
        `INSERT INTO accounts
         (account_id, user_id, provider_subject, email, channel_token)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        TEST_ACCOUNT.account_id,
        TEST_ACCOUNT.user_id,
        TEST_ACCOUNT.provider_subject,
        TEST_ACCOUNT.email,
        token,
      );

      const row = db
        .prepare(
          "SELECT channel_token FROM accounts WHERE account_id = ?",
        )
        .get(TEST_ACCOUNT.account_id) as Record<string, unknown>;

      expect(row.channel_token).toBe(token);
    });

    it("is updatable", () => {
      db.prepare(
        `INSERT INTO accounts
         (account_id, user_id, provider_subject, email, channel_token)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        TEST_ACCOUNT.account_id,
        TEST_ACCOUNT.user_id,
        TEST_ACCOUNT.provider_subject,
        TEST_ACCOUNT.email,
        "initial-token",
      );

      db.prepare(
        "UPDATE accounts SET channel_token = ? WHERE account_id = ?",
      ).run("rotated-token-999", TEST_ACCOUNT.account_id);

      const row = db
        .prepare(
          "SELECT channel_token FROM accounts WHERE account_id = ?",
        )
        .get(TEST_ACCOUNT.account_id) as Record<string, unknown>;

      expect(row.channel_token).toBe("rotated-token-999");
    });

    it("is queryable (lookup by channel_token)", () => {
      const token = "unique-lookup-token";
      db.prepare(
        `INSERT INTO accounts
         (account_id, user_id, provider_subject, email, channel_token)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        TEST_ACCOUNT.account_id,
        TEST_ACCOUNT.user_id,
        TEST_ACCOUNT.provider_subject,
        TEST_ACCOUNT.email,
        token,
      );

      const row = db
        .prepare("SELECT account_id FROM accounts WHERE channel_token = ?")
        .get(token) as Record<string, unknown>;

      expect(row).toBeDefined();
      expect(row.account_id).toBe(TEST_ACCOUNT.account_id);
    });

    it("can be set to null (cleared on channel expiry)", () => {
      db.prepare(
        `INSERT INTO accounts
         (account_id, user_id, provider_subject, email, channel_token)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        TEST_ACCOUNT.account_id,
        TEST_ACCOUNT.user_id,
        TEST_ACCOUNT.provider_subject,
        TEST_ACCOUNT.email,
        "some-token",
      );

      db.prepare(
        "UPDATE accounts SET channel_token = NULL WHERE account_id = ?",
      ).run(TEST_ACCOUNT.account_id);

      const row = db
        .prepare(
          "SELECT channel_token FROM accounts WHERE account_id = ?",
        )
        .get(TEST_ACCOUNT.account_id) as Record<string, unknown>;

      expect(row.channel_token).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // deletion_certificates table CRUD
  // -------------------------------------------------------------------------

  describe("deletion_certificates table", () => {
    it("INSERT and SELECT", () => {
      db.prepare(
        `INSERT INTO deletion_certificates
         (cert_id, entity_type, entity_id, proof_hash, signature)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        TEST_DELETION_CERT.cert_id,
        TEST_DELETION_CERT.entity_type,
        TEST_DELETION_CERT.entity_id,
        TEST_DELETION_CERT.proof_hash,
        TEST_DELETION_CERT.signature,
      );

      const row = db
        .prepare("SELECT * FROM deletion_certificates WHERE cert_id = ?")
        .get(TEST_DELETION_CERT.cert_id) as Record<string, unknown>;

      expect(row).toBeDefined();
      expect(row.cert_id).toBe(TEST_DELETION_CERT.cert_id);
      expect(row.entity_type).toBe("user");
      expect(row.entity_id).toBe(TEST_DELETION_CERT.entity_id);
      expect(row.proof_hash).toBe(TEST_DELETION_CERT.proof_hash);
      expect(row.signature).toBe(TEST_DELETION_CERT.signature);
      expect(typeof row.deleted_at).toBe("string");
    });

    it("supports multiple entity types", () => {
      const types = ["user", "account", "event"];
      for (const [i, entityType] of types.entries()) {
        db.prepare(
          `INSERT INTO deletion_certificates
           (cert_id, entity_type, entity_id, proof_hash, signature)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(`cert_${i}`, entityType, `entity_${i}`, `hash_${i}`, `sig_${i}`);
      }

      const rows = db
        .prepare("SELECT entity_type FROM deletion_certificates ORDER BY cert_id")
        .all() as Array<{ entity_type: string }>;

      expect(rows.map((r) => r.entity_type)).toEqual(types);
    });

    it("rejects null proof_hash (NOT NULL)", () => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO deletion_certificates
           (cert_id, entity_type, entity_id, proof_hash, signature)
           VALUES (?, ?, ?, ?, ?)`,
          )
          .run("cert_bad", "user", "entity_1", null, "sig_1"),
      ).toThrow(/NOT NULL constraint failed/);
    });

    it("rejects null signature (NOT NULL)", () => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO deletion_certificates
           (cert_id, entity_type, entity_id, proof_hash, signature)
           VALUES (?, ?, ?, ?, ?)`,
          )
          .run("cert_bad", "user", "entity_1", "hash_1", null),
      ).toThrow(/NOT NULL constraint failed/);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-table foreign key cascade behavior
  // -------------------------------------------------------------------------

  describe("cross-table relationships", () => {
    beforeEach(() => {
      db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
        TEST_ORG.org_id,
        TEST_ORG.name,
      );
      db.prepare(
        "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
      ).run(TEST_USER.user_id, TEST_USER.org_id, TEST_USER.email);
      db.prepare(
        `INSERT INTO accounts
         (account_id, user_id, provider_subject, email, channel_token)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        TEST_ACCOUNT.account_id,
        TEST_ACCOUNT.user_id,
        TEST_ACCOUNT.provider_subject,
        TEST_ACCOUNT.email,
        TEST_ACCOUNT.channel_token,
      );
    });

    it("cannot delete user with existing accounts (FK constraint)", () => {
      expect(() =>
        db.prepare("DELETE FROM users WHERE user_id = ?").run(TEST_USER.user_id),
      ).toThrow(/FOREIGN KEY constraint failed/);
    });

    it("cannot delete org with existing users (FK constraint)", () => {
      expect(() =>
        db.prepare("DELETE FROM orgs WHERE org_id = ?").run(TEST_ORG.org_id),
      ).toThrow(/FOREIGN KEY constraint failed/);
    });

    it("can delete account then user then org (correct order)", () => {
      // Delete in reverse dependency order
      db.prepare("DELETE FROM accounts WHERE account_id = ?").run(
        TEST_ACCOUNT.account_id,
      );
      db.prepare("DELETE FROM users WHERE user_id = ?").run(TEST_USER.user_id);
      db.prepare("DELETE FROM orgs WHERE org_id = ?").run(TEST_ORG.org_id);

      const orgCount = db
        .prepare("SELECT COUNT(*) as cnt FROM orgs")
        .get() as { cnt: number };
      expect(orgCount.cnt).toBe(0);
    });

    it("supports querying accounts by user with join", () => {
      const rows = db
        .prepare(
          `SELECT a.account_id, a.channel_token, u.email as user_email
           FROM accounts a
           JOIN users u ON a.user_id = u.user_id
           WHERE u.user_id = ?`,
        )
        .all(TEST_USER.user_id) as Array<Record<string, unknown>>;

      expect(rows).toHaveLength(1);
      expect(rows[0].account_id).toBe(TEST_ACCOUNT.account_id);
      expect(rows[0].channel_token).toBe(TEST_ACCOUNT.channel_token);
      expect(rows[0].user_email).toBe(TEST_USER.email);
    });
  });
});
