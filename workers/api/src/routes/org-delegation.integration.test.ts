/**
 * Integration tests for organization domain-wide delegation routes.
 *
 * Tests the full delegation lifecycle against real SQLite (via better-sqlite3):
 * 1. Register org with delegation validation (mock Google API)
 * 2. Duplicate domain registration rejected
 * 3. Delegation validation failure (mock Google API rejection)
 * 4. Fetch calendars for delegated user (success path)
 * 5. Fetch calendars for unregistered domain (404)
 * 6. Service account credentials encrypted (not plaintext in DB)
 * 7. Org user sees calendars without personal OAuth
 *
 * Uses real D1 mock backed by better-sqlite3 with the org_delegations migration.
 * Google API calls are mocked via injectable fetchFn.
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  MIGRATION_0001_INITIAL_SCHEMA,
  MIGRATION_0004_AUTH_FIELDS,
  MIGRATION_0022_ORG_DELEGATIONS,
} from "@tminus/d1-registry";
import {
  handleOrgRegister,
  handleDelegationCalendars,
} from "./org-delegation";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ADMIN_USER_ID = "usr_01HXYZ00000000000000000001";
const TEST_MASTER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// Generate a fresh RSA key pair at test runtime (no hardcoded PEM in source).
const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const TEST_SERVICE_ACCOUNT_KEY = {
  type: "service_account" as const,
  project_id: "tminus-test",
  private_key_id: "key-id-abc123",
  private_key: TEST_PRIVATE_KEY,
  client_email: "tminus-sa@tminus-test.iam.gserviceaccount.com",
  client_id: "123456789012345678901",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
};

// ---------------------------------------------------------------------------
// Real D1 mock backed by better-sqlite3
// ---------------------------------------------------------------------------

function createRealD1(db: DatabaseType): D1Database {
  const normalizeSQL = (sql: string): string => sql.replace(/\?(\d+)/g, "?");

  function makeBoundStatement(sql: string, params: unknown[]) {
    const normalizedSql = normalizeSQL(sql);
    return {
      bind(...extraParams: unknown[]) {
        return makeBoundStatement(sql, extraParams);
      },
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
      _sql: normalizedSql,
      _params: params,
    };
  }

  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return makeBoundStatement(sql, params);
        },
        first<T>(): Promise<T | null> {
          const stmt = db.prepare(normalizeSQL(sql));
          const row = stmt.get() as T | null;
          return Promise.resolve(row ?? null);
        },
        all<T>(): Promise<{ results: T[] }> {
          const stmt = db.prepare(normalizeSQL(sql));
          const rows = stmt.all() as T[];
          return Promise.resolve({ results: rows });
        },
        run(): Promise<D1Result<unknown>> {
          const stmt = db.prepare(normalizeSQL(sql));
          const info = stmt.run();
          return Promise.resolve({
            success: true,
            results: [],
            meta: { duration: 0, changes: info.changes },
          } as unknown as D1Result<unknown>);
        },
      };
    },
    exec(sql: string): Promise<D1ExecResult> {
      db.exec(sql);
      return Promise.resolve({ count: 0, duration: 0 });
    },
    batch(stmts: D1PreparedStatement[]): Promise<D1Result<unknown>[]> {
      const results: D1Result<unknown>[] = [];
      const run = db.transaction(() => {
        for (const stmt of stmts) {
          const s = stmt as unknown as { _sql: string; _params: unknown[] };
          const prepared = db.prepare(s._sql);
          const info = prepared.run(...s._params);
          results.push({
            success: true,
            results: [],
            meta: { duration: 0, changes: info.changes },
          } as unknown as D1Result<unknown>);
        }
      });
      run();
      return Promise.resolve(results);
    },
    dump(): Promise<ArrayBuffer> {
      return Promise.resolve(new ArrayBuffer(0));
    },
  } as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// Mock Google API fetchFn
// ---------------------------------------------------------------------------

/**
 * Creates a mock fetchFn that simulates Google API responses.
 * - Token exchange: returns a mock access token
 * - Calendar list: returns mock calendars
 */
function createSuccessMockFetch() {
  return async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as Request).url;

    // Token exchange endpoint
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({
          access_token: "ya29.mock-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Calendar list endpoint
    if (url.includes("/calendarList")) {
      return new Response(
        JSON.stringify({
          items: [
            { id: "primary", summary: "Work Calendar", primary: true, accessRole: "owner" },
            { id: "team@acme.com", summary: "Team Calendar", primary: false, accessRole: "reader" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Unexpected URL
    return new Response("Not found", { status: 404 });
  };
}

/**
 * Creates a mock fetchFn that simulates delegation failure.
 */
function createFailureMockFetch() {
  return async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as Request).url;

    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({
          error: "unauthorized_client",
          error_description: "Client is unauthorized to retrieve access tokens using this method",
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("Not found", { status: 404 });
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: unknown): Request {
  return new Request("https://api.tminus.ink/v1/orgs/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeGetRequest(url: string): Request {
  return new Request(url, { method: "GET" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("org-delegation integration", () => {
  let rawDb: DatabaseType;
  let d1: D1Database;
  let env: { DB: D1Database; MASTER_KEY: string };
  const auth = { userId: ADMIN_USER_ID };

  beforeEach(() => {
    rawDb = new Database(":memory:");
    rawDb.exec(MIGRATION_0001_INITIAL_SCHEMA);
    rawDb.exec(MIGRATION_0004_AUTH_FIELDS);
    rawDb.exec(MIGRATION_0022_ORG_DELEGATIONS);
    d1 = createRealD1(rawDb);
    env = { DB: d1, MASTER_KEY: TEST_MASTER_KEY };
  });

  // -----------------------------------------------------------------------
  // POST /v1/orgs/register
  // -----------------------------------------------------------------------

  describe("POST /v1/orgs/register", () => {
    it("registers org with active delegation on successful validation", async () => {
      const request = makeRequest({
        domain: "acme.com",
        admin_email: "admin@acme.com",
        service_account_key: TEST_SERVICE_ACCOUNT_KEY,
      });

      const mockFetch = createSuccessMockFetch();
      const response = await handleOrgRegister(request, auth, env, mockFetch);
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(201);
      expect(body.ok).toBe(true);

      const data = body.data as Record<string, unknown>;
      expect(data.domain).toBe("acme.com");
      expect(data.admin_email).toBe("admin@acme.com");
      expect(data.delegation_status).toBe("active");
      expect(data.sa_client_email).toBe("tminus-sa@tminus-test.iam.gserviceaccount.com");
      expect(data.sa_client_id).toBe("123456789012345678901");
      expect(data.delegation_id).toBeDefined();
      expect(data.validated_at).toBeDefined();
    });

    it("stores delegation record in D1", async () => {
      const request = makeRequest({
        domain: "acme.com",
        admin_email: "admin@acme.com",
        service_account_key: TEST_SERVICE_ACCOUNT_KEY,
      });

      const mockFetch = createSuccessMockFetch();
      await handleOrgRegister(request, auth, env, mockFetch);

      // Verify record in D1
      const row = rawDb.prepare("SELECT * FROM org_delegations WHERE domain = ?").get("acme.com") as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.domain).toBe("acme.com");
      expect(row.admin_email).toBe("admin@acme.com");
      expect(row.delegation_status).toBe("active");
      expect(row.sa_client_email).toBe("tminus-sa@tminus-test.iam.gserviceaccount.com");
    });

    it("encrypts service account credentials in D1 (AD-2)", async () => {
      const request = makeRequest({
        domain: "acme.com",
        admin_email: "admin@acme.com",
        service_account_key: TEST_SERVICE_ACCOUNT_KEY,
      });

      const mockFetch = createSuccessMockFetch();
      await handleOrgRegister(request, auth, env, mockFetch);

      // Verify encrypted_sa_key is NOT plaintext
      const row = rawDb.prepare("SELECT encrypted_sa_key FROM org_delegations WHERE domain = ?").get("acme.com") as Record<string, unknown>;
      const encryptedKey = row.encrypted_sa_key as string;

      // The encrypted key should be a JSON envelope, not the raw service account key
      expect(encryptedKey).not.toContain("PRIVATE KEY");
      expect(encryptedKey).not.toContain("service_account");
      expect(encryptedKey).not.toContain("tminus-test");

      // Should be a valid JSON envelope with iv, ciphertext, encryptedDek, dekIv
      const envelope = JSON.parse(encryptedKey);
      expect(envelope.iv).toBeDefined();
      expect(envelope.ciphertext).toBeDefined();
      expect(envelope.encryptedDek).toBeDefined();
      expect(envelope.dekIv).toBeDefined();
    });

    it("rejects duplicate domain registration (409)", async () => {
      const mockFetch = createSuccessMockFetch();

      // First registration succeeds
      const req1 = makeRequest({
        domain: "acme.com",
        admin_email: "admin@acme.com",
        service_account_key: TEST_SERVICE_ACCOUNT_KEY,
      });
      const resp1 = await handleOrgRegister(req1, auth, env, mockFetch);
      expect(resp1.status).toBe(201);

      // Second registration for same domain fails
      const req2 = makeRequest({
        domain: "acme.com",
        admin_email: "admin@acme.com",
        service_account_key: TEST_SERVICE_ACCOUNT_KEY,
      });
      const resp2 = await handleOrgRegister(req2, auth, env, mockFetch);
      const body2 = await resp2.json() as Record<string, unknown>;

      expect(resp2.status).toBe(409);
      expect(body2.ok).toBe(false);
      expect(body2.error).toContain("already registered");
    });

    it("rejects registration when delegation validation fails (422)", async () => {
      const mockFetch = createFailureMockFetch();

      const request = makeRequest({
        domain: "acme.com",
        admin_email: "admin@acme.com",
        service_account_key: TEST_SERVICE_ACCOUNT_KEY,
      });

      const response = await handleOrgRegister(request, auth, env, mockFetch);
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(422);
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Delegation validation failed");
    });

    it("rejects invalid input (400)", async () => {
      const request = makeRequest({ domain: "acme.com" }); // missing admin_email
      const response = await handleOrgRegister(request, auth, env);
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(400);
      expect(body.ok).toBe(false);
    });

    it("rejects when MASTER_KEY is not configured (500)", async () => {
      const envNoKey = { DB: d1, MASTER_KEY: undefined };
      const request = makeRequest({
        domain: "acme.com",
        admin_email: "admin@acme.com",
        service_account_key: TEST_SERVICE_ACCOUNT_KEY,
      });

      const response = await handleOrgRegister(request, auth, envNoKey);
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(500);
      expect(body.ok).toBe(false);
      expect(body.error).toContain("MASTER_KEY");
    });
  });

  // -----------------------------------------------------------------------
  // GET /v1/orgs/delegation/calendars/:email
  // -----------------------------------------------------------------------

  describe("GET /v1/orgs/delegation/calendars/:email", () => {
    beforeEach(async () => {
      // Register an org first
      const request = makeRequest({
        domain: "acme.com",
        admin_email: "admin@acme.com",
        service_account_key: TEST_SERVICE_ACCOUNT_KEY,
      });
      const mockFetch = createSuccessMockFetch();
      await handleOrgRegister(request, auth, env, mockFetch);
    });

    it("returns calendars for user in registered domain (success path)", async () => {
      const mockFetch = createSuccessMockFetch();
      const request = makeGetRequest("https://api.tminus.ink/v1/orgs/delegation/calendars/user@acme.com");

      const response = await handleDelegationCalendars(request, auth, env, "user@acme.com", mockFetch);
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);

      const data = body.data as Record<string, unknown>;
      expect(data.email).toBe("user@acme.com");
      expect(data.domain).toBe("acme.com");
      expect(data.source).toBe("delegation");

      const calendars = data.calendars as Array<Record<string, unknown>>;
      expect(calendars).toHaveLength(2);
      expect(calendars[0].id).toBe("primary");
      expect(calendars[0].summary).toBe("Work Calendar");
      expect(calendars[0].primary).toBe(true);
      expect(calendars[1].id).toBe("team@acme.com");
    });

    it("returns 404 for unregistered domain", async () => {
      const mockFetch = createSuccessMockFetch();
      const request = makeGetRequest("https://api.tminus.ink/v1/orgs/delegation/calendars/user@unknown.com");

      const response = await handleDelegationCalendars(request, auth, env, "user@unknown.com", mockFetch);
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(404);
      expect(body.ok).toBe(false);
      expect(body.error).toContain("No delegation found");
    });

    it("returns 400 for invalid email", async () => {
      const request = makeGetRequest("https://api.tminus.ink/v1/orgs/delegation/calendars/invalid");

      const response = await handleDelegationCalendars(request, auth, env, "invalid");
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(400);
      expect(body.ok).toBe(false);
    });

    it("returns 403 for revoked delegation", async () => {
      // Manually revoke the delegation
      rawDb.prepare("UPDATE org_delegations SET delegation_status = 'revoked' WHERE domain = ?").run("acme.com");

      const mockFetch = createSuccessMockFetch();
      const request = makeGetRequest("https://api.tminus.ink/v1/orgs/delegation/calendars/user@acme.com");

      const response = await handleDelegationCalendars(request, auth, env, "user@acme.com", mockFetch);
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(403);
      expect(body.ok).toBe(false);
      expect(body.error).toContain("revoked");
    });

    it("returns 502 when Google API call fails", async () => {
      const failFetch = createFailureMockFetch();
      const request = makeGetRequest("https://api.tminus.ink/v1/orgs/delegation/calendars/user@acme.com");

      const response = await handleDelegationCalendars(request, auth, env, "user@acme.com", failFetch);
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(502);
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Failed to fetch calendars");
    });

    it("returns 500 when MASTER_KEY is not configured", async () => {
      const envNoKey = { DB: d1, MASTER_KEY: undefined };
      const request = makeGetRequest("https://api.tminus.ink/v1/orgs/delegation/calendars/user@acme.com");

      const response = await handleDelegationCalendars(request, auth, envNoKey, "user@acme.com");
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(500);
      expect(body.ok).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // End-to-end: org user sees calendar without personal OAuth
  // -----------------------------------------------------------------------

  describe("end-to-end: org user sees calendar without personal OAuth", () => {
    it("registers org, then user fetches calendars without any OAuth consent", async () => {
      const mockFetch = createSuccessMockFetch();

      // Step 1: Admin registers the org
      const registerRequest = makeRequest({
        domain: "workspace-org.com",
        admin_email: "admin@workspace-org.com",
        service_account_key: TEST_SERVICE_ACCOUNT_KEY,
      });
      const registerResponse = await handleOrgRegister(registerRequest, auth, env, mockFetch);
      expect(registerResponse.status).toBe(201);

      // Step 2: Regular user in the org fetches their calendars
      // NO OAuth consent, NO personal access token -- just their email
      const calRequest = makeGetRequest(
        "https://api.tminus.ink/v1/orgs/delegation/calendars/employee@workspace-org.com",
      );
      const calResponse = await handleDelegationCalendars(
        calRequest,
        { userId: "usr_random_user" }, // Different user than admin
        env,
        "employee@workspace-org.com",
        mockFetch,
      );
      const calBody = await calResponse.json() as Record<string, unknown>;

      expect(calResponse.status).toBe(200);
      expect(calBody.ok).toBe(true);

      const data = calBody.data as Record<string, unknown>;
      expect(data.email).toBe("employee@workspace-org.com");
      expect(data.source).toBe("delegation");
      expect((data.calendars as unknown[]).length).toBeGreaterThan(0);
    });
  });
});
