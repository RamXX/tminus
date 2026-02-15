/**
 * Integration tests for DeletionWorkflow.
 *
 * Uses real SQLite (better-sqlite3) for UserGraphDO and a D1-like adapter
 * backed by SQLite. Verifies the complete cascade: create user data across
 * all stores, run the workflow, verify every table is empty.
 *
 * Tests prove:
 * - AC1: All 8 deletion steps execute in order
 * - AC2: Canonical events deleted from UserGraphDO SQLite
 * - AC3: Mirrors deleted from UserGraphDO SQLite
 * - AC4: Journal entries deleted from UserGraphDO SQLite
 * - AC5: Relationship/ledger data deleted
 * - AC6: D1 registry rows deleted (users, accounts)
 * - AC7: R2 audit objects deleted
 * - AC8: Provider-side deletions enqueued to write-queue
 * - AC9: Each step is idempotent (safe to retry)
 * - AC10: deletion_requests status updated to completed
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import type { SqlStorageLike, SqlStorageCursorLike, ProviderDelta, AccountId } from "@tminus/shared";
import { UserGraphDO } from "../../../durable-objects/user-graph/src/index";
import type { QueueLike as DoQueueLike } from "../../../durable-objects/user-graph/src/index";
import { ALL_MIGRATIONS } from "@tminus/d1-registry";
import { DeletionWorkflow } from "./index";
import type {
  DeletionEnv,
  R2BucketLike,
  R2ListResult,
  QueueLike,
} from "./index";
import { verifyDeletionCertificate } from "@tminus/shared";
import type { DeletionCertificate } from "@tminus/shared";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_USER_ID = "usr_01TESTUSER000000000000001";
const TEST_ACCOUNT_ID = "acc_01TESTACCOUNT0000000000001" as AccountId;
const OTHER_ACCOUNT_ID = "acc_01TESTACCOUNT0000000000002" as AccountId;
const TEST_ORG_ID = "org_01TESTORG0000000000000001";
const TEST_REQUEST_ID = "delreq_01TESTREQUEST0000000001";
const TEST_MASTER_KEY = "test-master-key-for-deletion-certs-2026";

// ---------------------------------------------------------------------------
// SqlStorage adapter (real SQLite for UserGraphDO)
// ---------------------------------------------------------------------------

function createSqlStorageAdapter(db: DatabaseType): SqlStorageLike {
  return {
    exec<T extends Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): SqlStorageCursorLike<T> {
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
// D1-like adapter backed by SQLite (for D1 registry tables)
// ---------------------------------------------------------------------------

/**
 * Translate D1-style positional params (?1, ?2, ...) to SQLite-style (?, ?, ...).
 * D1 uses ?N notation but better-sqlite3 uses plain ? with positional binding.
 */
function normalizeD1Sql(sql: string): string {
  return sql.replace(/\?(\d+)/g, "?");
}

function createD1Adapter(db: DatabaseType): D1Database {
  return {
    prepare(sql: string) {
      const normalizedSql = normalizeD1Sql(sql);
      return {
        bind(...params: unknown[]) {
          return {
            run() {
              const stmt = db.prepare(normalizedSql);
              const result = stmt.run(...params);
              return Promise.resolve({
                meta: { changes: result.changes },
                results: [],
                success: true,
              });
            },
            all<T>() {
              const stmt = db.prepare(normalizedSql);
              const rows = stmt.all(...params) as T[];
              return Promise.resolve({ results: rows });
            },
            first<T>() {
              const stmt = db.prepare(normalizedSql);
              const row = stmt.get(...params) as T | undefined;
              return Promise.resolve(row ?? null);
            },
          };
        },
      };
    },
    batch() {
      return Promise.resolve([]);
    },
    exec() {
      return Promise.resolve({ count: 0, duration: 0 });
    },
    dump() {
      return Promise.resolve(new ArrayBuffer(0));
    },
  } as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// Mock R2 (in-memory key-value store)
// ---------------------------------------------------------------------------

class MockR2 implements R2BucketLike {
  private objects: Map<string, string> = new Map();

  put(key: string, value: string): void {
    this.objects.set(key, value);
  }

  async list(options?: {
    prefix?: string;
    cursor?: string;
  }): Promise<R2ListResult> {
    const prefix = options?.prefix ?? "";
    const matching = Array.from(this.objects.keys())
      .filter((k) => k.startsWith(prefix))
      .map((key) => ({ key }));
    return { objects: matching, truncated: false };
  }

  async delete(keys: string | string[]): Promise<void> {
    const keyArray = typeof keys === "string" ? [keys] : keys;
    for (const k of keyArray) {
      this.objects.delete(k);
    }
  }

  size(): number {
    return this.objects.size;
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }
}

// ---------------------------------------------------------------------------
// Mock Queue
// ---------------------------------------------------------------------------

class MockQueue implements QueueLike, DoQueueLike {
  messages: unknown[] = [];

  async send(message: unknown): Promise<void> {
    this.messages.push(message);
  }

  async sendBatch(messages: Array<{ body: unknown }>): Promise<void> {
    for (const m of messages) {
      this.messages.push(m.body);
    }
  }

  clear(): void {
    this.messages = [];
  }
}

// ---------------------------------------------------------------------------
// Mock DurableObject namespace that wraps a real UserGraphDO
// ---------------------------------------------------------------------------

function createDoNamespace(ug: UserGraphDO): DurableObjectNamespace {
  const stub = {
    fetch: async (req: Request) => {
      return ug.handleFetch(req);
    },
  } as unknown as DurableObjectStub;

  return {
    idFromName: () => ({ toString: () => "mock-id" }),
    get: () => stub,
  } as unknown as DurableObjectNamespace;
}

// ---------------------------------------------------------------------------
// Helper: seed test data across all stores
// ---------------------------------------------------------------------------

function seedUserGraphData(
  doDb: DatabaseType,
  ug: UserGraphDO,
  doQueue: MockQueue,
): void {
  // Seed canonical events
  doDb.prepare(
    `INSERT INTO canonical_events (
      canonical_event_id, origin_account_id, origin_event_id,
      title, start_ts, end_ts, status, visibility, transparency, source, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "evt_001", TEST_ACCOUNT_ID, "google_001",
    "Meeting 1", "2026-02-15T09:00:00Z", "2026-02-15T10:00:00Z",
    "confirmed", "default", "opaque", "google_sync", 1,
  );
  doDb.prepare(
    `INSERT INTO canonical_events (
      canonical_event_id, origin_account_id, origin_event_id,
      title, start_ts, end_ts, status, visibility, transparency, source, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "evt_002", OTHER_ACCOUNT_ID, "google_002",
    "Meeting 2", "2026-02-16T09:00:00Z", "2026-02-16T10:00:00Z",
    "confirmed", "default", "opaque", "google_sync", 1,
  );

  // Seed mirrors
  doDb.prepare(
    `INSERT INTO event_mirrors (
      canonical_event_id, target_account_id, target_calendar_id,
      provider_event_id, state
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run("evt_001", OTHER_ACCOUNT_ID, "cal_other", "mirror_001", "SYNCED");
  doDb.prepare(
    `INSERT INTO event_mirrors (
      canonical_event_id, target_account_id, target_calendar_id,
      provider_event_id, state
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run("evt_002", TEST_ACCOUNT_ID, "cal_test", "mirror_002", "SYNCED");

  // Seed journal entries
  doDb.prepare(
    `INSERT INTO event_journal (
      journal_id, canonical_event_id, ts, actor, change_type
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run("jrn_001", "evt_001", "2026-02-15T08:00:00Z", "sync", "created");
  doDb.prepare(
    `INSERT INTO event_journal (
      journal_id, canonical_event_id, ts, actor, change_type
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run("jrn_002", "evt_002", "2026-02-16T08:00:00Z", "sync", "created");

  // Seed policy + edges
  doDb.prepare(
    `INSERT INTO policies (policy_id, name, is_default) VALUES (?, ?, ?)`,
  ).run("pol_001", "default", 1);
  doDb.prepare(
    `INSERT INTO policy_edges (
      policy_id, from_account_id, to_account_id, detail_level, calendar_kind
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run("pol_001", TEST_ACCOUNT_ID, OTHER_ACCOUNT_ID, "BUSY", "BUSY_OVERLAY");

  // Seed calendars
  doDb.prepare(
    `INSERT INTO calendars (
      calendar_id, account_id, provider_calendar_id, role, kind
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run("cal_test", TEST_ACCOUNT_ID, "primary", "primary", "PRIMARY");
  doDb.prepare(
    `INSERT INTO calendars (
      calendar_id, account_id, provider_calendar_id, role, kind
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run("cal_other", OTHER_ACCOUNT_ID, "primary", "primary", "PRIMARY");

  // Seed constraints
  doDb.prepare(
    `INSERT INTO constraints (constraint_id, kind, config_json) VALUES (?, ?, ?)`,
  ).run("cst_001", "no_overlap", "{}");

  // Seed relationships (Phase 4)
  doDb.prepare(
    `INSERT INTO relationships (
      relationship_id, participant_hash, category, closeness_weight
    ) VALUES (?, ?, ?, ?)`,
  ).run("rel_001", "hash_abc", "COLLEAGUE", 0.7);

  // Seed interaction_ledger (Phase 4)
  doDb.prepare(
    `INSERT INTO interaction_ledger (
      ledger_id, participant_hash, outcome, weight
    ) VALUES (?, ?, ?, ?)`,
  ).run("ldg_001", "hash_abc", "met", 1.0);

  // Seed milestones (Phase 4)
  doDb.prepare(
    `INSERT INTO milestones (
      milestone_id, participant_hash, kind, date, recurs_annually
    ) VALUES (?, ?, ?, ?, ?)`,
  ).run("mst_001", "hash_abc", "birthday", "2026-06-15", 1);
}

function seedD1Data(d1Db: DatabaseType): void {
  // D1 does not enforce foreign keys by default. Disable in test to match.
  d1Db.pragma("foreign_keys = OFF");

  // Apply all D1 migrations
  for (const migration of ALL_MIGRATIONS) {
    d1Db.exec(migration);
  }

  // Seed org
  d1Db.prepare(
    `INSERT INTO orgs (org_id, name) VALUES (?, ?)`,
  ).run(TEST_ORG_ID, "Test Org");

  // Seed user
  d1Db.prepare(
    `INSERT INTO users (user_id, org_id, email, display_name) VALUES (?, ?, ?, ?)`,
  ).run(TEST_USER_ID, TEST_ORG_ID, "test@example.com", "Test User");

  // Seed accounts
  d1Db.prepare(
    `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(TEST_ACCOUNT_ID, TEST_USER_ID, "google", "goog_sub_1", "a@test.com", "active");
  d1Db.prepare(
    `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(OTHER_ACCOUNT_ID, TEST_USER_ID, "google", "goog_sub_2", "b@test.com", "active");

  // Seed API key
  d1Db.prepare(
    `INSERT INTO api_keys (key_id, user_id, name, prefix, key_hash) VALUES (?, ?, ?, ?, ?)`,
  ).run("key_001", TEST_USER_ID, "Test Key", "tmk_live", "hash_abc123");

  // Seed deletion request (status = 'processing')
  d1Db.prepare(
    `INSERT INTO deletion_requests (request_id, user_id, status, requested_at, scheduled_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    TEST_REQUEST_ID, TEST_USER_ID, "processing",
    "2026-02-12T00:00:00.000Z", "2026-02-15T00:00:00.000Z",
  );
}

// ---------------------------------------------------------------------------
// Helper: count rows
// ---------------------------------------------------------------------------

function countRows(db: DatabaseType, table: string): number {
  return (db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as { cnt: number }).cnt;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("DeletionWorkflow integration tests (real SQLite, full cascade)", () => {
  let doDb: DatabaseType;
  let d1Db: DatabaseType;
  let sql: SqlStorageLike;
  let doQueue: MockQueue;
  let wfQueue: MockQueue;
  let ug: UserGraphDO;
  let r2: MockR2;
  let env: DeletionEnv;

  beforeEach(() => {
    // UserGraphDO backed by real SQLite
    doDb = new Database(":memory:");
    sql = createSqlStorageAdapter(doDb);
    doQueue = new MockQueue();
    ug = new UserGraphDO(sql, doQueue);

    // Force migration by calling any method that triggers ensureMigrated()
    ug.getSyncHealth();

    // D1 backed by real SQLite
    d1Db = new Database(":memory:");

    // R2 mock
    r2 = new MockR2();

    // Queue for workflow (step 7 provider deletions)
    wfQueue = new MockQueue();

    // Seed data
    seedUserGraphData(doDb, ug, doQueue);
    seedD1Data(d1Db);

    // Seed R2 objects
    r2.put(`${TEST_USER_ID}/audit-2026-02-01.json`, '{"action":"login"}');
    r2.put(`${TEST_USER_ID}/audit-2026-02-02.json`, '{"action":"sync"}');
    r2.put("other_user/audit.json", '{"action":"other"}');

    // Build DeletionEnv
    env = {
      USER_GRAPH: createDoNamespace(ug),
      DB: createD1Adapter(d1Db),
      R2_AUDIT: r2,
      WRITE_QUEUE: wfQueue,
      MASTER_KEY: TEST_MASTER_KEY,
    };
  });

  afterEach(() => {
    doDb.close();
    d1Db.close();
  });

  // -----------------------------------------------------------------------
  // Verify pre-conditions (data exists before deletion)
  // -----------------------------------------------------------------------

  it("pre-condition: user data exists across all stores", () => {
    // UserGraphDO
    expect(countRows(doDb, "canonical_events")).toBe(2);
    expect(countRows(doDb, "event_mirrors")).toBe(2);
    expect(countRows(doDb, "event_journal")).toBe(2);
    expect(countRows(doDb, "policies")).toBe(1);
    expect(countRows(doDb, "policy_edges")).toBe(1);
    expect(countRows(doDb, "calendars")).toBe(2);
    expect(countRows(doDb, "constraints")).toBe(1);
    expect(countRows(doDb, "relationships")).toBe(1);
    expect(countRows(doDb, "interaction_ledger")).toBe(1);
    expect(countRows(doDb, "milestones")).toBe(1);

    // D1
    expect(countRows(d1Db, "users")).toBe(1);
    expect(countRows(d1Db, "accounts")).toBe(2);
    expect(countRows(d1Db, "api_keys")).toBe(1);
    expect(countRows(d1Db, "deletion_requests")).toBe(1);

    // R2
    expect(r2.size()).toBe(3); // 2 user + 1 other
  });

  // -----------------------------------------------------------------------
  // AC1: All 8 deletion steps execute in order
  // -----------------------------------------------------------------------

  it("AC1: all 9 steps execute in order and return results", async () => {
    const wf = new DeletionWorkflow(env);
    const result = await wf.run({
      request_id: TEST_REQUEST_ID,
      user_id: TEST_USER_ID,
    });

    expect(result.steps).toHaveLength(9);
    expect(result.steps.map((s) => s.step)).toEqual([
      "delete_events",
      "delete_mirrors",
      "delete_journal",
      "delete_relationship_data",
      "delete_d1_registry",
      "delete_r2_audit",
      "enqueue_provider_deletions",
      "generate_certificate",
      "mark_completed",
    ]);
    for (const step of result.steps) {
      expect(step.ok).toBe(true);
    }
  });

  // -----------------------------------------------------------------------
  // AC2: Canonical events deleted from UserGraphDO SQLite
  // -----------------------------------------------------------------------

  it("AC2: canonical events deleted from UserGraphDO SQLite", async () => {
    const wf = new DeletionWorkflow(env);
    await wf.run({ request_id: TEST_REQUEST_ID, user_id: TEST_USER_ID });

    expect(countRows(doDb, "canonical_events")).toBe(0);
  });

  // -----------------------------------------------------------------------
  // AC3: Mirrors deleted from UserGraphDO SQLite
  // -----------------------------------------------------------------------

  it("AC3: event mirrors deleted from UserGraphDO SQLite", async () => {
    const wf = new DeletionWorkflow(env);
    await wf.run({ request_id: TEST_REQUEST_ID, user_id: TEST_USER_ID });

    expect(countRows(doDb, "event_mirrors")).toBe(0);
  });

  // -----------------------------------------------------------------------
  // AC4: Journal entries deleted from UserGraphDO SQLite
  // -----------------------------------------------------------------------

  it("AC4: journal entries deleted from UserGraphDO SQLite", async () => {
    const wf = new DeletionWorkflow(env);
    await wf.run({ request_id: TEST_REQUEST_ID, user_id: TEST_USER_ID });

    expect(countRows(doDb, "event_journal")).toBe(0);
  });

  // -----------------------------------------------------------------------
  // AC5: Relationship/ledger data deleted
  // -----------------------------------------------------------------------

  it("AC5: relationship, ledger, milestone, policy, calendar, constraint data deleted", async () => {
    const wf = new DeletionWorkflow(env);
    const result = await wf.run({
      request_id: TEST_REQUEST_ID,
      user_id: TEST_USER_ID,
    });

    expect(countRows(doDb, "relationships")).toBe(0);
    expect(countRows(doDb, "interaction_ledger")).toBe(0);
    expect(countRows(doDb, "milestones")).toBe(0);
    expect(countRows(doDb, "policies")).toBe(0);
    expect(countRows(doDb, "policy_edges")).toBe(0);
    expect(countRows(doDb, "calendars")).toBe(0);
    expect(countRows(doDb, "constraints")).toBe(0);

    // Verify step 4 reports correct total
    const step4 = result.steps.find((s) => s.step === "delete_relationship_data");
    expect(step4).toBeDefined();
    // 1 relationship + 1 ledger + 1 milestone + 1 policy edge + 1 policy +
    // 2 calendars + 1 constraint = 8 rows total
    expect(step4!.deleted).toBe(8);
  });

  // -----------------------------------------------------------------------
  // AC6: D1 registry rows deleted (users, accounts)
  // -----------------------------------------------------------------------

  it("AC6: D1 registry rows deleted (users, accounts, api_keys)", async () => {
    const wf = new DeletionWorkflow(env);
    const result = await wf.run({
      request_id: TEST_REQUEST_ID,
      user_id: TEST_USER_ID,
    });

    expect(countRows(d1Db, "accounts")).toBe(0);
    expect(countRows(d1Db, "api_keys")).toBe(0);
    expect(countRows(d1Db, "users")).toBe(0);

    // Verify step 5 reports correct total: 2 accounts + 1 api_key + 1 user = 4
    const step5 = result.steps.find((s) => s.step === "delete_d1_registry");
    expect(step5!.deleted).toBe(4);
  });

  // -----------------------------------------------------------------------
  // AC7: R2 audit objects deleted
  // -----------------------------------------------------------------------

  it("AC7: R2 audit objects deleted (only user's prefix)", async () => {
    const wf = new DeletionWorkflow(env);
    const result = await wf.run({
      request_id: TEST_REQUEST_ID,
      user_id: TEST_USER_ID,
    });

    // User's objects deleted
    expect(r2.has(`${TEST_USER_ID}/audit-2026-02-01.json`)).toBe(false);
    expect(r2.has(`${TEST_USER_ID}/audit-2026-02-02.json`)).toBe(false);

    // Other user's objects remain
    expect(r2.has("other_user/audit.json")).toBe(true);

    // Verify step 6 reports correct count
    const step6 = result.steps.find((s) => s.step === "delete_r2_audit");
    expect(step6!.deleted).toBe(2);
  });

  // -----------------------------------------------------------------------
  // AC8: Provider-side deletions enqueued to write-queue
  // -----------------------------------------------------------------------

  it("AC8: provider-side deletions enqueued to write-queue", async () => {
    const wf = new DeletionWorkflow(env);
    await wf.run({ request_id: TEST_REQUEST_ID, user_id: TEST_USER_ID });

    // Two accounts -> two messages
    expect(wfQueue.messages).toHaveLength(2);

    const msgs = wfQueue.messages as Array<{
      type: string;
      user_id: string;
      account_id: string;
      provider: string;
    }>;

    // Verify both accounts received DELETE_USER_MIRRORS messages
    const accountIds = msgs.map((m) => m.account_id).sort();
    expect(accountIds).toEqual([TEST_ACCOUNT_ID, OTHER_ACCOUNT_ID].sort());

    for (const msg of msgs) {
      expect(msg.type).toBe("DELETE_USER_MIRRORS");
      expect(msg.user_id).toBe(TEST_USER_ID);
      expect(msg.provider).toBe("google");
    }
  });

  // -----------------------------------------------------------------------
  // AC9: Each step is idempotent (safe to retry)
  // -----------------------------------------------------------------------

  it("AC9: running deletion twice is safe (idempotent)", async () => {
    const wf = new DeletionWorkflow(env);

    // First run
    const result1 = await wf.run({
      request_id: TEST_REQUEST_ID,
      user_id: TEST_USER_ID,
    });
    for (const step of result1.steps) {
      expect(step.ok).toBe(true);
    }

    // Second run -- all data already gone, should still succeed
    wfQueue.clear();
    const result2 = await wf.run({
      request_id: TEST_REQUEST_ID,
      user_id: TEST_USER_ID,
    });

    expect(result2.steps).toHaveLength(9);
    for (const step of result2.steps) {
      expect(step.ok).toBe(true);
      // generate_certificate always reports 1 (it creates a new cert each run)
      if (step.step === "generate_certificate") {
        expect(step.deleted).toBe(1);
      } else {
        expect(step.deleted).toBe(0);
      }
    }
  });

  // -----------------------------------------------------------------------
  // AC10: deletion_requests status updated to completed
  // -----------------------------------------------------------------------

  it("AC10: deletion_requests status updated to completed", async () => {
    const wf = new DeletionWorkflow(env);
    await wf.run({ request_id: TEST_REQUEST_ID, user_id: TEST_USER_ID });

    const row = d1Db
      .prepare("SELECT status, completed_at FROM deletion_requests WHERE request_id = ?")
      .get(TEST_REQUEST_ID) as { status: string; completed_at: string | null };

    expect(row.status).toBe("completed");
    expect(row.completed_at).toBeDefined();
    expect(row.completed_at).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // Additional: No PII remains after deletion
  // -----------------------------------------------------------------------

  it("no PII remains in UserGraphDO after deletion", async () => {
    const wf = new DeletionWorkflow(env);
    await wf.run({ request_id: TEST_REQUEST_ID, user_id: TEST_USER_ID });

    // All PII-bearing tables are completely empty
    const piiTables = [
      "canonical_events",   // titles, descriptions, locations
      "event_mirrors",      // account references
      "event_journal",      // audit trail with PII
      "calendars",          // account/calendar mappings
      "relationships",      // participant info
      "interaction_ledger", // interaction details
      "milestones",         // personal dates
    ];

    for (const table of piiTables) {
      expect(countRows(doDb, table)).toBe(0);
    }
  });

  // -----------------------------------------------------------------------
  // Edge case: user with no data
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // AC (TM-ito): Deletion certificate generated and stored in D1
  // -----------------------------------------------------------------------

  it("TM-ito AC1: deletion certificate generated with SHA-256 proof hash", async () => {
    const wf = new DeletionWorkflow(env);
    const result = await wf.run({
      request_id: TEST_REQUEST_ID,
      user_id: TEST_USER_ID,
    });

    // Certificate ID should be present in result
    expect(result.certificate_id).toBeDefined();
    expect(result.certificate_id!).toMatch(/^crt_/);

    // Certificate should be stored in D1
    const certRow = d1Db
      .prepare("SELECT * FROM deletion_certificates WHERE cert_id = ?")
      .get(result.certificate_id!) as {
        cert_id: string;
        entity_type: string;
        entity_id: string;
        deleted_at: string;
        proof_hash: string;
        signature: string;
        deletion_summary: string;
      };

    expect(certRow).toBeDefined();
    expect(certRow.proof_hash).toHaveLength(64);
    expect(certRow.proof_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("TM-ito AC2: certificate signed with HMAC-SHA-256 using MASTER_KEY", async () => {
    const wf = new DeletionWorkflow(env);
    const result = await wf.run({
      request_id: TEST_REQUEST_ID,
      user_id: TEST_USER_ID,
    });

    const certRow = d1Db
      .prepare("SELECT * FROM deletion_certificates WHERE cert_id = ?")
      .get(result.certificate_id!) as {
        cert_id: string;
        entity_type: string;
        entity_id: string;
        deleted_at: string;
        proof_hash: string;
        signature: string;
        deletion_summary: string;
      };

    expect(certRow.signature).toHaveLength(64);
    expect(certRow.signature).toMatch(/^[0-9a-f]{64}$/);

    // Reconstruct the certificate and verify signature
    const cert: DeletionCertificate = {
      certificate_id: certRow.cert_id,
      entity_type: certRow.entity_type as "user",
      entity_id: certRow.entity_id,
      deleted_at: certRow.deleted_at,
      proof_hash: certRow.proof_hash,
      signature: certRow.signature,
      deletion_summary: JSON.parse(certRow.deletion_summary),
    };

    const valid = await verifyDeletionCertificate(cert, TEST_MASTER_KEY);
    expect(valid).toBe(true);
  });

  it("TM-ito AC3: certificate stored in D1 deletion_certificates table", async () => {
    const wf = new DeletionWorkflow(env);
    const result = await wf.run({
      request_id: TEST_REQUEST_ID,
      user_id: TEST_USER_ID,
    });

    // Certificate should be in the deletion_certificates table
    const count = (d1Db
      .prepare("SELECT COUNT(*) as cnt FROM deletion_certificates WHERE cert_id = ?")
      .get(result.certificate_id!) as { cnt: number }).cnt;
    expect(count).toBe(1);

    // Verify all required fields are populated
    const certRow = d1Db
      .prepare("SELECT * FROM deletion_certificates WHERE cert_id = ?")
      .get(result.certificate_id!) as Record<string, unknown>;
    expect(certRow.entity_type).toBe("user");
    expect(certRow.entity_id).toBe(TEST_USER_ID);
    expect(certRow.deleted_at).toBeDefined();
    expect(certRow.proof_hash).toBeDefined();
    expect(certRow.signature).toBeDefined();
    expect(certRow.deletion_summary).toBeDefined();
  });

  it("TM-ito AC5: no PII in certificate (only counts and hashes)", async () => {
    const wf = new DeletionWorkflow(env);
    const result = await wf.run({
      request_id: TEST_REQUEST_ID,
      user_id: TEST_USER_ID,
    });

    const certRow = d1Db
      .prepare("SELECT * FROM deletion_certificates WHERE cert_id = ?")
      .get(result.certificate_id!) as {
        cert_id: string;
        deletion_summary: string;
      };

    const summary = JSON.parse(certRow.deletion_summary);

    // Summary should only contain numeric counts
    expect(typeof summary.events_deleted).toBe("number");
    expect(typeof summary.mirrors_deleted).toBe("number");
    expect(typeof summary.journal_entries_deleted).toBe("number");
    expect(typeof summary.relationship_records_deleted).toBe("number");
    expect(typeof summary.d1_rows_deleted).toBe("number");
    expect(typeof summary.r2_objects_deleted).toBe("number");
    expect(typeof summary.provider_deletions_enqueued).toBe("number");

    // No email, name, or other PII strings in the summary
    const summaryStr = certRow.deletion_summary;
    expect(summaryStr).not.toContain("@");
    expect(summaryStr).not.toContain("email");
    expect(summaryStr).not.toContain("test@example.com");
    expect(summaryStr).not.toContain("Test User");
  });

  it("TM-ito AC6: signature independently verifiable (round-trip via D1)", async () => {
    const wf = new DeletionWorkflow(env);
    const result = await wf.run({
      request_id: TEST_REQUEST_ID,
      user_id: TEST_USER_ID,
    });

    // Retrieve certificate from D1 (simulating API endpoint)
    const certRow = d1Db
      .prepare("SELECT * FROM deletion_certificates WHERE cert_id = ?")
      .get(result.certificate_id!) as {
        cert_id: string;
        entity_type: string;
        entity_id: string;
        deleted_at: string;
        proof_hash: string;
        signature: string;
        deletion_summary: string;
      };

    // Reconstruct from D1 data (as if from API response)
    const cert: DeletionCertificate = {
      certificate_id: certRow.cert_id,
      entity_type: certRow.entity_type as "user",
      entity_id: certRow.entity_id,
      deleted_at: certRow.deleted_at,
      proof_hash: certRow.proof_hash,
      signature: certRow.signature,
      deletion_summary: JSON.parse(certRow.deletion_summary),
    };

    // Verify with correct key succeeds
    expect(await verifyDeletionCertificate(cert, TEST_MASTER_KEY)).toBe(true);

    // Verify with wrong key fails
    expect(await verifyDeletionCertificate(cert, "wrong-key")).toBe(false);

    // Verify with tampered summary fails
    const tampered: DeletionCertificate = {
      ...cert,
      deletion_summary: { ...cert.deletion_summary, events_deleted: 999 },
    };
    expect(await verifyDeletionCertificate(tampered, TEST_MASTER_KEY)).toBe(false);
  });

  it("TM-ito: certificate summary contains correct deletion counts from step results", async () => {
    const wf = new DeletionWorkflow(env);
    const result = await wf.run({
      request_id: TEST_REQUEST_ID,
      user_id: TEST_USER_ID,
    });

    const certRow = d1Db
      .prepare("SELECT deletion_summary FROM deletion_certificates WHERE cert_id = ?")
      .get(result.certificate_id!) as { deletion_summary: string };

    const summary = JSON.parse(certRow.deletion_summary);

    // Counts match step results. Note: deleteAllEvents() deletes event_mirrors
    // as FK children before canonical_events, so mirrors_deleted=0 by the time
    // step 2 runs. This is correct -- the certificate records what each step
    // reported, which is the truth of execution.
    expect(summary.events_deleted).toBe(2);  // 2 canonical events (counted by step 1)
    expect(summary.mirrors_deleted).toBe(0);  // 0 -- mirrors were already deleted by step 1 (FK child cleanup)
    expect(summary.journal_entries_deleted).toBe(2);  // 2 journal entries
    expect(summary.relationship_records_deleted).toBe(8);  // 1 rel + 1 ledger + 1 milestone + 1 edge + 1 policy + 2 calendars + 1 constraint
    expect(summary.d1_rows_deleted).toBe(4);  // 2 accounts + 1 api_key + 1 user
    expect(summary.r2_objects_deleted).toBe(2);  // 2 R2 objects
    expect(summary.provider_deletions_enqueued).toBe(2);  // 2 accounts

    // Verify the summary matches the actual step results
    const stepResults = result.steps;
    expect(summary.events_deleted).toBe(
      stepResults.find(s => s.step === "delete_events")!.deleted,
    );
    expect(summary.mirrors_deleted).toBe(
      stepResults.find(s => s.step === "delete_mirrors")!.deleted,
    );
    expect(summary.d1_rows_deleted).toBe(
      stepResults.find(s => s.step === "delete_d1_registry")!.deleted,
    );
  });

  // -----------------------------------------------------------------------
  // Edge case: user with no data
  // -----------------------------------------------------------------------

  it("handles user with no data gracefully (empty state)", async () => {
    // Create a fresh DO with no seeded data
    const emptyDoDb = new Database(":memory:");
    const emptySql = createSqlStorageAdapter(emptyDoDb);
    const emptyDoQueue = new MockQueue();
    const emptyUg = new UserGraphDO(emptySql, emptyDoQueue);
    emptyUg.getSyncHealth(); // trigger migration

    // D1 with a different user that has no accounts/data
    const emptyD1Db = new Database(":memory:");
    emptyD1Db.pragma("foreign_keys = OFF");
    for (const migration of ALL_MIGRATIONS) {
      emptyD1Db.exec(migration);
    }
    emptyD1Db.prepare(
      "INSERT INTO orgs (org_id, name) VALUES (?, ?)",
    ).run("org_empty", "Empty Org");
    emptyD1Db.prepare(
      "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
    ).run("usr_empty", "org_empty", "empty@test.com");
    emptyD1Db.prepare(
      `INSERT INTO deletion_requests (request_id, user_id, status, requested_at, scheduled_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("delreq_empty", "usr_empty", "processing", "2026-02-12T00:00:00Z", "2026-02-15T00:00:00Z");

    const emptyR2 = new MockR2();
    const emptyWfQueue = new MockQueue();

    const emptyEnv: DeletionEnv = {
      USER_GRAPH: createDoNamespace(emptyUg),
      DB: createD1Adapter(emptyD1Db),
      R2_AUDIT: emptyR2,
      WRITE_QUEUE: emptyWfQueue,
      MASTER_KEY: TEST_MASTER_KEY,
    };

    const wf = new DeletionWorkflow(emptyEnv);
    const result = await wf.run({
      request_id: "delreq_empty",
      user_id: "usr_empty",
    });

    expect(result.steps).toHaveLength(9);
    for (const step of result.steps) {
      expect(step.ok).toBe(true);
    }

    // User deleted from D1
    expect(countRows(emptyD1Db, "users")).toBe(0);

    // Deletion request marked completed
    const row = emptyD1Db
      .prepare("SELECT status FROM deletion_requests WHERE request_id = ?")
      .get("delreq_empty") as { status: string };
    expect(row.status).toBe("completed");

    emptyDoDb.close();
    emptyD1Db.close();
  });
});
