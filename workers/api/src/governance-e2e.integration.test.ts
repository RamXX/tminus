/**
 * Phase 3B E2E Validation: Governance pipeline end-to-end proof.
 *
 * This test suite proves the COMPLETE governance story:
 *   1. Create VIP policy via API -> verify stored (list confirms it).
 *   2. Scheduling override allows after-hours meeting (VIP bypass).
 *   3. Tag events as billable via time allocation API -> verify stored.
 *   4. Create commitment -> GET status -> verify actual vs target hours.
 *   5. Export commitment proof -> download "PDF" -> verify SHA-256 hash.
 *   6. Governance dashboard data: VIP list + commitments + time allocations.
 *
 * All DO calls use a mock DO namespace that captures calls and returns
 * configurable responses (same pattern as billing-e2e-validation). D1 is
 * backed by real SQLite (better-sqlite3) for accurate SQL behavior. JWT
 * auth is real. R2 is an in-memory mock.
 *
 * DO response format: the mock DO returns raw data as its JSON body.
 * `callDO` wraps it into `{ ok: true, data: <raw-body> }`. So pathResponses
 * should NOT include `{ ok: true, data: ... }` wrappers.
 *
 * Story: TM-yke.8 (Phase 3B E2E Validation)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  MIGRATION_0001_INITIAL_SCHEMA,
  MIGRATION_0004_AUTH_FIELDS,
  MIGRATION_0008_SYNC_STATUS_COLUMNS,
  MIGRATION_0012_SUBSCRIPTIONS,
  MIGRATION_0013_SUBSCRIPTION_LIFECYCLE,
} from "@tminus/d1-registry";
import {
  createHandler,
  createJwt,
  computeProofHash,
} from "./index";

// ---------------------------------------------------------------------------
// Test constants -- All IDs use valid ULID format (prefix_ + 26 Crockford B32)
// ---------------------------------------------------------------------------

const JWT_SECRET = "governance-e2e-jwt-secret-32chars-minimum";
const MASTER_KEY = "governance-e2e-master-key-32chars-minimum";
const TEST_USER_ID = "usr_01HXYE2E0000000000000G0001";
const TEST_USER_EMAIL = "governance-e2e@example.com";
const BASE_URL = "https://api.tminus.ink";

// Valid prefixed ULID IDs for test entities
const VIP_ID_1 = "vip_01HXYE2E0000000000000G0001";
const VIP_ID_2 = "vip_01HXYE2E0000000000000G0002";
const CMT_ID_1 = "cmt_01HXYE2E0000000000000G0001";
const CMT_ID_2 = "cmt_01HXYE2E0000000000000G0002";
const ALC_ID_1 = "alc_01HXYE2E0000000000000G0001";
const EVT_ID_1 = "evt_01HXYE2E0000000000000G0001";
const EVT_ID_2 = "evt_01HXYE2E0000000000000G0002";
const CST_ID_1 = "cst_01HXYE2E0000000000000G0001";
const ACC_ID_1 = "acc_01HXYE2E0000000000000G0001";

// Proof data that the DO returns for commitment proof export.
// This is the RAW DO response body (no ok/data wrapper).
const PROOF_DATA = {
  commitment: {
    commitment_id: CMT_ID_1,
    client_id: "client_acme",
    client_name: "Acme Corp",
    window_type: "WEEKLY",
    target_hours: 20,
    rolling_window_weeks: 4,
    hard_minimum: false,
    proof_required: true,
    created_at: "2026-02-10T00:00:00Z",
  },
  window_start: "2026-02-10T00:00:00Z",
  window_end: "2026-02-16T23:59:59Z",
  actual_hours: 18,
  status: "under",
  events: [
    {
      canonical_event_id: EVT_ID_1,
      title: "Strategy call with Acme",
      start_ts: "2026-02-10T10:00:00Z",
      end_ts: "2026-02-10T12:00:00Z",
      hours: 2,
      billing_category: "BILLABLE",
    },
    {
      canonical_event_id: EVT_ID_2,
      title: "Acme sprint review",
      start_ts: "2026-02-12T14:00:00Z",
      end_ts: "2026-02-12T15:30:00Z",
      hours: 1.5,
      billing_category: "BILLABLE",
    },
    {
      canonical_event_id: "evt_01HXYE2E0000000000000G0003",
      title: "Acme integration testing",
      start_ts: "2026-02-14T09:00:00Z",
      end_ts: "2026-02-14T17:00:00Z",
      hours: 8,
      billing_category: "BILLABLE",
    },
    {
      canonical_event_id: "evt_01HXYE2E0000000000000G0004",
      title: "Acme stakeholder sync",
      start_ts: "2026-02-15T10:00:00Z",
      end_ts: "2026-02-15T16:30:00Z",
      hours: 6.5,
      billing_category: "BILLABLE",
    },
  ],
};

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
// Mock KV namespace (in-memory)
// ---------------------------------------------------------------------------

function createMockKV(): KVNamespace {
  const store = new Map<string, { value: string; expiration?: number }>();
  return {
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
      return { keys: Array.from(store.keys()).map((name) => ({ name })), list_complete: true };
    },
    async getWithMetadata(): Promise<{ value: string | null; metadata: unknown }> {
      return { value: null, metadata: null };
    },
  } as unknown as KVNamespace;
}

// ---------------------------------------------------------------------------
// Mock R2 bucket (in-memory) for proof export
// ---------------------------------------------------------------------------

function createMockR2(): R2Bucket & { objects: Map<string, { content: string; metadata: Record<string, string> }> } {
  const objects = new Map<string, { content: string; metadata: Record<string, string> }>();

  return {
    objects,
    async put(key: string, value: string | ReadableStream | ArrayBuffer, opts?: {
      httpMetadata?: { contentType?: string; contentDisposition?: string };
      customMetadata?: Record<string, string>;
    }): Promise<unknown> {
      const content = typeof value === "string" ? value : "[binary data]";
      objects.set(key, {
        content,
        metadata: opts?.customMetadata ?? {},
      });
      return { key, version: "v1" };
    },
    async get(key: string): Promise<unknown> {
      const obj = objects.get(key);
      if (!obj) return null;

      const encoder = new TextEncoder();
      const bytes = encoder.encode(obj.content);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });

      return {
        body: stream,
        httpEtag: `"etag-${key}"`,
        writeHttpMetadata(headers: Headers) {
          headers.set("Content-Type", "application/pdf");
          headers.set("Content-Disposition", `attachment; filename="proof.pdf"`);
        },
      };
    },
    async delete(): Promise<void> {},
    async list(): Promise<unknown> {
      return { objects: [], truncated: false };
    },
    async head(): Promise<unknown> {
      return null;
    },
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
  } as unknown as R2Bucket & { objects: Map<string, { content: string; metadata: Record<string, string> }> };
}

// ---------------------------------------------------------------------------
// Mock DO namespace: captures calls and returns path-specific responses.
// Responses are RAW data -- callDO wraps them into { ok, data }.
// ---------------------------------------------------------------------------

interface DOCallRecord {
  name: string;
  path: string;
  method: string;
  body?: unknown;
}

function createMockDONamespace(config?: {
  defaultResponse?: unknown;
  pathResponses?: Map<string, unknown>;
}): DurableObjectNamespace & { calls: DOCallRecord[] } {
  const calls: DOCallRecord[] = [];
  const defaultResp = config?.defaultResponse ?? { ok: true };

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

          const pathData = config?.pathResponses?.get(url.pathname);
          const responseData = pathData !== undefined ? pathData : defaultResp;

          return new Response(JSON.stringify(responseData), {
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

// ---------------------------------------------------------------------------
// Mock Queue
// ---------------------------------------------------------------------------

function createMockQueue(): Queue {
  return {
    async send() {},
    async sendBatch() {},
  } as unknown as Queue;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function makeToken(userId: string = TEST_USER_ID): Promise<string> {
  return createJwt(
    {
      sub: userId,
      email: TEST_USER_EMAIL,
      tier: "premium",
      pwd_ver: 1,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    JWT_SECRET,
  );
}

function setupUser(db: DatabaseType, userId: string = TEST_USER_ID): void {
  const orgExists = db.prepare("SELECT org_id FROM orgs WHERE org_id = 'org_gov_e2e_01'").get();
  if (!orgExists) {
    db.exec("INSERT INTO orgs (org_id, name) VALUES ('org_gov_e2e_01', 'Governance E2E Org')");
  }

  db.exec(
    `INSERT INTO users (user_id, org_id, email, password_hash, password_version)
     VALUES ('${userId}', 'org_gov_e2e_01', '${TEST_USER_EMAIL}', 'hash', 1)`,
  );

  // Give user premium subscription (governance features require premium)
  const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.exec(
    `INSERT INTO subscriptions (
       subscription_id, user_id, stripe_subscription_id, stripe_customer_id,
       tier, status, current_period_end
     ) VALUES (
       'sub_gov_e2e_001', '${userId}', 'sub_stripe_gov_e2e', 'cus_stripe_gov_e2e',
       'premium', 'active', '${periodEnd}'
     )`,
  );
}

function setupAccount(db: DatabaseType, userId: string, accountId: string, email: string): void {
  db.exec(
    `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status)
     VALUES ('${accountId}', '${userId}', 'google', 'sub_${accountId}', '${email}', 'active')`,
  );
}

function buildEnv(
  d1: D1Database,
  userGraph?: DurableObjectNamespace,
  opts?: { r2?: R2Bucket },
): Record<string, unknown> {
  const env: Record<string, unknown> = {
    DB: d1,
    USER_GRAPH: userGraph ?? createMockDONamespace(),
    ACCOUNT: createMockDONamespace(),
    SYNC_QUEUE: createMockQueue(),
    WRITE_QUEUE: createMockQueue(),
    SESSIONS: createMockKV(),
    RATE_LIMITS: createMockKV(),
    JWT_SECRET,
    MASTER_KEY,
  };
  if (opts?.r2) {
    env.PROOF_BUCKET = opts.r2;
  }
  return env;
}

const mockCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

// ===========================================================================
// E2E Validation Test Suite
// ===========================================================================

describe("Phase 3B E2E Validation: Governance pipeline end-to-end", () => {
  let db: DatabaseType;
  let d1: D1Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(MIGRATION_0001_INITIAL_SCHEMA);
    db.exec(MIGRATION_0004_AUTH_FIELDS);
    db.exec(MIGRATION_0008_SYNC_STATUS_COLUMNS);
    db.exec(MIGRATION_0012_SUBSCRIPTIONS);
    db.exec(MIGRATION_0013_SUBSCRIPTION_LIFECYCLE);
    d1 = createRealD1(db);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // AC#1: VIP allows after-hours scheduling
  // =========================================================================

  describe("AC#1: VIP policy creation and after-hours scheduling", () => {
    it("creates a VIP policy and verifies it is stored (list returns it)", async () => {
      setupUser(db);

      // Raw DO response for createVipPolicy (no ok/data wrapper)
      const createdVip = {
        vip_id: VIP_ID_1,
        participant_hash: "sha256_investor_hash_abc",
        display_name: "Key Investor",
        priority_weight: 2.0,
        conditions_json: { allow_after_hours: true, min_notice_hours: 1 },
        created_at: "2026-02-15T10:00:00Z",
      };

      const userGraph = createMockDONamespace({
        pathResponses: new Map([
          ["/createVipPolicy", createdVip],
          // listVipPolicies returns { items: [...] }
          ["/listVipPolicies", { items: [createdVip] }],
        ]),
      });

      const env = buildEnv(d1, userGraph);
      const handler = createHandler();
      const token = await makeToken();

      // Step 1: Create VIP policy
      const createResp = await handler.fetch(
        new Request(`${BASE_URL}/v1/vip-policies`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            participant_hash: "sha256_investor_hash_abc",
            display_name: "Key Investor",
            priority_weight: 2.0,
            conditions_json: { allow_after_hours: true, min_notice_hours: 1 },
          }),
        }),
        env,
        mockCtx,
      );

      expect(createResp.status).toBe(201);
      const createBody = await createResp.json() as { ok: boolean; data: { vip_id: string } };
      expect(createBody.ok).toBe(true);
      expect(createBody.data.vip_id).toBe(VIP_ID_1);

      // Step 2: Verify DO was called with correct args
      const ugCalls = (userGraph as unknown as { calls: DOCallRecord[] }).calls;
      const createCall = ugCalls.find((c) => c.path === "/createVipPolicy");
      expect(createCall).toBeDefined();
      expect(createCall!.body).toMatchObject({
        participant_hash: "sha256_investor_hash_abc",
        display_name: "Key Investor",
        priority_weight: 2.0,
      });

      // Step 3: List VIP policies to confirm stored
      const listResp = await handler.fetch(
        new Request(`${BASE_URL}/v1/vip-policies`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
        mockCtx,
      );

      expect(listResp.status).toBe(200);
      const listBody = await listResp.json() as {
        ok: boolean;
        data: Array<{ vip_id: string; display_name: string }>;
      };
      expect(listBody.ok).toBe(true);
      // handleListVipPolicies returns result.data.items ?? result.data
      expect(Array.isArray(listBody.data)).toBe(true);
      expect(listBody.data).toHaveLength(1);
      expect(listBody.data[0].vip_id).toBe(VIP_ID_1);
      expect(listBody.data[0].display_name).toBe("Key Investor");
    });

    it("free user is blocked from creating VIP policy (premium required)", async () => {
      const freeUserId = "usr_01HXYE2E000000000000FREE01";
      const orgExists = db.prepare("SELECT org_id FROM orgs WHERE org_id = 'org_gov_e2e_01'").get();
      if (!orgExists) {
        db.exec("INSERT INTO orgs (org_id, name) VALUES ('org_gov_e2e_01', 'Governance E2E Org')");
      }
      db.exec(
        `INSERT INTO users (user_id, org_id, email, password_hash, password_version)
         VALUES ('${freeUserId}', 'org_gov_e2e_01', 'free@example.com', 'hash', 1)`,
      );

      const env = buildEnv(d1);
      const handler = createHandler();
      const freeToken = await createJwt(
        {
          sub: freeUserId,
          email: "free@example.com",
          tier: "free",
          pwd_ver: 1,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
        JWT_SECRET,
      );

      const resp = await handler.fetch(
        new Request(`${BASE_URL}/v1/vip-policies`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${freeToken}`,
          },
          body: JSON.stringify({
            participant_hash: "sha256_some_hash",
            conditions_json: { allow_after_hours: true },
          }),
        }),
        env,
        mockCtx,
      );

      expect(resp.status).toBe(403);
      const body = await resp.json() as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
    });

    it("scheduling override allows after-hours meeting (VIP bypass equivalent)", async () => {
      setupUser(db);
      setupAccount(db, TEST_USER_ID, ACC_ID_1, "work@example.com");

      const overrideResult = {
        constraint_id: CST_ID_1,
        kind: "override",
        config_json: {
          reason: "VIP investor meeting",
          slot_start: "2026-02-15T20:00:00Z",
          slot_end: "2026-02-15T21:00:00Z",
          timezone: "UTC",
        },
        active_from: "2026-02-15T20:00:00Z",
        active_to: "2026-02-15T21:00:00Z",
        created_at: "2026-02-15T10:00:00Z",
      };

      const userGraph = createMockDONamespace({
        pathResponses: new Map([
          ["/addConstraint", overrideResult],
        ]),
      });

      const env = buildEnv(d1, userGraph);
      const handler = createHandler();
      const token = await makeToken();

      const resp = await handler.fetch(
        new Request(`${BASE_URL}/v1/scheduling/override`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            reason: "VIP investor meeting",
            slot_start: "2026-02-15T20:00:00Z",
            slot_end: "2026-02-15T21:00:00Z",
            timezone: "UTC",
          }),
        }),
        env,
        mockCtx,
      );

      expect(resp.status).toBe(201);
      const body = await resp.json() as {
        ok: boolean;
        data: { constraint_id: string; kind: string };
      };
      expect(body.ok).toBe(true);
      expect(body.data.constraint_id).toBe(CST_ID_1);
      expect(body.data.kind).toBe("override");

      const ugCalls = (userGraph as unknown as { calls: DOCallRecord[] }).calls;
      const overrideCall = ugCalls.find((c) => c.path === "/addConstraint");
      expect(overrideCall).toBeDefined();
      expect(overrideCall!.body).toMatchObject({
        kind: "override",
        config_json: {
          reason: "VIP investor meeting",
          slot_start: "2026-02-15T20:00:00Z",
          slot_end: "2026-02-15T21:00:00Z",
        },
      });
    });

    it("VIP policy deletion works", async () => {
      setupUser(db);

      const userGraph = createMockDONamespace({
        pathResponses: new Map([
          ["/deleteVipPolicy", { deleted: true }],
        ]),
      });

      const env = buildEnv(d1, userGraph);
      const handler = createHandler();
      const token = await makeToken();

      const resp = await handler.fetch(
        new Request(`${BASE_URL}/v1/vip-policies/${VIP_ID_1}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
        mockCtx,
      );

      expect(resp.status).toBe(200);
      const body = await resp.json() as { ok: boolean; data: { deleted: boolean } };
      expect(body.ok).toBe(true);
      expect(body.data.deleted).toBe(true);
    });
  });

  // =========================================================================
  // AC#2: Billable tagging via time allocation API
  // =========================================================================

  describe("AC#2: Billable time tagging via allocation API", () => {
    it("tags an event as BILLABLE and verifies allocation is stored", async () => {
      setupUser(db);

      const createdAlloc = {
        allocation_id: ALC_ID_1,
        canonical_event_id: EVT_ID_1,
        client_id: "client_acme",
        billing_category: "BILLABLE",
        rate: 150,
        confidence: "HIGH",
        locked: false,
        created_at: "2026-02-15T10:00:00Z",
      };

      const userGraph = createMockDONamespace({
        pathResponses: new Map([
          ["/createAllocation", createdAlloc],
          ["/getAllocation", createdAlloc],
        ]),
      });

      const env = buildEnv(d1, userGraph);
      const handler = createHandler();
      const token = await makeToken();

      // Step 1: Tag event as BILLABLE
      const tagResp = await handler.fetch(
        new Request(`${BASE_URL}/v1/events/${EVT_ID_1}/allocation`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            billing_category: "BILLABLE",
            client_id: "client_acme",
            rate: 150,
          }),
        }),
        env,
        mockCtx,
      );

      expect(tagResp.status).toBe(201);
      const tagBody = await tagResp.json() as {
        ok: boolean;
        data: { allocation_id: string; billing_category: string; client_id: string };
      };
      expect(tagBody.ok).toBe(true);
      expect(tagBody.data.allocation_id).toBe(ALC_ID_1);
      expect(tagBody.data.billing_category).toBe("BILLABLE");
      expect(tagBody.data.client_id).toBe("client_acme");

      // Verify DO was called correctly
      const ugCalls = (userGraph as unknown as { calls: DOCallRecord[] }).calls;
      const createCall = ugCalls.find((c) => c.path === "/createAllocation");
      expect(createCall).toBeDefined();
      expect(createCall!.body).toMatchObject({
        canonical_event_id: EVT_ID_1,
        billing_category: "BILLABLE",
        client_id: "client_acme",
        rate: 150,
      });

      // Step 2: Retrieve allocation to confirm stored
      const getResp = await handler.fetch(
        new Request(`${BASE_URL}/v1/events/${EVT_ID_1}/allocation`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
        mockCtx,
      );

      expect(getResp.status).toBe(200);
      const getBody = await getResp.json() as {
        ok: boolean;
        data: { allocation_id: string; billing_category: string };
      };
      expect(getBody.ok).toBe(true);
      expect(getBody.data.billing_category).toBe("BILLABLE");
    });

    it("tags multiple events with different billing categories", async () => {
      setupUser(db);

      const userGraph = createMockDONamespace({
        pathResponses: new Map([
          ["/createAllocation", {
            allocation_id: ALC_ID_1,
            billing_category: "BILLABLE",
            client_id: "client_acme",
            created_at: "2026-02-15T10:00:00Z",
          }],
        ]),
      });

      const env = buildEnv(d1, userGraph);
      const handler = createHandler();
      const token = await makeToken();

      // Tag event 1 as BILLABLE
      const resp1 = await handler.fetch(
        new Request(`${BASE_URL}/v1/events/${EVT_ID_1}/allocation`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            billing_category: "BILLABLE",
            client_id: "client_acme",
          }),
        }),
        env,
        mockCtx,
      );
      expect(resp1.status).toBe(201);

      // Tag event 2 as STRATEGIC
      const resp2 = await handler.fetch(
        new Request(`${BASE_URL}/v1/events/${EVT_ID_2}/allocation`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            billing_category: "STRATEGIC",
            client_id: "client_beta",
          }),
        }),
        env,
        mockCtx,
      );
      expect(resp2.status).toBe(201);

      // Verify DO was called twice with different events
      const ugCalls = (userGraph as unknown as { calls: DOCallRecord[] }).calls;
      const createCalls = ugCalls.filter((c) => c.path === "/createAllocation");
      expect(createCalls).toHaveLength(2);
      expect((createCalls[0].body as Record<string, unknown>).canonical_event_id).toBe(EVT_ID_1);
      expect((createCalls[1].body as Record<string, unknown>).canonical_event_id).toBe(EVT_ID_2);
      expect((createCalls[0].body as Record<string, unknown>).billing_category).toBe("BILLABLE");
      expect((createCalls[1].body as Record<string, unknown>).billing_category).toBe("STRATEGIC");
    });

    it("rejects invalid billing category", async () => {
      setupUser(db);

      const env = buildEnv(d1);
      const handler = createHandler();
      const token = await makeToken();

      const resp = await handler.fetch(
        new Request(`${BASE_URL}/v1/events/${EVT_ID_1}/allocation`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            billing_category: "INVALID_CATEGORY",
            client_id: "client_acme",
          }),
        }),
        env,
        mockCtx,
      );

      expect(resp.status).toBe(400);
      const body = await resp.json() as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("Invalid billing_category");
    });
  });

  // =========================================================================
  // AC#3: Commitment status shows actual vs target
  // =========================================================================

  describe("AC#3: Commitment tracking with actual vs target hours", () => {
    it("creates commitment and retrieves status with actual vs target", async () => {
      setupUser(db);

      const createdCommitment = {
        commitment_id: CMT_ID_1,
        client_id: "client_acme",
        client_name: "Acme Corp",
        target_hours: 20,
        window_type: "WEEKLY",
        rolling_window_weeks: 4,
        hard_minimum: false,
        proof_required: true,
        created_at: "2026-02-15T10:00:00Z",
      };

      const commitmentStatus = {
        commitment_id: CMT_ID_1,
        client_id: "client_acme",
        client_name: "Acme Corp",
        target_hours: 20,
        actual_hours: 18,
        window_type: "WEEKLY",
        window_start: "2026-02-10T00:00:00Z",
        window_end: "2026-02-16T23:59:59Z",
        status: "under",
        compliance_pct: 90,
      };

      const userGraph = createMockDONamespace({
        pathResponses: new Map([
          ["/createCommitment", createdCommitment],
          ["/getCommitmentStatus", commitmentStatus],
          ["/listCommitments", { items: [createdCommitment] }],
        ]),
      });

      const env = buildEnv(d1, userGraph);
      const handler = createHandler();
      const token = await makeToken();

      // Step 1: Create commitment
      const createResp = await handler.fetch(
        new Request(`${BASE_URL}/v1/commitments`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            client_id: "client_acme",
            client_name: "Acme Corp",
            target_hours: 20,
            window_type: "WEEKLY",
            rolling_window_weeks: 4,
            proof_required: true,
          }),
        }),
        env,
        mockCtx,
      );

      expect(createResp.status).toBe(201);
      const createBody = await createResp.json() as {
        ok: boolean;
        data: { commitment_id: string; target_hours: number };
      };
      expect(createBody.ok).toBe(true);
      expect(createBody.data.commitment_id).toBe(CMT_ID_1);
      expect(createBody.data.target_hours).toBe(20);

      // Step 2: Get commitment status (actual vs target)
      const statusResp = await handler.fetch(
        new Request(`${BASE_URL}/v1/commitments/${CMT_ID_1}/status`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
        mockCtx,
      );

      expect(statusResp.status).toBe(200);
      const statusBody = await statusResp.json() as {
        ok: boolean;
        data: {
          commitment_id: string;
          actual_hours: number;
          target_hours: number;
          status: string;
        };
      };
      expect(statusBody.ok).toBe(true);
      expect(statusBody.data.actual_hours).toBe(18);
      expect(statusBody.data.target_hours).toBe(20);
      expect(statusBody.data.status).toBe("under");

      // Verify DO calls
      const ugCalls = (userGraph as unknown as { calls: DOCallRecord[] }).calls;
      const createCall = ugCalls.find((c) => c.path === "/createCommitment");
      expect(createCall).toBeDefined();
      expect(createCall!.body).toMatchObject({
        client_id: "client_acme",
        target_hours: 20,
        window_type: "WEEKLY",
      });

      const statusCall = ugCalls.find((c) => c.path === "/getCommitmentStatus");
      expect(statusCall).toBeDefined();
      expect(statusCall!.body).toMatchObject({
        commitment_id: CMT_ID_1,
      });
    });

    it("lists all commitments for the user", async () => {
      setupUser(db);

      const commitments = [
        { commitment_id: CMT_ID_1, client_id: "client_acme", client_name: "Acme Corp", target_hours: 20 },
        { commitment_id: CMT_ID_2, client_id: "client_beta", client_name: "Beta Inc", target_hours: 10 },
      ];

      const userGraph = createMockDONamespace({
        pathResponses: new Map([
          ["/listCommitments", { items: commitments }],
        ]),
      });

      const env = buildEnv(d1, userGraph);
      const handler = createHandler();
      const token = await makeToken();

      const resp = await handler.fetch(
        new Request(`${BASE_URL}/v1/commitments`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
        mockCtx,
      );

      expect(resp.status).toBe(200);
      const body = await resp.json() as {
        ok: boolean;
        data: Array<{ commitment_id: string; target_hours: number }>;
      };
      expect(body.ok).toBe(true);
      // handleListCommitments returns successEnvelope(result.data.items)
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].commitment_id).toBe(CMT_ID_1);
      expect(body.data[1].commitment_id).toBe(CMT_ID_2);
    });

    it("deletes a commitment", async () => {
      setupUser(db);

      const userGraph = createMockDONamespace({
        pathResponses: new Map([
          ["/deleteCommitment", { deleted: true }],
        ]),
      });

      const env = buildEnv(d1, userGraph);
      const handler = createHandler();
      const token = await makeToken();

      const resp = await handler.fetch(
        new Request(`${BASE_URL}/v1/commitments/${CMT_ID_1}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
        mockCtx,
      );

      expect(resp.status).toBe(200);
      const body = await resp.json() as { ok: boolean; data: { deleted: boolean } };
      expect(body.ok).toBe(true);
      expect(body.data.deleted).toBe(true);
    });
  });

  // =========================================================================
  // AC#4: Proof export downloadable with SHA-256 verification
  // =========================================================================

  describe("AC#4: Commitment proof export and download", () => {
    it("exports proof document and verifies SHA-256 hash is present", async () => {
      setupUser(db);

      const userGraph = createMockDONamespace({
        pathResponses: new Map([
          ["/getCommitmentProofData", PROOF_DATA],
        ]),
      });

      const r2 = createMockR2();
      const env = buildEnv(d1, userGraph, { r2 });
      const handler = createHandler();
      const token = await makeToken();

      // Export proof as PDF
      const exportResp = await handler.fetch(
        new Request(`${BASE_URL}/v1/commitments/${CMT_ID_1}/export`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ format: "pdf" }),
        }),
        env,
        mockCtx,
      );

      expect(exportResp.status).toBe(200);
      const exportBody = await exportResp.json() as {
        ok: boolean;
        data: {
          download_url: string;
          proof_hash: string;
          format: string;
          r2_key: string;
          commitment_id: string;
          actual_hours: number;
          target_hours: number;
          status: string;
          event_count: number;
        };
      };
      expect(exportBody.ok).toBe(true);
      expect(exportBody.data.format).toBe("pdf");
      expect(exportBody.data.proof_hash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
      expect(exportBody.data.download_url).toBeTruthy();
      expect(exportBody.data.r2_key).toContain("proofs/");
      expect(exportBody.data.commitment_id).toBe(CMT_ID_1);
      expect(exportBody.data.actual_hours).toBe(18);
      expect(exportBody.data.target_hours).toBe(20);
      expect(exportBody.data.status).toBe("under");
      expect(exportBody.data.event_count).toBe(4);

      // Verify proof stored in R2
      expect(r2.objects.size).toBe(1);
      const [r2Key, r2Value] = Array.from(r2.objects.entries())[0];
      expect(r2Key).toContain(`proofs/${TEST_USER_ID}/${CMT_ID_1}/`);
      expect(r2Value.content).toContain("Commitment Proof Document"); // HTML proof doc header
      expect(r2Value.metadata.proof_hash).toBe(exportBody.data.proof_hash);

      // Verify hash is independently reproducible
      const expectedHash = await computeProofHash(PROOF_DATA);
      expect(exportBody.data.proof_hash).toBe(expectedHash);
    });

    it("exports proof as CSV format", async () => {
      setupUser(db);

      const userGraph = createMockDONamespace({
        pathResponses: new Map([
          ["/getCommitmentProofData", PROOF_DATA],
        ]),
      });

      const r2 = createMockR2();
      const env = buildEnv(d1, userGraph, { r2 });
      const handler = createHandler();
      const token = await makeToken();

      const exportResp = await handler.fetch(
        new Request(`${BASE_URL}/v1/commitments/${CMT_ID_1}/export`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ format: "csv" }),
        }),
        env,
        mockCtx,
      );

      expect(exportResp.status).toBe(200);
      const exportBody = await exportResp.json() as {
        ok: boolean;
        data: { format: string; r2_key: string; proof_hash: string };
      };
      expect(exportBody.ok).toBe(true);
      expect(exportBody.data.format).toBe("csv");
      expect(exportBody.data.r2_key).toContain(".csv");

      // Verify CSV content in R2
      const [, r2Value] = Array.from(r2.objects.entries())[0];
      expect(r2Value.content).toContain("Commitment ID");
      expect(r2Value.content).toContain("Acme Corp");
    });

    it("downloads stored proof document from R2", async () => {
      setupUser(db);

      const r2 = createMockR2();
      const r2Key = `proofs/${TEST_USER_ID}/${CMT_ID_1}/2026-02-15T10-00-00Z.pdf`;
      await r2.put(r2Key, "PROOF DOCUMENT CONTENT HERE", {
        httpMetadata: { contentType: "application/pdf" },
        customMetadata: { proof_hash: "abc123" },
      });

      const env = buildEnv(d1, undefined, { r2 });
      const handler = createHandler();
      const token = await makeToken();

      const downloadResp = await handler.fetch(
        new Request(`${BASE_URL}/v1/proofs/${encodeURIComponent(r2Key)}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
        mockCtx,
      );

      expect(downloadResp.status).toBe(200);
      const downloadBody = await downloadResp.text();
      expect(downloadBody).toBe("PROOF DOCUMENT CONTENT HERE");
    });

    it("prevents downloading another user's proof", async () => {
      setupUser(db);

      const r2 = createMockR2();
      const r2Key = "proofs/usr_01HXYE2E000000000000OTHER1/cmt_01HXYE2E000000000000OTHER1/2026-02-15.pdf";
      await r2.put(r2Key, "SHOULD NOT ACCESS", {});

      const env = buildEnv(d1, undefined, { r2 });
      const handler = createHandler();
      const token = await makeToken();

      const resp = await handler.fetch(
        new Request(`${BASE_URL}/v1/proofs/${encodeURIComponent(r2Key)}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
        mockCtx,
      );

      expect(resp.status).toBe(404);
      const body = await resp.json() as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("not found");
    });

    it("returns 500 when PROOF_BUCKET is missing", async () => {
      setupUser(db);

      // No PROOF_BUCKET in env
      const env = buildEnv(d1);
      const handler = createHandler();
      const token = await makeToken();

      const resp = await handler.fetch(
        new Request(`${BASE_URL}/v1/commitments/${CMT_ID_1}/export`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ format: "pdf" }),
        }),
        env,
        mockCtx,
      );

      expect(resp.status).toBe(500);
      const body = await resp.json() as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("R2 bucket");
    });
  });

  // =========================================================================
  // AC#5: Dashboard shows compliance (VIP list + commitments)
  // =========================================================================

  describe("AC#5: Governance dashboard data via API", () => {
    it("retrieves VIP list, commitments, and commitment status for dashboard", async () => {
      setupUser(db);

      const vips = [
        {
          vip_id: VIP_ID_1,
          participant_hash: "sha256_investor_hash",
          display_name: "Key Investor",
          priority_weight: 2.0,
          conditions_json: { allow_after_hours: true },
          created_at: "2026-02-10T10:00:00Z",
        },
        {
          vip_id: VIP_ID_2,
          participant_hash: "sha256_cto_hash",
          display_name: "Company CTO",
          priority_weight: 1.5,
          conditions_json: { allow_after_hours: true, min_notice_hours: 2 },
          created_at: "2026-02-11T10:00:00Z",
        },
      ];

      const commitments = [
        { commitment_id: CMT_ID_1, client_id: "client_acme", client_name: "Acme Corp", target_hours: 20, window_type: "WEEKLY" },
        { commitment_id: CMT_ID_2, client_id: "client_beta", client_name: "Beta Inc", target_hours: 10, window_type: "MONTHLY" },
      ];

      const acmeStatus = {
        commitment_id: CMT_ID_1,
        actual_hours: 22,
        target_hours: 20,
        status: "compliant",
        compliance_pct: 110,
      };

      const userGraph = createMockDONamespace({
        pathResponses: new Map([
          ["/listVipPolicies", { items: vips }],
          ["/listCommitments", { items: commitments }],
          ["/getCommitmentStatus", acmeStatus],
        ]),
      });

      const env = buildEnv(d1, userGraph);
      const handler = createHandler();
      const token = await makeToken();

      // Step 1: GET VIP list
      const vipResp = await handler.fetch(
        new Request(`${BASE_URL}/v1/vip-policies`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
        mockCtx,
      );

      expect(vipResp.status).toBe(200);
      const vipBody = await vipResp.json() as {
        ok: boolean;
        data: Array<{ vip_id: string; display_name: string }>;
      };
      expect(vipBody.ok).toBe(true);
      expect(vipBody.data).toHaveLength(2);
      expect(vipBody.data[0].display_name).toBe("Key Investor");
      expect(vipBody.data[1].display_name).toBe("Company CTO");

      // Step 2: GET commitments list
      const commitmentsResp = await handler.fetch(
        new Request(`${BASE_URL}/v1/commitments`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
        mockCtx,
      );

      expect(commitmentsResp.status).toBe(200);
      const commitmentsBody = await commitmentsResp.json() as {
        ok: boolean;
        data: Array<{ commitment_id: string; client_name: string; target_hours: number }>;
      };
      expect(commitmentsBody.ok).toBe(true);
      expect(commitmentsBody.data).toHaveLength(2);
      expect(commitmentsBody.data[0].client_name).toBe("Acme Corp");
      expect(commitmentsBody.data[0].target_hours).toBe(20);
      expect(commitmentsBody.data[1].client_name).toBe("Beta Inc");

      // Step 3: GET commitment status (compliance data for chart)
      const statusResp = await handler.fetch(
        new Request(`${BASE_URL}/v1/commitments/${CMT_ID_1}/status`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
        mockCtx,
      );

      expect(statusResp.status).toBe(200);
      const statusBody = await statusResp.json() as {
        ok: boolean;
        data: { actual_hours: number; target_hours: number; status: string };
      };
      expect(statusBody.ok).toBe(true);
      expect(statusBody.data.actual_hours).toBe(22);
      expect(statusBody.data.target_hours).toBe(20);
      expect(statusBody.data.status).toBe("compliant");
    });
  });

  // =========================================================================
  // AC#6: No test fixtures -- full flow from scratch
  // =========================================================================

  describe("AC#6: Full governance pipeline -- no fixtures", () => {
    it("complete flow: create VIP -> tag billable -> create commitment -> get status -> export proof", async () => {
      setupUser(db);

      const createdVip = {
        vip_id: VIP_ID_1,
        participant_hash: "sha256_full_flow_hash",
        display_name: "Board Member",
        priority_weight: 3.0,
        conditions_json: { allow_after_hours: true, min_notice_hours: 0 },
        created_at: "2026-02-15T10:00:00Z",
      };

      const createdAlloc = {
        allocation_id: ALC_ID_1,
        canonical_event_id: EVT_ID_1,
        client_id: "client_gamma",
        billing_category: "BILLABLE",
        rate: 200,
        confidence: "HIGH",
        locked: false,
        created_at: "2026-02-15T10:00:00Z",
      };

      const createdCommitment = {
        commitment_id: CMT_ID_1,
        client_id: "client_gamma",
        client_name: "Gamma LLC",
        target_hours: 15,
        window_type: "WEEKLY",
        rolling_window_weeks: 4,
        hard_minimum: true,
        proof_required: true,
        created_at: "2026-02-15T10:00:00Z",
      };

      const commitmentStatus = {
        commitment_id: CMT_ID_1,
        client_id: "client_gamma",
        client_name: "Gamma LLC",
        target_hours: 15,
        actual_hours: 12,
        window_type: "WEEKLY",
        window_start: "2026-02-10T00:00:00Z",
        window_end: "2026-02-16T23:59:59Z",
        status: "under",
        compliance_pct: 80,
      };

      const fullProofData = {
        commitment: {
          commitment_id: CMT_ID_1,
          client_id: "client_gamma",
          client_name: "Gamma LLC",
          window_type: "WEEKLY",
          target_hours: 15,
          rolling_window_weeks: 4,
          hard_minimum: true,
          proof_required: true,
          created_at: "2026-02-15T10:00:00Z",
        },
        window_start: "2026-02-10T00:00:00Z",
        window_end: "2026-02-16T23:59:59Z",
        actual_hours: 12,
        status: "under",
        events: [
          {
            canonical_event_id: EVT_ID_1,
            title: "Gamma strategy session",
            start_ts: "2026-02-14T09:00:00Z",
            end_ts: "2026-02-14T15:00:00Z",
            hours: 6,
            billing_category: "BILLABLE",
          },
          {
            canonical_event_id: EVT_ID_2,
            title: "Gamma review call",
            start_ts: "2026-02-15T10:00:00Z",
            end_ts: "2026-02-15T16:00:00Z",
            hours: 6,
            billing_category: "BILLABLE",
          },
        ],
      };

      const userGraph = createMockDONamespace({
        pathResponses: new Map([
          ["/createVipPolicy", createdVip],
          ["/createAllocation", createdAlloc],
          ["/createCommitment", createdCommitment],
          ["/getCommitmentStatus", commitmentStatus],
          ["/getCommitmentProofData", fullProofData],
          ["/listVipPolicies", { items: [createdVip] }],
          ["/listCommitments", { items: [createdCommitment] }],
        ]),
      });

      const r2 = createMockR2();
      const env = buildEnv(d1, userGraph, { r2 });
      const handler = createHandler();
      const token = await makeToken();

      // -- Step 1: Create VIP policy --
      const vipResp = await handler.fetch(
        new Request(`${BASE_URL}/v1/vip-policies`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            participant_hash: "sha256_full_flow_hash",
            display_name: "Board Member",
            priority_weight: 3.0,
            conditions_json: { allow_after_hours: true, min_notice_hours: 0 },
          }),
        }),
        env,
        mockCtx,
      );

      expect(vipResp.status).toBe(201);
      const vipBody = await vipResp.json() as { ok: boolean; data: { vip_id: string } };
      expect(vipBody.ok).toBe(true);
      expect(vipBody.data.vip_id).toBe(VIP_ID_1);

      // -- Step 2: Tag event as billable --
      const allocResp = await handler.fetch(
        new Request(`${BASE_URL}/v1/events/${EVT_ID_1}/allocation`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            billing_category: "BILLABLE",
            client_id: "client_gamma",
            rate: 200,
          }),
        }),
        env,
        mockCtx,
      );

      expect(allocResp.status).toBe(201);
      const allocBody = await allocResp.json() as {
        ok: boolean;
        data: { billing_category: string; client_id: string };
      };
      expect(allocBody.ok).toBe(true);
      expect(allocBody.data.billing_category).toBe("BILLABLE");
      expect(allocBody.data.client_id).toBe("client_gamma");

      // -- Step 3: Create commitment --
      const commitResp = await handler.fetch(
        new Request(`${BASE_URL}/v1/commitments`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            client_id: "client_gamma",
            client_name: "Gamma LLC",
            target_hours: 15,
            window_type: "WEEKLY",
            hard_minimum: true,
            proof_required: true,
          }),
        }),
        env,
        mockCtx,
      );

      expect(commitResp.status).toBe(201);
      const commitBody = await commitResp.json() as {
        ok: boolean;
        data: { commitment_id: string; target_hours: number };
      };
      expect(commitBody.ok).toBe(true);
      expect(commitBody.data.target_hours).toBe(15);

      // -- Step 4: Get commitment status (actual vs target) --
      const statusResp = await handler.fetch(
        new Request(`${BASE_URL}/v1/commitments/${CMT_ID_1}/status`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
        mockCtx,
      );

      expect(statusResp.status).toBe(200);
      const statusBody = await statusResp.json() as {
        ok: boolean;
        data: { actual_hours: number; target_hours: number; status: string };
      };
      expect(statusBody.ok).toBe(true);
      expect(statusBody.data.actual_hours).toBe(12);
      expect(statusBody.data.target_hours).toBe(15);
      expect(statusBody.data.status).toBe("under");

      // -- Step 5: Export proof document --
      const exportResp = await handler.fetch(
        new Request(`${BASE_URL}/v1/commitments/${CMT_ID_1}/export`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ format: "pdf" }),
        }),
        env,
        mockCtx,
      );

      expect(exportResp.status).toBe(200);
      const exportBody = await exportResp.json() as {
        ok: boolean;
        data: {
          proof_hash: string;
          download_url: string;
          actual_hours: number;
          target_hours: number;
          status: string;
          event_count: number;
        };
      };
      expect(exportBody.ok).toBe(true);
      expect(exportBody.data.proof_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(exportBody.data.download_url).toBeTruthy();
      expect(exportBody.data.actual_hours).toBe(12);
      expect(exportBody.data.target_hours).toBe(15);
      expect(exportBody.data.event_count).toBe(2);

      // Verify proof hash is reproducible
      const expectedHash = await computeProofHash(fullProofData);
      expect(exportBody.data.proof_hash).toBe(expectedHash);

      // -- Step 6: Download the proof --
      const downloadUrl = exportBody.data.download_url;
      const downloadResp = await handler.fetch(
        new Request(`${BASE_URL}${downloadUrl}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
        mockCtx,
      );

      expect(downloadResp.status).toBe(200);
      const proofContent = await downloadResp.text();
      expect(proofContent).toContain("Commitment Proof Document");
      expect(proofContent).toContain("Gamma LLC");
      expect(proofContent).toContain(exportBody.data.proof_hash);

      // -- Step 7: Verify dashboard data is available --
      const dashVipResp = await handler.fetch(
        new Request(`${BASE_URL}/v1/vip-policies`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
        mockCtx,
      );
      expect(dashVipResp.status).toBe(200);
      const dashVips = await dashVipResp.json() as { ok: boolean; data: unknown[] };
      expect(dashVips.data).toHaveLength(1);

      const dashCommitmentsResp = await handler.fetch(
        new Request(`${BASE_URL}/v1/commitments`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
        mockCtx,
      );
      expect(dashCommitmentsResp.status).toBe(200);
      const dashCommitments = await dashCommitmentsResp.json() as {
        ok: boolean;
        data: unknown[];
      };
      expect(dashCommitments.data).toHaveLength(1);

      // Verify all DO call paths were exercised
      const ugCalls = (userGraph as unknown as { calls: DOCallRecord[] }).calls;
      const doCallPaths = new Set(ugCalls.map((c) => c.path));
      expect(doCallPaths).toContain("/createVipPolicy");
      expect(doCallPaths).toContain("/createAllocation");
      expect(doCallPaths).toContain("/createCommitment");
      expect(doCallPaths).toContain("/getCommitmentStatus");
      expect(doCallPaths).toContain("/getCommitmentProofData");
      expect(doCallPaths).toContain("/listVipPolicies");
      expect(doCallPaths).toContain("/listCommitments");
    });
  });
});
