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
  it("returns all 6 tools including 4 event management tools", async () => {
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
    expect(resultData.tools.length).toBe(6);
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
