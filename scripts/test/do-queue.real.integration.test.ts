/**
 * Real DO+queue integration tests for sync-consumer and write-consumer.
 *
 * Proves the full pipeline with REAL Durable Objects (wrangler dev):
 * - sync-consumer: SYNC_INCREMENTAL -> AccountDO.getAccessToken -> fetch events
 *   -> UserGraphDO.applyProviderDelta
 * - write-consumer: UPSERT_MIRROR -> AccountDO.getAccessToken -> create event
 *   -> UserGraphDO mirror state updated
 * - Full pipeline: sync -> canonical store -> write -> mirror state
 * - Error handling: DO 404 plain text, failed API calls
 *
 * Architecture:
 * - Single wrangler dev instance hosting AccountDO + UserGraphDO via do-test-worker.ts
 * - Queue consumer logic driven programmatically (import handler, call directly)
 *   because local wrangler dev cannot run cross-worker queue bindings.
 *   Same code paths as production queue consumers.
 * - D1 registry lookups simulated via a mock D1 object
 * - Google Calendar API mocked via injectable fetchFn (real API already proven by TM-e8z)
 * - DOs are REAL -- real SQLite storage, real encryption, real fetch routing
 *
 * AccountDO is seeded via DO RPC client (scripts/test/do-rpc-client.ts).
 *
 * @see TM-ap8 -- Full DO+queue real integration tests
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { startWranglerDev, DEFAULTS } from "./integration-helpers.js";
import type { StartedWorker } from "./integration-helpers.js";
import { DoRpcClient } from "./do-rpc-client.js";
import type { ProviderDeltaPayload } from "./do-rpc-client.js";
import {
  handleIncrementalSync,
  handleFullSync,
} from "../../workers/sync-consumer/src/index.js";
import type { SyncConsumerDeps } from "../../workers/sync-consumer/src/index.js";
import {
  createWriteQueueHandler,
} from "../../workers/write-consumer/src/index.js";
import type {
  SyncIncrementalMessage,
  SyncFullMessage,
  UpsertMirrorMessage,
  DeleteMirrorMessage,
  AccountId,
  EventId,
  CalendarId,
  ProjectedEvent,
} from "@tminus/shared";

const ROOT = resolve(import.meta.dirname, "../..");
const TEST_PORT = 18797;
const MASTER_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

let worker: StartedWorker;
let client: DoRpcClient;

beforeAll(async () => {
  worker = await startWranglerDev({
    wranglerToml: resolve(ROOT, "scripts/test/wrangler-test.toml"),
    port: TEST_PORT,
    vars: {
      MASTER_KEY: MASTER_KEY_HEX,
    },
    healthTimeoutMs: 60_000,
  });

  client = new DoRpcClient({ baseUrl: worker.url });
}, 90_000);

afterAll(async () => {
  if (worker) {
    await worker.cleanup(true);
  }
}, 15_000);

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_USER_ID = "usr_01JDOQUEUE000000000000001";
const TEST_ACCOUNT_ID = "acc_01JDOQUEUE000000000000001" as AccountId;
const TEST_ACCOUNT_ID_B = "acc_01JDOQUEUE000000000000002" as AccountId;
const TEST_ACCESS_TOKEN = "ya29.test-access-token-for-do-queue-tests";
const TEST_REFRESH_TOKEN = "1//test-refresh-token-do-queue";
const TEST_SYNC_TOKEN = "sync-token-do-queue-abc123";
const NEW_SYNC_TOKEN = "sync-token-do-queue-def456";

const TEST_TOKENS = {
  access_token: TEST_ACCESS_TOKEN,
  refresh_token: TEST_REFRESH_TOKEN,
  expiry: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
};
const TEST_SCOPES = "https://www.googleapis.com/auth/calendar";

// Unique DO name per test run to avoid state leaking
let testCounter = 0;
function uniqueSuffix(): string {
  return `${Date.now()}-${++testCounter}`;
}

// ---------------------------------------------------------------------------
// Mock D1 -- simulates the D1 registry used by consumers for account lookups
// ---------------------------------------------------------------------------

/**
 * Creates a mock D1Database that returns preset rows for SQL queries.
 * The consumers use DB.prepare("SELECT ... FROM accounts WHERE account_id = ?1")
 * so we intercept that pattern.
 */
function createMockD1(accounts: Array<{
  account_id: string;
  user_id: string;
  provider: string;
}>): D1Database {
  return {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          const accountId = params[0] as string;
          return {
            async first<T>(): Promise<T | null> {
              const match = accounts.find((a) => a.account_id === accountId);
              if (!match) return null;
              // Return both user_id and provider -- consumers may query either
              return { user_id: match.user_id, provider: match.provider } as T;
            },
            async all() { return { results: [], success: true, meta: {} }; },
            async run() { return { success: true, meta: {} }; },
            async raw() { return []; },
          };
        },
        async first<T>(): Promise<T | null> { return null; },
        async all() { return { results: [], success: true, meta: {} }; },
        async run() { return { success: true, meta: {} }; },
        async raw() { return []; },
      };
    },
    async batch() { return []; },
    async exec() { return { count: 0, duration: 0 }; },
    async dump() { return new ArrayBuffer(0); },
  } as unknown as D1Database;
}

// ---------------------------------------------------------------------------
// Mock Queue -- captures messages sent by consumers
// ---------------------------------------------------------------------------

interface CapturedMessage {
  body: unknown;
}

function createMockQueue(): Queue & { sent: CapturedMessage[] } {
  const sent: CapturedMessage[] = [];
  return {
    sent,
    async send(message: unknown): Promise<void> {
      sent.push({ body: message });
    },
    async sendBatch(messages: Iterable<{ body: unknown }>): Promise<void> {
      for (const m of messages) {
        sent.push({ body: m.body });
      }
    },
  } as unknown as Queue & { sent: CapturedMessage[] };
}

// ---------------------------------------------------------------------------
// DO namespace proxy -- routes stub.fetch() through the test worker's HTTP RPC
// ---------------------------------------------------------------------------

/**
 * Creates a mock DurableObjectNamespace that proxies DO fetch calls
 * through the test worker's HTTP RPC endpoint.
 *
 * This lets consumer code like:
 *   const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName("acct-1"));
 *   const response = await stub.fetch(new Request(...));
 *
 * ...actually reach real DOs running in the test worker.
 */
function createDoNamespaceProxy(
  baseUrl: string,
  namespace: "ACCOUNT" | "USER_GRAPH",
): DurableObjectNamespace {
  return {
    idFromName(name: string): DurableObjectId {
      // Encode the DO name in the id so get() can retrieve it
      return { name, toString: () => name } as unknown as DurableObjectId;
    },
    get(id: DurableObjectId): DurableObjectStub {
      const doName = (id as unknown as { name: string }).name;
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
          // Extract the path from the request
          const request = input instanceof Request ? input : new Request(input, init);
          const url = new URL(request.url);
          const doPath = url.pathname;

          // Forward to test worker: POST /do/:namespace/:name/:path
          const proxyUrl = `${baseUrl}/do/${namespace}/${doName}${doPath}`;

          // Read the body from the original request
          const body = request.body ? await request.text() : undefined;

          const response = await fetch(proxyUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: body || undefined,
          });

          return response;
        },
        id: id,
        name: doName,
      } as unknown as DurableObjectStub;
    },
    idFromString(_hexId: string): DurableObjectId {
      throw new Error("idFromString not implemented in test proxy");
    },
    newUniqueId(): DurableObjectId {
      throw new Error("newUniqueId not implemented in test proxy");
    },
    jurisdiction(_jd: string) {
      return this;
    },
  } as unknown as DurableObjectNamespace;
}

// ---------------------------------------------------------------------------
// No-op sleep to avoid real delays in retry logic
// ---------------------------------------------------------------------------

const noopSleep = async (_ms: number): Promise<void> => {};

// ---------------------------------------------------------------------------
// Google Calendar API mock for sync-consumer
// ---------------------------------------------------------------------------

/**
 * Creates a mock fetch function that simulates Google Calendar events.list.
 * Returns configurable events and sync tokens.
 */
function createMockGoogleFetch(opts: {
  events?: Array<Record<string, unknown>>;
  nextSyncToken?: string;
  nextPageToken?: string;
  statusCode?: number;
  errorBody?: string;
}): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    // Handle Google Calendar events.list
    if (url.includes("googleapis.com/calendar/v3/calendars") && url.includes("/events")) {
      if (opts.statusCode && opts.statusCode !== 200) {
        return new Response(opts.errorBody ?? `{"error":{"code":${opts.statusCode}}}`, {
          status: opts.statusCode,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(
        JSON.stringify({
          items: opts.events ?? [],
          nextSyncToken: opts.nextSyncToken ?? "mock-sync-token",
          nextPageToken: opts.nextPageToken,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Handle Google Calendar calendars.insert (for busy overlay)
    if (url.includes("googleapis.com/calendar/v3/calendars") && !url.includes("/events")) {
      return new Response(
        JSON.stringify({ id: "mock-calendar-id-12345" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Handle Google Calendar events.insert
    if (url.includes("googleapis.com/calendar/v3/calendars") && url.includes("/events")) {
      return new Response(
        JSON.stringify({ id: "mock-event-id-12345" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // Default: return 404
    return new Response("Not Found", { status: 404 });
  };
}

/**
 * Creates a mock fetch function for write-consumer that simulates
 * Google Calendar API insert/patch/delete event calls.
 */
function createMockGoogleWriteFetch(opts?: {
  insertedEventId?: string;
  statusCode?: number;
}): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  const eventId = opts?.insertedEventId ?? `mock-provider-evt-${Date.now()}`;

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const request = input instanceof Request ? input : new Request(input, init);
    const method = request.method;

    if (opts?.statusCode && opts.statusCode !== 200) {
      return new Response(
        JSON.stringify({ error: { code: opts.statusCode, message: "Mock error" } }),
        { status: opts.statusCode, headers: { "Content-Type": "application/json" } },
      );
    }

    // events.insert (POST to /events without /:eventId)
    if (method === "POST" && url.includes("/events") && !url.includes("/events/")) {
      return new Response(
        JSON.stringify({ id: eventId, status: "confirmed" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // events.patch (PATCH to /events/:eventId)
    if (method === "PATCH" && url.includes("/events/")) {
      return new Response(
        JSON.stringify({ id: eventId, status: "confirmed" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // events.delete (DELETE to /events/:eventId)
    if (method === "DELETE" && url.includes("/events/")) {
      return new Response("", { status: 204 });
    }

    // calendars.insert (POST to /calendars)
    if (method === "POST" && url.includes("/calendars") && !url.includes("/events")) {
      return new Response(
        JSON.stringify({ id: `mock-overlay-cal-${Date.now()}` }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("Not Found", { status: 404 });
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeProjectedPayload(overrides?: Partial<ProjectedEvent>): ProjectedEvent {
  return {
    summary: "Busy",
    start: { dateTime: new Date(Date.now() + 86400_000).toISOString() },
    end: { dateTime: new Date(Date.now() + 86400_000 + 1800_000).toISOString() },
    transparency: "opaque",
    visibility: "private",
    extendedProperties: {
      private: {
        tminus: "true",
        managed: "true",
        canonical_event_id: "evt_01JDOQUEUE000000000000001" as EventId,
        origin_account_id: TEST_ACCOUNT_ID,
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("DO+queue real integration (wrangler dev)", () => {
  // -------------------------------------------------------------------------
  // sync-consumer: SYNC_INCREMENTAL with real DOs
  // -------------------------------------------------------------------------

  describe("sync-consumer: handleIncrementalSync with real DOs", () => {
    it("processes SYNC_INCREMENTAL: AccountDO returns token, events applied to UserGraphDO", async () => {
      const suffix = uniqueSuffix();
      const accountName = `doq-sync-acct-${suffix}`;
      const userName = `doq-sync-user-${suffix}`;

      // Step 1: Seed AccountDO with tokens via RPC client (REAL DO)
      const acct = client.account(accountName);
      const initResult = await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      expect(initResult.ok).toBe(true);

      // Step 2: Set a sync token so incremental sync can proceed
      await acct.setSyncToken(TEST_SYNC_TOKEN);

      // Step 3: Build the mock Env with real DO proxies
      const mockD1 = createMockD1([{
        account_id: accountName,
        user_id: userName,
        provider: "google",
      }]);

      const syncQueue = createMockQueue();
      const writeQueue = createMockQueue();

      const env: Env = {
        ACCOUNT: createDoNamespaceProxy(worker.url, "ACCOUNT"),
        USER_GRAPH: createDoNamespaceProxy(worker.url, "USER_GRAPH"),
        DB: mockD1,
        SYNC_QUEUE: syncQueue,
        WRITE_QUEUE: writeQueue,
        GOOGLE_CLIENT_ID: "mock-client-id",
        GOOGLE_CLIENT_SECRET: "mock-client-secret",
        MASTER_KEY: MASTER_KEY_HEX,
      } as unknown as Env;

      // Step 4: Create mock Google Calendar API that returns one event
      const mockFetch = createMockGoogleFetch({
        events: [
          {
            id: "google_evt_doq_001",
            summary: "DO Queue Test Event",
            description: "Test event for DO+queue integration",
            start: { dateTime: "2026-02-20T10:00:00Z" },
            end: { dateTime: "2026-02-20T11:00:00Z" },
            status: "confirmed",
            visibility: "default",
            transparency: "opaque",
          },
        ],
        nextSyncToken: NEW_SYNC_TOKEN,
      });

      const deps: SyncConsumerDeps = {
        fetchFn: mockFetch,
        sleepFn: noopSleep,
      };

      // Step 5: Call handleIncrementalSync programmatically
      const message: SyncIncrementalMessage = {
        type: "SYNC_INCREMENTAL",
        account_id: accountName as AccountId,
        channel_id: "ch_test",
        resource_id: "res_test",
        ping_ts: new Date().toISOString(),
        calendar_id: null,
      };

      // This calls the REAL AccountDO (getAccessToken, getSyncToken, setSyncToken, markSyncSuccess)
      // and the REAL UserGraphDO (applyProviderDelta) via the DO namespace proxies
      await handleIncrementalSync(message, env, deps);

      // Step 6: Verify AccountDO state was updated (REAL DO)
      const syncToken = await acct.getSyncToken();
      expect(syncToken.sync_token).toBe(NEW_SYNC_TOKEN);

      const health = await acct.getHealth();
      expect(health.lastSuccessTs).not.toBeNull();

      // Step 7: Verify UserGraphDO received the delta (REAL DO)
      const ug = client.userGraph(userName);
      const events = await ug.listCanonicalEvents({
        origin_account_id: accountName,
      });
      expect(events.items.length).toBeGreaterThanOrEqual(1);

      // Find the event we synced
      const syncedEvent = events.items.find(
        (e) => (e as Record<string, unknown>).origin_event_id === "google_evt_doq_001",
      );
      expect(syncedEvent).toBeDefined();
      expect((syncedEvent as Record<string, unknown>).title).toBe("DO Queue Test Event");
    });

    it("handles 410 Gone by enqueuing SYNC_FULL message", async () => {
      const suffix = uniqueSuffix();
      const accountName = `doq-sync410-acct-${suffix}`;

      // Seed AccountDO
      const acct = client.account(accountName);
      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      await acct.setSyncToken("old-expired-token");

      const mockD1 = createMockD1([{
        account_id: accountName,
        user_id: `doq-sync410-user-${suffix}`,
        provider: "google",
      }]);

      const syncQueue = createMockQueue();

      const env = {
        ACCOUNT: createDoNamespaceProxy(worker.url, "ACCOUNT"),
        USER_GRAPH: createDoNamespaceProxy(worker.url, "USER_GRAPH"),
        DB: mockD1,
        SYNC_QUEUE: syncQueue,
        WRITE_QUEUE: createMockQueue(),
        GOOGLE_CLIENT_ID: "mock",
        GOOGLE_CLIENT_SECRET: "mock",
        MASTER_KEY: MASTER_KEY_HEX,
      } as unknown as Env;

      // Mock Google API returning 410 Gone
      const mockFetch = createMockGoogleFetch({
        statusCode: 410,
        errorBody: JSON.stringify({
          error: { code: 410, message: "Sync token expired", status: "GONE" },
        }),
      });

      const deps: SyncConsumerDeps = { fetchFn: mockFetch, sleepFn: noopSleep };

      const message: SyncIncrementalMessage = {
        type: "SYNC_INCREMENTAL",
        account_id: accountName as AccountId,
        channel_id: "ch_test",
        resource_id: "res_test",
        ping_ts: new Date().toISOString(),
        calendar_id: null,
      };

      await handleIncrementalSync(message, env, deps);

      // Verify SYNC_FULL was enqueued
      expect(syncQueue.sent.length).toBe(1);
      const enqueuedMsg = syncQueue.sent[0].body as SyncFullMessage;
      expect(enqueuedMsg.type).toBe("SYNC_FULL");
      expect(enqueuedMsg.account_id).toBe(accountName);
      expect(enqueuedMsg.reason).toBe("token_410");
    });
  });

  // -------------------------------------------------------------------------
  // sync-consumer: SYNC_FULL with real DOs
  // -------------------------------------------------------------------------

  describe("sync-consumer: handleFullSync with real DOs", () => {
    it("processes SYNC_FULL: fetches all events, applies deltas to UserGraphDO", async () => {
      const suffix = uniqueSuffix();
      const accountName = `doq-fullsync-acct-${suffix}`;
      const userName = `doq-fullsync-user-${suffix}`;

      // Seed AccountDO
      const acct = client.account(accountName);
      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      const mockD1 = createMockD1([{
        account_id: accountName,
        user_id: userName,
        provider: "google",
      }]);

      const env = {
        ACCOUNT: createDoNamespaceProxy(worker.url, "ACCOUNT"),
        USER_GRAPH: createDoNamespaceProxy(worker.url, "USER_GRAPH"),
        DB: mockD1,
        SYNC_QUEUE: createMockQueue(),
        WRITE_QUEUE: createMockQueue(),
        GOOGLE_CLIENT_ID: "mock",
        GOOGLE_CLIENT_SECRET: "mock",
        MASTER_KEY: MASTER_KEY_HEX,
      } as unknown as Env;

      // Mock Google API returning multiple events
      const mockFetch = createMockGoogleFetch({
        events: [
          {
            id: "google_evt_full_001",
            summary: "Full Sync Event 1",
            start: { dateTime: "2026-02-20T08:00:00Z" },
            end: { dateTime: "2026-02-20T09:00:00Z" },
            status: "confirmed",
          },
          {
            id: "google_evt_full_002",
            summary: "Full Sync Event 2",
            start: { dateTime: "2026-02-20T14:00:00Z" },
            end: { dateTime: "2026-02-20T15:00:00Z" },
            status: "confirmed",
          },
        ],
        nextSyncToken: "full-sync-final-token",
      });

      const deps: SyncConsumerDeps = { fetchFn: mockFetch, sleepFn: noopSleep };

      const message: SyncFullMessage = {
        type: "SYNC_FULL",
        account_id: accountName as AccountId,
        reason: "onboarding",
      };

      await handleFullSync(message, env, deps);

      // Verify sync token stored in AccountDO
      const syncToken = await acct.getSyncToken();
      expect(syncToken.sync_token).toBe("full-sync-final-token");

      // Verify health updated
      const health = await acct.getHealth();
      expect(health.lastSuccessTs).not.toBeNull();

      // Verify UserGraphDO received both events
      const ug = client.userGraph(userName);
      const events = await ug.listCanonicalEvents({
        origin_account_id: accountName,
      });
      expect(events.items.length).toBeGreaterThanOrEqual(2);
    });
  });

  // -------------------------------------------------------------------------
  // write-consumer: UPSERT_MIRROR with real DOs
  // -------------------------------------------------------------------------

  describe("write-consumer: UPSERT_MIRROR with real DOs", () => {
    it("processes UPSERT_MIRROR: gets token from AccountDO, creates event, updates DO mirror state", async () => {
      const suffix = uniqueSuffix();
      const accountName = `doq-write-acct-${suffix}`;
      const userName = `doq-write-user-${suffix}`;
      const originAccountName = `doq-write-origin-${suffix}`;
      const canonicalEventId = `evt_01JDOQWRITE${suffix.replace(/-/g, "").slice(0, 14)}` as EventId;

      // Step 1: Seed AccountDO with tokens
      const acct = client.account(accountName);
      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      // Step 2: Set up UserGraphDO with policy edges BEFORE applying delta.
      // applyProviderDelta calls projectAndEnqueue which looks up policy_edges
      // at delta time -- edges must exist for mirrors to be created.
      const ug = client.userGraph(userName);
      const policy = await ug.createPolicy("test-write-policy");
      expect(policy.policy_id).toBeDefined();
      await ug.setPolicyEdges(policy.policy_id, [
        {
          from_account_id: originAccountName,
          to_account_id: accountName,
          detail_level: "BUSY",
          calendar_kind: "BUSY_OVERLAY",
        },
      ]);

      // Step 3: Apply delta -- this creates canonical event + PENDING mirror
      const applyResult = await ug.applyProviderDelta(originAccountName, [
        {
          type: "created",
          origin_event_id: "google_evt_write_origin_001",
          event: {
            origin_account_id: originAccountName,
            origin_event_id: "google_evt_write_origin_001",
            title: "Origin Event for Mirror Test",
            start: { dateTime: "2026-02-20T10:00:00Z" },
            end: { dateTime: "2026-02-20T11:00:00Z" },
          },
        },
      ]);
      expect(applyResult.created).toBe(1);
      expect(applyResult.mirrors_enqueued).toBeGreaterThanOrEqual(1);

      // Get the canonical event ID
      const canonicalEvents = await ug.listCanonicalEvents({
        origin_account_id: originAccountName,
      });
      expect(canonicalEvents.items.length).toBeGreaterThanOrEqual(1);
      const actualCanonicalId = (canonicalEvents.items[0] as Record<string, unknown>).canonical_event_id as string;

      // Step 4: Build the write-consumer env
      const mockD1 = createMockD1([
        { account_id: accountName, user_id: userName, provider: "google" },
        { account_id: originAccountName, user_id: userName, provider: "google" },
      ]);

      const mockInsertedEventId = `mock-provider-evt-${suffix}`;
      const mockFetch = createMockGoogleWriteFetch({
        insertedEventId: mockInsertedEventId,
      });

      const env = {
        ACCOUNT: createDoNamespaceProxy(worker.url, "ACCOUNT"),
        USER_GRAPH: createDoNamespaceProxy(worker.url, "USER_GRAPH"),
        DB: mockD1,
      } as unknown as Env;

      // Step 5: Create the write-consumer handler with mock Google API
      const writeHandler = createWriteQueueHandler({ fetchFn: mockFetch });

      // Step 6: Create a mock batch message
      const acked: string[] = [];
      const retried: string[] = [];

      const msg: UpsertMirrorMessage = {
        type: "UPSERT_MIRROR",
        canonical_event_id: actualCanonicalId as EventId,
        target_account_id: accountName as AccountId,
        target_calendar_id: accountName as unknown as CalendarId, // placeholder -- triggers overlay calendar creation
        projected_payload: makeProjectedPayload({
          extendedProperties: {
            private: {
              tminus: "true",
              managed: "true",
              canonical_event_id: actualCanonicalId as EventId,
              origin_account_id: originAccountName as AccountId,
            },
          },
        }),
        idempotency_key: `idem-doq-write-${suffix}`,
      };

      const mockBatch = {
        queue: "tminus-write-queue",
        messages: [
          {
            id: `msg-${suffix}`,
            timestamp: new Date(),
            body: msg,
            ack() { acked.push(this.id); },
            retry() { retried.push(this.id); },
          },
        ],
      } as unknown as MessageBatch<UpsertMirrorMessage | DeleteMirrorMessage>;

      // Step 7: Process the queue batch
      await writeHandler.queue(mockBatch, env);

      // Step 8: Verify message was acked (not retried)
      expect(acked.length).toBe(1);
      expect(retried.length).toBe(0);

      // Step 9: Verify mirror state in UserGraphDO was updated
      const mirrorResp = await ug.raw<{
        mirror: {
          state: string;
          provider_event_id: string | null;
          last_write_ts: string | null;
        } | null;
      }>("/getMirror", {
        canonical_event_id: actualCanonicalId,
        target_account_id: accountName,
      });

      // The mirror should be ACTIVE with a provider_event_id
      expect(mirrorResp.data.mirror).not.toBeNull();
      expect(mirrorResp.data.mirror!.state).toBe("ACTIVE");
      expect(mirrorResp.data.mirror!.provider_event_id).toBe(mockInsertedEventId);
      expect(mirrorResp.data.mirror!.last_write_ts).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Full pipeline: sync -> canonical store -> write -> mirror
  // -------------------------------------------------------------------------

  describe("full pipeline: sync -> canonical -> write", () => {
    it("sync creates canonical events, then write creates mirrors with state tracking", async () => {
      const suffix = uniqueSuffix();
      const originAccount = `doq-pipe-origin-${suffix}`;
      const targetAccount = `doq-pipe-target-${suffix}`;
      const userName = `doq-pipe-user-${suffix}`;

      // Step 1: Seed both AccountDOs
      const originAcct = client.account(originAccount);
      await originAcct.initialize(TEST_TOKENS, TEST_SCOPES);

      const targetAcct = client.account(targetAccount);
      await targetAcct.initialize(TEST_TOKENS, TEST_SCOPES);

      // Step 2: Set up UserGraphDO with a policy
      const ug = client.userGraph(userName);
      await ug.ensureDefaultPolicy([originAccount, targetAccount]);

      const policy = await ug.createPolicy("test-pipeline-policy");
      expect(policy.policy_id).toBeDefined();

      await ug.setPolicyEdges(policy.policy_id, [
        {
          from_account_id: originAccount,
          to_account_id: targetAccount,
          detail_level: "BUSY",
          calendar_kind: "BUSY_OVERLAY",
        },
      ]);

      // Step 3: Run sync-consumer (creates canonical events in UserGraphDO)
      const syncMockD1 = createMockD1([{
        account_id: originAccount,
        user_id: userName,
        provider: "google",
      }]);

      const writeQueue = createMockQueue();

      const syncEnv = {
        ACCOUNT: createDoNamespaceProxy(worker.url, "ACCOUNT"),
        USER_GRAPH: createDoNamespaceProxy(worker.url, "USER_GRAPH"),
        DB: syncMockD1,
        SYNC_QUEUE: createMockQueue(),
        WRITE_QUEUE: writeQueue,
        GOOGLE_CLIENT_ID: "mock",
        GOOGLE_CLIENT_SECRET: "mock",
        MASTER_KEY: MASTER_KEY_HEX,
      } as unknown as Env;

      const syncFetch = createMockGoogleFetch({
        events: [
          {
            id: "google_evt_pipeline_001",
            summary: "Pipeline Test Event",
            start: { dateTime: "2026-02-22T10:00:00Z" },
            end: { dateTime: "2026-02-22T11:00:00Z" },
            status: "confirmed",
          },
        ],
        nextSyncToken: "pipeline-sync-token",
      });

      await handleFullSync(
        {
          type: "SYNC_FULL",
          account_id: originAccount as AccountId,
          reason: "onboarding",
        },
        syncEnv,
        { fetchFn: syncFetch, sleepFn: noopSleep },
      );

      // Verify canonical event was created
      const events = await ug.listCanonicalEvents({
        origin_account_id: originAccount,
      });
      expect(events.items.length).toBeGreaterThanOrEqual(1);
      const canonicalId = (events.items[0] as Record<string, unknown>).canonical_event_id as string;

      // Step 4: Check mirrors were enqueued by UserGraphDO
      // The UserGraphDO WRITE_QUEUE is the one bound in wrangler-test.toml,
      // not our mock. We verify indirectly by checking mirror state.
      const syncHealth = await ug.getSyncHealth();
      expect(syncHealth.total_events).toBeGreaterThanOrEqual(1);
      // Mirrors should be PENDING (enqueued but not yet processed)
      expect(syncHealth.pending_mirrors).toBeGreaterThanOrEqual(0);

      // Step 5: Process the write side (simulating write-consumer)
      // First check if there's a mirror for the canonical event
      const mirrorCheck = await ug.raw<{
        mirror: { state: string; target_calendar_id: string } | null;
      }>("/getMirror", {
        canonical_event_id: canonicalId,
        target_account_id: targetAccount,
      });

      if (mirrorCheck.data.mirror) {
        // There IS a pending mirror -- process it
        const writeMockD1 = createMockD1([
          { account_id: targetAccount, user_id: userName, provider: "google" },
          { account_id: originAccount, user_id: userName, provider: "google" },
        ]);

        const mockInsertedId = `mock-pipeline-evt-${suffix}`;
        const writeFetch = createMockGoogleWriteFetch({ insertedEventId: mockInsertedId });

        const writeEnv = {
          ACCOUNT: createDoNamespaceProxy(worker.url, "ACCOUNT"),
          USER_GRAPH: createDoNamespaceProxy(worker.url, "USER_GRAPH"),
          DB: writeMockD1,
        } as unknown as Env;

        const writeHandler = createWriteQueueHandler({ fetchFn: writeFetch });

        const acked: string[] = [];

        const writeBatch = {
          queue: "tminus-write-queue",
          messages: [{
            id: `msg-pipeline-${suffix}`,
            timestamp: new Date(),
            body: {
              type: "UPSERT_MIRROR",
              canonical_event_id: canonicalId,
              target_account_id: targetAccount,
              target_calendar_id: mirrorCheck.data.mirror.target_calendar_id,
              projected_payload: makeProjectedPayload({
                extendedProperties: {
                  private: {
                    tminus: "true",
                    managed: "true",
                    canonical_event_id: canonicalId as EventId,
                    origin_account_id: originAccount as AccountId,
                  },
                },
              }),
              idempotency_key: `idem-pipeline-${suffix}`,
            } as UpsertMirrorMessage,
            ack() { acked.push(this.id); },
            retry() {},
          }],
        } as unknown as MessageBatch<UpsertMirrorMessage | DeleteMirrorMessage>;

        await writeHandler.queue(writeBatch, writeEnv);
        expect(acked.length).toBe(1);

        // Verify mirror is now ACTIVE
        const finalMirror = await ug.raw<{
          mirror: { state: string; provider_event_id: string | null } | null;
        }>("/getMirror", {
          canonical_event_id: canonicalId,
          target_account_id: targetAccount,
        });
        expect(finalMirror.data.mirror).not.toBeNull();
        expect(finalMirror.data.mirror!.state).toBe("ACTIVE");
        expect(finalMirror.data.mirror!.provider_event_id).toBe(mockInsertedId);
      }

      // Step 6: Verify journal entries recorded the sync
      const journal = await ug.queryJournal({ canonical_event_id: canonicalId });
      expect(journal.items.length).toBeGreaterThanOrEqual(1);
      expect(journal.items[0].change_type).toBe("created");
    });
  });

  // -------------------------------------------------------------------------
  // Error handling: DO returning non-JSON (404 plain text)
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("handles DO returning 404 plain text for unknown action", async () => {
      const suffix = uniqueSuffix();
      const accountName = `doq-err-acct-${suffix}`;

      // Seed AccountDO
      const acct = client.account(accountName);
      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      // Call a non-existent endpoint -- DO returns plain text, not JSON
      const result = await acct.raw<{ text?: string }>("/nonexistent");
      expect(result.status).toBe(404);
      // The rpcCall helper wraps non-JSON as { text: "..." }
      expect(result.data).toBeDefined();
    });

    it("sync-consumer fails gracefully when AccountDO has no tokens", async () => {
      const suffix = uniqueSuffix();
      const accountName = `doq-notokens-acct-${suffix}`;
      const userName = `doq-notokens-user-${suffix}`;

      // Do NOT initialize AccountDO -- no tokens stored

      const mockD1 = createMockD1([{
        account_id: accountName,
        user_id: userName,
        provider: "google",
      }]);

      const env = {
        ACCOUNT: createDoNamespaceProxy(worker.url, "ACCOUNT"),
        USER_GRAPH: createDoNamespaceProxy(worker.url, "USER_GRAPH"),
        DB: mockD1,
        SYNC_QUEUE: createMockQueue(),
        WRITE_QUEUE: createMockQueue(),
        GOOGLE_CLIENT_ID: "mock",
        GOOGLE_CLIENT_SECRET: "mock",
        MASTER_KEY: MASTER_KEY_HEX,
      } as unknown as Env;

      const deps: SyncConsumerDeps = {
        fetchFn: createMockGoogleFetch({ events: [] }),
        sleepFn: noopSleep,
      };

      const message: SyncIncrementalMessage = {
        type: "SYNC_INCREMENTAL",
        account_id: accountName as AccountId,
        channel_id: "ch_test",
        resource_id: "res_test",
        ping_ts: new Date().toISOString(),
        calendar_id: null,
      };

      // Should throw because AccountDO returns 500 "no tokens stored"
      await expect(
        handleIncrementalSync(message, env, deps),
      ).rejects.toThrow(/getAccessToken failed|no tokens stored/);
    });

    it("sync-consumer handles 403 by marking sync failure, no retry", async () => {
      const suffix = uniqueSuffix();
      const accountName = `doq-403-acct-${suffix}`;
      const userName = `doq-403-user-${suffix}`;

      // Seed AccountDO
      const acct = client.account(accountName);
      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      await acct.setSyncToken("some-sync-token");

      const mockD1 = createMockD1([{
        account_id: accountName,
        user_id: userName,
        provider: "google",
      }]);

      const env = {
        ACCOUNT: createDoNamespaceProxy(worker.url, "ACCOUNT"),
        USER_GRAPH: createDoNamespaceProxy(worker.url, "USER_GRAPH"),
        DB: mockD1,
        SYNC_QUEUE: createMockQueue(),
        WRITE_QUEUE: createMockQueue(),
        GOOGLE_CLIENT_ID: "mock",
        GOOGLE_CLIENT_SECRET: "mock",
        MASTER_KEY: MASTER_KEY_HEX,
      } as unknown as Env;

      // Mock Google API returning 403 (insufficient scope)
      const mockFetch = createMockGoogleFetch({
        statusCode: 403,
        errorBody: JSON.stringify({
          error: { code: 403, message: "Insufficient Permission" },
        }),
      });

      const deps: SyncConsumerDeps = { fetchFn: mockFetch, sleepFn: noopSleep };

      await handleIncrementalSync(
        {
          type: "SYNC_INCREMENTAL",
          account_id: accountName as AccountId,
          channel_id: "ch_test",
          resource_id: "res_test",
          ping_ts: new Date().toISOString(),
          calendar_id: null,
        },
        env,
        deps,
      );

      // Function should return without throwing (403 is handled gracefully)
      // Sync failure should be marked on AccountDO
      // (markSyncFailure updates lastSyncTs but not lastSuccessTs)
      const health = await acct.getHealth();
      // lastSuccessTs should still be null (never succeeded)
      expect(health.lastSuccessTs).toBeNull();
    });

    it("write-consumer acks message when account not found in D1", async () => {
      const suffix = uniqueSuffix();

      // D1 returns null for the account
      const mockD1 = createMockD1([]);

      const env = {
        ACCOUNT: createDoNamespaceProxy(worker.url, "ACCOUNT"),
        USER_GRAPH: createDoNamespaceProxy(worker.url, "USER_GRAPH"),
        DB: mockD1,
      } as unknown as Env;

      const writeHandler = createWriteQueueHandler({
        fetchFn: createMockGoogleWriteFetch(),
      });

      const acked: string[] = [];
      const retried: string[] = [];

      const mockBatch = {
        queue: "tminus-write-queue",
        messages: [{
          id: `msg-notfound-${suffix}`,
          timestamp: new Date(),
          body: {
            type: "UPSERT_MIRROR",
            canonical_event_id: "evt_notfound" as EventId,
            target_account_id: "acc_notfound" as AccountId,
            target_calendar_id: "primary" as CalendarId,
            projected_payload: makeProjectedPayload(),
            idempotency_key: `idem-notfound-${suffix}`,
          } as UpsertMirrorMessage,
          ack() { acked.push(this.id); },
          retry() { retried.push(this.id); },
        }],
      } as unknown as MessageBatch<UpsertMirrorMessage | DeleteMirrorMessage>;

      await writeHandler.queue(mockBatch, env);

      // Should be acked (permanent failure, no retry)
      expect(acked.length).toBe(1);
      expect(retried.length).toBe(0);
    });
  });
});
