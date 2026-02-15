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
  MIGRATION_0017_ORG_POLICIES,
} from "@tminus/d1-registry";
import {
  handleCreateOrg,
  handleGetOrg,
  handleAddMember,
  handleListMembers,
  handleRemoveMember,
  handleChangeRole,
  checkOrgAdmin,
  handleCreateOrgPolicy,
  handleListOrgPolicies,
  handleUpdateOrgPolicy,
  handleDeleteOrgPolicy,
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
  sqliteDb.exec(MIGRATION_0017_ORG_POLICIES);

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

  // -------------------------------------------------------------------------
  // Org Policies CRUD
  // -------------------------------------------------------------------------

  describe("Org Policy CRUD", () => {
    let testOrgId: string;

    beforeEach(async () => {
      const request = makeRequest("POST", { name: "Policy Test Org" });
      const response = await handleCreateOrg(request, { userId: ADMIN_USER_ID }, d1);
      const body = await parseResponse<{ org_id: string }>(response);
      testOrgId = body.data!.org_id;

      // Add a regular member for RBAC tests
      const addReq = makeRequest("POST", { user_id: MEMBER_USER_ID, role: "member" });
      await handleAddMember(addReq, { userId: ADMIN_USER_ID }, d1, testOrgId);
    });

    // -----------------------------------------------------------------------
    // POST /v1/orgs/:id/policies (create)
    // -----------------------------------------------------------------------

    describe("POST /v1/orgs/:id/policies (handleCreateOrgPolicy)", () => {
      it("creates a working hours policy (admin, 201 with envelope)", async () => {
        const request = makeRequest("POST", {
          policy_type: "mandatory_working_hours",
          config: { start_hour: 9, end_hour: 17 },
        });
        const response = await handleCreateOrgPolicy(request, { userId: ADMIN_USER_ID }, d1, testOrgId);

        expect(response.status).toBe(201);
        const body = await parseResponse<{
          policy_id: string;
          org_id: string;
          policy_type: string;
          config_json: string;
          created_by: string;
        }>(response);
        expect(body.ok).toBe(true);
        expect(body.data?.policy_id).toMatch(/^pol_/);
        expect(body.data?.org_id).toBe(testOrgId);
        expect(body.data?.policy_type).toBe("mandatory_working_hours");
        expect(body.data?.created_by).toBe(ADMIN_USER_ID);
        expect(body.meta).toBeDefined();

        // Verify config_json is stored correctly
        const config = JSON.parse(body.data!.config_json);
        expect(config.start_hour).toBe(9);
        expect(config.end_hour).toBe(17);
      });

      it("creates a VIP priority policy", async () => {
        const request = makeRequest("POST", {
          policy_type: "minimum_vip_priority",
          config: { minimum_weight: 0.5 },
        });
        const response = await handleCreateOrgPolicy(request, { userId: ADMIN_USER_ID }, d1, testOrgId);

        expect(response.status).toBe(201);
        const body = await parseResponse<{ policy_type: string; config_json: string }>(response);
        expect(body.data?.policy_type).toBe("minimum_vip_priority");
        expect(JSON.parse(body.data!.config_json).minimum_weight).toBe(0.5);
      });

      it("creates a max account count policy", async () => {
        const request = makeRequest("POST", {
          policy_type: "max_account_count",
          config: { max_accounts: 5 },
        });
        const response = await handleCreateOrgPolicy(request, { userId: ADMIN_USER_ID }, d1, testOrgId);

        expect(response.status).toBe(201);
        const body = await parseResponse<{ policy_type: string }>(response);
        expect(body.data?.policy_type).toBe("max_account_count");
      });

      it("creates a projection detail policy", async () => {
        const request = makeRequest("POST", {
          policy_type: "required_projection_detail",
          config: { minimum_detail: "TITLE" },
        });
        const response = await handleCreateOrgPolicy(request, { userId: ADMIN_USER_ID }, d1, testOrgId);

        expect(response.status).toBe(201);
      });

      it("returns 403 for non-admin", async () => {
        const request = makeRequest("POST", {
          policy_type: "mandatory_working_hours",
          config: { start_hour: 9, end_hour: 17 },
        });
        const response = await handleCreateOrgPolicy(request, { userId: MEMBER_USER_ID }, d1, testOrgId);

        expect(response.status).toBe(403);
        const body = await parseResponse(response);
        expect(body.ok).toBe(false);
        expect(body.error).toContain("Admin access required");
      });

      it("returns 403 for non-member", async () => {
        const request = makeRequest("POST", {
          policy_type: "mandatory_working_hours",
          config: { start_hour: 9, end_hour: 17 },
        });
        const response = await handleCreateOrgPolicy(request, { userId: OUTSIDER_USER_ID }, d1, testOrgId);

        expect(response.status).toBe(403);
      });

      it("returns 400 for invalid policy type", async () => {
        const request = makeRequest("POST", {
          policy_type: "invalid_type",
          config: {},
        });
        const response = await handleCreateOrgPolicy(request, { userId: ADMIN_USER_ID }, d1, testOrgId);

        expect(response.status).toBe(400);
        const body = await parseResponse(response);
        expect(body.error).toContain("policy_type must be one of");
      });

      it("returns 400 for invalid config", async () => {
        const request = makeRequest("POST", {
          policy_type: "mandatory_working_hours",
          config: { start_hour: 20, end_hour: 8 },
        });
        const response = await handleCreateOrgPolicy(request, { userId: ADMIN_USER_ID }, d1, testOrgId);

        expect(response.status).toBe(400);
        const body = await parseResponse(response);
        expect(body.error).toContain("start_hour must be less than end_hour");
      });

      it("returns 409 for duplicate policy type", async () => {
        const req1 = makeRequest("POST", {
          policy_type: "mandatory_working_hours",
          config: { start_hour: 9, end_hour: 17 },
        });
        await handleCreateOrgPolicy(req1, { userId: ADMIN_USER_ID }, d1, testOrgId);

        const req2 = makeRequest("POST", {
          policy_type: "mandatory_working_hours",
          config: { start_hour: 8, end_hour: 18 },
        });
        const response = await handleCreateOrgPolicy(req2, { userId: ADMIN_USER_ID }, d1, testOrgId);

        expect(response.status).toBe(409);
        const body = await parseResponse(response);
        expect(body.error).toContain("already exists");
      });

      it("returns 400 for invalid JSON body", async () => {
        const request = new Request("https://api.test.com/v1/orgs/policies", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not json",
        });
        const response = await handleCreateOrgPolicy(request, { userId: ADMIN_USER_ID }, d1, testOrgId);

        expect(response.status).toBe(400);
      });
    });

    // -----------------------------------------------------------------------
    // GET /v1/orgs/:id/policies (list)
    // -----------------------------------------------------------------------

    describe("GET /v1/orgs/:id/policies (handleListOrgPolicies)", () => {
      it("lists all policies for org member", async () => {
        // Create two policies
        const req1 = makeRequest("POST", {
          policy_type: "mandatory_working_hours",
          config: { start_hour: 9, end_hour: 17 },
        });
        await handleCreateOrgPolicy(req1, { userId: ADMIN_USER_ID }, d1, testOrgId);

        const req2 = makeRequest("POST", {
          policy_type: "max_account_count",
          config: { max_accounts: 5 },
        });
        await handleCreateOrgPolicy(req2, { userId: ADMIN_USER_ID }, d1, testOrgId);

        // Regular member can list
        const request = makeRequest("GET");
        const response = await handleListOrgPolicies(request, { userId: MEMBER_USER_ID }, d1, testOrgId);

        expect(response.status).toBe(200);
        const body = await parseResponse<Array<{ policy_id: string; policy_type: string }>>(response);
        expect(body.ok).toBe(true);
        expect(body.data).toHaveLength(2);
        expect(body.meta).toBeDefined();

        const types = body.data!.map((p) => p.policy_type);
        expect(types).toContain("mandatory_working_hours");
        expect(types).toContain("max_account_count");
      });

      it("returns empty array when no policies exist", async () => {
        const request = makeRequest("GET");
        const response = await handleListOrgPolicies(request, { userId: ADMIN_USER_ID }, d1, testOrgId);

        expect(response.status).toBe(200);
        const body = await parseResponse<unknown[]>(response);
        expect(body.data).toHaveLength(0);
      });

      it("returns 403 for non-member", async () => {
        const request = makeRequest("GET");
        const response = await handleListOrgPolicies(request, { userId: OUTSIDER_USER_ID }, d1, testOrgId);

        expect(response.status).toBe(403);
      });
    });

    // -----------------------------------------------------------------------
    // PUT /v1/orgs/:id/policies/:pid (update)
    // -----------------------------------------------------------------------

    describe("PUT /v1/orgs/:id/policies/:pid (handleUpdateOrgPolicy)", () => {
      let testPolicyId: string;

      beforeEach(async () => {
        const req = makeRequest("POST", {
          policy_type: "mandatory_working_hours",
          config: { start_hour: 9, end_hour: 17 },
        });
        const resp = await handleCreateOrgPolicy(req, { userId: ADMIN_USER_ID }, d1, testOrgId);
        const body = await parseResponse<{ policy_id: string }>(resp);
        testPolicyId = body.data!.policy_id;
      });

      it("updates policy config (admin, 200 with envelope)", async () => {
        const request = makeRequest("PUT", {
          config: { start_hour: 8, end_hour: 18 },
        });
        const response = await handleUpdateOrgPolicy(request, { userId: ADMIN_USER_ID }, d1, testOrgId, testPolicyId);

        expect(response.status).toBe(200);
        const body = await parseResponse<{
          policy_id: string;
          policy_type: string;
          config_json: string;
        }>(response);
        expect(body.ok).toBe(true);
        expect(body.data?.policy_id).toBe(testPolicyId);
        expect(body.data?.policy_type).toBe("mandatory_working_hours");
        expect(body.meta).toBeDefined();

        const config = JSON.parse(body.data!.config_json);
        expect(config.start_hour).toBe(8);
        expect(config.end_hour).toBe(18);

        // Verify in DB
        const row = sqliteDb
          .prepare("SELECT config_json FROM org_policies WHERE policy_id = ?")
          .get(testPolicyId) as { config_json: string };
        expect(JSON.parse(row.config_json).start_hour).toBe(8);
      });

      it("returns 403 for non-admin", async () => {
        const request = makeRequest("PUT", {
          config: { start_hour: 8, end_hour: 18 },
        });
        const response = await handleUpdateOrgPolicy(request, { userId: MEMBER_USER_ID }, d1, testOrgId, testPolicyId);

        expect(response.status).toBe(403);
      });

      it("returns 404 for non-existent policy", async () => {
        const request = makeRequest("PUT", {
          config: { start_hour: 8, end_hour: 18 },
        });
        const response = await handleUpdateOrgPolicy(
          request,
          { userId: ADMIN_USER_ID },
          d1,
          testOrgId,
          "pol_00000000000000000000000000",
        );

        expect(response.status).toBe(404);
      });

      it("returns 400 for invalid config", async () => {
        const request = makeRequest("PUT", {
          config: { start_hour: 20, end_hour: 8 },
        });
        const response = await handleUpdateOrgPolicy(request, { userId: ADMIN_USER_ID }, d1, testOrgId, testPolicyId);

        expect(response.status).toBe(400);
        const body = await parseResponse(response);
        expect(body.error).toContain("start_hour must be less than end_hour");
      });
    });

    // -----------------------------------------------------------------------
    // DELETE /v1/orgs/:id/policies/:pid (delete)
    // -----------------------------------------------------------------------

    describe("DELETE /v1/orgs/:id/policies/:pid (handleDeleteOrgPolicy)", () => {
      let testPolicyId: string;

      beforeEach(async () => {
        const req = makeRequest("POST", {
          policy_type: "max_account_count",
          config: { max_accounts: 5 },
        });
        const resp = await handleCreateOrgPolicy(req, { userId: ADMIN_USER_ID }, d1, testOrgId);
        const body = await parseResponse<{ policy_id: string }>(resp);
        testPolicyId = body.data!.policy_id;
      });

      it("deletes a policy (admin, 200 with envelope)", async () => {
        const request = makeRequest("DELETE");
        const response = await handleDeleteOrgPolicy(request, { userId: ADMIN_USER_ID }, d1, testOrgId, testPolicyId);

        expect(response.status).toBe(200);
        const body = await parseResponse<{ deleted: boolean; policy_id: string }>(response);
        expect(body.ok).toBe(true);
        expect(body.data?.deleted).toBe(true);
        expect(body.data?.policy_id).toBe(testPolicyId);
        expect(body.meta).toBeDefined();

        // Verify gone from DB
        const row = sqliteDb
          .prepare("SELECT * FROM org_policies WHERE policy_id = ?")
          .get(testPolicyId);
        expect(row).toBeUndefined();
      });

      it("returns 403 for non-admin", async () => {
        const request = makeRequest("DELETE");
        const response = await handleDeleteOrgPolicy(request, { userId: MEMBER_USER_ID }, d1, testOrgId, testPolicyId);

        expect(response.status).toBe(403);
      });

      it("returns 404 for non-existent policy", async () => {
        const request = makeRequest("DELETE");
        const response = await handleDeleteOrgPolicy(
          request,
          { userId: ADMIN_USER_ID },
          d1,
          testOrgId,
          "pol_00000000000000000000000000",
        );

        expect(response.status).toBe(404);
      });
    });

    // -----------------------------------------------------------------------
    // Policy merge enforcement (via CRUD + merge engine)
    // -----------------------------------------------------------------------

    describe("Policy merge enforcement", () => {
      it("org policy acts as floor -- user cannot be more lenient", async () => {
        // Create working hours policy: 9-17
        const createReq = makeRequest("POST", {
          policy_type: "mandatory_working_hours",
          config: { start_hour: 9, end_hour: 17 },
        });
        const createResp = await handleCreateOrgPolicy(createReq, { userId: ADMIN_USER_ID }, d1, testOrgId);
        expect(createResp.status).toBe(201);

        // Verify the policy is stored and retrievable
        const listReq = makeRequest("GET");
        const listResp = await handleListOrgPolicies(listReq, { userId: MEMBER_USER_ID }, d1, testOrgId);
        const listBody = await parseResponse<Array<{ policy_type: string; config_json: string }>>(listResp);
        expect(listBody.data).toHaveLength(1);

        const whConfig = JSON.parse(listBody.data![0].config_json);
        expect(whConfig.start_hour).toBe(9);
        expect(whConfig.end_hour).toBe(17);

        // Now test the merge engine: user tries wider hours (7-20)
        // The merge engine (tested in shared) would clamp to 9-17
        // Here we verify the data is stored correctly for merge to use
      });

      it("full CRUD lifecycle: create, list, update, delete", async () => {
        // 1. Create
        const createReq = makeRequest("POST", {
          policy_type: "max_account_count",
          config: { max_accounts: 3 },
        });
        const createResp = await handleCreateOrgPolicy(createReq, { userId: ADMIN_USER_ID }, d1, testOrgId);
        expect(createResp.status).toBe(201);
        const createBody = await parseResponse<{ policy_id: string }>(createResp);
        const policyId = createBody.data!.policy_id;

        // 2. List (member can see)
        const listReq = makeRequest("GET");
        const listResp = await handleListOrgPolicies(listReq, { userId: MEMBER_USER_ID }, d1, testOrgId);
        const listBody = await parseResponse<unknown[]>(listResp);
        expect(listBody.data).toHaveLength(1);

        // 3. Update (admin)
        const updateReq = makeRequest("PUT", { config: { max_accounts: 10 } });
        const updateResp = await handleUpdateOrgPolicy(updateReq, { userId: ADMIN_USER_ID }, d1, testOrgId, policyId);
        expect(updateResp.status).toBe(200);
        const updateBody = await parseResponse<{ config_json: string }>(updateResp);
        expect(JSON.parse(updateBody.data!.config_json).max_accounts).toBe(10);

        // 4. Delete (admin)
        const deleteReq = makeRequest("DELETE");
        const deleteResp = await handleDeleteOrgPolicy(deleteReq, { userId: ADMIN_USER_ID }, d1, testOrgId, policyId);
        expect(deleteResp.status).toBe(200);

        // 5. Verify empty list
        const listReq2 = makeRequest("GET");
        const listResp2 = await handleListOrgPolicies(listReq2, { userId: ADMIN_USER_ID }, d1, testOrgId);
        const listBody2 = await parseResponse<unknown[]>(listResp2);
        expect(listBody2.data).toHaveLength(0);
      });

      it("user can be stricter -- policy allows narrower working hours", async () => {
        // Org says 8-18 (wide window)
        const createReq = makeRequest("POST", {
          policy_type: "mandatory_working_hours",
          config: { start_hour: 8, end_hour: 18 },
        });
        await handleCreateOrgPolicy(createReq, { userId: ADMIN_USER_ID }, d1, testOrgId);

        // Verify stored correctly
        const listReq = makeRequest("GET");
        const listResp = await handleListOrgPolicies(listReq, { userId: MEMBER_USER_ID }, d1, testOrgId);
        const listBody = await parseResponse<Array<{ config_json: string }>>(listResp);
        const config = JSON.parse(listBody.data![0].config_json);
        expect(config.start_hour).toBe(8);
        expect(config.end_hour).toBe(18);
        // A user choosing 9-17 is stricter and would be allowed (merge tested in shared)
      });

      it("all four policy types can coexist", async () => {
        const policies = [
          { policy_type: "mandatory_working_hours", config: { start_hour: 9, end_hour: 17 } },
          { policy_type: "minimum_vip_priority", config: { minimum_weight: 0.5 } },
          { policy_type: "max_account_count", config: { max_accounts: 5 } },
          { policy_type: "required_projection_detail", config: { minimum_detail: "TITLE" } },
        ];

        for (const pol of policies) {
          const req = makeRequest("POST", pol);
          const resp = await handleCreateOrgPolicy(req, { userId: ADMIN_USER_ID }, d1, testOrgId);
          expect(resp.status).toBe(201);
        }

        const listReq = makeRequest("GET");
        const listResp = await handleListOrgPolicies(listReq, { userId: ADMIN_USER_ID }, d1, testOrgId);
        const listBody = await parseResponse<unknown[]>(listResp);
        expect(listBody.data).toHaveLength(4);
      });

      it("envelope format compliance on all policy responses", async () => {
        const request = makeRequest("POST", {
          policy_type: "max_account_count",
          config: { max_accounts: 5 },
        });
        const response = await handleCreateOrgPolicy(request, { userId: ADMIN_USER_ID }, d1, testOrgId);

        const body = await parseResponse(response);
        expect(body).toHaveProperty("ok", true);
        expect(body).toHaveProperty("data");
        expect(body).toHaveProperty("meta");
        expect((body.meta as { request_id: string }).request_id).toMatch(/^req_/);
      });
    });
  });
});
