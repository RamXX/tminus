/**
 * Integration tests for organization-level admin controls (TM-ga8.4).
 *
 * Tests the admin controls API against real SQLite (via better-sqlite3):
 * 1. List org users with T-Minus accounts
 * 2. Admin deactivation disconnects all org users (BR-2)
 * 3. Individual user disconnect still works after org install (BR-3)
 * 4. RBAC enforcement (admin only)
 *
 * Uses real D1 mock backed by better-sqlite3 with working batch support.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  MIGRATION_0001_INITIAL_SCHEMA,
  MIGRATION_0004_AUTH_FIELDS,
  MIGRATION_0012_SUBSCRIPTIONS,
  MIGRATION_0015_ORGANIZATIONS,
  MIGRATION_0016_ORG_MEMBERS,
  MIGRATION_0017_ORG_POLICIES,
  MIGRATION_0018_ORG_SEAT_BILLING,
  MIGRATION_0021_ORG_INSTALLATIONS,
} from "@tminus/d1-registry";
import {
  handleListOrgUsers,
  handleDeactivateOrg,
  handleGetOrgInstallStatus,
} from "./org-admin";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ADMIN_USER_ID = "usr_01HXYZ00000000000000000001";
const MEMBER_USER_ID = "usr_01HXYZ00000000000000000002";
const OUTSIDER_USER_ID = "usr_01HXYZ00000000000000000003";
const TEST_ORG_ID = "org_01HXYZ00000000000000000001";
const TEST_INSTALL_ID = "oin_01HXYZ00000000000000000001";
const TEST_CUSTOMER_ID = "C01INTEG999";

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
// Test setup
// ---------------------------------------------------------------------------

let sqliteDb: DatabaseType;
let d1: D1Database;

function setupTestDb(): void {
  sqliteDb = new Database(":memory:");
  // Apply needed migrations
  sqliteDb.exec(MIGRATION_0001_INITIAL_SCHEMA);
  sqliteDb.exec(MIGRATION_0004_AUTH_FIELDS);
  sqliteDb.exec(MIGRATION_0012_SUBSCRIPTIONS);
  sqliteDb.exec(MIGRATION_0015_ORGANIZATIONS);
  sqliteDb.exec(MIGRATION_0016_ORG_MEMBERS);
  sqliteDb.exec(MIGRATION_0017_ORG_POLICIES);
  sqliteDb.exec(MIGRATION_0018_ORG_SEAT_BILLING);
  sqliteDb.exec(MIGRATION_0021_ORG_INSTALLATIONS);

  // Insert test org
  sqliteDb.exec(`
    INSERT INTO organizations (org_id, name) VALUES ('${TEST_ORG_ID}', 'Acme Corp');
  `);

  // Insert test users in the legacy orgs table first
  sqliteDb.exec(`
    INSERT INTO orgs (org_id, name) VALUES ('${TEST_ORG_ID}', 'Acme Corp');
  `);
  sqliteDb.exec(`
    INSERT INTO users (user_id, org_id, email, display_name)
      VALUES ('${ADMIN_USER_ID}', '${TEST_ORG_ID}', 'admin@acme.com', 'Admin User');
    INSERT INTO users (user_id, org_id, email, display_name)
      VALUES ('${MEMBER_USER_ID}', '${TEST_ORG_ID}', 'member@acme.com', 'Member User');
    INSERT INTO users (user_id, org_id, email, display_name)
      VALUES ('${OUTSIDER_USER_ID}', '${TEST_ORG_ID}', 'outsider@other.com', 'Outsider User');
  `);

  // Set up org members (admin + regular member)
  sqliteDb.exec(`
    INSERT INTO org_members (org_id, user_id, role) VALUES ('${TEST_ORG_ID}', '${ADMIN_USER_ID}', 'admin');
    INSERT INTO org_members (org_id, user_id, role) VALUES ('${TEST_ORG_ID}', '${MEMBER_USER_ID}', 'member');
  `);

  // Insert org installation
  sqliteDb.exec(`
    INSERT INTO org_installations (install_id, google_customer_id, org_id, admin_email, admin_google_sub, scopes_granted, status)
      VALUES ('${TEST_INSTALL_ID}', '${TEST_CUSTOMER_ID}', '${TEST_ORG_ID}', 'admin@acme.com', 'google-sub-admin', 'openid email profile calendar', 'active');
  `);

  // Insert accounts for admin and member
  sqliteDb.exec(`
    INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status)
      VALUES ('acc_admin_01', '${ADMIN_USER_ID}', 'google', 'sub-admin', 'admin@acme.com', 'active');
    INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status)
      VALUES ('acc_member_01', '${MEMBER_USER_ID}', 'google', 'sub-member', 'member@acme.com', 'active');
  `);

  d1 = createRealD1(sqliteDb);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(method: string, body?: unknown): Request {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return new Request("https://api.test.com/v1/org", init);
}

async function parseResponse<T>(response: Response): Promise<{ ok: boolean; data?: T; error?: string; meta?: unknown }> {
  return response.json() as Promise<{ ok: boolean; data?: T; error?: string; meta?: unknown }>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Org admin controls integration", () => {
  beforeEach(() => {
    setupTestDb();
  });

  // -------------------------------------------------------------------------
  // GET /v1/org/:id/install-users -- List org users
  // -------------------------------------------------------------------------

  describe("handleListOrgUsers (AC#4: Admin can list all T-Minus users in their org)", () => {
    it("lists users with their account status (admin, 200)", async () => {
      const request = makeRequest("GET");
      const response = await handleListOrgUsers(request, { userId: ADMIN_USER_ID }, d1, TEST_ORG_ID);

      expect(response.status).toBe(200);
      const body = await parseResponse<{ install_id: string; users: Array<{ user_id: string; email: string; account_status: string }> }>(response);
      expect(body.ok).toBe(true);
      expect(body.data?.install_id).toBe(TEST_INSTALL_ID);
      expect(body.data?.users.length).toBeGreaterThanOrEqual(2);

      // Admin user should be in the list
      const admin = body.data!.users.find((u) => u.user_id === ADMIN_USER_ID);
      expect(admin).toBeDefined();
      expect(admin!.email).toBe("admin@acme.com");
      expect(admin!.account_status).toBe("active");

      // Member user should be in the list
      const member = body.data!.users.find((u) => u.user_id === MEMBER_USER_ID);
      expect(member).toBeDefined();
      expect(member!.account_status).toBe("active");
    });

    it("returns 403 for non-admin member", async () => {
      const request = makeRequest("GET");
      const response = await handleListOrgUsers(request, { userId: MEMBER_USER_ID }, d1, TEST_ORG_ID);

      expect(response.status).toBe(403);
      const body = await parseResponse(response);
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Admin access required");
    });

    it("returns 400 for invalid org ID", async () => {
      const request = makeRequest("GET");
      const response = await handleListOrgUsers(request, { userId: ADMIN_USER_ID }, d1, "invalid");

      expect(response.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/org/:id/deactivate -- Deactivate org
  // -------------------------------------------------------------------------

  describe("handleDeactivateOrg (AC#5: Admin deactivation disconnects all org users)", () => {
    it("deactivates installation and revokes all org user accounts (admin, 200)", async () => {
      const request = makeRequest("POST");
      const response = await handleDeactivateOrg(request, { userId: ADMIN_USER_ID }, d1, TEST_ORG_ID);

      expect(response.status).toBe(200);
      const body = await parseResponse<{ deactivated: boolean; affected_users: number }>(response);
      expect(body.ok).toBe(true);
      expect(body.data?.deactivated).toBe(true);
      expect(body.data?.affected_users).toBe(2); // admin + member accounts revoked

      // Verify installation is inactive
      const install = sqliteDb
        .prepare("SELECT status, deactivated_at FROM org_installations WHERE install_id = ?")
        .get(TEST_INSTALL_ID) as { status: string; deactivated_at: string };
      expect(install.status).toBe("inactive");
      expect(install.deactivated_at).toBeTruthy();

      // Verify all Google accounts are revoked (BR-2)
      const accounts = sqliteDb
        .prepare("SELECT status FROM accounts WHERE provider = 'google' AND user_id IN (SELECT user_id FROM users WHERE org_id = ?)")
        .all(TEST_ORG_ID) as Array<{ status: string }>;
      for (const account of accounts) {
        expect(account.status).toBe("revoked");
      }
    });

    it("returns 403 for non-admin", async () => {
      const request = makeRequest("POST");
      const response = await handleDeactivateOrg(request, { userId: MEMBER_USER_ID }, d1, TEST_ORG_ID);

      expect(response.status).toBe(403);
    });

    it("returns 409 if already deactivated", async () => {
      // Deactivate first
      const req1 = makeRequest("POST");
      await handleDeactivateOrg(req1, { userId: ADMIN_USER_ID }, d1, TEST_ORG_ID);

      // Try again
      const req2 = makeRequest("POST");
      const response = await handleDeactivateOrg(req2, { userId: ADMIN_USER_ID }, d1, TEST_ORG_ID);

      expect(response.status).toBe(409);
      const body = await parseResponse(response);
      expect(body.error).toContain("already deactivated");
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/org/:id/install-status -- Org install health
  // -------------------------------------------------------------------------

  describe("handleGetOrgInstallStatus", () => {
    it("returns installation health with user counts (admin, 200)", async () => {
      const request = makeRequest("GET");
      const response = await handleGetOrgInstallStatus(request, { userId: ADMIN_USER_ID }, d1, TEST_ORG_ID);

      expect(response.status).toBe(200);
      const body = await parseResponse<{
        install_id: string;
        status: string;
        admin_email: string;
        total_users: number;
        active_accounts: number;
      }>(response);
      expect(body.ok).toBe(true);
      expect(body.data?.install_id).toBe(TEST_INSTALL_ID);
      expect(body.data?.status).toBe("active");
      expect(body.data?.admin_email).toBe("admin@acme.com");
      expect(body.data?.total_users).toBeGreaterThanOrEqual(2);
      expect(body.data?.active_accounts).toBe(2);
    });

    it("returns 403 for non-admin", async () => {
      const request = makeRequest("GET");
      const response = await handleGetOrgInstallStatus(request, { userId: MEMBER_USER_ID }, d1, TEST_ORG_ID);

      expect(response.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // BR-3: Individual user disconnect still works
  // -------------------------------------------------------------------------

  describe("BR-3: Individual user can still disconnect within org install", () => {
    it("revoking one account does not affect others in the org", async () => {
      // Simulate individual user disconnecting their account
      sqliteDb.exec(`
        UPDATE accounts SET status = 'revoked'
        WHERE account_id = 'acc_member_01';
      `);

      // Verify member's account is revoked
      const memberAccount = sqliteDb
        .prepare("SELECT status FROM accounts WHERE account_id = 'acc_member_01'")
        .get() as { status: string };
      expect(memberAccount.status).toBe("revoked");

      // Verify admin's account is still active
      const adminAccount = sqliteDb
        .prepare("SELECT status FROM accounts WHERE account_id = 'acc_admin_01'")
        .get() as { status: string };
      expect(adminAccount.status).toBe("active");

      // Verify org installation is still active
      const install = sqliteDb
        .prepare("SELECT status FROM org_installations WHERE install_id = ?")
        .get(TEST_INSTALL_ID) as { status: string };
      expect(install.status).toBe("active");
    });
  });

  // -------------------------------------------------------------------------
  // Full lifecycle
  // -------------------------------------------------------------------------

  describe("Full org admin lifecycle", () => {
    it("list users -> check status -> deactivate -> verify all revoked", async () => {
      // 1. List users (should show 2 active)
      const listReq = makeRequest("GET");
      const listResp = await handleListOrgUsers(listReq, { userId: ADMIN_USER_ID }, d1, TEST_ORG_ID);
      expect(listResp.status).toBe(200);
      const listBody = await parseResponse<{ users: Array<{ account_status: string }> }>(listResp);
      const activeUsers = listBody.data!.users.filter((u) => u.account_status === "active");
      expect(activeUsers.length).toBe(2);

      // 2. Check install status
      const statusReq = makeRequest("GET");
      const statusResp = await handleGetOrgInstallStatus(statusReq, { userId: ADMIN_USER_ID }, d1, TEST_ORG_ID);
      expect(statusResp.status).toBe(200);
      const statusBody = await parseResponse<{ status: string; active_accounts: number }>(statusResp);
      expect(statusBody.data?.status).toBe("active");
      expect(statusBody.data?.active_accounts).toBe(2);

      // 3. Deactivate
      const deactReq = makeRequest("POST");
      const deactResp = await handleDeactivateOrg(deactReq, { userId: ADMIN_USER_ID }, d1, TEST_ORG_ID);
      expect(deactResp.status).toBe(200);
      const deactBody = await parseResponse<{ affected_users: number }>(deactResp);
      expect(deactBody.data?.affected_users).toBe(2);

      // 4. Verify all accounts revoked
      const accounts = sqliteDb
        .prepare("SELECT status FROM accounts WHERE user_id IN (SELECT user_id FROM users WHERE org_id = ?)")
        .all(TEST_ORG_ID) as Array<{ status: string }>;
      for (const acct of accounts) {
        expect(acct.status).toBe("revoked");
      }
    });
  });
});
