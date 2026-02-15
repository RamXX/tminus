/**
 * Integration tests for tminus-mcp worker.
 *
 * These tests use better-sqlite3 for real D1 database operations.
 * Proves the full request flow: auth -> JSON-RPC parse -> tool dispatch ->
 * D1 query -> JSON-RPC response with real data.
 *
 * Tests both success paths (authenticated user with real account data)
 * and failure paths (unauth, empty results).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { MIGRATION_0001_INITIAL_SCHEMA } from "@tminus/d1-registry";
import { generateJWT } from "@tminus/shared";
import { createMcpHandler } from "./index";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const JWT_SECRET = "integration-test-mcp-jwt-secret-32chars-minimum";

const TEST_ORG = {
  org_id: "org_01HXY000000000000000000001",
  name: "MCP Integration Test Org",
} as const;

const TEST_USER = {
  user_id: "usr_01HXY000000000000000000001",
  org_id: TEST_ORG.org_id,
  email: "mcp-test@example.com",
} as const;

const ACCOUNT_A = {
  account_id: "acc_01HXY0000000000000000000AA",
  user_id: TEST_USER.user_id,
  provider: "google",
  provider_subject: "google-sub-aaaa",
  email: "alice@gmail.com",
  status: "active",
} as const;

const ACCOUNT_B = {
  account_id: "acc_01HXY0000000000000000000BB",
  user_id: TEST_USER.user_id,
  provider: "microsoft",
  provider_subject: "ms-sub-bbbb",
  email: "bob@outlook.com",
  status: "active",
} as const;

/** A different user's account -- must NOT appear in our results. */
const OTHER_USER_ACCOUNT = {
  account_id: "acc_01HXY0000000000000000000CC",
  user_id: "usr_01HXY0000000000000000000ZZ",
  provider: "google",
  provider_subject: "google-sub-cccc",
  email: "other@gmail.com",
  status: "active",
} as const;

const OTHER_USER = {
  user_id: OTHER_USER_ACCOUNT.user_id,
  org_id: TEST_ORG.org_id,
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
              });
            },
          };
        },
        first<T>(): Promise<T | null> {
          const stmt = db.prepare(normalizedSql);
          const row = stmt.get() as T | null;
          return Promise.resolve(row ?? null);
        },
        all<T>(): Promise<{ results: T[] }> {
          const stmt = db.prepare(normalizedSql);
          const rows = stmt.all() as T[];
          return Promise.resolve({ results: rows });
        },
        run(): Promise<D1Result<unknown>> {
          const stmt = db.prepare(normalizedSql);
          const info = stmt.run();
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
          });
        },
      };
    },
    dump: vi.fn(),
    batch: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// Test setup/teardown
// ---------------------------------------------------------------------------

let db: DatabaseType;
let d1: D1Database;
const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");

  // Apply D1 schema
  const statements = MIGRATION_0001_INITIAL_SCHEMA.split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    db.exec(stmt);
  }

  // Seed test data
  db.prepare("INSERT INTO orgs (org_id, name) VALUES (?, ?)").run(
    TEST_ORG.org_id,
    TEST_ORG.name,
  );

  db.prepare(
    "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
  ).run(TEST_USER.user_id, TEST_USER.org_id, TEST_USER.email);

  db.prepare(
    "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
  ).run(OTHER_USER.user_id, OTHER_USER.org_id, OTHER_USER.email);

  db.prepare(
    "INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    ACCOUNT_A.account_id,
    ACCOUNT_A.user_id,
    ACCOUNT_A.provider,
    ACCOUNT_A.provider_subject,
    ACCOUNT_A.email,
    ACCOUNT_A.status,
  );

  db.prepare(
    "INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    ACCOUNT_B.account_id,
    ACCOUNT_B.user_id,
    ACCOUNT_B.provider,
    ACCOUNT_B.provider_subject,
    ACCOUNT_B.email,
    ACCOUNT_B.status,
  );

  db.prepare(
    "INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    OTHER_USER_ACCOUNT.account_id,
    OTHER_USER_ACCOUNT.user_id,
    OTHER_USER_ACCOUNT.provider,
    OTHER_USER_ACCOUNT.provider_subject,
    OTHER_USER_ACCOUNT.email,
    OTHER_USER_ACCOUNT.status,
  );

  d1 = createRealD1(db);
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// JWT helper
// ---------------------------------------------------------------------------

async function makeAuthHeader(userId?: string): Promise<string> {
  const token = await generateJWT(
    {
      sub: userId ?? TEST_USER.user_id,
      email: TEST_USER.email,
      tier: "free",
      pwd_ver: 1,
    },
    JWT_SECRET,
    3600,
  );
  return `Bearer ${token}`;
}

function createEnv() {
  return {
    JWT_SECRET,
    DB: d1,
    ENVIRONMENT: "development",
  };
}

// ---------------------------------------------------------------------------
// Helper: send a JSON-RPC request
// ---------------------------------------------------------------------------

async function sendMcpRequest(
  body: unknown,
  authHeader?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const handler = createMcpHandler();
  const env = createEnv();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (authHeader) {
    headers["Authorization"] = authHeader;
  }

  const request = new Request("https://mcp.tminus.ink/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const response = await handler.fetch(request, env, mockCtx);
  const responseBody = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body: responseBody };
}

// ---------------------------------------------------------------------------
// Integration: full MCP flow -- tools/list
// ---------------------------------------------------------------------------

describe("MCP integration: tools/list", () => {
  it("authenticated request returns tool registry with schemas", async () => {
    const authHeader = await makeAuthHeader();
    const result = await sendMcpRequest(
      { jsonrpc: "2.0", method: "tools/list", id: 1 },
      authHeader,
    );

    expect(result.status).toBe(200);
    expect(result.body.jsonrpc).toBe("2.0");
    expect(result.body.id).toBe(1);
    expect(result.body.error).toBeUndefined();

    const resultData = result.body.result as { tools: Array<Record<string, unknown>> };
    expect(resultData.tools.length).toBe(1);
    expect(resultData.tools[0].name).toBe("calendar.list_accounts");
    expect(resultData.tools[0].description).toBeTruthy();
    expect(resultData.tools[0].inputSchema).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Integration: full MCP flow -- tools/call calendar.list_accounts SUCCESS
// ---------------------------------------------------------------------------

describe("MCP integration: tools/call calendar.list_accounts", () => {
  it("returns accounts for authenticated user from real D1", async () => {
    const authHeader = await makeAuthHeader();
    const result = await sendMcpRequest(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "calendar.list_accounts" },
        id: 2,
      },
      authHeader,
    );

    expect(result.status).toBe(200);
    expect(result.body.jsonrpc).toBe("2.0");
    expect(result.body.id).toBe(2);
    expect(result.body.error).toBeUndefined();

    // MCP tool results use content array format
    const resultData = result.body.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(resultData.content).toBeInstanceOf(Array);
    expect(resultData.content.length).toBe(1);
    expect(resultData.content[0].type).toBe("text");

    // Parse the text content -- it should be JSON array of accounts
    const accounts = JSON.parse(resultData.content[0].text) as Array<{
      account_id: string;
      provider: string;
      email: string;
      status: string;
    }>;

    expect(accounts.length).toBe(2);

    // Verify ACCOUNT_A is present
    const accountA = accounts.find((a) => a.account_id === ACCOUNT_A.account_id);
    expect(accountA).toBeDefined();
    expect(accountA?.provider).toBe("google");
    expect(accountA?.email).toBe("alice@gmail.com");
    expect(accountA?.status).toBe("active");

    // Verify ACCOUNT_B is present
    const accountB = accounts.find((a) => a.account_id === ACCOUNT_B.account_id);
    expect(accountB).toBeDefined();
    expect(accountB?.provider).toBe("microsoft");
    expect(accountB?.email).toBe("bob@outlook.com");

    // Verify OTHER user's account is NOT present (user isolation)
    const otherAccount = accounts.find(
      (a) => a.account_id === OTHER_USER_ACCOUNT.account_id,
    );
    expect(otherAccount).toBeUndefined();
  });

  it("returns empty array for user with no accounts", async () => {
    // Create a user with no accounts
    const noAccountsUserId = "usr_01HXY000000000000000EMPTY";
    db.prepare(
      "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
    ).run(noAccountsUserId, TEST_ORG.org_id, "empty@example.com");

    const authHeader = await makeAuthHeader(noAccountsUserId);
    const result = await sendMcpRequest(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "calendar.list_accounts" },
        id: 3,
      },
      authHeader,
    );

    expect(result.status).toBe(200);
    expect(result.body.error).toBeUndefined();

    const resultData = result.body.result as {
      content: Array<{ type: string; text: string }>;
    };
    const accounts = JSON.parse(resultData.content[0].text) as unknown[];
    expect(accounts).toEqual([]);
  });

  it("returns DIFFERENT data for different users (user isolation)", async () => {
    // Authenticate as the other user
    const otherAuth = await makeAuthHeader(OTHER_USER.user_id);
    const result = await sendMcpRequest(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "calendar.list_accounts" },
        id: 4,
      },
      otherAuth,
    );

    expect(result.status).toBe(200);
    const resultData = result.body.result as {
      content: Array<{ type: string; text: string }>;
    };
    const accounts = JSON.parse(resultData.content[0].text) as Array<{
      account_id: string;
    }>;

    // Other user should only see their own account
    expect(accounts.length).toBe(1);
    expect(accounts[0].account_id).toBe(OTHER_USER_ACCOUNT.account_id);

    // And NOT see test user's accounts
    const testUserAccount = accounts.find(
      (a) => a.account_id === ACCOUNT_A.account_id,
    );
    expect(testUserAccount).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration: unauthenticated requests
// ---------------------------------------------------------------------------

describe("MCP integration: unauthenticated requests", () => {
  it("returns JSON-RPC auth error (401) for unauthenticated tools/call", async () => {
    const result = await sendMcpRequest({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "calendar.list_accounts" },
      id: 5,
    });

    expect(result.status).toBe(401);
    const error = result.body.error as Record<string, unknown>;
    expect(error.code).toBe(-32000);
    expect(error.message).toContain("Authentication required");
  });

  it("returns JSON-RPC auth error for tools/list without auth", async () => {
    const result = await sendMcpRequest({
      jsonrpc: "2.0",
      method: "tools/list",
      id: 6,
    });

    expect(result.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Integration: health endpoint with real env
// ---------------------------------------------------------------------------

describe("MCP integration: health endpoint", () => {
  it("returns 200 healthy with real D1 env", async () => {
    const handler = createMcpHandler();
    const env = createEnv();
    const request = new Request("https://mcp.tminus.ink/health", {
      method: "GET",
    });
    const response = await handler.fetch(request, env, mockCtx);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.status).toBe("healthy");
  });
});

// ---------------------------------------------------------------------------
// Integration: error handling for invalid tool calls
// ---------------------------------------------------------------------------

describe("MCP integration: error paths", () => {
  it("returns error for unknown tool via full flow", async () => {
    const authHeader = await makeAuthHeader();
    const result = await sendMcpRequest(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "nonexistent.tool" },
        id: 7,
      },
      authHeader,
    );

    expect(result.status).toBe(200);
    const error = result.body.error as Record<string, unknown>;
    expect(error.code).toBe(-32601);
    expect(error.message).toContain("nonexistent.tool");
  });

  it("handles malformed JSON via full flow", async () => {
    const handler = createMcpHandler();
    const env = createEnv();
    const authHeader = await makeAuthHeader();

    const request = new Request("https://mcp.tminus.ink/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: "this is not json",
    });

    const response = await handler.fetch(request, env, mockCtx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    const error = body.error as Record<string, unknown>;
    expect(error.code).toBe(-32700);
  });
});
