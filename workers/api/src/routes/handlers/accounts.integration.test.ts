/**
 * Integration tests for account scope management endpoints (TM-8gfd.2).
 *
 * Tests exercise the FULL handler flow: createHandler() -> fetch() -> response,
 * with real SQL via better-sqlite3 and mock DOs that simulate the actual
 * AccountDO /listCalendarScopes and /upsertCalendarScope protocol.
 *
 * NO MOCKS in scope validation/capability logic -- real validation runs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  MIGRATION_0001_INITIAL_SCHEMA,
  MIGRATION_0008_SYNC_STATUS_COLUMNS,
  MIGRATION_0012_SUBSCRIPTIONS,
  MIGRATION_0013_SUBSCRIPTION_LIFECYCLE,
} from "@tminus/d1-registry";
import { createHandler, createJwt } from "../../index";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const JWT_SECRET = "integration-test-jwt-secret-32chars-minimum";

const TEST_ORG = {
  org_id: "org_01HXY000000000000000000001",
  name: "Scope Integration Test Org",
} as const;

const TEST_USER = {
  user_id: "usr_01HXY000000000000000000001",
  org_id: TEST_ORG.org_id,
  email: "scope-test@example.com",
} as const;

const ACCOUNT_A = {
  account_id: "acc_01HXY0000000000000000000AA",
  user_id: TEST_USER.user_id,
  provider: "google",
  provider_subject: "google-sub-scope-a",
  email: "scopes@gmail.com",
  status: "active",
} as const;

// Another user's account (should not be accessible)
const OTHER_USER = {
  user_id: "usr_01HXY0000000000000000000ZZ",
  org_id: "org_01HXYZ00000000000000000099",
  email: "other-scope@example.com",
} as const;

const OTHER_ACCOUNT = {
  account_id: "acc_01HXY0000000000000000000CC",
  user_id: OTHER_USER.user_id,
  provider: "google",
  provider_subject: "google-sub-other",
  email: "other@gmail.com",
  status: "active",
} as const;

// Simulated DO scope data
const MOCK_SCOPES = [
  {
    scopeId: "cal_01TEST000000000000000001",
    providerCalendarId: "primary",
    displayName: "Main Calendar",
    calendarRole: "owner",
    enabled: true,
    syncEnabled: true,
  },
  {
    scopeId: "cal_01TEST000000000000000002",
    providerCalendarId: "shared-team@group.calendar.google.com",
    displayName: "Team Calendar",
    calendarRole: "editor",
    enabled: true,
    syncEnabled: false,
  },
  {
    scopeId: "cal_01TEST000000000000000003",
    providerCalendarId: "holidays@calendar.google.com",
    displayName: "Holidays",
    calendarRole: "reader",
    enabled: false,
    syncEnabled: false,
  },
];

// ---------------------------------------------------------------------------
// Real D1 mock backed by better-sqlite3
// ---------------------------------------------------------------------------

function createRealD1(db: DatabaseType): D1Database {
  const normalizeSQL = (sql: string): string => sql.replace(/\?(\d+)/g, "?");

  function createBoundStatement(normalizedSql: string, params: unknown[]) {
    return {
      first<T>(): Promise<T | null> {
        const stmt = db.prepare(normalizedSql);
        const row = (params.length > 0 ? stmt.get(...params) : stmt.get()) as T | null;
        return Promise.resolve(row ?? null);
      },
      all<T>(): Promise<{ results: T[] }> {
        const stmt = db.prepare(normalizedSql);
        const rows = (params.length > 0 ? stmt.all(...params) : stmt.all()) as T[];
        return Promise.resolve({ results: rows });
      },
      run(): Promise<D1Result<unknown>> {
        const stmt = db.prepare(normalizedSql);
        const info = params.length > 0 ? stmt.run(...params) : stmt.run();
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
  }

  return {
    prepare(sql: string) {
      const normalizedSql = normalizeSQL(sql);
      // Support both .prepare(sql).bind(...).run() and .prepare(sql).run()
      const unboundStmt = createBoundStatement(normalizedSql, []);
      return {
        ...unboundStmt,
        bind(...params: unknown[]) {
          return createBoundStatement(normalizedSql, params);
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
// Mock DO namespace with configurable scope responses
// ---------------------------------------------------------------------------

interface DOCallRecord {
  name: string;
  path: string;
  method: string;
  body?: unknown;
}

function createMockAccountDO(config?: {
  scopes?: typeof MOCK_SCOPES;
}): DurableObjectNamespace & { calls: DOCallRecord[] } {
  const calls: DOCallRecord[] = [];
  // Mutable copy so upsert calls can modify
  const scopeData = config?.scopes ? [...config.scopes] : [...MOCK_SCOPES];

  return {
    calls,
    idFromName(name: string): DurableObjectId {
      return {
        toString: () => name,
        name,
        equals: () => false,
      } as unknown as DurableObjectId;
    },
    get(_id: DurableObjectId): DurableObjectStub {
      const doName = _id.toString();
      return {
        async fetch(
          input: RequestInfo | URL,
          init?: RequestInit,
        ): Promise<Response> {
          const url =
            typeof input === "string"
              ? new URL(input)
              : input instanceof URL
                ? input
                : new URL(input.url);
          const method =
            init?.method ??
            (typeof input === "object" && "method" in input
              ? input.method
              : "GET");

          let parsedBody: unknown;
          if (init?.body) {
            try {
              parsedBody = JSON.parse(init.body as string);
            } catch {
              parsedBody = init.body;
            }
          }

          calls.push({ name: doName, path: url.pathname, method, body: parsedBody });

          if (url.pathname === "/listCalendarScopes") {
            return new Response(JSON.stringify({ scopes: scopeData }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }

          if (url.pathname === "/upsertCalendarScope") {
            // Simulate scope update by modifying local data
            const body = parsedBody as {
              provider_calendar_id: string;
              enabled?: boolean;
              sync_enabled?: boolean;
            };
            const idx = scopeData.findIndex(
              (s) => s.providerCalendarId === body.provider_calendar_id,
            );
            if (idx >= 0) {
              if (body.enabled !== undefined) scopeData[idx].enabled = body.enabled;
              if (body.sync_enabled !== undefined) scopeData[idx].syncEnabled = body.sync_enabled;
            }
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }

          // Default passthrough for other DO calls (getHealth, etc.)
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      } as unknown as DurableObjectStub;
    },
    idFromString(_hexId: string): DurableObjectId {
      return {
        toString: () => _hexId,
        equals: () => false,
      } as unknown as DurableObjectId;
    },
    newUniqueId(): DurableObjectId {
      return {
        toString: () => "unique",
        equals: () => false,
      } as unknown as DurableObjectId;
    },
    jurisdiction(_name: string): DurableObjectNamespace {
      return this;
    },
  } as unknown as DurableObjectNamespace & { calls: DOCallRecord[] };
}

function createMockDONamespace(): DurableObjectNamespace {
  return createMockAccountDO({ scopes: [] });
}

function createMockQueue(): Queue & { messages: unknown[] } {
  const messages: unknown[] = [];
  return {
    messages,
    async send(msg: unknown) {
      messages.push(msg);
    },
    async sendBatch(_msgs: Iterable<MessageSendRequest>) {},
  } as unknown as Queue & { messages: unknown[] };
}

function createMockKV(): KVNamespace {
  const store = new Map<string, { value: string; expiration?: number }>();
  return {
    store,
    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      if (!entry) return null;
      return entry.value;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
      const expiration = opts?.expirationTtl
        ? Math.floor(Date.now() / 1000) + opts.expirationTtl
        : undefined;
      store.set(key, { value, expiration });
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(): Promise<{ keys: Array<{ name: string }>; list_complete: boolean }> {
      return { keys: [], list_complete: true };
    },
    async getWithMetadata(): Promise<{ value: string | null; metadata: unknown }> {
      return { value: null, metadata: null };
    },
  } as unknown as KVNamespace;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeAuthHeader(userId?: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await createJwt(
    { sub: userId ?? TEST_USER.user_id, iat: now, exp: now + 3600 },
    JWT_SECRET,
  );
  return `Bearer ${token}`;
}

function insertAccount(
  db: DatabaseType,
  account: {
    account_id: string;
    user_id: string;
    provider: string;
    provider_subject: string;
    email: string;
    status?: string;
  },
): void {
  db.prepare(
    `INSERT INTO accounts
     (account_id, user_id, provider, provider_subject, email, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    account.account_id,
    account.user_id,
    account.provider,
    account.provider_subject,
    account.email,
    account.status ?? "active",
  );
}

function buildEnv(
  d1: D1Database,
  accountDO?: DurableObjectNamespace,
): Env {
  return {
    DB: d1,
    USER_GRAPH: createMockDONamespace(),
    ACCOUNT: accountDO ?? createMockAccountDO(),
    SYNC_QUEUE: createMockQueue(),
    WRITE_QUEUE: createMockQueue(),
    SESSIONS: createMockKV(),
    JWT_SECRET,
  };
}

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

// ===========================================================================
// Integration tests
// ===========================================================================

describe("Integration: Calendar scope endpoints", () => {
  let db: DatabaseType;
  let d1: D1Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0008_SYNC_STATUS_COLUMNS);
    db.exec(MIGRATION_0012_SUBSCRIPTIONS);
    db.exec(MIGRATION_0013_SUBSCRIPTION_LIFECYCLE);
    db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
      TEST_ORG.org_id,
      TEST_ORG.name,
    );
    db.prepare(
      "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
    ).run(TEST_USER.user_id, TEST_USER.org_id, TEST_USER.email);
    d1 = createRealD1(db);
  });

  afterEach(() => {
    db.close();
  });

  // -----------------------------------------------------------------------
  // GET /v1/accounts/:id/scopes
  // -----------------------------------------------------------------------

  describe("GET /v1/accounts/:id/scopes", () => {
    it("returns 401 without auth header", async () => {
      insertAccount(db, ACCOUNT_A);
      const handler = createHandler();
      const env = buildEnv(d1);

      const response = await handler.fetch(
        new Request(`https://api.tminus.dev/v1/accounts/${ACCOUNT_A.account_id}/scopes`),
        env,
        mockCtx,
      );

      expect(response.status).toBe(401);
    });

    it("returns 404 for non-existent account", async () => {
      const handler = createHandler();
      const env = buildEnv(d1);
      const authHeader = await makeAuthHeader();

      const response = await handler.fetch(
        new Request(
          `https://api.tminus.dev/v1/accounts/${ACCOUNT_A.account_id}/scopes`,
          { headers: { Authorization: authHeader } },
        ),
        env,
        mockCtx,
      );

      expect(response.status).toBe(404);
      const body = await response.json() as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("not found");
    });

    it("returns 404 for another user's account", async () => {
      // Insert other user's org, user, and account
      db.prepare("INSERT OR IGNORE INTO orgs (org_id, name) VALUES (?, ?)").run(
        OTHER_USER.org_id,
        "Other Org",
      );
      db.prepare(
        "INSERT OR IGNORE INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
      ).run(OTHER_USER.user_id, OTHER_USER.org_id, OTHER_USER.email);
      insertAccount(db, OTHER_ACCOUNT);

      const handler = createHandler();
      const env = buildEnv(d1);
      const authHeader = await makeAuthHeader(TEST_USER.user_id);

      const response = await handler.fetch(
        new Request(
          `https://api.tminus.dev/v1/accounts/${OTHER_ACCOUNT.account_id}/scopes`,
          { headers: { Authorization: authHeader } },
        ),
        env,
        mockCtx,
      );

      expect(response.status).toBe(404);
    });

    it("returns scopes with capability metadata for owned account", async () => {
      insertAccount(db, ACCOUNT_A);
      const accountDO = createMockAccountDO();
      const handler = createHandler();
      const env = buildEnv(d1, accountDO);
      const authHeader = await makeAuthHeader();

      const response = await handler.fetch(
        new Request(
          `https://api.tminus.dev/v1/accounts/${ACCOUNT_A.account_id}/scopes`,
          { headers: { Authorization: authHeader } },
        ),
        env,
        mockCtx,
      );

      expect(response.status).toBe(200);
      const body = await response.json() as {
        ok: boolean;
        data: {
          account_id: string;
          provider: string;
          scopes: Array<{
            scope_id: string;
            provider_calendar_id: string;
            display_name: string | null;
            calendar_role: string;
            access_level: string;
            capabilities: string[];
            enabled: boolean;
            sync_enabled: boolean;
            recommended: boolean;
          }>;
        };
      };

      expect(body.ok).toBe(true);
      expect(body.data.account_id).toBe(ACCOUNT_A.account_id);
      expect(body.data.provider).toBe("google");
      expect(body.data.scopes).toHaveLength(3);

      // Verify capability metadata on primary (owner) calendar
      const primary = body.data.scopes.find((s) => s.provider_calendar_id === "primary");
      expect(primary).toBeDefined();
      expect(primary!.access_level).toBe("owner");
      expect(primary!.capabilities).toEqual(["read", "write"]);
      expect(primary!.recommended).toBe(true);
      expect(primary!.display_name).toBe("Main Calendar");

      // Verify editor calendar
      const team = body.data.scopes.find((s) => s.provider_calendar_id.includes("shared-team"));
      expect(team).toBeDefined();
      expect(team!.access_level).toBe("editor");
      expect(team!.capabilities).toEqual(["read", "write"]);
      expect(team!.recommended).toBe(false);

      // Verify reader calendar
      const holidays = body.data.scopes.find((s) => s.provider_calendar_id.includes("holidays"));
      expect(holidays).toBeDefined();
      expect(holidays!.access_level).toBe("readonly");
      expect(holidays!.capabilities).toEqual(["read"]);
      expect(holidays!.recommended).toBe(false);
      expect(holidays!.enabled).toBe(false);
    });

    it("returns 400 for invalid account ID format", async () => {
      const handler = createHandler();
      const env = buildEnv(d1);
      const authHeader = await makeAuthHeader();

      const response = await handler.fetch(
        new Request(
          "https://api.tminus.dev/v1/accounts/bad-id/scopes",
          { headers: { Authorization: authHeader } },
        ),
        env,
        mockCtx,
      );

      expect(response.status).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // PUT /v1/accounts/:id/scopes
  // -----------------------------------------------------------------------

  describe("PUT /v1/accounts/:id/scopes", () => {
    it("returns 401 without auth header", async () => {
      insertAccount(db, ACCOUNT_A);
      const handler = createHandler();
      const env = buildEnv(d1);

      const response = await handler.fetch(
        new Request(`https://api.tminus.dev/v1/accounts/${ACCOUNT_A.account_id}/scopes`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scopes: [{ provider_calendar_id: "primary", enabled: true }] }),
        }),
        env,
        mockCtx,
      );

      expect(response.status).toBe(401);
    });

    it("returns 400 for empty scopes array", async () => {
      insertAccount(db, ACCOUNT_A);
      const handler = createHandler();
      const env = buildEnv(d1);
      const authHeader = await makeAuthHeader();

      const response = await handler.fetch(
        new Request(`https://api.tminus.dev/v1/accounts/${ACCOUNT_A.account_id}/scopes`, {
          method: "PUT",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ scopes: [] }),
        }),
        env,
        mockCtx,
      );

      expect(response.status).toBe(400);
      const body = await response.json() as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("must not be empty");
    });

    it("returns 400 when enabling sync on a readonly calendar", async () => {
      insertAccount(db, ACCOUNT_A);
      const accountDO = createMockAccountDO();
      const handler = createHandler();
      const env = buildEnv(d1, accountDO);
      const authHeader = await makeAuthHeader();

      const response = await handler.fetch(
        new Request(`https://api.tminus.dev/v1/accounts/${ACCOUNT_A.account_id}/scopes`, {
          method: "PUT",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            scopes: [
              { provider_calendar_id: "holidays@calendar.google.com", sync_enabled: true },
            ],
          }),
        }),
        env,
        mockCtx,
      );

      expect(response.status).toBe(400);
      const body = await response.json() as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("write capability");
      expect(body.error).toContain("holidays@calendar.google.com");
    });

    it("returns 404 for non-existent account", async () => {
      const handler = createHandler();
      const env = buildEnv(d1);
      const authHeader = await makeAuthHeader();

      const response = await handler.fetch(
        new Request(`https://api.tminus.dev/v1/accounts/${ACCOUNT_A.account_id}/scopes`, {
          method: "PUT",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            scopes: [{ provider_calendar_id: "primary", enabled: true }],
          }),
        }),
        env,
        mockCtx,
      );

      expect(response.status).toBe(404);
    });

    it("successfully updates scopes and returns updated data with capabilities", async () => {
      insertAccount(db, ACCOUNT_A);
      const accountDO = createMockAccountDO();
      const handler = createHandler();
      const env = buildEnv(d1, accountDO);
      const authHeader = await makeAuthHeader();

      const response = await handler.fetch(
        new Request(`https://api.tminus.dev/v1/accounts/${ACCOUNT_A.account_id}/scopes`, {
          method: "PUT",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            scopes: [
              { provider_calendar_id: "shared-team@group.calendar.google.com", sync_enabled: true },
              { provider_calendar_id: "primary", enabled: true, sync_enabled: true },
            ],
          }),
        }),
        env,
        mockCtx,
      );

      expect(response.status).toBe(200);
      const body = await response.json() as {
        ok: boolean;
        data: {
          account_id: string;
          provider: string;
          scopes: Array<{
            scope_id: string;
            provider_calendar_id: string;
            access_level: string;
            capabilities: string[];
            sync_enabled: boolean;
            recommended: boolean;
          }>;
        };
      };

      expect(body.ok).toBe(true);
      expect(body.data.account_id).toBe(ACCOUNT_A.account_id);
      expect(body.data.scopes).toHaveLength(3);

      // Verify the team calendar was updated
      const team = body.data.scopes.find(
        (s) => s.provider_calendar_id === "shared-team@group.calendar.google.com",
      );
      expect(team).toBeDefined();
      expect(team!.sync_enabled).toBe(true);
      expect(team!.capabilities).toEqual(["read", "write"]);

      // Verify DO calls were made for each scope
      const upsertCalls = accountDO.calls.filter(
        (c) => c.path === "/upsertCalendarScope",
      );
      expect(upsertCalls).toHaveLength(2);
    });

    it("emits an audit event on successful scope change", async () => {
      insertAccount(db, ACCOUNT_A);
      const accountDO = createMockAccountDO();
      const handler = createHandler();
      const env = buildEnv(d1, accountDO);
      const authHeader = await makeAuthHeader();

      await handler.fetch(
        new Request(`https://api.tminus.dev/v1/accounts/${ACCOUNT_A.account_id}/scopes`, {
          method: "PUT",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            scopes: [
              { provider_calendar_id: "primary", sync_enabled: false },
            ],
          }),
        }),
        env,
        mockCtx,
      );

      // Give the async audit write a moment to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify audit record was written to D1
      const auditRows = db
        .prepare(
          "SELECT * FROM scope_change_audit WHERE account_id = ? AND user_id = ?",
        )
        .all(ACCOUNT_A.account_id, TEST_USER.user_id) as Array<{
        audit_id: string;
        user_id: string;
        account_id: string;
        changes: string;
        created_at: string;
      }>;

      expect(auditRows.length).toBeGreaterThanOrEqual(1);
      const audit = auditRows[0];
      expect(audit.user_id).toBe(TEST_USER.user_id);
      expect(audit.account_id).toBe(ACCOUNT_A.account_id);
      const changes = JSON.parse(audit.changes);
      expect(changes).toHaveLength(1);
      expect(changes[0].provider_calendar_id).toBe("primary");
      expect(audit.created_at).toBeTruthy();
    });

    it("returns 400 for missing body", async () => {
      insertAccount(db, ACCOUNT_A);
      const handler = createHandler();
      const env = buildEnv(d1);
      const authHeader = await makeAuthHeader();

      const response = await handler.fetch(
        new Request(`https://api.tminus.dev/v1/accounts/${ACCOUNT_A.account_id}/scopes`, {
          method: "PUT",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json",
          },
        }),
        env,
        mockCtx,
      );

      expect(response.status).toBe(400);
    });

    it("returns 400 for scope with non-string provider_calendar_id", async () => {
      insertAccount(db, ACCOUNT_A);
      const handler = createHandler();
      const env = buildEnv(d1);
      const authHeader = await makeAuthHeader();

      const response = await handler.fetch(
        new Request(`https://api.tminus.dev/v1/accounts/${ACCOUNT_A.account_id}/scopes`, {
          method: "PUT",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            scopes: [{ provider_calendar_id: 123, enabled: true }],
          }),
        }),
        env,
        mockCtx,
      );

      expect(response.status).toBe(400);
      const body = await response.json() as { ok: boolean; error: string };
      expect(body.error).toContain("provider_calendar_id");
    });
  });

  // -----------------------------------------------------------------------
  // GET /v1/accounts/health (TM-qyjm)
  // -----------------------------------------------------------------------

  describe("GET /v1/accounts/health", () => {
    it("returns 401 without auth header", async () => {
      const handler = createHandler();
      const env = buildEnv(d1);

      const response = await handler.fetch(
        new Request("https://api.tminus.dev/v1/accounts/health"),
        env,
        mockCtx,
      );

      expect(response.status).toBe(401);
    });

    it("returns enriched AccountsHealthResponse shape with accounts, count, and tier_limit", async () => {
      insertAccount(db, ACCOUNT_A);
      const accountDO = createMockAccountDO();
      const handler = createHandler();
      const env = buildEnv(d1, accountDO);
      const authHeader = await makeAuthHeader();

      const response = await handler.fetch(
        new Request("https://api.tminus.dev/v1/accounts/health", {
          headers: { Authorization: authHeader },
        }),
        env,
        mockCtx,
      );

      expect(response.status).toBe(200);
      const body = await response.json() as {
        ok: boolean;
        data: {
          accounts: Array<{
            account_id: string;
            email: string;
            provider: string;
            status: string;
            calendar_count: number;
            calendar_names: string[];
            last_successful_sync: string | null;
            is_syncing: boolean;
            error_message: string | null;
            token_expires_at: string | null;
            created_at: string;
          }>;
          account_count: number;
          tier_limit: number;
        };
      };

      expect(body.ok).toBe(true);

      // Verify top-level shape
      expect(body.data).toHaveProperty("accounts");
      expect(body.data).toHaveProperty("account_count");
      expect(body.data).toHaveProperty("tier_limit");

      // Verify account_count matches accounts length
      expect(body.data.account_count).toBe(body.data.accounts.length);
      expect(body.data.accounts).toHaveLength(1);

      // Verify tier_limit is the free tier limit (no subscription inserted)
      expect(body.data.tier_limit).toBe(2);

      // Verify enriched account fields
      const account = body.data.accounts[0];
      expect(account.account_id).toBe(ACCOUNT_A.account_id);
      expect(account.email).toBe(ACCOUNT_A.email);
      expect(account.provider).toBe("google");
      expect(account.status).toBe("active");
      expect(typeof account.calendar_count).toBe("number");
      expect(Array.isArray(account.calendar_names)).toBe(true);
      expect(typeof account.is_syncing).toBe("boolean");
    });

    it("returns empty accounts array when user has no accounts", async () => {
      const handler = createHandler();
      const env = buildEnv(d1);
      const authHeader = await makeAuthHeader();

      const response = await handler.fetch(
        new Request("https://api.tminus.dev/v1/accounts/health", {
          headers: { Authorization: authHeader },
        }),
        env,
        mockCtx,
      );

      expect(response.status).toBe(200);
      const body = await response.json() as {
        ok: boolean;
        data: {
          accounts: unknown[];
          account_count: number;
          tier_limit: number;
        };
      };

      expect(body.ok).toBe(true);
      expect(body.data.accounts).toHaveLength(0);
      expect(body.data.account_count).toBe(0);
      expect(body.data.tier_limit).toBe(2); // free tier default
    });

    it("returns multiple accounts when user has more than one", async () => {
      insertAccount(db, ACCOUNT_A);
      // Insert second account for same user
      insertAccount(db, {
        account_id: "acc_01HXY0000000000000000000BB",
        user_id: TEST_USER.user_id,
        provider: "microsoft",
        provider_subject: "ms-sub-scope-b",
        email: "scopes@outlook.com",
        status: "active",
      });

      const accountDO = createMockAccountDO();
      const handler = createHandler();
      const env = buildEnv(d1, accountDO);
      const authHeader = await makeAuthHeader();

      const response = await handler.fetch(
        new Request("https://api.tminus.dev/v1/accounts/health", {
          headers: { Authorization: authHeader },
        }),
        env,
        mockCtx,
      );

      expect(response.status).toBe(200);
      const body = await response.json() as {
        ok: boolean;
        data: {
          accounts: Array<{ account_id: string; provider: string }>;
          account_count: number;
          tier_limit: number;
        };
      };

      expect(body.ok).toBe(true);
      expect(body.data.accounts).toHaveLength(2);
      expect(body.data.account_count).toBe(2);
    });

    it("tier_limit varies by subscription tier (premium=5)", async () => {
      insertAccount(db, ACCOUNT_A);

      // Insert a premium subscription for the test user
      db.prepare(
        `INSERT INTO subscriptions (subscription_id, user_id, tier, status)
         VALUES (?, ?, ?, ?)`,
      ).run("sub_test_premium", TEST_USER.user_id, "premium", "active");

      const accountDO = createMockAccountDO();
      const handler = createHandler();
      const env = buildEnv(d1, accountDO);
      const authHeader = await makeAuthHeader();

      const response = await handler.fetch(
        new Request("https://api.tminus.dev/v1/accounts/health", {
          headers: { Authorization: authHeader },
        }),
        env,
        mockCtx,
      );

      expect(response.status).toBe(200);
      const body = await response.json() as {
        ok: boolean;
        data: { tier_limit: number };
      };

      expect(body.ok).toBe(true);
      expect(body.data.tier_limit).toBe(5); // premium limit
    });

    it("tier_limit varies by subscription tier (enterprise=10)", async () => {
      insertAccount(db, ACCOUNT_A);

      // Insert an enterprise subscription
      db.prepare(
        `INSERT INTO subscriptions (subscription_id, user_id, tier, status)
         VALUES (?, ?, ?, ?)`,
      ).run("sub_test_enterprise", TEST_USER.user_id, "enterprise", "active");

      const accountDO = createMockAccountDO();
      const handler = createHandler();
      const env = buildEnv(d1, accountDO);
      const authHeader = await makeAuthHeader();

      const response = await handler.fetch(
        new Request("https://api.tminus.dev/v1/accounts/health", {
          headers: { Authorization: authHeader },
        }),
        env,
        mockCtx,
      );

      expect(response.status).toBe(200);
      const body = await response.json() as {
        ok: boolean;
        data: { tier_limit: number };
      };

      expect(body.ok).toBe(true);
      expect(body.data.tier_limit).toBe(10); // enterprise limit
    });

    it("calendar_count and calendar_names derived from sync-enabled scopes", async () => {
      insertAccount(db, ACCOUNT_A);
      // MOCK_SCOPES has 3 scopes: only Main Calendar is both enabled+syncEnabled.
      const accountDO = createMockAccountDO();
      const handler = createHandler();
      const env = buildEnv(d1, accountDO);
      const authHeader = await makeAuthHeader();

      const response = await handler.fetch(
        new Request("https://api.tminus.dev/v1/accounts/health", {
          headers: { Authorization: authHeader },
        }),
        env,
        mockCtx,
      );

      expect(response.status).toBe(200);
      const body = await response.json() as {
        ok: boolean;
        data: {
          accounts: Array<{
            calendar_count: number;
            calendar_names: string[];
          }>;
        };
      };

      expect(body.ok).toBe(true);
      const account = body.data.accounts[0];
      // Only enabled+sync-enabled scopes count.
      expect(account.calendar_count).toBe(1);
      expect(account.calendar_names).toContain("Main Calendar");
      // Team is enabled but sync-disabled; holidays is disabled.
      expect(account.calendar_names).not.toContain("Team Calendar");
      expect(account.calendar_names).not.toContain("Holidays");
    });

    it("excludes revoked accounts from health response", async () => {
      // Insert a revoked account
      insertAccount(db, { ...ACCOUNT_A, status: "revoked" });
      const handler = createHandler();
      const env = buildEnv(d1);
      const authHeader = await makeAuthHeader();

      const response = await handler.fetch(
        new Request("https://api.tminus.dev/v1/accounts/health", {
          headers: { Authorization: authHeader },
        }),
        env,
        mockCtx,
      );

      expect(response.status).toBe(200);
      const body = await response.json() as {
        ok: boolean;
        data: { accounts: unknown[]; account_count: number };
      };

      expect(body.ok).toBe(true);
      expect(body.data.accounts).toHaveLength(0);
      expect(body.data.account_count).toBe(0);
    });

    it("does not include other user's accounts", async () => {
      // Insert accounts for both users
      insertAccount(db, ACCOUNT_A);

      db.prepare("INSERT OR IGNORE INTO orgs (org_id, name) VALUES (?, ?)").run(
        OTHER_USER.org_id,
        "Other Org",
      );
      db.prepare(
        "INSERT OR IGNORE INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
      ).run(OTHER_USER.user_id, OTHER_USER.org_id, OTHER_USER.email);
      insertAccount(db, OTHER_ACCOUNT);

      const accountDO = createMockAccountDO();
      const handler = createHandler();
      const env = buildEnv(d1, accountDO);
      const authHeader = await makeAuthHeader(TEST_USER.user_id);

      const response = await handler.fetch(
        new Request("https://api.tminus.dev/v1/accounts/health", {
          headers: { Authorization: authHeader },
        }),
        env,
        mockCtx,
      );

      expect(response.status).toBe(200);
      const body = await response.json() as {
        ok: boolean;
        data: {
          accounts: Array<{ account_id: string }>;
          account_count: number;
        };
      };

      expect(body.ok).toBe(true);
      expect(body.data.accounts).toHaveLength(1);
      expect(body.data.accounts[0].account_id).toBe(ACCOUNT_A.account_id);
    });

    it("existing GET /v1/accounts endpoint still works unchanged", async () => {
      insertAccount(db, ACCOUNT_A);
      const handler = createHandler();
      const env = buildEnv(d1);
      const authHeader = await makeAuthHeader();

      const response = await handler.fetch(
        new Request("https://api.tminus.dev/v1/accounts", {
          headers: { Authorization: authHeader },
        }),
        env,
        mockCtx,
      );

      expect(response.status).toBe(200);
      const body = await response.json() as {
        ok: boolean;
        data: Array<{ account_id: string; email: string }>;
      };

      expect(body.ok).toBe(true);
      // Original endpoint returns flat array, NOT the health shape
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data[0].account_id).toBe(ACCOUNT_A.account_id);
      // Verify it does NOT have the health shape fields
      expect(body.data).not.toHaveProperty("accounts");
      expect(body.data).not.toHaveProperty("tier_limit");
    });
  });

  // -----------------------------------------------------------------------
  // Persistence round-trip: PUT then GET proves scope changes survive reload
  // -----------------------------------------------------------------------

  describe("Persistence round-trip: scope update reflected on fresh GET", () => {
    it("PUT sync_enabled=true is reflected by a subsequent GET (simulating reload)", async () => {
      insertAccount(db, ACCOUNT_A);
      const accountDO = createMockAccountDO();
      const handler = createHandler();
      const env = buildEnv(d1, accountDO);
      const authHeader = await makeAuthHeader();

      // Step 1: PUT to enable sync on the team calendar
      const putResponse = await handler.fetch(
        new Request(`https://api.tminus.dev/v1/accounts/${ACCOUNT_A.account_id}/scopes`, {
          method: "PUT",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            scopes: [
              {
                provider_calendar_id: "shared-team@group.calendar.google.com",
                sync_enabled: true,
              },
            ],
          }),
        }),
        env,
        mockCtx,
      );

      expect(putResponse.status).toBe(200);
      const putBody = await putResponse.json() as {
        ok: boolean;
        data: { scopes: Array<{ provider_calendar_id: string; sync_enabled: boolean }> };
      };
      expect(putBody.ok).toBe(true);
      const putTeam = putBody.data.scopes.find(
        (s) => s.provider_calendar_id === "shared-team@group.calendar.google.com",
      );
      expect(putTeam).toBeDefined();
      expect(putTeam!.sync_enabled).toBe(true);

      // Step 2: Fresh GET request (simulates page reload -- new request, same handler)
      const getResponse = await handler.fetch(
        new Request(`https://api.tminus.dev/v1/accounts/${ACCOUNT_A.account_id}/scopes`, {
          headers: { Authorization: authHeader },
        }),
        env,
        mockCtx,
      );

      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json() as {
        ok: boolean;
        data: {
          account_id: string;
          provider: string;
          scopes: Array<{ provider_calendar_id: string; sync_enabled: boolean }>;
        };
      };

      expect(getBody.ok).toBe(true);
      expect(getBody.data.account_id).toBe(ACCOUNT_A.account_id);

      // Assert the scope change persisted across requests
      const getTeam = getBody.data.scopes.find(
        (s) => s.provider_calendar_id === "shared-team@group.calendar.google.com",
      );
      expect(getTeam).toBeDefined();
      expect(getTeam!.sync_enabled).toBe(true);
    });
  });
});
