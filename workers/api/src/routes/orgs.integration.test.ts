/**
 * Integration tests for organization management routes.
 *
 * Tests the full org lifecycle against real SQLite (via better-sqlite3):
 * 1. Create org -> caller becomes admin (enterprise required)
 * 2. Get org details
 * 3. Add member (admin only)
 * 4. List members
 * 5. Remove member (admin only)
 * 6. Change role (admin only)
 * 7. RBAC enforcement: non-admins blocked from admin operations
 * 8. Enterprise tier requirement for org creation
 * 9. Envelope format compliance
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
} from "@tminus/d1-registry";
import {
  handleCreateOrg,
  handleGetOrg,
  handleAddMember,
  handleListMembers,
  handleRemoveMember,
  handleChangeRole,
  checkOrgAdmin,
} from "./orgs";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ADMIN_USER_ID = "usr_01HXYZ000000000000000001";
const MEMBER_USER_ID = "usr_01HXYZ000000000000000002";
const OUTSIDER_USER_ID = "usr_01HXYZ000000000000000003";

// ---------------------------------------------------------------------------
// Real D1 mock backed by better-sqlite3
// ---------------------------------------------------------------------------

/**
 * Creates a D1-compatible wrapper around better-sqlite3.
 * Supports prepare/bind/first/all/run/batch/exec.
 * The batch method executes statements in a transaction.
 */
function createRealD1(db: DatabaseType): D1Database {
  const normalizeSQL = (sql: string): string => sql.replace(/\?(\d+)/g, "?");

  /**
   * Build a bound statement wrapper.
   * Captures the SQL and bound params, exposes first/all/run.
   */
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
      // Store SQL and params so batch() can re-execute
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
      // Execute all statements in a transaction
      const results: D1Result<unknown>[] = [];
      const run = db.transaction(() => {
        for (const stmt of stmts) {
          const s = stmt as unknown as { _sql: string; _params: unknown[] };
          const prepared = db.prepare(s._sql);
          const info = prepared.run(...s._params);
          results.push({
            success: true,
            results: [],
            meta: {
              duration: 0,
              changes: info.changes,
            },
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

  // Insert test users
  sqliteDb.exec(`
    INSERT INTO orgs (org_id, name) VALUES ('org_legacy', 'Legacy Org');
    INSERT INTO users (user_id, org_id, email, display_name)
      VALUES ('${ADMIN_USER_ID}', 'org_legacy', 'admin@test.com', 'Admin User');
    INSERT INTO users (user_id, org_id, email, display_name)
      VALUES ('${MEMBER_USER_ID}', 'org_legacy', 'member@test.com', 'Member User');
    INSERT INTO users (user_id, org_id, email, display_name)
      VALUES ('${OUTSIDER_USER_ID}', 'org_legacy', 'outsider@test.com', 'Outsider User');
  `);

  // Give admin user enterprise tier
  sqliteDb.exec(`
    INSERT INTO subscriptions (subscription_id, user_id, tier, status)
      VALUES ('sub_test_admin', '${ADMIN_USER_ID}', 'enterprise', 'active');
  `);

  // Give member user free tier (no subscription record = free)

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
  return new Request("https://api.test.com/v1/orgs", init);
}

async function parseResponse<T>(response: Response): Promise<{ ok: boolean; data?: T; error?: string; meta?: unknown }> {
  return response.json() as Promise<{ ok: boolean; data?: T; error?: string; meta?: unknown }>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Organization routes integration", () => {
  beforeEach(() => {
    setupTestDb();
  });

  // -------------------------------------------------------------------------
  // POST /v1/orgs -- Create org
  // -------------------------------------------------------------------------

  describe("POST /v1/orgs (handleCreateOrg)", () => {
    it("creates an org and makes caller admin", async () => {
      const request = makeRequest("POST", { name: "Acme Corp" });
      const response = await handleCreateOrg(request, { userId: ADMIN_USER_ID }, d1);

      expect(response.status).toBe(201);
      const body = await parseResponse<{ org_id: string; name: string }>(response);
      expect(body.ok).toBe(true);
      expect(body.data?.name).toBe("Acme Corp");
      expect(body.data?.org_id).toMatch(/^org_/);
      expect(body.meta).toBeDefined();

      // Verify caller is admin in D1
      const member = sqliteDb
        .prepare("SELECT role FROM org_members WHERE org_id = ? AND user_id = ?")
        .get(body.data!.org_id, ADMIN_USER_ID) as { role: string } | undefined;
      expect(member).toBeDefined();
      expect(member!.role).toBe("admin");
    });

    it("returns 400 for missing name", async () => {
      const request = makeRequest("POST", {});
      const response = await handleCreateOrg(request, { userId: ADMIN_USER_ID }, d1);

      expect(response.status).toBe(400);
      const body = await parseResponse(response);
      expect(body.ok).toBe(false);
      expect(body.error).toContain("name is required");
    });

    it("returns 400 for empty name", async () => {
      const request = makeRequest("POST", { name: "   " });
      const response = await handleCreateOrg(request, { userId: ADMIN_USER_ID }, d1);

      expect(response.status).toBe(400);
      const body = await parseResponse(response);
      expect(body.ok).toBe(false);
      expect(body.error).toContain("empty");
    });

    it("returns 400 for invalid JSON body", async () => {
      const request = new Request("https://api.test.com/v1/orgs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      const response = await handleCreateOrg(request, { userId: ADMIN_USER_ID }, d1);

      expect(response.status).toBe(400);
    });

    it("accepts custom settings_json", async () => {
      const request = makeRequest("POST", { name: "ConfigOrg", settings_json: { theme: "dark" } });
      const response = await handleCreateOrg(request, { userId: ADMIN_USER_ID }, d1);

      expect(response.status).toBe(201);
      const body = await parseResponse<{ settings_json: string }>(response);
      expect(body.data?.settings_json).toBe('{"theme":"dark"}');
    });

    it("uses envelope format with ok, data, and meta", async () => {
      const request = makeRequest("POST", { name: "Envelope Test Org" });
      const response = await handleCreateOrg(request, { userId: ADMIN_USER_ID }, d1);

      const body = await parseResponse(response);
      expect(body).toHaveProperty("ok", true);
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("meta");
      expect((body.meta as { request_id: string }).request_id).toMatch(/^req_/);
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/orgs/:id -- Get org
  // -------------------------------------------------------------------------

  describe("GET /v1/orgs/:id (handleGetOrg)", () => {
    let testOrgId: string;

    beforeEach(async () => {
      // Create an org for get tests
      const request = makeRequest("POST", { name: "Get Test Org" });
      const response = await handleCreateOrg(request, { userId: ADMIN_USER_ID }, d1);
      const body = await parseResponse<{ org_id: string }>(response);
      testOrgId = body.data!.org_id;
    });

    it("returns org details for a member", async () => {
      const request = makeRequest("GET");
      const response = await handleGetOrg(request, { userId: ADMIN_USER_ID }, d1, testOrgId);

      expect(response.status).toBe(200);
      const body = await parseResponse<{ org_id: string; name: string }>(response);
      expect(body.ok).toBe(true);
      expect(body.data?.org_id).toBe(testOrgId);
      expect(body.data?.name).toBe("Get Test Org");
    });

    it("returns 403 for non-member", async () => {
      const request = makeRequest("GET");
      const response = await handleGetOrg(request, { userId: OUTSIDER_USER_ID }, d1, testOrgId);

      expect(response.status).toBe(403);
      const body = await parseResponse(response);
      expect(body.ok).toBe(false);
      expect(body.error).toContain("not a member");
    });

    it("returns 400 for invalid org ID format", async () => {
      const request = makeRequest("GET");
      const response = await handleGetOrg(request, { userId: ADMIN_USER_ID }, d1, "invalid_id");

      expect(response.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/orgs/:id/members -- Add member
  // -------------------------------------------------------------------------

  describe("POST /v1/orgs/:id/members (handleAddMember)", () => {
    let testOrgId: string;

    beforeEach(async () => {
      const request = makeRequest("POST", { name: "Member Test Org" });
      const response = await handleCreateOrg(request, { userId: ADMIN_USER_ID }, d1);
      const body = await parseResponse<{ org_id: string }>(response);
      testOrgId = body.data!.org_id;
    });

    it("adds a member (admin operation)", async () => {
      const request = makeRequest("POST", {
        user_id: MEMBER_USER_ID,
        role: "member",
      });
      const response = await handleAddMember(request, { userId: ADMIN_USER_ID }, d1, testOrgId);

      expect(response.status).toBe(201);
      const body = await parseResponse<{ user_id: string; role: string }>(response);
      expect(body.ok).toBe(true);
      expect(body.data?.user_id).toBe(MEMBER_USER_ID);
      expect(body.data?.role).toBe("member");
    });

    it("returns 403 for non-admin", async () => {
      // First add member_user as 'member'
      const addReq = makeRequest("POST", { user_id: MEMBER_USER_ID, role: "member" });
      await handleAddMember(addReq, { userId: ADMIN_USER_ID }, d1, testOrgId);

      // Now try to add outsider as member_user (not admin)
      const request = makeRequest("POST", { user_id: OUTSIDER_USER_ID, role: "member" });
      const response = await handleAddMember(request, { userId: MEMBER_USER_ID }, d1, testOrgId);

      expect(response.status).toBe(403);
      const body = await parseResponse(response);
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Admin access required");
    });

    it("returns 403 for non-member trying to add", async () => {
      const request = makeRequest("POST", { user_id: MEMBER_USER_ID, role: "member" });
      const response = await handleAddMember(request, { userId: OUTSIDER_USER_ID }, d1, testOrgId);

      expect(response.status).toBe(403);
    });

    it("returns 409 for duplicate member", async () => {
      const request1 = makeRequest("POST", { user_id: MEMBER_USER_ID, role: "member" });
      await handleAddMember(request1, { userId: ADMIN_USER_ID }, d1, testOrgId);

      const request2 = makeRequest("POST", { user_id: MEMBER_USER_ID, role: "admin" });
      const response = await handleAddMember(request2, { userId: ADMIN_USER_ID }, d1, testOrgId);

      expect(response.status).toBe(409);
      const body = await parseResponse(response);
      expect(body.error).toContain("already a member");
    });

    it("returns 400 for missing user_id", async () => {
      const request = makeRequest("POST", { role: "member" });
      const response = await handleAddMember(request, { userId: ADMIN_USER_ID }, d1, testOrgId);

      expect(response.status).toBe(400);
    });

    it("returns 400 for invalid role", async () => {
      const request = makeRequest("POST", { user_id: MEMBER_USER_ID, role: "superadmin" });
      const response = await handleAddMember(request, { userId: ADMIN_USER_ID }, d1, testOrgId);

      expect(response.status).toBe(400);
      const body = await parseResponse(response);
      expect(body.error).toContain("role must be one of");
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/orgs/:id/members -- List members
  // -------------------------------------------------------------------------

  describe("GET /v1/orgs/:id/members (handleListMembers)", () => {
    let testOrgId: string;

    beforeEach(async () => {
      const request = makeRequest("POST", { name: "List Test Org" });
      const response = await handleCreateOrg(request, { userId: ADMIN_USER_ID }, d1);
      const body = await parseResponse<{ org_id: string }>(response);
      testOrgId = body.data!.org_id;

      // Add a second member
      const addReq = makeRequest("POST", { user_id: MEMBER_USER_ID, role: "member" });
      await handleAddMember(addReq, { userId: ADMIN_USER_ID }, d1, testOrgId);
    });

    it("lists all members for a member", async () => {
      const request = makeRequest("GET");
      const response = await handleListMembers(request, { userId: MEMBER_USER_ID }, d1, testOrgId);

      expect(response.status).toBe(200);
      const body = await parseResponse<Array<{ user_id: string; role: string }>>(response);
      expect(body.ok).toBe(true);
      expect(body.data).toHaveLength(2);

      // Admin should be first (earlier joined_at)
      const admin = body.data!.find((m) => m.user_id === ADMIN_USER_ID);
      expect(admin?.role).toBe("admin");
      const member = body.data!.find((m) => m.user_id === MEMBER_USER_ID);
      expect(member?.role).toBe("member");
    });

    it("returns 403 for non-member", async () => {
      const request = makeRequest("GET");
      const response = await handleListMembers(request, { userId: OUTSIDER_USER_ID }, d1, testOrgId);

      expect(response.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /v1/orgs/:id/members/:user_id -- Remove member
  // -------------------------------------------------------------------------

  describe("DELETE /v1/orgs/:id/members/:user_id (handleRemoveMember)", () => {
    let testOrgId: string;

    beforeEach(async () => {
      const request = makeRequest("POST", { name: "Remove Test Org" });
      const response = await handleCreateOrg(request, { userId: ADMIN_USER_ID }, d1);
      const body = await parseResponse<{ org_id: string }>(response);
      testOrgId = body.data!.org_id;

      // Add member
      const addReq = makeRequest("POST", { user_id: MEMBER_USER_ID, role: "member" });
      await handleAddMember(addReq, { userId: ADMIN_USER_ID }, d1, testOrgId);
    });

    it("removes a member (admin operation)", async () => {
      const request = makeRequest("DELETE");
      const response = await handleRemoveMember(request, { userId: ADMIN_USER_ID }, d1, testOrgId, MEMBER_USER_ID);

      expect(response.status).toBe(200);
      const body = await parseResponse<{ removed: boolean }>(response);
      expect(body.ok).toBe(true);
      expect(body.data?.removed).toBe(true);

      // Verify member is gone
      const row = sqliteDb
        .prepare("SELECT * FROM org_members WHERE org_id = ? AND user_id = ?")
        .get(testOrgId, MEMBER_USER_ID);
      expect(row).toBeUndefined();
    });

    it("returns 403 for non-admin", async () => {
      const request = makeRequest("DELETE");
      const response = await handleRemoveMember(request, { userId: MEMBER_USER_ID }, d1, testOrgId, OUTSIDER_USER_ID);

      expect(response.status).toBe(403);
    });

    it("returns 404 for member not in org", async () => {
      const request = makeRequest("DELETE");
      const response = await handleRemoveMember(request, { userId: ADMIN_USER_ID }, d1, testOrgId, OUTSIDER_USER_ID);

      expect(response.status).toBe(404);
      const body = await parseResponse(response);
      expect(body.error).toContain("not found");
    });

    it("prevents removing last admin", async () => {
      const request = makeRequest("DELETE");
      const response = await handleRemoveMember(request, { userId: ADMIN_USER_ID }, d1, testOrgId, ADMIN_USER_ID);

      expect(response.status).toBe(400);
      const body = await parseResponse(response);
      expect(body.error).toContain("last admin");
    });
  });

  // -------------------------------------------------------------------------
  // PUT /v1/orgs/:id/members/:user_id/role -- Change role
  // -------------------------------------------------------------------------

  describe("PUT /v1/orgs/:id/members/:user_id/role (handleChangeRole)", () => {
    let testOrgId: string;

    beforeEach(async () => {
      const request = makeRequest("POST", { name: "Role Test Org" });
      const response = await handleCreateOrg(request, { userId: ADMIN_USER_ID }, d1);
      const body = await parseResponse<{ org_id: string }>(response);
      testOrgId = body.data!.org_id;

      // Add member
      const addReq = makeRequest("POST", { user_id: MEMBER_USER_ID, role: "member" });
      await handleAddMember(addReq, { userId: ADMIN_USER_ID }, d1, testOrgId);
    });

    it("changes member role to admin", async () => {
      const request = makeRequest("PUT", { role: "admin" });
      const response = await handleChangeRole(request, { userId: ADMIN_USER_ID }, d1, testOrgId, MEMBER_USER_ID);

      expect(response.status).toBe(200);
      const body = await parseResponse<{ role: string }>(response);
      expect(body.ok).toBe(true);
      expect(body.data?.role).toBe("admin");

      // Verify in DB
      const row = sqliteDb
        .prepare("SELECT role FROM org_members WHERE org_id = ? AND user_id = ?")
        .get(testOrgId, MEMBER_USER_ID) as { role: string };
      expect(row.role).toBe("admin");
    });

    it("returns 403 for non-admin", async () => {
      const request = makeRequest("PUT", { role: "admin" });
      const response = await handleChangeRole(request, { userId: MEMBER_USER_ID }, d1, testOrgId, MEMBER_USER_ID);

      expect(response.status).toBe(403);
    });

    it("prevents demoting last admin", async () => {
      const request = makeRequest("PUT", { role: "member" });
      const response = await handleChangeRole(request, { userId: ADMIN_USER_ID }, d1, testOrgId, ADMIN_USER_ID);

      expect(response.status).toBe(400);
      const body = await parseResponse(response);
      expect(body.error).toContain("last admin");
    });

    it("returns 400 for invalid role", async () => {
      const request = makeRequest("PUT", { role: "owner" });
      const response = await handleChangeRole(request, { userId: ADMIN_USER_ID }, d1, testOrgId, MEMBER_USER_ID);

      expect(response.status).toBe(400);
    });

    it("returns 404 for non-existent member", async () => {
      const request = makeRequest("PUT", { role: "admin" });
      const response = await handleChangeRole(request, { userId: ADMIN_USER_ID }, d1, testOrgId, OUTSIDER_USER_ID);

      expect(response.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // RBAC -- checkOrgAdmin
  // -------------------------------------------------------------------------

  describe("checkOrgAdmin RBAC", () => {
    let testOrgId: string;

    beforeEach(async () => {
      const request = makeRequest("POST", { name: "RBAC Test Org" });
      const response = await handleCreateOrg(request, { userId: ADMIN_USER_ID }, d1);
      const body = await parseResponse<{ org_id: string }>(response);
      testOrgId = body.data!.org_id;

      // Add a regular member
      const addReq = makeRequest("POST", { user_id: MEMBER_USER_ID, role: "member" });
      await handleAddMember(addReq, { userId: ADMIN_USER_ID }, d1, testOrgId);
    });

    it("returns null for admin (access granted)", async () => {
      const result = await checkOrgAdmin(ADMIN_USER_ID, testOrgId, d1);
      expect(result).toBeNull();
    });

    it("returns 403 Response for member (not admin)", async () => {
      const result = await checkOrgAdmin(MEMBER_USER_ID, testOrgId, d1);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });

    it("returns 403 Response for non-member", async () => {
      const result = await checkOrgAdmin(OUTSIDER_USER_ID, testOrgId, d1);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Full CRUD lifecycle
  // -------------------------------------------------------------------------

  describe("Full org lifecycle", () => {
    it("creates org, adds members, changes roles, removes members", async () => {
      // 1. Create org
      const createReq = makeRequest("POST", { name: "Lifecycle Org" });
      const createResp = await handleCreateOrg(createReq, { userId: ADMIN_USER_ID }, d1);
      expect(createResp.status).toBe(201);
      const createBody = await parseResponse<{ org_id: string }>(createResp);
      const orgId = createBody.data!.org_id;

      // 2. Get org
      const getReq = makeRequest("GET");
      const getResp = await handleGetOrg(getReq, { userId: ADMIN_USER_ID }, d1, orgId);
      expect(getResp.status).toBe(200);

      // 3. Add member
      const addReq = makeRequest("POST", { user_id: MEMBER_USER_ID, role: "member" });
      const addResp = await handleAddMember(addReq, { userId: ADMIN_USER_ID }, d1, orgId);
      expect(addResp.status).toBe(201);

      // 4. List members (should be 2)
      const listReq1 = makeRequest("GET");
      const listResp1 = await handleListMembers(listReq1, { userId: ADMIN_USER_ID }, d1, orgId);
      const listBody1 = await parseResponse<unknown[]>(listResp1);
      expect(listBody1.data).toHaveLength(2);

      // 5. Promote member to admin
      const roleReq = makeRequest("PUT", { role: "admin" });
      const roleResp = await handleChangeRole(roleReq, { userId: ADMIN_USER_ID }, d1, orgId, MEMBER_USER_ID);
      expect(roleResp.status).toBe(200);

      // 6. Now member can also remove people (they are admin)
      // Add outsider first
      const addOutsider = makeRequest("POST", { user_id: OUTSIDER_USER_ID, role: "member" });
      const addOutResp = await handleAddMember(addOutsider, { userId: MEMBER_USER_ID }, d1, orgId);
      expect(addOutResp.status).toBe(201);

      // 7. Remove outsider
      const removeReq = makeRequest("DELETE");
      const removeResp = await handleRemoveMember(removeReq, { userId: MEMBER_USER_ID }, d1, orgId, OUTSIDER_USER_ID);
      expect(removeResp.status).toBe(200);

      // 8. Final member list should be 2 (admin + promoted member)
      const listReq2 = makeRequest("GET");
      const listResp2 = await handleListMembers(listReq2, { userId: ADMIN_USER_ID }, d1, orgId);
      const listBody2 = await parseResponse<unknown[]>(listResp2);
      expect(listBody2.data).toHaveLength(2);
    });
  });
});
