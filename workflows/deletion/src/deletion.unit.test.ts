/**
 * Unit tests for DeletionWorkflow.
 *
 * Tests each step in isolation with mocked dependencies.
 * Verifies:
 * - Each step calls the correct RPC endpoint / D1 query / R2 operation
 * - Each step is idempotent (running on empty state returns 0)
 * - Results are correctly shaped
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DeletionWorkflow } from "./index";
import type {
  DeletionEnv,
  R2BucketLike,
  R2ListResult,
  QueueLike,
} from "./index";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockDoStub(responses: Record<string, unknown> = {}): DurableObjectStub {
  return {
    fetch: vi.fn(async (req: Request) => {
      const url = new URL(req.url);
      const path = url.pathname;
      const data = responses[path] ?? { deleted: 0 };
      return Response.json(data);
    }),
  } as unknown as DurableObjectStub;
}

function createMockDoNamespace(stub: DurableObjectStub): DurableObjectNamespace {
  return {
    idFromName: vi.fn(() => ({ toString: () => "mock-id" })),
    get: vi.fn(() => stub),
  } as unknown as DurableObjectNamespace;
}

function createMockD1(): D1Database {
  const mockPrepare = vi.fn().mockReturnValue({
    bind: vi.fn().mockReturnValue({
      run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
      all: vi.fn().mockResolvedValue({ results: [] }),
      first: vi.fn().mockResolvedValue(null),
    }),
  });

  return { prepare: mockPrepare } as unknown as D1Database;
}

function createMockR2(objects: Array<{ key: string }> = []): R2BucketLike {
  let returned = false;
  return {
    list: vi.fn(async () => {
      if (!returned) {
        returned = true;
        return { objects, truncated: false } as R2ListResult;
      }
      return { objects: [], truncated: false } as R2ListResult;
    }),
    delete: vi.fn(async () => {}),
  };
}

function createMockQueue(): QueueLike {
  return {
    send: vi.fn(async () => {}),
    sendBatch: vi.fn(async () => {}),
  };
}

function createMockEnv(overrides: Partial<DeletionEnv> = {}): DeletionEnv {
  const stub = createMockDoStub();
  return {
    USER_GRAPH: createMockDoNamespace(stub),
    DB: createMockD1(),
    R2_AUDIT: createMockR2(),
    WRITE_QUEUE: createMockQueue(),
    MASTER_KEY: "test-master-key-unit",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DeletionWorkflow unit tests", () => {
  describe("step1_deleteEvents", () => {
    it("calls /deleteAllEvents RPC and returns step result", async () => {
      const stub = createMockDoStub({ "/deleteAllEvents": { deleted: 5 } });
      const env = createMockEnv({ USER_GRAPH: createMockDoNamespace(stub) });
      const wf = new DeletionWorkflow(env);

      const result = await wf.step1_deleteEvents(stub);

      expect(result).toEqual({ step: "delete_events", deleted: 5, ok: true });
      expect(stub.fetch).toHaveBeenCalledTimes(1);
      const fetchCall = vi.mocked(stub.fetch).mock.calls[0][0] as Request;
      expect(new URL(fetchCall.url).pathname).toBe("/deleteAllEvents");
    });

    it("is idempotent: returns deleted=0 on empty state", async () => {
      const stub = createMockDoStub({ "/deleteAllEvents": { deleted: 0 } });
      const env = createMockEnv({ USER_GRAPH: createMockDoNamespace(stub) });
      const wf = new DeletionWorkflow(env);

      const result = await wf.step1_deleteEvents(stub);
      expect(result.deleted).toBe(0);
      expect(result.ok).toBe(true);
    });
  });

  describe("step2_deleteMirrors", () => {
    it("calls /deleteAllMirrors RPC and returns step result", async () => {
      const stub = createMockDoStub({ "/deleteAllMirrors": { deleted: 3 } });
      const env = createMockEnv({ USER_GRAPH: createMockDoNamespace(stub) });
      const wf = new DeletionWorkflow(env);

      const result = await wf.step2_deleteMirrors(stub);

      expect(result).toEqual({ step: "delete_mirrors", deleted: 3, ok: true });
    });

    it("is idempotent: returns deleted=0 on empty state", async () => {
      const stub = createMockDoStub({ "/deleteAllMirrors": { deleted: 0 } });
      const wf = new DeletionWorkflow(createMockEnv());

      const result = await wf.step2_deleteMirrors(stub);
      expect(result.deleted).toBe(0);
      expect(result.ok).toBe(true);
    });
  });

  describe("step3_deleteJournal", () => {
    it("calls /deleteJournal RPC and returns step result", async () => {
      const stub = createMockDoStub({ "/deleteJournal": { deleted: 10 } });
      const wf = new DeletionWorkflow(createMockEnv());

      const result = await wf.step3_deleteJournal(stub);

      expect(result).toEqual({ step: "delete_journal", deleted: 10, ok: true });
    });

    it("is idempotent: returns deleted=0 on empty state", async () => {
      const stub = createMockDoStub({ "/deleteJournal": { deleted: 0 } });
      const wf = new DeletionWorkflow(createMockEnv());

      const result = await wf.step3_deleteJournal(stub);
      expect(result.deleted).toBe(0);
    });
  });

  describe("step4_deleteRelationshipData", () => {
    it("calls /deleteRelationshipData RPC and returns step result", async () => {
      const stub = createMockDoStub({
        "/deleteRelationshipData": { deleted: 7 },
      });
      const wf = new DeletionWorkflow(createMockEnv());

      const result = await wf.step4_deleteRelationshipData(stub);

      expect(result).toEqual({
        step: "delete_relationship_data",
        deleted: 7,
        ok: true,
      });
    });

    it("is idempotent: returns deleted=0 on empty state", async () => {
      const stub = createMockDoStub({
        "/deleteRelationshipData": { deleted: 0 },
      });
      const wf = new DeletionWorkflow(createMockEnv());

      const result = await wf.step4_deleteRelationshipData(stub);
      expect(result.deleted).toBe(0);
    });
  });

  describe("step5_deleteD1Registry", () => {
    it("deletes accounts, api_keys, and users in order", async () => {
      const bindResults = [
        { run: vi.fn().mockResolvedValue({ meta: { changes: 2 } }) }, // accounts
        { run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }) }, // api_keys
        { run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }) }, // users
      ];
      let callIndex = 0;
      const mockPrepare = vi.fn().mockReturnValue({
        bind: vi.fn(() => bindResults[callIndex++]),
      });
      const db = { prepare: mockPrepare } as unknown as D1Database;
      const env = createMockEnv({ DB: db });
      const wf = new DeletionWorkflow(env);

      const result = await wf.step5_deleteD1Registry("user_123");

      expect(result).toEqual({
        step: "delete_d1_registry",
        deleted: 4,
        ok: true,
      });

      // Verify deletion order: accounts -> api_keys -> users
      const calls = mockPrepare.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(calls[0]).toContain("accounts");
      expect(calls[1]).toContain("api_keys");
      expect(calls[2]).toContain("users");
    });

    it("is idempotent: returns deleted=0 when user does not exist", async () => {
      const env = createMockEnv();
      const wf = new DeletionWorkflow(env);

      const result = await wf.step5_deleteD1Registry("nonexistent_user");
      expect(result.deleted).toBe(0);
      expect(result.ok).toBe(true);
    });
  });

  describe("step6_deleteR2AuditObjects", () => {
    it("lists and deletes all objects with user prefix", async () => {
      const objects = [
        { key: "user_123/audit-1.json" },
        { key: "user_123/audit-2.json" },
      ];
      const r2 = createMockR2(objects);
      const env = createMockEnv({ R2_AUDIT: r2 });
      const wf = new DeletionWorkflow(env);

      const result = await wf.step6_deleteR2AuditObjects("user_123");

      expect(result).toEqual({ step: "delete_r2_audit", deleted: 2, ok: true });
      expect(r2.list).toHaveBeenCalledWith({
        prefix: "user_123/",
        cursor: undefined,
      });
      expect(r2.delete).toHaveBeenCalledWith([
        "user_123/audit-1.json",
        "user_123/audit-2.json",
      ]);
    });

    it("handles paginated R2 listings", async () => {
      let callCount = 0;
      const r2: R2BucketLike = {
        list: vi.fn(async (options?: { cursor?: string }) => {
          callCount++;
          if (callCount === 1) {
            return {
              objects: [{ key: "user_123/a.json" }],
              truncated: true,
              cursor: "page2",
            };
          }
          return { objects: [{ key: "user_123/b.json" }], truncated: false };
        }),
        delete: vi.fn(async () => {}),
      };
      const env = createMockEnv({ R2_AUDIT: r2 });
      const wf = new DeletionWorkflow(env);

      const result = await wf.step6_deleteR2AuditObjects("user_123");

      expect(result.deleted).toBe(2);
      expect(r2.list).toHaveBeenCalledTimes(2);
      expect(r2.delete).toHaveBeenCalledTimes(2);
    });

    it("is idempotent: returns deleted=0 when no objects exist", async () => {
      const r2 = createMockR2([]);
      const env = createMockEnv({ R2_AUDIT: r2 });
      const wf = new DeletionWorkflow(env);

      const result = await wf.step6_deleteR2AuditObjects("user_123");
      expect(result.deleted).toBe(0);
      expect(r2.delete).not.toHaveBeenCalled();
    });
  });

  describe("step7_enqueueProviderDeletions", () => {
    it("enqueues DELETE_USER_MIRRORS for each account", async () => {
      const queue = createMockQueue();
      const env = createMockEnv({ WRITE_QUEUE: queue });
      const wf = new DeletionWorkflow(env);

      const accounts = [
        { account_id: "acc_1", user_id: "user_123", provider: "google", email: "a@test.com" },
        { account_id: "acc_2", user_id: "user_123", provider: "google", email: "b@test.com" },
      ];

      const result = await wf.step7_enqueueProviderDeletions("user_123", accounts);

      expect(result).toEqual({
        step: "enqueue_provider_deletions",
        deleted: 2,
        ok: true,
      });
      expect(queue.send).toHaveBeenCalledTimes(2);
      expect(queue.send).toHaveBeenCalledWith({
        type: "DELETE_USER_MIRRORS",
        user_id: "user_123",
        account_id: "acc_1",
        provider: "google",
      });
      expect(queue.send).toHaveBeenCalledWith({
        type: "DELETE_USER_MIRRORS",
        user_id: "user_123",
        account_id: "acc_2",
        provider: "google",
      });
    });

    it("is idempotent: returns deleted=0 when no accounts exist", async () => {
      const env = createMockEnv();
      const wf = new DeletionWorkflow(env);

      const result = await wf.step7_enqueueProviderDeletions("user_123", []);
      expect(result.deleted).toBe(0);
    });
  });

  describe("step8_generateCertificate", () => {
    it("generates a signed certificate and stores in D1", async () => {
      const runMock = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
      const mockPrepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({ run: runMock }),
      });
      const db = { prepare: mockPrepare } as unknown as D1Database;
      const env = createMockEnv({ DB: db, MASTER_KEY: "test-key" });
      const wf = new DeletionWorkflow(env);

      const previousSteps = [
        { step: "delete_events", deleted: 5, ok: true },
        { step: "delete_mirrors", deleted: 3, ok: true },
        { step: "delete_journal", deleted: 10, ok: true },
        { step: "delete_relationship_data", deleted: 7, ok: true },
        { step: "delete_d1_registry", deleted: 4, ok: true },
        { step: "delete_r2_audit", deleted: 2, ok: true },
        { step: "enqueue_provider_deletions", deleted: 1, ok: true },
      ];

      const { stepResult, certificateId } = await wf.step8_generateCertificate(
        "user_123",
        previousSteps,
      );

      expect(stepResult).toEqual({ step: "generate_certificate", deleted: 1, ok: true });
      expect(certificateId).toMatch(/^crt_/);
      expect(mockPrepare.mock.calls[0][0]).toContain("INSERT OR IGNORE INTO deletion_certificates");
    });
  });

  describe("step9_markCompleted", () => {
    it("updates deletion_requests to completed status", async () => {
      const runMock = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
      const mockPrepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({ run: runMock }),
      });
      const db = { prepare: mockPrepare } as unknown as D1Database;
      const env = createMockEnv({ DB: db });
      const wf = new DeletionWorkflow(env);

      const result = await wf.step9_markCompleted("req_123");

      expect(result).toEqual({ step: "mark_completed", deleted: 1, ok: true });
      expect(mockPrepare.mock.calls[0][0]).toContain("UPDATE deletion_requests");
      expect(mockPrepare.mock.calls[0][0]).toContain("status = 'completed'");
    });

    it("is idempotent: returns deleted=0 if already completed", async () => {
      const env = createMockEnv();
      const wf = new DeletionWorkflow(env);

      const result = await wf.step9_markCompleted("req_completed");
      expect(result.deleted).toBe(0);
      expect(result.ok).toBe(true);
    });
  });

  describe("run (full workflow)", () => {
    it("executes all 9 steps in order and returns complete result", async () => {
      const stub = createMockDoStub({
        "/deleteAllEvents": { deleted: 5 },
        "/deleteAllMirrors": { deleted: 3 },
        "/deleteJournal": { deleted: 10 },
        "/deleteRelationshipData": { deleted: 7 },
      });
      const doNs = createMockDoNamespace(stub);

      // D1 mock: responds to prepare calls in order
      const d1Responses = [
        // Pre-fetch accounts query (all().results)
        {
          bind: vi.fn().mockReturnValue({
            all: vi.fn().mockResolvedValue({
              results: [
                { account_id: "acc_1", user_id: "user_123", provider: "google", email: "a@t.com" },
              ],
            }),
          }),
        },
        // Step 5: DELETE FROM accounts
        {
          bind: vi.fn().mockReturnValue({
            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          }),
        },
        // Step 5: DELETE FROM api_keys
        {
          bind: vi.fn().mockReturnValue({
            run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
          }),
        },
        // Step 5: DELETE FROM users
        {
          bind: vi.fn().mockReturnValue({
            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          }),
        },
        // Step 8: INSERT INTO deletion_certificates
        {
          bind: vi.fn().mockReturnValue({
            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          }),
        },
        // Step 9: UPDATE deletion_requests
        {
          bind: vi.fn().mockReturnValue({
            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          }),
        },
      ];
      let d1CallIdx = 0;
      const db = {
        prepare: vi.fn(() => d1Responses[d1CallIdx++]),
      } as unknown as D1Database;

      const r2 = createMockR2([{ key: "user_123/audit.json" }]);
      const queue = createMockQueue();

      const env: DeletionEnv = {
        USER_GRAPH: doNs,
        DB: db,
        R2_AUDIT: r2,
        WRITE_QUEUE: queue,
        MASTER_KEY: "test-key-full-workflow",
      };

      const wf = new DeletionWorkflow(env);
      const result = await wf.run({
        request_id: "req_001",
        user_id: "user_123",
      });

      // Verify all 9 steps completed
      expect(result.steps).toHaveLength(9);
      expect(result.request_id).toBe("req_001");
      expect(result.user_id).toBe("user_123");
      expect(result.completed_at).toBeDefined();
      expect(result.certificate_id).toMatch(/^crt_/);

      // Verify step names in order
      const stepNames = result.steps.map((s) => s.step);
      expect(stepNames).toEqual([
        "delete_events",
        "delete_mirrors",
        "delete_journal",
        "delete_relationship_data",
        "delete_d1_registry",
        "delete_r2_audit",
        "enqueue_provider_deletions",
        "generate_certificate",
        "mark_completed",
      ]);

      // Verify all steps report ok
      for (const step of result.steps) {
        expect(step.ok).toBe(true);
      }

      // Verify DO stub was called 4 times (steps 1-4)
      expect(stub.fetch).toHaveBeenCalledTimes(4);

      // Verify queue received provider deletion message
      expect(queue.send).toHaveBeenCalledWith({
        type: "DELETE_USER_MIRRORS",
        user_id: "user_123",
        account_id: "acc_1",
        provider: "google",
      });
    });

    it("full workflow with no user data is still successful (idempotent)", async () => {
      const stub = createMockDoStub();
      const doNs = createMockDoNamespace(stub);
      const db = createMockD1();
      const r2 = createMockR2([]);
      const queue = createMockQueue();

      const env: DeletionEnv = {
        USER_GRAPH: doNs,
        DB: db,
        R2_AUDIT: r2,
        WRITE_QUEUE: queue,
        MASTER_KEY: "test-key-empty",
      };

      const wf = new DeletionWorkflow(env);
      const result = await wf.run({
        request_id: "req_empty",
        user_id: "nonexistent_user",
      });

      expect(result.steps).toHaveLength(9);
      for (const step of result.steps) {
        expect(step.ok).toBe(true);
        // generate_certificate always produces 1
        if (step.step === "generate_certificate") {
          expect(step.deleted).toBe(1);
        } else {
          expect(step.deleted).toBe(0);
        }
      }
    });
  });
});
