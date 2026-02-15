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
import { ALL_MIGRATIONS } from "@tminus/d1-registry";
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

  // Apply ALL D1 migrations (includes sync status columns from migration 0008)
  for (const migration of ALL_MIGRATIONS) {
    const statements = migration.split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      db.exec(stmt);
    }
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

  // Account A: google, active, with channel and recent sync
  const recentSync = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago
  const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h from now
  db.prepare(
    `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status,
     channel_id, channel_expiry_ts, last_sync_ts, error_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ACCOUNT_A.account_id,
    ACCOUNT_A.user_id,
    ACCOUNT_A.provider,
    ACCOUNT_A.provider_subject,
    ACCOUNT_A.email,
    ACCOUNT_A.status,
    "ch_test_aaa",
    futureExpiry,
    recentSync,
    0,
  );

  // Account B: microsoft, active, no channel, never synced
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
      tier: "premium",
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
  it("authenticated request returns tool registry including list_accounts and get_sync_status", async () => {
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
    expect(resultData.tools.length).toBeGreaterThanOrEqual(2);

    const toolNames = resultData.tools.map((t) => t.name);
    expect(toolNames).toContain("calendar.list_accounts");
    expect(toolNames).toContain("calendar.get_sync_status");

    // Verify get_sync_status has account_id in schema
    const syncTool = resultData.tools.find((t) => t.name === "calendar.get_sync_status");
    expect(syncTool).toBeDefined();
    const schema = syncTool?.inputSchema as { properties: Record<string, unknown> };
    expect(schema.properties).toHaveProperty("account_id");
  });
});

// ---------------------------------------------------------------------------
// Integration: full MCP flow -- tools/call calendar.list_accounts SUCCESS
// ---------------------------------------------------------------------------

describe("MCP integration: tools/call calendar.list_accounts", () => {
  it("returns accounts with channel_status for authenticated user from real D1", async () => {
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
      channel_status: string;
    }>;

    expect(accounts.length).toBe(2);

    // Verify ACCOUNT_A is present with channel_status
    const accountA = accounts.find((a) => a.account_id === ACCOUNT_A.account_id);
    expect(accountA).toBeDefined();
    expect(accountA?.provider).toBe("google");
    expect(accountA?.email).toBe("alice@gmail.com");
    expect(accountA?.status).toBe("active");
    expect(accountA?.channel_status).toBe("active"); // has channel with future expiry

    // Verify ACCOUNT_B has channel_status "none" (no channel)
    const accountB = accounts.find((a) => a.account_id === ACCOUNT_B.account_id);
    expect(accountB).toBeDefined();
    expect(accountB?.provider).toBe("microsoft");
    expect(accountB?.email).toBe("bob@outlook.com");
    expect(accountB?.channel_status).toBe("none"); // no channel_id

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

// ---------------------------------------------------------------------------
// Integration: full MCP flow -- tools/call calendar.get_sync_status
// ---------------------------------------------------------------------------

describe("MCP integration: tools/call calendar.get_sync_status", () => {
  it("returns sync health for all accounts (no filter)", async () => {
    const authHeader = await makeAuthHeader();
    const result = await sendMcpRequest(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "calendar.get_sync_status" },
        id: 10,
      },
      authHeader,
    );

    expect(result.status).toBe(200);
    expect(result.body.error).toBeUndefined();

    const resultData = result.body.result as {
      content: Array<{ type: string; text: string }>;
    };
    const syncStatus = JSON.parse(resultData.content[0].text) as {
      overall: string;
      accounts: Array<{
        account_id: string;
        provider: string;
        email: string;
        health: string;
        last_sync_ts: string | null;
        channel_status: string;
        error_count: number;
      }>;
    };

    // Should have 2 accounts (ACCOUNT_A and ACCOUNT_B)
    expect(syncStatus.accounts.length).toBe(2);
    expect(syncStatus.overall).toBeDefined();

    // ACCOUNT_A: synced 30 min ago -> healthy
    const accountA = syncStatus.accounts.find(
      (a) => a.account_id === ACCOUNT_A.account_id,
    );
    expect(accountA).toBeDefined();
    expect(accountA?.health).toBe("healthy");
    expect(accountA?.last_sync_ts).toBeTruthy(); // has a sync timestamp
    expect(accountA?.channel_status).toBe("active");
    expect(accountA?.error_count).toBe(0);

    // ACCOUNT_B: never synced -> unhealthy
    const accountB = syncStatus.accounts.find(
      (a) => a.account_id === ACCOUNT_B.account_id,
    );
    expect(accountB).toBeDefined();
    expect(accountB?.health).toBe("unhealthy");
    expect(accountB?.last_sync_ts).toBeNull();
    expect(accountB?.channel_status).toBe("none");

    // Overall should be "unhealthy" (worst of healthy + unhealthy)
    expect(syncStatus.overall).toBe("unhealthy");
  });

  it("filters by account_id when provided via arguments", async () => {
    const authHeader = await makeAuthHeader();
    const result = await sendMcpRequest(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.get_sync_status",
          arguments: { account_id: ACCOUNT_A.account_id },
        },
        id: 11,
      },
      authHeader,
    );

    expect(result.status).toBe(200);
    expect(result.body.error).toBeUndefined();

    const resultData = result.body.result as {
      content: Array<{ type: string; text: string }>;
    };
    const syncStatus = JSON.parse(resultData.content[0].text) as {
      overall: string;
      accounts: Array<{ account_id: string; health: string }>;
    };

    // Should only have 1 account (the filtered one)
    expect(syncStatus.accounts.length).toBe(1);
    expect(syncStatus.accounts[0].account_id).toBe(ACCOUNT_A.account_id);
    expect(syncStatus.accounts[0].health).toBe("healthy");
    expect(syncStatus.overall).toBe("healthy");
  });

  it("returns error for non-existent account_id", async () => {
    const authHeader = await makeAuthHeader();
    const result = await sendMcpRequest(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.get_sync_status",
          arguments: { account_id: "acc_nonexistent" },
        },
        id: 12,
      },
      authHeader,
    );

    expect(result.status).toBe(200);
    const error = result.body.error as Record<string, unknown>;
    expect(error.code).toBe(-32602); // Invalid params
    expect(error.message).toContain("Account not found");
    expect(error.message).toContain("acc_nonexistent");
  });

  it("returns error when account_id belongs to another user", async () => {
    // Try to access the OTHER user's account as TEST_USER
    const authHeader = await makeAuthHeader();
    const result = await sendMcpRequest(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.get_sync_status",
          arguments: { account_id: OTHER_USER_ACCOUNT.account_id },
        },
        id: 13,
      },
      authHeader,
    );

    // Should fail because the account doesn't belong to this user
    expect(result.status).toBe(200);
    const error = result.body.error as Record<string, unknown>;
    expect(error.code).toBe(-32602);
    expect(error.message).toContain("Account not found");
  });

  it("correctly reports degraded health for account synced 3 hours ago", async () => {
    // Update ACCOUNT_A to have synced 3 hours ago
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    db.prepare(
      "UPDATE accounts SET last_sync_ts = ? WHERE account_id = ?",
    ).run(threeHoursAgo, ACCOUNT_A.account_id);

    const authHeader = await makeAuthHeader();
    const result = await sendMcpRequest(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.get_sync_status",
          arguments: { account_id: ACCOUNT_A.account_id },
        },
        id: 14,
      },
      authHeader,
    );

    expect(result.body.error).toBeUndefined();
    const resultData = result.body.result as {
      content: Array<{ type: string; text: string }>;
    };
    const syncStatus = JSON.parse(resultData.content[0].text) as {
      overall: string;
      accounts: Array<{ health: string }>;
    };

    expect(syncStatus.accounts[0].health).toBe("degraded");
    expect(syncStatus.overall).toBe("degraded");
  });

  it("correctly reports stale health for account synced 12 hours ago", async () => {
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    db.prepare(
      "UPDATE accounts SET last_sync_ts = ? WHERE account_id = ?",
    ).run(twelveHoursAgo, ACCOUNT_A.account_id);

    const authHeader = await makeAuthHeader();
    const result = await sendMcpRequest(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.get_sync_status",
          arguments: { account_id: ACCOUNT_A.account_id },
        },
        id: 15,
      },
      authHeader,
    );

    const resultData = result.body.result as {
      content: Array<{ type: string; text: string }>;
    };
    const syncStatus = JSON.parse(resultData.content[0].text) as {
      accounts: Array<{ health: string }>;
    };
    expect(syncStatus.accounts[0].health).toBe("stale");
  });

  it("correctly reports error health for account with error status", async () => {
    db.prepare(
      "UPDATE accounts SET status = 'error', last_sync_ts = ? WHERE account_id = ?",
    ).run(new Date().toISOString(), ACCOUNT_A.account_id);

    const authHeader = await makeAuthHeader();
    const result = await sendMcpRequest(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.get_sync_status",
          arguments: { account_id: ACCOUNT_A.account_id },
        },
        id: 16,
      },
      authHeader,
    );

    const resultData = result.body.result as {
      content: Array<{ type: string; text: string }>;
    };
    const syncStatus = JSON.parse(resultData.content[0].text) as {
      overall: string;
      accounts: Array<{ health: string }>;
    };
    // Error status takes priority over recent sync time
    expect(syncStatus.accounts[0].health).toBe("error");
    expect(syncStatus.overall).toBe("error");
  });

  it("returns empty accounts for user with no accounts", async () => {
    const noAccountsUserId = "usr_01HXY000000000000000EMPTY";
    db.prepare(
      "INSERT INTO users (user_id, org_id, email) VALUES (?, ?, ?)",
    ).run(noAccountsUserId, TEST_ORG.org_id, "noaccounts@example.com");

    const authHeader = await makeAuthHeader(noAccountsUserId);
    const result = await sendMcpRequest(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "calendar.get_sync_status" },
        id: 17,
      },
      authHeader,
    );

    expect(result.body.error).toBeUndefined();
    const resultData = result.body.result as {
      content: Array<{ type: string; text: string }>;
    };
    const syncStatus = JSON.parse(resultData.content[0].text) as {
      overall: string;
      accounts: unknown[];
    };
    expect(syncStatus.accounts).toEqual([]);
    expect(syncStatus.overall).toBe("healthy"); // no accounts = healthy by default
  });

  it("includes error_count in response", async () => {
    db.prepare(
      "UPDATE accounts SET error_count = 5 WHERE account_id = ?",
    ).run(ACCOUNT_A.account_id);

    const authHeader = await makeAuthHeader();
    const result = await sendMcpRequest(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.get_sync_status",
          arguments: { account_id: ACCOUNT_A.account_id },
        },
        id: 18,
      },
      authHeader,
    );

    const resultData = result.body.result as {
      content: Array<{ type: string; text: string }>;
    };
    const syncStatus = JSON.parse(resultData.content[0].text) as {
      accounts: Array<{ error_count: number }>;
    };
    expect(syncStatus.accounts[0].error_count).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Integration: channel_status in sync status
// ---------------------------------------------------------------------------

describe("MCP integration: channel_status in get_sync_status", () => {
  it("reports expired channel when channel_expiry_ts is in the past", async () => {
    const pastExpiry = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    db.prepare(
      "UPDATE accounts SET channel_id = 'ch_expired', channel_expiry_ts = ? WHERE account_id = ?",
    ).run(pastExpiry, ACCOUNT_B.account_id);

    const authHeader = await makeAuthHeader();
    const result = await sendMcpRequest(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.get_sync_status",
          arguments: { account_id: ACCOUNT_B.account_id },
        },
        id: 19,
      },
      authHeader,
    );

    const resultData = result.body.result as {
      content: Array<{ type: string; text: string }>;
    };
    const syncStatus = JSON.parse(resultData.content[0].text) as {
      accounts: Array<{ channel_status: string }>;
    };
    expect(syncStatus.accounts[0].channel_status).toBe("expired");
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

// ---------------------------------------------------------------------------
// Integration: Event CRUD lifecycle
// ---------------------------------------------------------------------------

/**
 * Helper to call an MCP tool and parse the result content.
 * Returns the parsed JSON from the content[0].text field.
 */
async function callTool(
  toolName: string,
  toolArgs?: Record<string, unknown>,
  authHeader?: string,
): Promise<{
  status: number;
  error?: { code: number; message: string };
  data?: unknown;
}> {
  const auth = authHeader ?? (await makeAuthHeader());
  const result = await sendMcpRequest(
    {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: toolName, arguments: toolArgs },
      id: Math.floor(Math.random() * 100000),
    },
    auth,
  );

  if (result.body.error) {
    const err = result.body.error as { code: number; message: string };
    return { status: result.status, error: err };
  }

  const resultData = result.body.result as {
    content: Array<{ type: string; text: string }>;
  };
  const data = JSON.parse(resultData.content[0].text);
  return { status: result.status, data };
}

describe("MCP integration: tools/list includes event management tools", () => {
  it("returns tools including event management and availability tools", async () => {
    const authHeader = await makeAuthHeader();
    const result = await sendMcpRequest(
      { jsonrpc: "2.0", method: "tools/list", id: 100 },
      authHeader,
    );

    const resultData = result.body.result as { tools: Array<Record<string, unknown>> };
    const toolNames = resultData.tools.map((t) => t.name);

    expect(toolNames).toContain("calendar.list_events");
    expect(toolNames).toContain("calendar.create_event");
    expect(toolNames).toContain("calendar.update_event");
    expect(toolNames).toContain("calendar.delete_event");
    expect(toolNames).toContain("calendar.get_availability");
    // At least 7 tools: list_accounts, get_sync_status, list_events, create_event,
    // update_event, delete_event, get_availability
    expect(resultData.tools.length).toBeGreaterThanOrEqual(7);
  });
});

describe("MCP integration: calendar.create_event", () => {
  it("creates an event and returns it with event_id", async () => {
    const result = await callTool("calendar.create_event", {
      title: "Team Standup",
      start_ts: "2026-03-15T09:00:00Z",
      end_ts: "2026-03-15T09:30:00Z",
      timezone: "America/Chicago",
      description: "Daily standup meeting",
      location: "Room 101",
    });

    expect(result.error).toBeUndefined();
    const event = result.data as Record<string, unknown>;
    expect(event.event_id).toBeDefined();
    expect(typeof event.event_id).toBe("string");
    expect((event.event_id as string).startsWith("evt_")).toBe(true);
    expect(event.title).toBe("Team Standup");
    expect(event.start_ts).toBe("2026-03-15T09:00:00Z");
    expect(event.end_ts).toBe("2026-03-15T09:30:00Z");
    expect(event.timezone).toBe("America/Chicago");
    expect(event.description).toBe("Daily standup meeting");
    expect(event.location).toBe("Room 101");
    expect(event.source).toBe("mcp");
    expect(event.created_at).toBeDefined();
    expect(event.updated_at).toBeDefined();
  });

  it("creates an event with minimal fields (defaults for optional)", async () => {
    const result = await callTool("calendar.create_event", {
      title: "Quick Sync",
      start_ts: "2026-03-15T14:00:00Z",
      end_ts: "2026-03-15T14:15:00Z",
    });

    expect(result.error).toBeUndefined();
    const event = result.data as Record<string, unknown>;
    expect(event.event_id).toBeDefined();
    expect(event.title).toBe("Quick Sync");
    expect(event.timezone).toBe("UTC");
    expect(event.description).toBeNull();
    expect(event.location).toBeNull();
  });

  it("rejects creation with missing required fields", async () => {
    const result = await callTool("calendar.create_event", {
      start_ts: "2026-03-15T09:00:00Z",
      end_ts: "2026-03-15T09:30:00Z",
    });

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(result.error!.message).toContain("title");
  });

  it("rejects creation with invalid datetime", async () => {
    const result = await callTool("calendar.create_event", {
      title: "Bad Event",
      start_ts: "not-a-date",
      end_ts: "2026-03-15T09:30:00Z",
    });

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(result.error!.message).toContain("start_ts");
  });

  it("rejects creation when start >= end", async () => {
    const result = await callTool("calendar.create_event", {
      title: "Backwards Event",
      start_ts: "2026-03-15T10:00:00Z",
      end_ts: "2026-03-15T09:00:00Z",
    });

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(result.error!.message).toContain("before");
  });
});

describe("MCP integration: calendar.list_events", () => {
  it("returns empty array when no events exist in time range", async () => {
    const result = await callTool("calendar.list_events", {
      start: "2026-01-01T00:00:00Z",
      end: "2026-12-31T23:59:59Z",
    });

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual([]);
  });

  it("returns events within the time range after creation", async () => {
    // Create two events
    await callTool("calendar.create_event", {
      title: "Event A",
      start_ts: "2026-03-15T09:00:00Z",
      end_ts: "2026-03-15T10:00:00Z",
    });
    await callTool("calendar.create_event", {
      title: "Event B",
      start_ts: "2026-03-16T09:00:00Z",
      end_ts: "2026-03-16T10:00:00Z",
    });

    const result = await callTool("calendar.list_events", {
      start: "2026-03-01T00:00:00Z",
      end: "2026-03-31T23:59:59Z",
    });

    expect(result.error).toBeUndefined();
    const events = result.data as Array<Record<string, unknown>>;
    expect(events.length).toBe(2);
    expect(events[0].title).toBe("Event A"); // sorted by start_ts
    expect(events[1].title).toBe("Event B");
  });

  it("filters events outside the time range", async () => {
    // Create an event in March
    await callTool("calendar.create_event", {
      title: "March Event",
      start_ts: "2026-03-15T09:00:00Z",
      end_ts: "2026-03-15T10:00:00Z",
    });

    // Query for April -- should not find March event
    const result = await callTool("calendar.list_events", {
      start: "2026-04-01T00:00:00Z",
      end: "2026-04-30T23:59:59Z",
    });

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual([]);
  });

  it("respects the limit parameter", async () => {
    // Create 3 events
    for (let i = 1; i <= 3; i++) {
      await callTool("calendar.create_event", {
        title: `Event ${i}`,
        start_ts: `2026-03-${String(i).padStart(2, "0")}T09:00:00Z`,
        end_ts: `2026-03-${String(i).padStart(2, "0")}T10:00:00Z`,
      });
    }

    const result = await callTool("calendar.list_events", {
      start: "2026-03-01T00:00:00Z",
      end: "2026-03-31T23:59:59Z",
      limit: 2,
    });

    expect(result.error).toBeUndefined();
    const events = result.data as Array<Record<string, unknown>>;
    expect(events.length).toBe(2);
  });

  it("rejects list_events with missing start parameter", async () => {
    const result = await callTool("calendar.list_events", {
      end: "2026-12-31T23:59:59Z",
    });

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(result.error!.message).toContain("start");
  });

  it("enforces user isolation -- other user cannot see events", async () => {
    // Create an event as TEST_USER
    await callTool("calendar.create_event", {
      title: "Private Event",
      start_ts: "2026-03-15T09:00:00Z",
      end_ts: "2026-03-15T10:00:00Z",
    });

    // Query as OTHER_USER
    const otherAuth = await makeAuthHeader(OTHER_USER.user_id);
    const result = await callTool(
      "calendar.list_events",
      {
        start: "2026-03-01T00:00:00Z",
        end: "2026-03-31T23:59:59Z",
      },
      otherAuth,
    );

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual([]);
  });
});

describe("MCP integration: calendar.update_event", () => {
  it("updates event title and returns updated event", async () => {
    // Create an event first
    const created = await callTool("calendar.create_event", {
      title: "Original Title",
      start_ts: "2026-03-15T09:00:00Z",
      end_ts: "2026-03-15T10:00:00Z",
    });
    const eventId = (created.data as Record<string, unknown>).event_id as string;

    // Update title
    const result = await callTool("calendar.update_event", {
      event_id: eventId,
      patch: { title: "Updated Title" },
    });

    expect(result.error).toBeUndefined();
    const event = result.data as Record<string, unknown>;
    expect(event.event_id).toBe(eventId);
    expect(event.title).toBe("Updated Title");
    // Start/end should be unchanged
    expect(event.start_ts).toBe("2026-03-15T09:00:00Z");
    expect(event.end_ts).toBe("2026-03-15T10:00:00Z");
  });

  it("updates multiple fields at once", async () => {
    const created = await callTool("calendar.create_event", {
      title: "Meeting",
      start_ts: "2026-03-15T09:00:00Z",
      end_ts: "2026-03-15T10:00:00Z",
    });
    const eventId = (created.data as Record<string, unknown>).event_id as string;

    const result = await callTool("calendar.update_event", {
      event_id: eventId,
      patch: {
        title: "Updated Meeting",
        description: "New description",
        location: "Room 202",
        start_ts: "2026-03-15T10:00:00Z",
        end_ts: "2026-03-15T11:00:00Z",
      },
    });

    expect(result.error).toBeUndefined();
    const event = result.data as Record<string, unknown>;
    expect(event.title).toBe("Updated Meeting");
    expect(event.description).toBe("New description");
    expect(event.location).toBe("Room 202");
    expect(event.start_ts).toBe("2026-03-15T10:00:00Z");
    expect(event.end_ts).toBe("2026-03-15T11:00:00Z");
  });

  it("verifies updated event is returned by list_events", async () => {
    const created = await callTool("calendar.create_event", {
      title: "Before Update",
      start_ts: "2026-03-15T09:00:00Z",
      end_ts: "2026-03-15T10:00:00Z",
    });
    const eventId = (created.data as Record<string, unknown>).event_id as string;

    await callTool("calendar.update_event", {
      event_id: eventId,
      patch: { title: "After Update" },
    });

    const listed = await callTool("calendar.list_events", {
      start: "2026-03-01T00:00:00Z",
      end: "2026-03-31T23:59:59Z",
    });

    const events = listed.data as Array<Record<string, unknown>>;
    expect(events.length).toBe(1);
    expect(events[0].title).toBe("After Update");
  });

  it("returns error for non-existent event_id", async () => {
    const result = await callTool("calendar.update_event", {
      event_id: "evt_nonexistent",
      patch: { title: "Ghost" },
    });

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(result.error!.message).toContain("Event not found");
  });

  it("returns error when updating another user's event", async () => {
    // Create event as TEST_USER
    const created = await callTool("calendar.create_event", {
      title: "Test User Event",
      start_ts: "2026-03-15T09:00:00Z",
      end_ts: "2026-03-15T10:00:00Z",
    });
    const eventId = (created.data as Record<string, unknown>).event_id as string;

    // Try to update as OTHER_USER
    const otherAuth = await makeAuthHeader(OTHER_USER.user_id);
    const result = await callTool(
      "calendar.update_event",
      { event_id: eventId, patch: { title: "Hacked" } },
      otherAuth,
    );

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(result.error!.message).toContain("Event not found");
  });

  it("returns error for empty patch object", async () => {
    const created = await callTool("calendar.create_event", {
      title: "No-op Event",
      start_ts: "2026-03-15T09:00:00Z",
      end_ts: "2026-03-15T10:00:00Z",
    });
    const eventId = (created.data as Record<string, unknown>).event_id as string;

    const result = await callTool("calendar.update_event", {
      event_id: eventId,
      patch: {},
    });

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(result.error!.message).toContain("at least one field");
  });
});

describe("MCP integration: calendar.delete_event", () => {
  it("deletes an event and confirms it is gone", async () => {
    // Create an event
    const created = await callTool("calendar.create_event", {
      title: "Doomed Event",
      start_ts: "2026-03-15T09:00:00Z",
      end_ts: "2026-03-15T10:00:00Z",
    });
    const eventId = (created.data as Record<string, unknown>).event_id as string;

    // Verify it exists
    const beforeDelete = await callTool("calendar.list_events", {
      start: "2026-03-01T00:00:00Z",
      end: "2026-03-31T23:59:59Z",
    });
    expect((beforeDelete.data as unknown[]).length).toBe(1);

    // Delete it
    const deleteResult = await callTool("calendar.delete_event", {
      event_id: eventId,
    });

    expect(deleteResult.error).toBeUndefined();
    const deleted = deleteResult.data as Record<string, unknown>;
    expect(deleted.deleted).toBe(true);
    expect(deleted.event_id).toBe(eventId);

    // Verify it is gone
    const afterDelete = await callTool("calendar.list_events", {
      start: "2026-03-01T00:00:00Z",
      end: "2026-03-31T23:59:59Z",
    });
    expect(afterDelete.data).toEqual([]);
  });

  it("returns error for non-existent event_id", async () => {
    const result = await callTool("calendar.delete_event", {
      event_id: "evt_nonexistent",
    });

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(result.error!.message).toContain("Event not found");
  });

  it("returns error when deleting another user's event", async () => {
    // Create event as TEST_USER
    const created = await callTool("calendar.create_event", {
      title: "Protected Event",
      start_ts: "2026-03-15T09:00:00Z",
      end_ts: "2026-03-15T10:00:00Z",
    });
    const eventId = (created.data as Record<string, unknown>).event_id as string;

    // Try to delete as OTHER_USER
    const otherAuth = await makeAuthHeader(OTHER_USER.user_id);
    const result = await callTool(
      "calendar.delete_event",
      { event_id: eventId },
      otherAuth,
    );

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(result.error!.message).toContain("Event not found");

    // Verify event still exists for the original user
    const stillExists = await callTool("calendar.list_events", {
      start: "2026-03-01T00:00:00Z",
      end: "2026-03-31T23:59:59Z",
    });
    expect((stillExists.data as unknown[]).length).toBe(1);
  });

  it("rejects delete with missing event_id", async () => {
    const result = await callTool("calendar.delete_event", {});

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(result.error!.message).toContain("event_id");
  });
});

describe("MCP integration: full CRUD lifecycle", () => {
  it("create -> list -> update -> list -> delete -> list empty", async () => {
    // 1. Create
    const created = await callTool("calendar.create_event", {
      title: "Lifecycle Event",
      start_ts: "2026-06-01T10:00:00Z",
      end_ts: "2026-06-01T11:00:00Z",
      description: "Full lifecycle test",
      location: "Conference Room A",
    });
    expect(created.error).toBeUndefined();
    const eventId = (created.data as Record<string, unknown>).event_id as string;
    expect(eventId).toBeTruthy();

    // 2. List -- should find 1 event
    const listed = await callTool("calendar.list_events", {
      start: "2026-06-01T00:00:00Z",
      end: "2026-06-30T23:59:59Z",
    });
    const listedEvents = listed.data as Array<Record<string, unknown>>;
    expect(listedEvents.length).toBe(1);
    expect(listedEvents[0].event_id).toBe(eventId);
    expect(listedEvents[0].title).toBe("Lifecycle Event");
    expect(listedEvents[0].description).toBe("Full lifecycle test");
    expect(listedEvents[0].location).toBe("Conference Room A");

    // 3. Update
    const updated = await callTool("calendar.update_event", {
      event_id: eventId,
      patch: {
        title: "Updated Lifecycle Event",
        location: "Conference Room B",
      },
    });
    expect(updated.error).toBeUndefined();
    const updatedEvent = updated.data as Record<string, unknown>;
    expect(updatedEvent.title).toBe("Updated Lifecycle Event");
    expect(updatedEvent.location).toBe("Conference Room B");
    expect(updatedEvent.description).toBe("Full lifecycle test"); // unchanged

    // 4. List -- should show updated data
    const listedAfterUpdate = await callTool("calendar.list_events", {
      start: "2026-06-01T00:00:00Z",
      end: "2026-06-30T23:59:59Z",
    });
    const updatedEvents = listedAfterUpdate.data as Array<Record<string, unknown>>;
    expect(updatedEvents.length).toBe(1);
    expect(updatedEvents[0].title).toBe("Updated Lifecycle Event");
    expect(updatedEvents[0].location).toBe("Conference Room B");

    // 5. Delete
    const deleted = await callTool("calendar.delete_event", {
      event_id: eventId,
    });
    expect(deleted.error).toBeUndefined();
    expect((deleted.data as Record<string, unknown>).deleted).toBe(true);

    // 6. List -- should be empty
    const listedAfterDelete = await callTool("calendar.list_events", {
      start: "2026-06-01T00:00:00Z",
      end: "2026-06-30T23:59:59Z",
    });
    expect(listedAfterDelete.data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration: calendar.get_availability
// ---------------------------------------------------------------------------

describe("MCP integration: calendar.get_availability", () => {
  it("returns all free slots when no events exist", async () => {
    const result = await callTool("calendar.get_availability", {
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T11:00:00Z",
    });

    expect(result.error).toBeUndefined();
    const data = result.data as { slots: Array<Record<string, unknown>> };
    expect(data.slots).toBeDefined();
    expect(data.slots.length).toBe(4); // 2 hours / 30m default granularity = 4 slots

    for (const slot of data.slots) {
      expect(slot.status).toBe("free");
      expect(slot.conflicting_events).toBeUndefined();
    }
  });

  it("marks slots as busy when events overlap", async () => {
    // Create an event from 09:00-10:00
    await callTool("calendar.create_event", {
      title: "Morning Meeting",
      start_ts: "2026-03-15T09:00:00Z",
      end_ts: "2026-03-15T10:00:00Z",
    });

    const result = await callTool("calendar.get_availability", {
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T11:00:00Z",
    });

    expect(result.error).toBeUndefined();
    const data = result.data as {
      slots: Array<{ start: string; end: string; status: string; conflicting_events?: number }>;
    };
    expect(data.slots.length).toBe(4);

    // Slots 09:00-09:30 and 09:30-10:00 should be busy
    expect(data.slots[0].status).toBe("busy");
    expect(data.slots[0].conflicting_events).toBe(1);
    expect(data.slots[1].status).toBe("busy");
    expect(data.slots[1].conflicting_events).toBe(1);
    // Slots 10:00-10:30 and 10:30-11:00 should be free
    expect(data.slots[2].status).toBe("free");
    expect(data.slots[3].status).toBe("free");
  });

  it("supports 15m granularity", async () => {
    await callTool("calendar.create_event", {
      title: "Quick Sync",
      start_ts: "2026-03-15T09:00:00Z",
      end_ts: "2026-03-15T09:30:00Z",
    });

    const result = await callTool("calendar.get_availability", {
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T10:00:00Z",
      granularity: "15m",
    });

    expect(result.error).toBeUndefined();
    const data = result.data as {
      slots: Array<{ start: string; end: string; status: string }>;
    };
    expect(data.slots.length).toBe(4); // 1 hour / 15m = 4 slots

    // Event 09:00-09:30 covers first 2 slots
    expect(data.slots[0].status).toBe("busy"); // 09:00-09:15
    expect(data.slots[1].status).toBe("busy"); // 09:15-09:30
    expect(data.slots[2].status).toBe("free"); // 09:30-09:45
    expect(data.slots[3].status).toBe("free"); // 09:45-10:00
  });

  it("supports 1h granularity", async () => {
    await callTool("calendar.create_event", {
      title: "Long Meeting",
      start_ts: "2026-03-15T10:00:00Z",
      end_ts: "2026-03-15T11:00:00Z",
    });

    const result = await callTool("calendar.get_availability", {
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T12:00:00Z",
      granularity: "1h",
    });

    expect(result.error).toBeUndefined();
    const data = result.data as {
      slots: Array<{ start: string; end: string; status: string }>;
    };
    expect(data.slots.length).toBe(3); // 3 hours / 1h = 3 slots

    expect(data.slots[0].status).toBe("free"); // 09:00-10:00
    expect(data.slots[1].status).toBe("busy"); // 10:00-11:00
    expect(data.slots[2].status).toBe("free"); // 11:00-12:00
  });

  it("marks tentative events as tentative", async () => {
    // Insert tentative event directly via SQL (create_event defaults to confirmed)
    db.prepare(
      "INSERT INTO mcp_events (event_id, user_id, title, start_ts, end_ts, timezone, source, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "evt_tentative_001",
      TEST_USER.user_id,
      "Maybe Meeting",
      "2026-03-15T09:00:00Z",
      "2026-03-15T10:00:00Z",
      "UTC",
      "mcp",
      "tentative",
    );

    const result = await callTool("calendar.get_availability", {
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T11:00:00Z",
    });

    expect(result.error).toBeUndefined();
    const data = result.data as {
      slots: Array<{ start: string; end: string; status: string; conflicting_events?: number }>;
    };

    // Tentative event in 09:00-10:00 should mark slots as tentative
    expect(data.slots[0].status).toBe("tentative");
    expect(data.slots[0].conflicting_events).toBe(1);
    expect(data.slots[1].status).toBe("tentative");
    expect(data.slots[1].conflicting_events).toBe(1);
    expect(data.slots[2].status).toBe("free");
    expect(data.slots[3].status).toBe("free");
  });

  it("confirmed event overrides tentative in same time slot", async () => {
    // Insert tentative event
    db.prepare(
      "INSERT INTO mcp_events (event_id, user_id, title, start_ts, end_ts, timezone, source, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "evt_tentative_002",
      TEST_USER.user_id,
      "Maybe Meeting",
      "2026-03-15T09:00:00Z",
      "2026-03-15T10:00:00Z",
      "UTC",
      "mcp",
      "tentative",
    );

    // Also create a confirmed event overlapping the same time
    await callTool("calendar.create_event", {
      title: "Confirmed Meeting",
      start_ts: "2026-03-15T09:00:00Z",
      end_ts: "2026-03-15T09:30:00Z",
    });

    const result = await callTool("calendar.get_availability", {
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T11:00:00Z",
    });

    expect(result.error).toBeUndefined();
    const data = result.data as {
      slots: Array<{ start: string; end: string; status: string; conflicting_events?: number }>;
    };

    // 09:00-09:30: both tentative and confirmed overlap -> busy (confirmed wins)
    expect(data.slots[0].status).toBe("busy");
    expect(data.slots[0].conflicting_events).toBe(2);
    // 09:30-10:00: only tentative overlaps -> tentative
    expect(data.slots[1].status).toBe("tentative");
    expect(data.slots[1].conflicting_events).toBe(1);
  });

  it("merges availability across multiple accounts", async () => {
    // Create event on account A
    db.prepare(
      "INSERT INTO mcp_events (event_id, user_id, account_id, title, start_ts, end_ts, timezone, source, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "evt_acc_a_001",
      TEST_USER.user_id,
      ACCOUNT_A.account_id,
      "Account A Meeting",
      "2026-03-15T09:00:00Z",
      "2026-03-15T09:30:00Z",
      "UTC",
      "mcp",
      "confirmed",
    );

    // Create event on account B
    db.prepare(
      "INSERT INTO mcp_events (event_id, user_id, account_id, title, start_ts, end_ts, timezone, source, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "evt_acc_b_001",
      TEST_USER.user_id,
      ACCOUNT_B.account_id,
      "Account B Meeting",
      "2026-03-15T10:00:00Z",
      "2026-03-15T10:30:00Z",
      "UTC",
      "mcp",
      "confirmed",
    );

    const result = await callTool("calendar.get_availability", {
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T11:00:00Z",
    });

    expect(result.error).toBeUndefined();
    const data = result.data as {
      slots: Array<{ start: string; end: string; status: string }>;
    };

    expect(data.slots[0].status).toBe("busy"); // 09:00-09:30 (acc A)
    expect(data.slots[1].status).toBe("free"); // 09:30-10:00 (both free)
    expect(data.slots[2].status).toBe("busy"); // 10:00-10:30 (acc B)
    expect(data.slots[3].status).toBe("free"); // 10:30-11:00 (both free)
  });

  it("filters by accounts when specified", async () => {
    // Create events on different accounts
    db.prepare(
      "INSERT INTO mcp_events (event_id, user_id, account_id, title, start_ts, end_ts, timezone, source, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "evt_filter_a_001",
      TEST_USER.user_id,
      ACCOUNT_A.account_id,
      "Account A Event",
      "2026-03-15T09:00:00Z",
      "2026-03-15T10:00:00Z",
      "UTC",
      "mcp",
      "confirmed",
    );

    db.prepare(
      "INSERT INTO mcp_events (event_id, user_id, account_id, title, start_ts, end_ts, timezone, source, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "evt_filter_b_001",
      TEST_USER.user_id,
      ACCOUNT_B.account_id,
      "Account B Event",
      "2026-03-15T10:00:00Z",
      "2026-03-15T11:00:00Z",
      "UTC",
      "mcp",
      "confirmed",
    );

    // Filter to only account A -- should only see first event
    const result = await callTool("calendar.get_availability", {
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T11:00:00Z",
      accounts: [ACCOUNT_A.account_id],
    });

    expect(result.error).toBeUndefined();
    const data = result.data as {
      slots: Array<{ start: string; end: string; status: string }>;
    };

    expect(data.slots[0].status).toBe("busy"); // 09:00-09:30 (acc A event)
    expect(data.slots[1].status).toBe("busy"); // 09:30-10:00 (acc A event)
    expect(data.slots[2].status).toBe("free"); // 10:00-10:30 (acc B excluded by filter)
    expect(data.slots[3].status).toBe("free"); // 10:30-11:00
  });

  it("enforces user isolation -- other user's events not visible", async () => {
    // Create event for other user
    db.prepare(
      "INSERT INTO mcp_events (event_id, user_id, title, start_ts, end_ts, timezone, source, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "evt_other_user_001",
      OTHER_USER.user_id,
      "Other User Meeting",
      "2026-03-15T09:00:00Z",
      "2026-03-15T11:00:00Z",
      "UTC",
      "mcp",
      "confirmed",
    );

    // Query as TEST_USER -- should see all free
    const result = await callTool("calendar.get_availability", {
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T11:00:00Z",
    });

    expect(result.error).toBeUndefined();
    const data = result.data as { slots: Array<{ status: string }> };
    for (const slot of data.slots) {
      expect(slot.status).toBe("free");
    }
  });

  it("rejects request with missing start parameter", async () => {
    const result = await callTool("calendar.get_availability", {
      end: "2026-03-15T17:00:00Z",
    });

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(result.error!.message).toContain("start");
  });

  it("rejects request with invalid granularity", async () => {
    const result = await callTool("calendar.get_availability", {
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T17:00:00Z",
      granularity: "2h",
    });

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(result.error!.message).toContain("granularity");
  });

  it("rejects request with time range exceeding 7 days", async () => {
    const result = await callTool("calendar.get_availability", {
      start: "2026-03-01T00:00:00Z",
      end: "2026-03-15T00:00:00Z",
    });

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(result.error!.message).toContain("7 days");
  });

  it("excludes cancelled events from availability", async () => {
    // Insert a cancelled event
    db.prepare(
      "INSERT INTO mcp_events (event_id, user_id, title, start_ts, end_ts, timezone, source, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "evt_cancelled_001",
      TEST_USER.user_id,
      "Cancelled Meeting",
      "2026-03-15T09:00:00Z",
      "2026-03-15T11:00:00Z",
      "UTC",
      "mcp",
      "cancelled",
    );

    const result = await callTool("calendar.get_availability", {
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T11:00:00Z",
    });

    expect(result.error).toBeUndefined();
    const data = result.data as { slots: Array<{ status: string }> };
    for (const slot of data.slots) {
      expect(slot.status).toBe("free");
    }
  });

  it("responds under 500ms for a full day at 15m granularity", async () => {
    // Create some events
    for (let hour = 9; hour < 17; hour++) {
      db.prepare(
        "INSERT INTO mcp_events (event_id, user_id, title, start_ts, end_ts, timezone, source, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        `evt_perf_${hour}`,
        TEST_USER.user_id,
        `Meeting ${hour}`,
        `2026-03-15T${String(hour).padStart(2, "0")}:00:00Z`,
        `2026-03-15T${String(hour).padStart(2, "0")}:30:00Z`,
        "UTC",
        "mcp",
        "confirmed",
      );
    }

    const startTime = performance.now();
    const result = await callTool("calendar.get_availability", {
      start: "2026-03-15T00:00:00Z",
      end: "2026-03-16T00:00:00Z",
      granularity: "15m",
    });
    const elapsed = performance.now() - startTime;

    expect(result.error).toBeUndefined();
    const data = result.data as { slots: Array<Record<string, unknown>> };
    expect(data.slots.length).toBe(96); // 24 hours * 4 (15m slots) = 96
    expect(elapsed).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// Integration: tools/list includes policy management tools
// ---------------------------------------------------------------------------

describe("MCP integration: tools/list includes policy management tools", () => {
  it("returns all 22 tools including policy, constraint, scheduling, and governance tools", async () => {
    const authHeader = await makeAuthHeader();
    const result = await sendMcpRequest(
      { jsonrpc: "2.0", method: "tools/list", id: 200 },
      authHeader,
    );

    const resultData = result.body.result as { tools: Array<Record<string, unknown>> };
    const toolNames = resultData.tools.map((t) => t.name);

    expect(toolNames).toContain("calendar.list_policies");
    expect(toolNames).toContain("calendar.get_policy_edge");
    expect(toolNames).toContain("calendar.set_policy_edge");
    expect(toolNames).toContain("calendar.add_trip");
    expect(toolNames).toContain("calendar.add_constraint");
    expect(toolNames).toContain("calendar.list_constraints");
    expect(toolNames).toContain("calendar.propose_times");
    expect(toolNames).toContain("calendar.commit_candidate");
    expect(toolNames).toContain("calendar.add_relationship");
    expect(toolNames).toContain("calendar.get_drift_report");
    expect(toolNames).toContain("calendar.mark_outcome");
    expect(toolNames).toContain("calendar.get_reconnection_suggestions");
    expect(toolNames).toContain("calendar.get_event_briefing");
    expect(toolNames).toContain("calendar.generate_excuse");
    expect(toolNames).toContain("calendar.add_milestone");
    expect(toolNames).toContain("calendar.list_milestones");
    expect(toolNames).toContain("calendar.upcoming_milestones");
    expect(toolNames).toContain("calendar.get_cognitive_load");
    expect(toolNames).toContain("calendar.get_risk_scores");
    expect(toolNames).toContain("calendar.query_graph");
    expect(resultData.tools.length).toBe(38);
  });
});

// ---------------------------------------------------------------------------
// Integration: calendar.set_policy_edge
// ---------------------------------------------------------------------------

describe("MCP integration: calendar.set_policy_edge", () => {
  it("creates a new policy edge with BUSY detail_level", async () => {
    const result = await callTool("calendar.set_policy_edge", {
      from_account: ACCOUNT_A.account_id,
      to_account: ACCOUNT_B.account_id,
      detail_level: "BUSY",
    });

    expect(result.error).toBeUndefined();
    const policy = result.data as Record<string, unknown>;
    expect(policy.policy_id).toBeDefined();
    expect(typeof policy.policy_id).toBe("string");
    expect((policy.policy_id as string).startsWith("pol_")).toBe(true);
    expect(policy.from_account).toBe(ACCOUNT_A.account_id);
    expect(policy.to_account).toBe(ACCOUNT_B.account_id);
    expect(policy.detail_level).toBe("BUSY");
    expect(policy.calendar_kind).toBe("BUSY_OVERLAY"); // default per BR-11
    expect(policy.created_at).toBeDefined();
    expect(policy.updated_at).toBeDefined();
  });

  it("creates a policy edge with TITLE detail_level and TRUE_MIRROR kind", async () => {
    const result = await callTool("calendar.set_policy_edge", {
      from_account: ACCOUNT_A.account_id,
      to_account: ACCOUNT_B.account_id,
      detail_level: "TITLE",
      calendar_kind: "TRUE_MIRROR",
    });

    expect(result.error).toBeUndefined();
    const policy = result.data as Record<string, unknown>;
    expect(policy.detail_level).toBe("TITLE");
    expect(policy.calendar_kind).toBe("TRUE_MIRROR");
  });

  it("upserts existing policy edge (updates detail_level)", async () => {
    // Create initial policy with BUSY
    const created = await callTool("calendar.set_policy_edge", {
      from_account: ACCOUNT_A.account_id,
      to_account: ACCOUNT_B.account_id,
      detail_level: "BUSY",
    });
    expect(created.error).toBeUndefined();
    const originalId = (created.data as Record<string, unknown>).policy_id;

    // Upsert with FULL -- should update same policy, not create new
    const updated = await callTool("calendar.set_policy_edge", {
      from_account: ACCOUNT_A.account_id,
      to_account: ACCOUNT_B.account_id,
      detail_level: "FULL",
    });
    expect(updated.error).toBeUndefined();
    const updatedPolicy = updated.data as Record<string, unknown>;
    expect(updatedPolicy.policy_id).toBe(originalId); // same policy ID
    expect(updatedPolicy.detail_level).toBe("FULL"); // updated
    expect(updatedPolicy.calendar_kind).toBe("BUSY_OVERLAY"); // default
  });

  it("rejects when from_account does not belong to user", async () => {
    const result = await callTool("calendar.set_policy_edge", {
      from_account: OTHER_USER_ACCOUNT.account_id,
      to_account: ACCOUNT_B.account_id,
      detail_level: "BUSY",
    });

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(result.error!.message).toContain("not found");
    expect(result.error!.message).toContain("from_account");
  });

  it("rejects when to_account does not belong to user", async () => {
    const result = await callTool("calendar.set_policy_edge", {
      from_account: ACCOUNT_A.account_id,
      to_account: OTHER_USER_ACCOUNT.account_id,
      detail_level: "BUSY",
    });

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(result.error!.message).toContain("not found");
    expect(result.error!.message).toContain("to_account");
  });

  it("rejects when from_account equals to_account", async () => {
    const result = await callTool("calendar.set_policy_edge", {
      from_account: ACCOUNT_A.account_id,
      to_account: ACCOUNT_A.account_id,
      detail_level: "BUSY",
    });

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(result.error!.message).toContain("different accounts");
  });

  it("rejects invalid detail_level", async () => {
    const result = await callTool("calendar.set_policy_edge", {
      from_account: ACCOUNT_A.account_id,
      to_account: ACCOUNT_B.account_id,
      detail_level: "PARTIAL",
    });

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(result.error!.message).toContain("detail_level");
    expect(result.error!.message).toContain("BUSY, TITLE, FULL");
  });

  it("rejects invalid calendar_kind", async () => {
    const result = await callTool("calendar.set_policy_edge", {
      from_account: ACCOUNT_A.account_id,
      to_account: ACCOUNT_B.account_id,
      detail_level: "BUSY",
      calendar_kind: "SHARED_VIEW",
    });

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(result.error!.message).toContain("calendar_kind");
    expect(result.error!.message).toContain("BUSY_OVERLAY, TRUE_MIRROR");
  });

  it("rejects missing from_account", async () => {
    const result = await callTool("calendar.set_policy_edge", {
      to_account: ACCOUNT_B.account_id,
      detail_level: "BUSY",
    });

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(result.error!.message).toContain("from_account");
  });

  it("rejects missing to_account", async () => {
    const result = await callTool("calendar.set_policy_edge", {
      from_account: ACCOUNT_A.account_id,
      detail_level: "BUSY",
    });

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(result.error!.message).toContain("to_account");
  });
});

// ---------------------------------------------------------------------------
// Integration: calendar.list_policies
// ---------------------------------------------------------------------------

describe("MCP integration: calendar.list_policies", () => {
  it("returns empty array when no policies exist", async () => {
    const result = await callTool("calendar.list_policies");

    expect(result.error).toBeUndefined();
    const data = result.data as { policies: unknown[] };
    expect(data.policies).toEqual([]);
  });

  it("returns all policies for the authenticated user", async () => {
    // Create two policy edges
    await callTool("calendar.set_policy_edge", {
      from_account: ACCOUNT_A.account_id,
      to_account: ACCOUNT_B.account_id,
      detail_level: "BUSY",
    });
    await callTool("calendar.set_policy_edge", {
      from_account: ACCOUNT_B.account_id,
      to_account: ACCOUNT_A.account_id,
      detail_level: "FULL",
      calendar_kind: "TRUE_MIRROR",
    });

    const result = await callTool("calendar.list_policies");

    expect(result.error).toBeUndefined();
    const data = result.data as { policies: Array<Record<string, unknown>> };
    expect(data.policies.length).toBe(2);

    // Verify first policy (A -> B)
    const policyAB = data.policies.find(
      (p) => p.from_account === ACCOUNT_A.account_id && p.to_account === ACCOUNT_B.account_id,
    );
    expect(policyAB).toBeDefined();
    expect(policyAB?.detail_level).toBe("BUSY");
    expect(policyAB?.calendar_kind).toBe("BUSY_OVERLAY");
    expect(policyAB?.policy_id).toBeDefined();

    // Verify second policy (B -> A)
    const policyBA = data.policies.find(
      (p) => p.from_account === ACCOUNT_B.account_id && p.to_account === ACCOUNT_A.account_id,
    );
    expect(policyBA).toBeDefined();
    expect(policyBA?.detail_level).toBe("FULL");
    expect(policyBA?.calendar_kind).toBe("TRUE_MIRROR");
  });

  it("enforces user isolation -- other user cannot see policies", async () => {
    // Create a policy as TEST_USER
    await callTool("calendar.set_policy_edge", {
      from_account: ACCOUNT_A.account_id,
      to_account: ACCOUNT_B.account_id,
      detail_level: "BUSY",
    });

    // List as OTHER_USER -- should see nothing
    const otherAuth = await makeAuthHeader(OTHER_USER.user_id);
    const result = await callTool("calendar.list_policies", undefined, otherAuth);

    expect(result.error).toBeUndefined();
    const data = result.data as { policies: unknown[] };
    expect(data.policies).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration: calendar.get_policy_edge
// ---------------------------------------------------------------------------

describe("MCP integration: calendar.get_policy_edge", () => {
  it("gets a policy edge by policy_id", async () => {
    // Create a policy
    const created = await callTool("calendar.set_policy_edge", {
      from_account: ACCOUNT_A.account_id,
      to_account: ACCOUNT_B.account_id,
      detail_level: "TITLE",
    });
    const policyId = (created.data as Record<string, unknown>).policy_id as string;

    // Get by policy_id
    const result = await callTool("calendar.get_policy_edge", {
      policy_id: policyId,
    });

    expect(result.error).toBeUndefined();
    const policy = result.data as Record<string, unknown>;
    expect(policy.policy_id).toBe(policyId);
    expect(policy.from_account).toBe(ACCOUNT_A.account_id);
    expect(policy.to_account).toBe(ACCOUNT_B.account_id);
    expect(policy.detail_level).toBe("TITLE");
    expect(policy.calendar_kind).toBe("BUSY_OVERLAY");
  });

  it("gets a policy edge by from/to account pair", async () => {
    // Create a policy
    await callTool("calendar.set_policy_edge", {
      from_account: ACCOUNT_A.account_id,
      to_account: ACCOUNT_B.account_id,
      detail_level: "FULL",
      calendar_kind: "TRUE_MIRROR",
    });

    // Get by from/to pair
    const result = await callTool("calendar.get_policy_edge", {
      from_account: ACCOUNT_A.account_id,
      to_account: ACCOUNT_B.account_id,
    });

    expect(result.error).toBeUndefined();
    const policy = result.data as Record<string, unknown>;
    expect(policy.from_account).toBe(ACCOUNT_A.account_id);
    expect(policy.to_account).toBe(ACCOUNT_B.account_id);
    expect(policy.detail_level).toBe("FULL");
    expect(policy.calendar_kind).toBe("TRUE_MIRROR");
  });

  it("returns error for non-existent policy_id", async () => {
    const result = await callTool("calendar.get_policy_edge", {
      policy_id: "pol_nonexistent",
    });

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(result.error!.message).toContain("Policy not found");
  });

  it("returns error for non-existent from/to pair", async () => {
    const result = await callTool("calendar.get_policy_edge", {
      from_account: ACCOUNT_A.account_id,
      to_account: ACCOUNT_B.account_id,
    });

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(result.error!.message).toContain("Policy not found");
  });

  it("returns error when no params provided", async () => {
    const result = await callTool("calendar.get_policy_edge", {});

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(result.error!.message).toContain("Provide either");
  });

  it("enforces user isolation -- cannot get another user's policy by ID", async () => {
    // Create a policy as TEST_USER
    const created = await callTool("calendar.set_policy_edge", {
      from_account: ACCOUNT_A.account_id,
      to_account: ACCOUNT_B.account_id,
      detail_level: "BUSY",
    });
    const policyId = (created.data as Record<string, unknown>).policy_id as string;

    // Try to get as OTHER_USER
    const otherAuth = await makeAuthHeader(OTHER_USER.user_id);
    const result = await callTool(
      "calendar.get_policy_edge",
      { policy_id: policyId },
      otherAuth,
    );

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32602);
    expect(result.error!.message).toContain("Policy not found");
  });
});

// ---------------------------------------------------------------------------
// Integration: full policy CRUD lifecycle
// ---------------------------------------------------------------------------

describe("MCP integration: full policy CRUD lifecycle", () => {
  it("create -> list -> get -> update detail_level -> verify change -> list", async () => {
    // 1. Create a policy edge (A -> B, BUSY, BUSY_OVERLAY)
    const created = await callTool("calendar.set_policy_edge", {
      from_account: ACCOUNT_A.account_id,
      to_account: ACCOUNT_B.account_id,
      detail_level: "BUSY",
    });
    expect(created.error).toBeUndefined();
    const policyId = (created.data as Record<string, unknown>).policy_id as string;
    expect(policyId).toBeTruthy();
    expect((created.data as Record<string, unknown>).detail_level).toBe("BUSY");
    expect((created.data as Record<string, unknown>).calendar_kind).toBe("BUSY_OVERLAY");

    // 2. List -- should find 1 policy
    const listed = await callTool("calendar.list_policies");
    expect(listed.error).toBeUndefined();
    const policies = (listed.data as { policies: Array<Record<string, unknown>> }).policies;
    expect(policies.length).toBe(1);
    expect(policies[0].policy_id).toBe(policyId);
    expect(policies[0].detail_level).toBe("BUSY");

    // 3. Get by policy_id -- verify details
    const fetched = await callTool("calendar.get_policy_edge", {
      policy_id: policyId,
    });
    expect(fetched.error).toBeUndefined();
    const fetchedPolicy = fetched.data as Record<string, unknown>;
    expect(fetchedPolicy.policy_id).toBe(policyId);
    expect(fetchedPolicy.from_account).toBe(ACCOUNT_A.account_id);
    expect(fetchedPolicy.to_account).toBe(ACCOUNT_B.account_id);

    // 4. Update detail_level to FULL (upsert same from/to pair)
    const updated = await callTool("calendar.set_policy_edge", {
      from_account: ACCOUNT_A.account_id,
      to_account: ACCOUNT_B.account_id,
      detail_level: "FULL",
      calendar_kind: "TRUE_MIRROR",
    });
    expect(updated.error).toBeUndefined();
    const updatedPolicy = updated.data as Record<string, unknown>;
    expect(updatedPolicy.policy_id).toBe(policyId); // same ID
    expect(updatedPolicy.detail_level).toBe("FULL"); // changed
    expect(updatedPolicy.calendar_kind).toBe("TRUE_MIRROR"); // changed

    // 5. Verify change via get
    const verified = await callTool("calendar.get_policy_edge", {
      from_account: ACCOUNT_A.account_id,
      to_account: ACCOUNT_B.account_id,
    });
    expect(verified.error).toBeUndefined();
    const verifiedPolicy = verified.data as Record<string, unknown>;
    expect(verifiedPolicy.detail_level).toBe("FULL");
    expect(verifiedPolicy.calendar_kind).toBe("TRUE_MIRROR");

    // 6. List -- should still show 1 policy (not 2)
    const finalList = await callTool("calendar.list_policies");
    expect(finalList.error).toBeUndefined();
    const finalPolicies = (finalList.data as { policies: Array<Record<string, unknown>> }).policies;
    expect(finalPolicies.length).toBe(1);
    expect(finalPolicies[0].detail_level).toBe("FULL");
    expect(finalPolicies[0].calendar_kind).toBe("TRUE_MIRROR");
  });

  it("supports bidirectional policies between two accounts", async () => {
    // A -> B: BUSY overlay
    await callTool("calendar.set_policy_edge", {
      from_account: ACCOUNT_A.account_id,
      to_account: ACCOUNT_B.account_id,
      detail_level: "BUSY",
    });

    // B -> A: FULL mirror
    await callTool("calendar.set_policy_edge", {
      from_account: ACCOUNT_B.account_id,
      to_account: ACCOUNT_A.account_id,
      detail_level: "FULL",
      calendar_kind: "TRUE_MIRROR",
    });

    // List should show 2 distinct policies
    const listed = await callTool("calendar.list_policies");
    expect(listed.error).toBeUndefined();
    const policies = (listed.data as { policies: Array<Record<string, unknown>> }).policies;
    expect(policies.length).toBe(2);

    // Verify each direction has correct settings
    const ab = policies.find(
      (p) => p.from_account === ACCOUNT_A.account_id && p.to_account === ACCOUNT_B.account_id,
    );
    const ba = policies.find(
      (p) => p.from_account === ACCOUNT_B.account_id && p.to_account === ACCOUNT_A.account_id,
    );

    expect(ab?.detail_level).toBe("BUSY");
    expect(ab?.calendar_kind).toBe("BUSY_OVERLAY");
    expect(ba?.detail_level).toBe("FULL");
    expect(ba?.calendar_kind).toBe("TRUE_MIRROR");
  });
});

// ---------------------------------------------------------------------------
// Integration: tier-based tool permissions
// ---------------------------------------------------------------------------

/**
 * Helper: generate a JWT with a specific tier for integration tier tests.
 */
async function makeAuthHeaderWithTier(tier: string, userId?: string): Promise<string> {
  const token = await generateJWT(
    {
      sub: userId ?? TEST_USER.user_id,
      email: TEST_USER.email,
      tier,
      pwd_ver: 1,
    },
    JWT_SECRET,
    3600,
  );
  return `Bearer ${token}`;
}

/**
 * Helper: call a tool with a specific tier for tier integration tests.
 * Returns the raw JSON-RPC response body for flexible assertions.
 */
async function callToolWithTier(
  toolName: string,
  tier: string,
  toolArgs?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const authHeader = await makeAuthHeaderWithTier(tier);
  return sendMcpRequest(
    {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: toolName, arguments: toolArgs ?? {} },
      id: Math.floor(Math.random() * 100000),
    },
    authHeader,
  );
}

describe("MCP integration: tier-based tool permissions", () => {
  // -- Free tier: read-only tools succeed with real data --

  it("free tier can call calendar.list_accounts (read-only tool)", async () => {
    const result = await callToolWithTier("calendar.list_accounts", "free");
    expect(result.body.error).toBeUndefined();
    expect(result.body.result).toBeDefined();
    const content = (result.body.result as { content: Array<{ text: string }> }).content;
    const data = JSON.parse(content[0].text);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(2);
  });

  it("free tier can call calendar.get_sync_status (read-only tool)", async () => {
    const result = await callToolWithTier("calendar.get_sync_status", "free");
    expect(result.body.error).toBeUndefined();
    const content = (result.body.result as { content: Array<{ text: string }> }).content;
    const data = JSON.parse(content[0].text);
    expect(data).toHaveProperty("overall");
    expect(data).toHaveProperty("accounts");
  });

  it("free tier can call calendar.list_events (read-only tool)", async () => {
    const result = await callToolWithTier("calendar.list_events", "free", {
      start: "2026-01-01T00:00:00Z",
      end: "2026-12-31T23:59:59Z",
    });
    expect(result.body.error).toBeUndefined();
  });

  it("free tier can call calendar.get_availability (read-only tool)", async () => {
    const result = await callToolWithTier("calendar.get_availability", "free", {
      start: "2026-03-15T09:00:00Z",
      end: "2026-03-15T17:00:00Z",
    });
    expect(result.body.error).toBeUndefined();
    const content = (result.body.result as { content: Array<{ text: string }> }).content;
    const data = JSON.parse(content[0].text);
    expect(data).toHaveProperty("slots");
  });

  it("free tier can call calendar.list_policies (read-only tool)", async () => {
    const result = await callToolWithTier("calendar.list_policies", "free");
    expect(result.body.error).toBeUndefined();
    const content = (result.body.result as { content: Array<{ text: string }> }).content;
    const data = JSON.parse(content[0].text);
    expect(data).toHaveProperty("policies");
  });

  // -- Free tier: write tools are denied with TIER_REQUIRED --

  it("free tier calling calendar.create_event returns TIER_REQUIRED", async () => {
    const result = await callToolWithTier("calendar.create_event", "free", {
      title: "Test Event",
      start_ts: "2026-03-15T09:00:00Z",
      end_ts: "2026-03-15T10:00:00Z",
    });
    const error = result.body.error as {
      code: number;
      message: string;
      data: { code: string; required_tier: string; current_tier: string; tool: string };
    };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32603);
    expect(error.message).toContain("requires a premium subscription");
    expect(error.data).toMatchObject({
      code: "TIER_REQUIRED",
      required_tier: "premium",
      current_tier: "free",
      tool: "calendar.create_event",
    });
  });

  it("free tier calling calendar.update_event returns TIER_REQUIRED", async () => {
    const result = await callToolWithTier("calendar.update_event", "free", {
      event_id: "evt_test",
      patch: { title: "Updated" },
    });
    const error = result.body.error as {
      code: number;
      data: { code: string; required_tier: string; current_tier: string; tool: string };
    };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32603);
    expect(error.data.code).toBe("TIER_REQUIRED");
    expect(error.data.required_tier).toBe("premium");
    expect(error.data.current_tier).toBe("free");
    expect(error.data.tool).toBe("calendar.update_event");
  });

  it("free tier calling calendar.delete_event returns TIER_REQUIRED", async () => {
    const result = await callToolWithTier("calendar.delete_event", "free", {
      event_id: "evt_test",
    });
    const error = result.body.error as {
      code: number;
      data: { code: string; tool: string };
    };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32603);
    expect(error.data.code).toBe("TIER_REQUIRED");
    expect(error.data.tool).toBe("calendar.delete_event");
  });

  it("free tier calling calendar.set_policy_edge returns TIER_REQUIRED", async () => {
    const result = await callToolWithTier("calendar.set_policy_edge", "free", {
      from_account: ACCOUNT_A.account_id,
      to_account: ACCOUNT_B.account_id,
      detail_level: "BUSY",
    });
    const error = result.body.error as {
      code: number;
      data: { code: string; tool: string };
    };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32603);
    expect(error.data.code).toBe("TIER_REQUIRED");
    expect(error.data.tool).toBe("calendar.set_policy_edge");
  });

  // -- Premium tier: write tools succeed --

  it("premium tier can call calendar.create_event (write tool allowed)", async () => {
    const result = await callToolWithTier("calendar.create_event", "premium", {
      title: "Premium Event",
      start_ts: "2026-03-15T09:00:00Z",
      end_ts: "2026-03-15T10:00:00Z",
    });
    expect(result.body.error).toBeUndefined();
    expect(result.body.result).toBeDefined();
    const content = (result.body.result as { content: Array<{ text: string }> }).content;
    const data = JSON.parse(content[0].text);
    expect(data).toHaveProperty("event_id");
    expect(data.title).toBe("Premium Event");
  });

  it("premium tier can call calendar.set_policy_edge (write tool allowed)", async () => {
    const result = await callToolWithTier("calendar.set_policy_edge", "premium", {
      from_account: ACCOUNT_A.account_id,
      to_account: ACCOUNT_B.account_id,
      detail_level: "BUSY",
    });
    expect(result.body.error).toBeUndefined();
    expect(result.body.result).toBeDefined();
    const content = (result.body.result as { content: Array<{ text: string }> }).content;
    const data = JSON.parse(content[0].text);
    expect(data).toHaveProperty("policy_id");
    expect(data.detail_level).toBe("BUSY");
  });

  it("premium tier can also call read-only tools", async () => {
    const result = await callToolWithTier("calendar.list_accounts", "premium");
    expect(result.body.error).toBeUndefined();
    expect(result.body.result).toBeDefined();
  });

  // -- Enterprise tier: can access everything --

  it("enterprise tier can call premium write tools", async () => {
    const result = await callToolWithTier("calendar.create_event", "enterprise", {
      title: "Enterprise Event",
      start_ts: "2026-04-01T09:00:00Z",
      end_ts: "2026-04-01T10:00:00Z",
    });
    expect(result.body.error).toBeUndefined();
    const content = (result.body.result as { content: Array<{ text: string }> }).content;
    const data = JSON.parse(content[0].text);
    expect(data.title).toBe("Enterprise Event");
  });

  it("enterprise tier can call read-only tools", async () => {
    const result = await callToolWithTier("calendar.list_accounts", "enterprise");
    expect(result.body.error).toBeUndefined();
  });

  // -- Tier check is fail-fast (before tool execution) --

  it("tier check happens before input validation (fail fast proof)", async () => {
    const result = await callToolWithTier("calendar.create_event", "free", {});
    const error = result.body.error as {
      code: number;
      data: { code: string };
    };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32603);
    expect(error.data.code).toBe("TIER_REQUIRED");
  });

  // -- Full CRUD flow: premium can create then delete --

  it("premium tier full write cycle: create, update, delete", async () => {
    const createResult = await callToolWithTier("calendar.create_event", "premium", {
      title: "Cycle Test Event",
      start_ts: "2026-05-01T10:00:00Z",
      end_ts: "2026-05-01T11:00:00Z",
    });
    expect(createResult.body.error).toBeUndefined();
    const createContent = (createResult.body.result as { content: Array<{ text: string }> }).content;
    const created = JSON.parse(createContent[0].text);
    const eventId = created.event_id;
    expect(eventId).toBeDefined();

    const updateResult = await callToolWithTier("calendar.update_event", "premium", {
      event_id: eventId,
      patch: { title: "Updated Cycle Event" },
    });
    expect(updateResult.body.error).toBeUndefined();
    const updateContent = (updateResult.body.result as { content: Array<{ text: string }> }).content;
    const updated = JSON.parse(updateContent[0].text);
    expect(updated.title).toBe("Updated Cycle Event");

    const deleteResult = await callToolWithTier("calendar.delete_event", "premium", {
      event_id: eventId,
    });
    expect(deleteResult.body.error).toBeUndefined();
    const deleteContent = (deleteResult.body.result as { content: Array<{ text: string }> }).content;
    const deleted = JSON.parse(deleteContent[0].text);
    expect(deleted.deleted).toBe(true);
    expect(deleted.event_id).toBe(eventId);
  });
});

// ---------------------------------------------------------------------------
// Integration: scheduling tools (TM-946.5)
// ---------------------------------------------------------------------------

/**
 * Create a mock API Fetcher that simulates the scheduling API endpoints.
 * Allows tests to verify the full MCP -> service binding -> API flow.
 */
function createMockSchedulingApi(options?: {
  sessionResponse?: unknown;
  commitResponse?: unknown;
  sessionStatus?: number;
  commitStatus?: number;
  noCandidates?: boolean;
}): Fetcher {
  const sessionData = options?.noCandidates
    ? {
        ok: true,
        data: {
          session_id: "sched_empty_001",
          status: "candidates_ready",
          candidates: [],
        },
        meta: { request_id: "req_test", timestamp: new Date().toISOString() },
      }
    : options?.sessionResponse ?? {
        ok: true,
        data: {
          session_id: "sched_test_001",
          status: "candidates_ready",
          title: "Scheduling Session",
          candidates: [
            {
              candidate_id: "cand_001",
              start: "2026-03-15T10:00:00Z",
              end: "2026-03-15T10:30:00Z",
              score: 0.95,
            },
            {
              candidate_id: "cand_002",
              start: "2026-03-15T14:00:00Z",
              end: "2026-03-15T14:30:00Z",
              score: 0.80,
            },
          ],
        },
        meta: { request_id: "req_test", timestamp: new Date().toISOString() },
      };

  const commitData = options?.commitResponse ?? {
    ok: true,
    data: {
      event_id: "evt_committed_001",
      session: {
        session_id: "sched_test_001",
        status: "committed",
      },
    },
    meta: { request_id: "req_test", timestamp: new Date().toISOString() },
  };

  return {
    fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input.url;
      const method = init?.method ?? "GET";

      // POST /v1/scheduling/sessions -- create session
      if (method === "POST" && url.includes("/v1/scheduling/sessions") && !url.includes("/commit")) {
        return Promise.resolve(
          new Response(JSON.stringify(sessionData), {
            status: options?.sessionStatus ?? 201,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }

      // POST /v1/scheduling/sessions/:id/commit
      if (method === "POST" && url.includes("/commit")) {
        return Promise.resolve(
          new Response(JSON.stringify(commitData), {
            status: options?.commitStatus ?? 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }

      return Promise.resolve(
        new Response(JSON.stringify({ ok: false, error: "Unknown endpoint" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      );
    },
    connect: vi.fn() as unknown as Fetcher["connect"],
  } as unknown as Fetcher;
}

/**
 * Helper: send an MCP request with a mock API Fetcher for scheduling tools.
 */
async function sendMcpRequestWithApi(
  body: unknown,
  authHeader: string,
  api: Fetcher,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const handler = createMcpHandler();
  const env = {
    JWT_SECRET,
    DB: d1,
    ENVIRONMENT: "development",
    API: api,
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: authHeader,
  };

  const request = new Request("https://mcp.tminus.ink/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const response = await handler.fetch(request, env, mockCtx);
  const responseBody = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body: responseBody };
}

describe("MCP integration: calendar.propose_times (TM-946.5)", () => {
  it("creates scheduling session and returns candidates (AC #1)", async () => {
    const authHeader = await makeAuthHeaderWithTier("premium");
    const api = createMockSchedulingApi();

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.propose_times",
          arguments: {
            participants: [ACCOUNT_A.account_id],
            window: {
              start: "2026-03-15T09:00:00Z",
              end: "2026-03-15T17:00:00Z",
            },
            duration_minutes: 30,
          },
        },
        id: 500,
      },
      authHeader,
      api,
    );

    expect(result.status).toBe(200);
    expect(result.body.error).toBeUndefined();

    const resultData = result.body.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(resultData.content).toHaveLength(1);
    expect(resultData.content[0].type).toBe("text");

    const session = JSON.parse(resultData.content[0].text);
    expect(session.session_id).toBe("sched_test_001");
    expect(session.candidates).toHaveLength(2);
    expect(session.candidates[0].candidate_id).toBe("cand_001");
    expect(session.candidates[0].score).toBe(0.95);
    expect(session.candidates[1].candidate_id).toBe("cand_002");
  });

  it("returns candidates with all optional fields (objective + constraints)", async () => {
    const authHeader = await makeAuthHeaderWithTier("premium");
    const api = createMockSchedulingApi();

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.propose_times",
          arguments: {
            participants: [ACCOUNT_A.account_id, ACCOUNT_B.account_id],
            window: {
              start: "2026-03-15T09:00:00Z",
              end: "2026-03-15T17:00:00Z",
            },
            duration_minutes: 60,
            constraints: { prefer_morning: true },
            objective: "least_conflicts",
          },
        },
        id: 501,
      },
      authHeader,
      api,
    );

    expect(result.status).toBe(200);
    expect(result.body.error).toBeUndefined();
    const resultData = result.body.result as { content: Array<{ text: string }> };
    const session = JSON.parse(resultData.content[0].text);
    expect(session.session_id).toBeDefined();
    expect(session.candidates).toBeInstanceOf(Array);
  });

  it("handles no-candidates scenario with proper error (AC #5)", async () => {
    const authHeader = await makeAuthHeaderWithTier("premium");
    const api = createMockSchedulingApi({ noCandidates: true });

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.propose_times",
          arguments: {
            participants: [ACCOUNT_A.account_id],
            window: {
              start: "2026-03-15T09:00:00Z",
              end: "2026-03-15T17:00:00Z",
            },
            duration_minutes: 30,
          },
        },
        id: 502,
      },
      authHeader,
      api,
    );

    expect(result.status).toBe(200);
    const error = result.body.error as {
      code: number;
      message: string;
      data?: { code?: string };
    };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32602);
    expect(error.message).toContain("No candidate times found");
    expect(error.data?.code).toBe("NO_CANDIDATES");
  });

  it("rejects invalid input via Zod validation (missing participants)", async () => {
    const authHeader = await makeAuthHeaderWithTier("premium");
    const api = createMockSchedulingApi();

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.propose_times",
          arguments: {
            window: {
              start: "2026-03-15T09:00:00Z",
              end: "2026-03-15T17:00:00Z",
            },
            duration_minutes: 30,
          },
        },
        id: 503,
      },
      authHeader,
      api,
    );

    expect(result.status).toBe(200);
    const error = result.body.error as { code: number; message: string };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32602);
    expect(error.message).toContain("Invalid parameters");
  });

  it("rejects when duration_minutes is out of range", async () => {
    const authHeader = await makeAuthHeaderWithTier("premium");
    const api = createMockSchedulingApi();

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.propose_times",
          arguments: {
            participants: ["acc_001"],
            window: {
              start: "2026-03-15T09:00:00Z",
              end: "2026-03-15T17:00:00Z",
            },
            duration_minutes: 5,
          },
        },
        id: 504,
      },
      authHeader,
      api,
    );

    expect(result.status).toBe(200);
    const error = result.body.error as { code: number; message: string };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32602);
    expect(error.message).toContain("at least 15");
  });

  it("handles API error response", async () => {
    const authHeader = await makeAuthHeaderWithTier("premium");
    const api = createMockSchedulingApi({
      sessionResponse: { ok: false, error: "Internal scheduling error" },
      sessionStatus: 500,
    });

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.propose_times",
          arguments: {
            participants: ["acc_001"],
            window: {
              start: "2026-03-15T09:00:00Z",
              end: "2026-03-15T17:00:00Z",
            },
            duration_minutes: 30,
          },
        },
        id: 505,
      },
      authHeader,
      api,
    );

    expect(result.status).toBe(200);
    const error = result.body.error as { code: number; message: string };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32602);
    expect(error.message).toContain("Internal scheduling error");
  });

  it("routes through service binding (AC #6) -- verifies fetch is called", async () => {
    const authHeader = await makeAuthHeaderWithTier("premium");
    const fetchCalls: { url: string; method: string; body: unknown }[] = [];
    const api = {
      fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
        const url = typeof input === "string" ? input : input.url;
        const method = init?.method ?? "GET";
        const bodyText = init?.body as string | undefined;
        fetchCalls.push({ url, method, body: bodyText ? JSON.parse(bodyText) : null });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              data: {
                session_id: "sched_verified_001",
                candidates: [{ candidate_id: "cand_v1", score: 0.9, start: "2026-03-15T10:00:00Z", end: "2026-03-15T10:30:00Z" }],
              },
              meta: { request_id: "req_test", timestamp: new Date().toISOString() },
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          ),
        );
      },
      connect: vi.fn(),
    } as unknown as Fetcher;

    await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.propose_times",
          arguments: {
            participants: ["acc_001", "acc_002"],
            window: {
              start: "2026-03-15T09:00:00Z",
              end: "2026-03-15T17:00:00Z",
            },
            duration_minutes: 45,
          },
        },
        id: 506,
      },
      authHeader,
      api,
    );

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].method).toBe("POST");
    expect(fetchCalls[0].url).toContain("/v1/scheduling/sessions");
    const requestBody = fetchCalls[0].body as Record<string, unknown>;
    expect(requestBody.duration_minutes).toBe(45);
    expect(requestBody.window_start).toBe("2026-03-15T09:00:00Z");
    expect(requestBody.window_end).toBe("2026-03-15T17:00:00Z");
    expect(requestBody.required_account_ids).toEqual(["acc_001", "acc_002"]);
  });
});

describe("MCP integration: calendar.commit_candidate (TM-946.5)", () => {
  it("commits selected candidate and returns created event (AC #2)", async () => {
    const authHeader = await makeAuthHeaderWithTier("premium");
    const api = createMockSchedulingApi();

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.commit_candidate",
          arguments: {
            session_id: "sched_test_001",
            candidate_id: "cand_001",
          },
        },
        id: 600,
      },
      authHeader,
      api,
    );

    expect(result.status).toBe(200);
    expect(result.body.error).toBeUndefined();

    const resultData = result.body.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(resultData.content).toHaveLength(1);
    expect(resultData.content[0].type).toBe("text");

    const committed = JSON.parse(resultData.content[0].text);
    expect(committed.event_id).toBe("evt_committed_001");
    expect(committed.session.session_id).toBe("sched_test_001");
    expect(committed.session.status).toBe("committed");
  });

  it("rejects invalid input via Zod validation (missing session_id)", async () => {
    const authHeader = await makeAuthHeaderWithTier("premium");
    const api = createMockSchedulingApi();

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.commit_candidate",
          arguments: {
            candidate_id: "cand_001",
          },
        },
        id: 601,
      },
      authHeader,
      api,
    );

    expect(result.status).toBe(200);
    const error = result.body.error as { code: number; message: string };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32602);
    expect(error.message).toContain("Invalid parameters");
  });

  it("rejects invalid input via Zod validation (missing candidate_id)", async () => {
    const authHeader = await makeAuthHeaderWithTier("premium");
    const api = createMockSchedulingApi();

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.commit_candidate",
          arguments: {
            session_id: "sched_test_001",
          },
        },
        id: 602,
      },
      authHeader,
      api,
    );

    expect(result.status).toBe(200);
    const error = result.body.error as { code: number; message: string };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32602);
    expect(error.message).toContain("Invalid parameters");
  });

  it("handles session not found (404)", async () => {
    const authHeader = await makeAuthHeaderWithTier("premium");
    const api = createMockSchedulingApi({
      commitResponse: { ok: false, error: "Session not found" },
      commitStatus: 404,
    });

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.commit_candidate",
          arguments: {
            session_id: "sched_nonexistent",
            candidate_id: "cand_001",
          },
        },
        id: 603,
      },
      authHeader,
      api,
    );

    expect(result.status).toBe(200);
    const error = result.body.error as { code: number; message: string };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32602);
    expect(error.message).toContain("Session not found");
  });

  it("handles session already committed (409)", async () => {
    const authHeader = await makeAuthHeaderWithTier("premium");
    const api = createMockSchedulingApi({
      commitResponse: { ok: false, error: "Session already committed" },
      commitStatus: 409,
    });

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.commit_candidate",
          arguments: {
            session_id: "sched_committed",
            candidate_id: "cand_001",
          },
        },
        id: 604,
      },
      authHeader,
      api,
    );

    expect(result.status).toBe(200);
    const error = result.body.error as { code: number; message: string };
    expect(error).toBeDefined();
    expect(error.code).toBe(-32602);
    expect(error.message).toContain("already committed");
  });

  it("routes through service binding (AC #6) -- verifies fetch is called", async () => {
    const authHeader = await makeAuthHeaderWithTier("premium");
    const fetchCalls: { url: string; method: string; body: unknown }[] = [];
    const api = {
      fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
        const url = typeof input === "string" ? input : input.url;
        const method = init?.method ?? "GET";
        const bodyText = init?.body as string | undefined;
        fetchCalls.push({ url, method, body: bodyText ? JSON.parse(bodyText) : null });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              data: {
                event_id: "evt_verify_001",
                session: { session_id: "sched_verify_001", status: "committed" },
              },
              meta: { request_id: "req_test", timestamp: new Date().toISOString() },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      },
      connect: vi.fn(),
    } as unknown as Fetcher;

    await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.commit_candidate",
          arguments: {
            session_id: "sched_verify_001",
            candidate_id: "cand_v1",
          },
        },
        id: 606,
      },
      authHeader,
      api,
    );

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].method).toBe("POST");
    expect(fetchCalls[0].url).toContain("/v1/scheduling/sessions/sched_verify_001/commit");
    const requestBody = fetchCalls[0].body as Record<string, unknown>;
    expect(requestBody.candidate_id).toBe("cand_v1");
  });

  it("premium user can commit (tier check passes before execution)", async () => {
    const authHeader = await makeAuthHeaderWithTier("premium");
    const api = createMockSchedulingApi();

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.commit_candidate",
          arguments: {
            session_id: "sched_test_001",
            candidate_id: "cand_001",
          },
        },
        id: 607,
      },
      authHeader,
      api,
    );

    // Should not get TIER_REQUIRED error
    if (result.body.error) {
      const error = result.body.error as { data?: { code?: string } };
      expect(error.data?.code).not.toBe("TIER_REQUIRED");
    }
    expect(result.body.result).toBeDefined();
  });
});

describe("MCP integration: scheduling tools -- tools/list registration (TM-946.5)", () => {
  it("tools/list includes propose_times and commit_candidate", async () => {
    const authHeader = await makeAuthHeader();
    const result = await sendMcpRequest(
      { jsonrpc: "2.0", method: "tools/list", id: 700 },
      authHeader,
    );

    expect(result.status).toBe(200);
    const resultData = result.body.result as { tools: Array<{ name: string }> };
    const toolNames = resultData.tools.map((t) => t.name);
    expect(toolNames).toContain("calendar.propose_times");
    expect(toolNames).toContain("calendar.commit_candidate");
  });
});

// ---------------------------------------------------------------------------
// Governance commitment tools (TM-yke.6)
// ---------------------------------------------------------------------------

/**
 * Mock API Fetcher for governance commitment endpoints.
 *
 * Simulates:
 * - GET /v1/commitments/status -> returns commitment compliance list
 * - GET /v1/commitments/status?client=X -> returns filtered compliance
 * - POST /v1/commitments/:id/export -> returns proof download URL
 */
function createMockGovernanceApi(options?: {
  statusResponse?: unknown;
  exportResponse?: unknown;
  statusCode?: number;
  exportCode?: number;
}): Fetcher {
  const statusData = options?.statusResponse ?? {
    ok: true,
    data: {
      commitments: [
        {
          commitment_id: "cmt_01abc",
          client: "acme-corp",
          hours_committed: 40,
          hours_delivered: 38.5,
          compliance_pct: 96.25,
          window_start: "2026-02-01T00:00:00Z",
          window_end: "2026-02-28T23:59:59Z",
          status: "on_track",
        },
        {
          commitment_id: "cmt_02def",
          client: "globex",
          hours_committed: 20,
          hours_delivered: 12,
          compliance_pct: 60.0,
          window_start: "2026-02-01T00:00:00Z",
          window_end: "2026-02-28T23:59:59Z",
          status: "at_risk",
        },
      ],
    },
    meta: { request_id: "req_test", timestamp: new Date().toISOString() },
  };

  const exportData = options?.exportResponse ?? {
    ok: true,
    data: {
      commitment_id: "cmt_01abc",
      format: "pdf",
      download_url: "https://r2.tminus.ink/proofs/cmt_01abc/proof-2026-02-15.pdf",
      sha256: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      generated_at: "2026-02-15T12:00:00Z",
    },
    meta: { request_id: "req_test", timestamp: new Date().toISOString() },
  };

  return {
    fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input.url;
      const method = init?.method ?? "GET";

      // GET /v1/commitments/status (with optional ?client= query param)
      if (method === "GET" && url.includes("/v1/commitments/status")) {
        return Promise.resolve(
          new Response(JSON.stringify(statusData), {
            status: options?.statusCode ?? 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }

      // POST /v1/commitments/:id/export
      if (method === "POST" && url.includes("/export")) {
        return Promise.resolve(
          new Response(JSON.stringify(exportData), {
            status: options?.exportCode ?? 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }

      return Promise.resolve(
        new Response(JSON.stringify({ ok: false, error: "Unknown endpoint" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      );
    },
    connect: vi.fn() as unknown as Fetcher["connect"],
  } as unknown as Fetcher;
}

describe("MCP integration: governance commitment tools (TM-yke.6)", () => {
  // -- calendar.get_commitment_status: success path --
  it("calendar.get_commitment_status returns compliance for all commitments", async () => {
    const authHeader = await makeAuthHeaderWithTier("premium");
    const api = createMockGovernanceApi();

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.get_commitment_status",
          arguments: {},
        },
        id: 801,
      },
      authHeader,
      api,
    );

    expect(result.body.error).toBeUndefined();
    expect(result.body.result).toBeDefined();
    const content = (result.body.result as { content: Array<{ text: string }> }).content;
    const data = JSON.parse(content[0].text);
    expect(data.commitments).toBeDefined();
    expect(Array.isArray(data.commitments)).toBe(true);
    expect(data.commitments.length).toBe(2);
    expect(data.commitments[0].client).toBe("acme-corp");
    expect(data.commitments[0].compliance_pct).toBe(96.25);
  });

  it("calendar.get_commitment_status with client filter passes query param", async () => {
    const authHeader = await makeAuthHeaderWithTier("premium");
    let capturedUrl = "";
    const api = {
      fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
        capturedUrl = typeof input === "string" ? input : input.url;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              data: {
                commitments: [
                  {
                    commitment_id: "cmt_01abc",
                    client: "acme-corp",
                    hours_committed: 40,
                    hours_delivered: 38.5,
                    compliance_pct: 96.25,
                    status: "on_track",
                  },
                ],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      },
      connect: vi.fn() as unknown as Fetcher["connect"],
    } as unknown as Fetcher;

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.get_commitment_status",
          arguments: { client: "acme-corp" },
        },
        id: 802,
      },
      authHeader,
      api,
    );

    expect(result.body.error).toBeUndefined();
    expect(capturedUrl).toContain("/v1/commitments/status");
    expect(capturedUrl).toContain("client=acme-corp");
  });

  // -- calendar.export_commitment_proof: success path --
  it("calendar.export_commitment_proof returns download URL", async () => {
    const authHeader = await makeAuthHeaderWithTier("premium");
    const api = createMockGovernanceApi();

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.export_commitment_proof",
          arguments: { commitment_id: "cmt_01abc" },
        },
        id: 803,
      },
      authHeader,
      api,
    );

    expect(result.body.error).toBeUndefined();
    expect(result.body.result).toBeDefined();
    const content = (result.body.result as { content: Array<{ text: string }> }).content;
    const data = JSON.parse(content[0].text);
    expect(data.download_url).toContain("https://");
    expect(data.sha256).toBeDefined();
    expect(data.commitment_id).toBe("cmt_01abc");
  });

  it("calendar.export_commitment_proof with csv format routes correctly", async () => {
    const authHeader = await makeAuthHeaderWithTier("premium");
    let capturedBody: Record<string, unknown> = {};
    const api = {
      fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
        if (init?.body) {
          capturedBody = JSON.parse(init.body as string);
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              data: {
                commitment_id: "cmt_01abc",
                format: "csv",
                download_url: "https://r2.tminus.ink/proofs/cmt_01abc/proof-2026-02-15.csv",
                sha256: "abcdef1234567890",
                generated_at: "2026-02-15T12:00:00Z",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      },
      connect: vi.fn() as unknown as Fetcher["connect"],
    } as unknown as Fetcher;

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.export_commitment_proof",
          arguments: { commitment_id: "cmt_01abc", format: "csv" },
        },
        id: 804,
      },
      authHeader,
      api,
    );

    expect(result.body.error).toBeUndefined();
    expect(capturedBody.format).toBe("csv");
  });

  // -- Tier enforcement: free user denied --
  it("free user calling calendar.get_commitment_status is denied", async () => {
    const authHeader = await makeAuthHeaderWithTier("free");
    const api = createMockGovernanceApi();

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.get_commitment_status",
          arguments: {},
        },
        id: 805,
      },
      authHeader,
      api,
    );

    expect(result.body.error).toBeDefined();
    const error = result.body.error as { data?: { code?: string } };
    expect(error.data?.code).toBe("TIER_REQUIRED");
  });

  it("free user calling calendar.export_commitment_proof is denied", async () => {
    const authHeader = await makeAuthHeaderWithTier("free");
    const api = createMockGovernanceApi();

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.export_commitment_proof",
          arguments: { commitment_id: "cmt_01abc" },
        },
        id: 806,
      },
      authHeader,
      api,
    );

    expect(result.body.error).toBeDefined();
    const error = result.body.error as { data?: { code?: string } };
    expect(error.data?.code).toBe("TIER_REQUIRED");
  });

  // -- API error forwarding --
  it("calendar.get_commitment_status forwards API error", async () => {
    const authHeader = await makeAuthHeaderWithTier("premium");
    const api = createMockGovernanceApi({
      statusResponse: { ok: false, error: "Service temporarily unavailable" },
      statusCode: 503,
    });

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.get_commitment_status",
          arguments: {},
        },
        id: 807,
      },
      authHeader,
      api,
    );

    expect(result.body.error).toBeDefined();
    const error = result.body.error as { message: string };
    expect(error.message).toContain("Service temporarily unavailable");
  });

  it("calendar.export_commitment_proof forwards API error", async () => {
    const authHeader = await makeAuthHeaderWithTier("premium");
    const api = createMockGovernanceApi({
      exportResponse: { ok: false, error: "Commitment not found" },
      exportCode: 404,
    });

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.export_commitment_proof",
          arguments: { commitment_id: "cmt_nonexistent" },
        },
        id: 808,
      },
      authHeader,
      api,
    );

    expect(result.body.error).toBeDefined();
    const error = result.body.error as { message: string };
    expect(error.message).toContain("Commitment not found");
  });

  // -- Validation errors (bad input) --
  it("calendar.export_commitment_proof rejects missing commitment_id", async () => {
    const authHeader = await makeAuthHeaderWithTier("premium");
    const api = createMockGovernanceApi();

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.export_commitment_proof",
          arguments: {},
        },
        id: 809,
      },
      authHeader,
      api,
    );

    expect(result.body.error).toBeDefined();
    const error = result.body.error as { code: number; message: string };
    expect(error.code).toBe(-32602); // RPC_INVALID_PARAMS
    expect(error.message).toContain("commitment_id");
  });
});

describe("MCP integration: governance tools -- tools/list registration (TM-yke.6)", () => {
  it("tools/list includes all governance tools", async () => {
    const authHeader = await makeAuthHeader();
    const result = await sendMcpRequest(
      { jsonrpc: "2.0", method: "tools/list", id: 810 },
      authHeader,
    );

    expect(result.status).toBe(200);
    const resultData = result.body.result as { tools: Array<{ name: string }> };
    const toolNames = resultData.tools.map((t) => t.name);
    expect(toolNames).toContain("calendar.set_vip");
    expect(toolNames).toContain("calendar.tag_billable");
    expect(toolNames).toContain("calendar.get_commitment_status");
    expect(toolNames).toContain("calendar.export_commitment_proof");
  });
});

// ---------------------------------------------------------------------------
// Integration: relationship tools (TM-4wb.5)
// ---------------------------------------------------------------------------

/**
 * Create a mock API Fetcher that simulates the relationship/drift API endpoints.
 * Allows tests to verify the full MCP -> service binding -> API flow.
 */
function createMockRelationshipApi(options?: {
  addRelationshipResponse?: unknown;
  driftReportResponse?: unknown;
  markOutcomeResponse?: unknown;
  reconnectionResponse?: unknown;
  addRelationshipStatus?: number;
  driftReportStatus?: number;
  markOutcomeStatus?: number;
  reconnectionStatus?: number;
}): Fetcher {
  const defaultRelationship = {
    ok: true,
    data: {
      relationship_id: "rel_test_001",
      participant_hash: "abc123def456",
      display_name: "Sarah Chen",
      category: "FRIEND",
      closeness_weight: 0.8,
      city: "San Francisco",
      timezone: "America/Los_Angeles",
      interaction_frequency_target: 14,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    meta: { request_id: "req_test", timestamp: new Date().toISOString() },
  };

  const defaultDriftReport = {
    ok: true,
    data: {
      overdue: [
        {
          relationship_id: "rel_test_001",
          participant_hash: "abc123def456",
          display_name: "Sarah Chen",
          category: "FRIEND",
          closeness_weight: 0.8,
          last_interaction_ts: "2026-01-01T00:00:00Z",
          interaction_frequency_target: 14,
          days_since_interaction: 45,
          days_overdue: 31,
          drift_ratio: 3.2,
          urgency: 24.8,
        },
      ],
      total_tracked: 5,
      total_overdue: 1,
      computed_at: new Date().toISOString(),
    },
    meta: { request_id: "req_test", timestamp: new Date().toISOString() },
  };

  const defaultOutcome = {
    ok: true,
    data: {
      ledger_id: "led_test_001",
      participant_hash: "abc123def456",
      canonical_event_id: null,
      outcome: "ATTENDED",
      weight: 1.0,
      note: null,
      ts: new Date().toISOString(),
    },
    meta: { request_id: "req_test", timestamp: new Date().toISOString() },
  };

  const defaultReconnection = {
    ok: true,
    data: {
      city: "San Francisco",
      trip_id: null,
      trip_name: null,
      trip_start: null,
      trip_end: null,
      suggestions: [
        {
          relationship_id: "rel_test_002",
          participant_hash: "def456ghi789",
          display_name: "Mike Johnson",
          category: "COLLEAGUE",
          closeness_weight: 0.6,
          last_interaction_ts: "2025-12-01T00:00:00Z",
          interaction_frequency_target: 30,
          days_since_interaction: 76,
          days_overdue: 46,
          drift_ratio: 2.5,
          urgency: 27.6,
        },
      ],
      total_in_city: 3,
      total_overdue_in_city: 1,
      computed_at: new Date().toISOString(),
    },
    meta: { request_id: "req_test", timestamp: new Date().toISOString() },
  };

  return {
    fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input.url;
      const method = init?.method ?? "GET";

      // POST /v1/relationships -- create relationship
      if (method === "POST" && url.includes("/v1/relationships") && !url.includes("/outcomes")) {
        return Promise.resolve(
          new Response(
            JSON.stringify(options?.addRelationshipResponse ?? defaultRelationship),
            {
              status: options?.addRelationshipStatus ?? 201,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }

      // GET /v1/drift-report
      if (method === "GET" && url.includes("/v1/drift-report")) {
        return Promise.resolve(
          new Response(
            JSON.stringify(options?.driftReportResponse ?? defaultDriftReport),
            {
              status: options?.driftReportStatus ?? 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }

      // POST /v1/relationships/:id/outcomes
      if (method === "POST" && url.includes("/outcomes")) {
        return Promise.resolve(
          new Response(
            JSON.stringify(options?.markOutcomeResponse ?? defaultOutcome),
            {
              status: options?.markOutcomeStatus ?? 201,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }

      // GET /v1/reconnection-suggestions
      if (method === "GET" && url.includes("/v1/reconnection-suggestions")) {
        return Promise.resolve(
          new Response(
            JSON.stringify(options?.reconnectionResponse ?? defaultReconnection),
            {
              status: options?.reconnectionStatus ?? 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }

      return Promise.resolve(
        new Response(JSON.stringify({ ok: false, error: "Unknown endpoint" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      );
    },
    connect: vi.fn() as unknown as Fetcher["connect"],
  } as unknown as Fetcher;
}

describe("MCP integration: calendar.add_relationship (TM-4wb.5)", () => {
  it("creates a relationship via API service binding", async () => {
    const authHeader = await makeAuthHeaderWithTier("enterprise");
    const api = createMockRelationshipApi();

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.add_relationship",
          arguments: {
            participant_email: "sarah@example.com",
            display_name: "Sarah Chen",
            category: "FRIEND",
            closeness_weight: 0.8,
            city: "San Francisco",
            timezone: "America/Los_Angeles",
            frequency_target: 14,
          },
        },
        id: 700,
      },
      authHeader,
      api,
    );

    expect(result.status).toBe(200);
    expect(result.body.error).toBeUndefined();

    const resultData = result.body.result as {
      content: Array<{ type: string; text: string }>;
    };
    expect(resultData.content).toHaveLength(1);
    expect(resultData.content[0].type).toBe("text");

    const data = JSON.parse(resultData.content[0].text);
    expect(data.relationship_id).toBe("rel_test_001");
    expect(data.display_name).toBe("Sarah Chen");
    expect(data.category).toBe("FRIEND");
  });

  it("hashes participant email before sending to API (SHA-256)", async () => {
    const authHeader = await makeAuthHeaderWithTier("enterprise");
    let capturedBody: Record<string, unknown> | null = null;
    const api: Fetcher = {
      fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("/v1/relationships") && init?.method === "POST") {
          capturedBody = JSON.parse(init?.body as string);
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              data: {
                relationship_id: "rel_hash_test",
                participant_hash: "hashed_value",
                display_name: "Test",
                category: "OTHER",
              },
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          ),
        );
      },
      connect: vi.fn() as unknown as Fetcher["connect"],
    } as unknown as Fetcher;

    await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.add_relationship",
          arguments: {
            participant_email: "sarah@example.com",
            display_name: "Test",
            category: "OTHER",
          },
        },
        id: 701,
      },
      authHeader,
      api,
    );

    expect(capturedBody).not.toBeNull();
    // Must send participant_hash, NOT participant_email
    expect(capturedBody!.participant_hash).toBeDefined();
    expect(typeof capturedBody!.participant_hash).toBe("string");
    expect((capturedBody!.participant_hash as string).length).toBe(64); // SHA-256 = 64 hex chars
    // Must NOT send raw email
    expect(capturedBody!.participant_email).toBeUndefined();
  });

  it("rejects free tier with TIER_REQUIRED error", async () => {
    const authHeader = await makeAuthHeaderWithTier("free");
    const api = createMockRelationshipApi();

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.add_relationship",
          arguments: {
            participant_email: "test@example.com",
            display_name: "Test",
            category: "OTHER",
          },
        },
        id: 702,
      },
      authHeader,
      api,
    );

    expect(result.status).toBe(200);
    const error = result.body.error as { code: number; data: { code: string; required_tier: string } };
    expect(error).toBeDefined();
    expect(error.data.code).toBe("TIER_REQUIRED");
    expect(error.data.required_tier).toBe("enterprise");
  });

  it("rejects premium tier with TIER_REQUIRED error", async () => {
    const authHeader = await makeAuthHeaderWithTier("premium");
    const api = createMockRelationshipApi();

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.add_relationship",
          arguments: {
            participant_email: "test@example.com",
            display_name: "Test",
            category: "OTHER",
          },
        },
        id: 703,
      },
      authHeader,
      api,
    );

    expect(result.status).toBe(200);
    const error = result.body.error as { code: number; data: { code: string; required_tier: string } };
    expect(error).toBeDefined();
    expect(error.data.code).toBe("TIER_REQUIRED");
    expect(error.data.required_tier).toBe("enterprise");
  });
});

describe("MCP integration: calendar.get_drift_report (TM-4wb.5)", () => {
  it("returns drift report via API service binding", async () => {
    const authHeader = await makeAuthHeaderWithTier("enterprise");
    const api = createMockRelationshipApi();

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.get_drift_report",
          arguments: {},
        },
        id: 710,
      },
      authHeader,
      api,
    );

    expect(result.status).toBe(200);
    expect(result.body.error).toBeUndefined();

    const resultData = result.body.result as {
      content: Array<{ type: string; text: string }>;
    };
    const data = JSON.parse(resultData.content[0].text);
    expect(data.overdue).toBeInstanceOf(Array);
    expect(data.overdue.length).toBeGreaterThan(0);
    expect(data.total_tracked).toBe(5);
    expect(data.total_overdue).toBe(1);
    expect(data.overdue[0].display_name).toBe("Sarah Chen");
    expect(data.overdue[0].urgency).toBeGreaterThan(0);
  });

  it("rejects free tier with TIER_REQUIRED error", async () => {
    const authHeader = await makeAuthHeaderWithTier("free");
    const api = createMockRelationshipApi();

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.get_drift_report",
          arguments: {},
        },
        id: 711,
      },
      authHeader,
      api,
    );

    const error = result.body.error as { code: number; data: { code: string; required_tier: string } };
    expect(error).toBeDefined();
    expect(error.data.code).toBe("TIER_REQUIRED");
    expect(error.data.required_tier).toBe("enterprise");
  });
});

describe("MCP integration: calendar.mark_outcome (TM-4wb.5)", () => {
  it("records outcome via API service binding", async () => {
    const authHeader = await makeAuthHeaderWithTier("enterprise");
    const api = createMockRelationshipApi();

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.mark_outcome",
          arguments: {
            relationship_id: "rel_test_001",
            outcome: "ATTENDED",
            note: "Great meeting",
          },
        },
        id: 720,
      },
      authHeader,
      api,
    );

    expect(result.status).toBe(200);
    expect(result.body.error).toBeUndefined();

    const resultData = result.body.result as {
      content: Array<{ type: string; text: string }>;
    };
    const data = JSON.parse(resultData.content[0].text);
    expect(data.ledger_id).toBe("led_test_001");
    expect(data.outcome).toBe("ATTENDED");
  });

  it("rejects premium tier with TIER_REQUIRED error", async () => {
    const authHeader = await makeAuthHeaderWithTier("premium");
    const api = createMockRelationshipApi();

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.mark_outcome",
          arguments: {
            relationship_id: "rel_test_001",
            outcome: "ATTENDED",
          },
        },
        id: 721,
      },
      authHeader,
      api,
    );

    const error = result.body.error as { code: number; data: { code: string; required_tier: string } };
    expect(error).toBeDefined();
    expect(error.data.code).toBe("TIER_REQUIRED");
    expect(error.data.required_tier).toBe("enterprise");
  });
});

describe("MCP integration: calendar.get_reconnection_suggestions (TM-4wb.5)", () => {
  it("returns reconnection suggestions with city parameter", async () => {
    const authHeader = await makeAuthHeaderWithTier("enterprise");
    const api = createMockRelationshipApi();

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.get_reconnection_suggestions",
          arguments: {
            city: "San Francisco",
          },
        },
        id: 730,
      },
      authHeader,
      api,
    );

    expect(result.status).toBe(200);
    expect(result.body.error).toBeUndefined();

    const resultData = result.body.result as {
      content: Array<{ type: string; text: string }>;
    };
    const data = JSON.parse(resultData.content[0].text);
    expect(data.city).toBe("San Francisco");
    expect(data.suggestions).toBeInstanceOf(Array);
    expect(data.suggestions.length).toBeGreaterThan(0);
    expect(data.total_in_city).toBe(3);
    expect(data.total_overdue_in_city).toBe(1);
    expect(data.suggestions[0].display_name).toBe("Mike Johnson");
  });

  it("accepts trip_id parameter for city resolution", async () => {
    const authHeader = await makeAuthHeaderWithTier("enterprise");
    let capturedUrl: string | null = null;
    const api: Fetcher = {
      fetch(input: RequestInfo): Promise<Response> {
        capturedUrl = typeof input === "string" ? input : input.url;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              data: {
                city: "New York",
                trip_id: "constraint_trip123",
                trip_name: "NYC Trip",
                trip_start: "2026-04-01T00:00:00Z",
                trip_end: "2026-04-05T00:00:00Z",
                suggestions: [],
                total_in_city: 0,
                total_overdue_in_city: 0,
                computed_at: new Date().toISOString(),
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      },
      connect: vi.fn() as unknown as Fetcher["connect"],
    } as unknown as Fetcher;

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.get_reconnection_suggestions",
          arguments: {
            trip_id: "constraint_trip123",
          },
        },
        id: 731,
      },
      authHeader,
      api,
    );

    expect(result.status).toBe(200);
    expect(result.body.error).toBeUndefined();
    // Verify the trip_id was passed as query parameter
    expect(capturedUrl).toContain("trip_id=constraint_trip123");
  });

  it("passes both trip_id and city as query parameters", async () => {
    const authHeader = await makeAuthHeaderWithTier("enterprise");
    let capturedUrl: string | null = null;
    const api: Fetcher = {
      fetch(input: RequestInfo): Promise<Response> {
        capturedUrl = typeof input === "string" ? input : input.url;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              data: {
                city: "Boston",
                trip_id: "constraint_trip456",
                trip_name: null,
                trip_start: null,
                trip_end: null,
                suggestions: [],
                total_in_city: 0,
                total_overdue_in_city: 0,
                computed_at: new Date().toISOString(),
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      },
      connect: vi.fn() as unknown as Fetcher["connect"],
    } as unknown as Fetcher;

    await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.get_reconnection_suggestions",
          arguments: {
            trip_id: "constraint_trip456",
            city: "Boston",
          },
        },
        id: 732,
      },
      authHeader,
      api,
    );

    expect(capturedUrl).toContain("trip_id=constraint_trip456");
    expect(capturedUrl).toContain("city=Boston");
  });

  it("returns error when neither trip_id nor city provided", async () => {
    const authHeader = await makeAuthHeaderWithTier("enterprise");
    const api = createMockRelationshipApi();

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.get_reconnection_suggestions",
          arguments: {},
        },
        id: 733,
      },
      authHeader,
      api,
    );

    expect(result.status).toBe(200);
    const error = result.body.error as { code: number; message: string };
    expect(error).toBeDefined();
    expect(error.message).toContain("trip_id or city");
  });

  it("rejects free tier with TIER_REQUIRED error", async () => {
    const authHeader = await makeAuthHeaderWithTier("free");
    const api = createMockRelationshipApi();

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.get_reconnection_suggestions",
          arguments: { city: "Test" },
        },
        id: 734,
      },
      authHeader,
      api,
    );

    const error = result.body.error as { code: number; data: { code: string; required_tier: string } };
    expect(error).toBeDefined();
    expect(error.data.code).toBe("TIER_REQUIRED");
    expect(error.data.required_tier).toBe("enterprise");
  });

  it("rejects premium tier with TIER_REQUIRED error", async () => {
    const authHeader = await makeAuthHeaderWithTier("premium");
    const api = createMockRelationshipApi();

    const result = await sendMcpRequestWithApi(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "calendar.get_reconnection_suggestions",
          arguments: { city: "Test" },
        },
        id: 735,
      },
      authHeader,
      api,
    );

    const error = result.body.error as { code: number; data: { code: string; required_tier: string } };
    expect(error).toBeDefined();
    expect(error.data.code).toBe("TIER_REQUIRED");
    expect(error.data.required_tier).toBe("enterprise");
  });
});
