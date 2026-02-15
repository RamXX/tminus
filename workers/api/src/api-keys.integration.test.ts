/**
 * Integration tests for API key CRUD and authentication.
 *
 * Tests the FULL flow with real SQLite (better-sqlite3) backing D1:
 * - Create API key -> receive raw key -> raw key shown only once
 * - Use API key to authenticate -> access protected endpoint -> verify access
 * - List keys -> verify key appears with prefix only (no raw key)
 * - Revoke key -> verify access denied with revoked key
 * - last_used_at is updated on successful auth
 * - API key for one user cannot access another user's resources
 * - Both JWT and API key auth work on the same endpoint
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  MIGRATION_0001_INITIAL_SCHEMA,
  MIGRATION_0003_API_KEYS,
} from "@tminus/d1-registry";
import { createHandler, createJwt } from "./index";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const JWT_SECRET = "integration-test-jwt-secret-32chars-minimum";

const TEST_ORG = {
  org_id: "org_01HXY000000000000000000001",
  name: "API Key Test Org",
} as const;

const TEST_USER = {
  user_id: "usr_01HXY000000000000000000001",
  org_id: TEST_ORG.org_id,
  email: "apikey-test@example.com",
} as const;

const OTHER_ORG = {
  org_id: "org_01HXY000000000000000000099",
  name: "Other Org",
} as const;

const OTHER_USER = {
  user_id: "usr_01HXY000000000000000000099",
  org_id: OTHER_ORG.org_id,
  email: "other-user@example.com",
} as const;

// ---------------------------------------------------------------------------
// Real D1 mock backed by better-sqlite3
// ---------------------------------------------------------------------------

function createRealD1(db: DatabaseType): D1Database {
  const normalizeSQL = (sql: string): string => sql.replace(/\?(\d+)/g, "?");

  return {
    prepare(sql: string) {
      const normalizedSql = normalizeSQL(sql);
      return {
        bind(...params: unknown[]) {
          return {
            first<T>(): Promise<T | null> {
              const stmt = db.prepare(normalizedSql);
              const row = stmt.get(...params) as T | null;
              return Promise.resolve(row ?? null);
            },
            all<T>(): Promise<{ results: T[] }> {
              const stmt = db.prepare(normalizedSql);
              const rows = stmt.all(...params) as T[];
              return Promise.resolve({ results: rows });
            },
            run(): Promise<D1Result<unknown>> {
              const stmt = db.prepare(normalizedSql);
              const info = stmt.run(...params);
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
// Mock DO namespace
// ---------------------------------------------------------------------------

function createMockDONamespace(): DurableObjectNamespace {
  return {
    idFromName(name: string): DurableObjectId {
      return {
        toString: () => name,
        name,
        equals: () => false,
      } as unknown as DurableObjectId;
    },
    get(_id: DurableObjectId): DurableObjectStub {
      return {
        async fetch(): Promise<Response> {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      } as unknown as DurableObjectStub;
    },
    idFromString(_hexId: string): DurableObjectId {
      return { toString: () => _hexId, equals: () => false } as unknown as DurableObjectId;
    },
    newUniqueId(): DurableObjectId {
      return { toString: () => "unique", equals: () => false } as unknown as DurableObjectId;
    },
    jurisdiction(): DurableObjectNamespace {
      return this;
    },
  } as unknown as DurableObjectNamespace;
}

function createMockQueue(): Queue {
  return {
    async send() {},
    async sendBatch() {},
  } as unknown as Queue;
}

// ---------------------------------------------------------------------------
// JWT helper
// ---------------------------------------------------------------------------

async function makeAuthHeader(userId?: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await createJwt(
    { sub: userId ?? TEST_USER.user_id, iat: now, exp: now + 3600 },
    JWT_SECRET,
  );
  return `Bearer ${token}`;
}

// ---------------------------------------------------------------------------
// Env builder
// ---------------------------------------------------------------------------

function buildEnv(d1: D1Database): Env {
  return {
    DB: d1,
    USER_GRAPH: createMockDONamespace(),
    ACCOUNT: createMockDONamespace(),
    SYNC_QUEUE: createMockQueue(),
    WRITE_QUEUE: createMockQueue(),
    JWT_SECRET,
  };
}

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

// ===========================================================================
// Integration test suites
// ===========================================================================

describe("Integration: API Key CRUD", () => {
  let db: DatabaseType;
  let d1: D1Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0003_API_KEYS);

    // Seed org and user
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
  // POST /v1/api-keys (Create)
  // -----------------------------------------------------------------------

  it("POST /v1/api-keys creates a new key and returns raw key exactly once", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/api-keys", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "My CI Key" }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      ok: boolean;
      data: {
        key_id: string;
        name: string;
        prefix: string;
        key: string;
        created_at: string;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.key_id).toMatch(/^key_/);
    expect(body.data.name).toBe("My CI Key");
    expect(body.data.prefix).toHaveLength(8);
    expect(body.data.key).toMatch(/^tmk_live_/);
    expect(body.data.key).toHaveLength(49); // tmk_live_ (9) + prefix (8) + random (32)
    expect(body.data.created_at).toBeTruthy();

    // Verify key was stored in D1
    const storedKey = db
      .prepare("SELECT key_id, user_id, name, prefix, key_hash FROM api_keys WHERE key_id = ?")
      .get(body.data.key_id) as {
      key_id: string;
      user_id: string;
      name: string;
      prefix: string;
      key_hash: string;
    };
    expect(storedKey).not.toBeNull();
    expect(storedKey.user_id).toBe(TEST_USER.user_id);
    expect(storedKey.prefix).toBe(body.data.prefix);
    // The raw key is NOT stored -- only the hash
    expect(storedKey.key_hash).not.toContain("tmk_live_");
    expect(storedKey.key_hash).toHaveLength(64); // SHA-256 hex
  });

  it("POST /v1/api-keys returns 400 without name", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/api-keys", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("name");
  });

  it("POST /v1/api-keys returns 401 without auth", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test" }),
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(401);
  });

  // -----------------------------------------------------------------------
  // GET /v1/api-keys (List)
  // -----------------------------------------------------------------------

  it("GET /v1/api-keys lists keys with prefix only, no raw key", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    // Create two keys
    await handler.fetch(
      new Request("https://api.tminus.dev/v1/api-keys", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Key Alpha" }),
      }),
      env,
      mockCtx,
    );

    await handler.fetch(
      new Request("https://api.tminus.dev/v1/api-keys", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Key Beta" }),
      }),
      env,
      mockCtx,
    );

    // List keys
    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/api-keys", {
        method: "GET",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data: Array<{
        key_id: string;
        name: string;
        prefix: string;
        created_at: string;
        last_used_at: string | null;
        revoked_at: string | null;
      }>;
    };
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(2);

    // Keys should have prefix but NOT the raw key or hash
    for (const key of body.data) {
      expect(key.prefix).toHaveLength(8);
      expect(key).not.toHaveProperty("key");
      expect(key).not.toHaveProperty("key_hash");
    }

    const names = body.data.map((k) => k.name).sort();
    expect(names).toEqual(["Key Alpha", "Key Beta"]);
  });

  // -----------------------------------------------------------------------
  // DELETE /v1/api-keys/:id (Revoke)
  // -----------------------------------------------------------------------

  it("DELETE /v1/api-keys/:id revokes the key", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    // Create a key
    const createRes = await handler.fetch(
      new Request("https://api.tminus.dev/v1/api-keys", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Revocable Key" }),
      }),
      env,
      mockCtx,
    );

    const createBody = (await createRes.json()) as {
      data: { key_id: string };
    };
    const keyId = createBody.data.key_id;

    // Revoke the key
    const revokeRes = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/api-keys/${keyId}`, {
        method: "DELETE",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(revokeRes.status).toBe(200);
    const revokeBody = (await revokeRes.json()) as {
      ok: boolean;
      data: { revoked: boolean };
    };
    expect(revokeBody.ok).toBe(true);
    expect(revokeBody.data.revoked).toBe(true);

    // Verify in D1
    const row = db
      .prepare("SELECT revoked_at FROM api_keys WHERE key_id = ?")
      .get(keyId) as { revoked_at: string | null };
    expect(row.revoked_at).not.toBeNull();
  });

  it("DELETE /v1/api-keys/:id returns 404 for nonexistent key", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    const response = await handler.fetch(
      new Request(
        "https://api.tminus.dev/v1/api-keys/key_01HXYZ00000000000000000099",
        { method: "DELETE", headers: { Authorization: authHeader } },
      ),
      env,
      mockCtx,
    );

    expect(response.status).toBe(404);
  });

  it("DELETE /v1/api-keys/:id returns 409 for already-revoked key", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const authHeader = await makeAuthHeader();

    // Create and revoke a key
    const createRes = await handler.fetch(
      new Request("https://api.tminus.dev/v1/api-keys", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Double Revoke" }),
      }),
      env,
      mockCtx,
    );

    const createBody = (await createRes.json()) as {
      data: { key_id: string };
    };
    const keyId = createBody.data.key_id;

    // First revoke
    await handler.fetch(
      new Request(`https://api.tminus.dev/v1/api-keys/${keyId}`, {
        method: "DELETE",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    // Second revoke
    const response = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/api-keys/${keyId}`, {
        method: "DELETE",
        headers: { Authorization: authHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(409);
  });
});

// ===========================================================================
// Integration: API Key Authentication
// ===========================================================================

describe("Integration: API Key Authentication", () => {
  let db: DatabaseType;
  let d1: D1Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0003_API_KEYS);

    // Seed org and user
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

  it("API key can authenticate to protected endpoints", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const jwtAuthHeader = await makeAuthHeader();

    // Create API key (authenticated via JWT)
    const createRes = await handler.fetch(
      new Request("https://api.tminus.dev/v1/api-keys", {
        method: "POST",
        headers: {
          Authorization: jwtAuthHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Auth Test Key" }),
      }),
      env,
      mockCtx,
    );

    const createBody = (await createRes.json()) as {
      data: { key: string };
    };
    const rawKey = createBody.data.key;

    // Use API key to call a protected endpoint (list accounts)
    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/accounts", {
        method: "GET",
        headers: { Authorization: `Bearer ${rawKey}` },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("Revoked API key is immediately rejected", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const jwtAuthHeader = await makeAuthHeader();

    // Create and then revoke an API key
    const createRes = await handler.fetch(
      new Request("https://api.tminus.dev/v1/api-keys", {
        method: "POST",
        headers: {
          Authorization: jwtAuthHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Revoke Test Key" }),
      }),
      env,
      mockCtx,
    );

    const createBody = (await createRes.json()) as {
      data: { key_id: string; key: string };
    };
    const { key_id, key: rawKey } = createBody.data;

    // Verify the key works before revocation
    const preRevokeRes = await handler.fetch(
      new Request("https://api.tminus.dev/v1/accounts", {
        method: "GET",
        headers: { Authorization: `Bearer ${rawKey}` },
      }),
      env,
      mockCtx,
    );
    expect(preRevokeRes.status).toBe(200);

    // Revoke
    await handler.fetch(
      new Request(`https://api.tminus.dev/v1/api-keys/${key_id}`, {
        method: "DELETE",
        headers: { Authorization: jwtAuthHeader },
      }),
      env,
      mockCtx,
    );

    // After revocation, the key should be rejected
    const postRevokeRes = await handler.fetch(
      new Request("https://api.tminus.dev/v1/accounts", {
        method: "GET",
        headers: { Authorization: `Bearer ${rawKey}` },
      }),
      env,
      mockCtx,
    );
    expect(postRevokeRes.status).toBe(401);
  });

  it("last_used_at is updated on successful API key auth", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const jwtAuthHeader = await makeAuthHeader();

    // Create API key
    const createRes = await handler.fetch(
      new Request("https://api.tminus.dev/v1/api-keys", {
        method: "POST",
        headers: {
          Authorization: jwtAuthHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Usage Track Key" }),
      }),
      env,
      mockCtx,
    );

    const createBody = (await createRes.json()) as {
      data: { key_id: string; key: string };
    };
    const { key_id, key: rawKey } = createBody.data;

    // Verify last_used_at is initially null
    const before = db
      .prepare("SELECT last_used_at FROM api_keys WHERE key_id = ?")
      .get(key_id) as { last_used_at: string | null };
    expect(before.last_used_at).toBeNull();

    // Use the key to authenticate
    await handler.fetch(
      new Request("https://api.tminus.dev/v1/accounts", {
        method: "GET",
        headers: { Authorization: `Bearer ${rawKey}` },
      }),
      env,
      mockCtx,
    );

    // Verify last_used_at was updated
    const after = db
      .prepare("SELECT last_used_at FROM api_keys WHERE key_id = ?")
      .get(key_id) as { last_used_at: string | null };
    expect(after.last_used_at).not.toBeNull();
  });

  it("JWT auth still works alongside API key auth", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);
    const jwtAuthHeader = await makeAuthHeader();

    // JWT auth should still work
    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/accounts", {
        method: "GET",
        headers: { Authorization: jwtAuthHeader },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("Invalid API key format returns 401", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);

    const response = await handler.fetch(
      new Request("https://api.tminus.dev/v1/accounts", {
        method: "GET",
        headers: { Authorization: "Bearer tmk_bad_format" },
      }),
      env,
      mockCtx,
    );

    expect(response.status).toBe(401);
  });

  it("API key cannot access other user's keys", async () => {
    const handler = createHandler();
    const env = buildEnv(d1);

    // Seed other user
    db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
      OTHER_ORG.org_id,
      OTHER_ORG.name,
    );
    db.prepare(
      "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
    ).run(OTHER_USER.user_id, OTHER_USER.org_id, OTHER_USER.email);

    // Create key for TEST_USER
    const jwtAuthHeader = await makeAuthHeader(TEST_USER.user_id);
    const createRes = await handler.fetch(
      new Request("https://api.tminus.dev/v1/api-keys", {
        method: "POST",
        headers: {
          Authorization: jwtAuthHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "User A Key" }),
      }),
      env,
      mockCtx,
    );

    const createBody = (await createRes.json()) as {
      data: { key_id: string };
    };
    const keyId = createBody.data.key_id;

    // OTHER_USER should not be able to revoke TEST_USER's key
    const otherAuthHeader = await makeAuthHeader(OTHER_USER.user_id);
    const revokeRes = await handler.fetch(
      new Request(`https://api.tminus.dev/v1/api-keys/${keyId}`, {
        method: "DELETE",
        headers: { Authorization: otherAuthHeader },
      }),
      env,
      mockCtx,
    );

    expect(revokeRes.status).toBe(404); // Not found because it's not theirs

    // OTHER_USER listing should not show TEST_USER's keys
    const listRes = await handler.fetch(
      new Request("https://api.tminus.dev/v1/api-keys", {
        method: "GET",
        headers: { Authorization: otherAuthHeader },
      }),
      env,
      mockCtx,
    );

    const listBody = (await listRes.json()) as {
      ok: boolean;
      data: unknown[];
    };
    expect(listBody.data).toHaveLength(0);
  });
});
