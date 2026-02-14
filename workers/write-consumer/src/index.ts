/**
 * write-consumer -- Cloudflare Worker queue consumer for write-queue.
 *
 * Provider-aware: dispatches to Google or Microsoft Calendar APIs based on
 * the target account's provider type (looked up from D1 registry).
 *
 * Processes UPSERT_MIRROR and DELETE_MIRROR messages to create, update,
 * and delete mirror events in target calendar accounts (Google or Microsoft).
 *
 * Queue configuration (from wrangler.toml):
 * - queue: tminus-write-queue
 * - max_retries: 5
 * - dead_letter_queue: tminus-write-queue-dlq
 *
 * Bindings:
 * - ACCOUNT: AccountDO namespace (for getAccessToken)
 * - USER_GRAPH: UserGraphDO namespace (for mirror state)
 * - DB: D1 registry database (for account -> user_id + provider lookup)
 */

import {
  APP_NAME,
  createCalendarProvider,
} from "@tminus/shared";
import type {
  UpsertMirrorMessage,
  DeleteMirrorMessage,
  MirrorState,
  AccountId,
  ProviderType,
} from "@tminus/shared";
import { WriteConsumer } from "./write-consumer";
import type {
  MirrorStore,
  MirrorRow,
  MirrorUpdate,
  TokenProvider,
} from "./write-consumer";

// ---------------------------------------------------------------------------
// DO-backed MirrorStore -- communicates with UserGraphDO via fetch()
// ---------------------------------------------------------------------------

/**
 * MirrorStore implementation that delegates to UserGraphDO via DO stub fetch().
 *
 * The UserGraphDO exposes RPC endpoints at:
 * - /getMirror
 * - /updateMirrorState
 * - /getBusyOverlayCalendar
 * - /storeBusyOverlayCalendar
 *
 * The userId is needed to resolve the correct DO instance via idFromName().
 */
export class DOBackedMirrorStore implements MirrorStore {
  private readonly stub: DurableObjectStub;

  constructor(stub: DurableObjectStub) {
    this.stub = stub;
  }

  getMirror(
    canonicalEventId: string,
    targetAccountId: string,
  ): MirrorRow | null {
    // NOTE: This is called synchronously by WriteConsumer, but DO fetch is async.
    // We cannot make this truly synchronous. The WriteConsumer interface was
    // designed for direct SQLite access. For the DO-backed implementation,
    // we need to pre-fetch mirror state before calling processMessage().
    // This is handled by the queue handler via prefetchMirror().
    throw new Error(
      "DOBackedMirrorStore.getMirror: use async methods via queue handler",
    );
  }

  updateMirrorState(
    canonicalEventId: string,
    targetAccountId: string,
    update: MirrorUpdate,
  ): void {
    // Same issue as getMirror -- synchronous interface but async DO communication.
    throw new Error(
      "DOBackedMirrorStore.updateMirrorState: use async methods via queue handler",
    );
  }

  getBusyOverlayCalendar(accountId: string): string | null {
    throw new Error(
      "DOBackedMirrorStore.getBusyOverlayCalendar: use async methods via queue handler",
    );
  }

  storeBusyOverlayCalendar(
    accountId: string,
    providerCalendarId: string,
  ): void {
    throw new Error(
      "DOBackedMirrorStore.storeBusyOverlayCalendar: use async methods via queue handler",
    );
  }

  // -----------------------------------------------------------------------
  // Async methods for queue handler to call DO stubs directly
  // -----------------------------------------------------------------------

  async getMirrorAsync(
    canonicalEventId: string,
    targetAccountId: string,
  ): Promise<MirrorRow | null> {
    const response = await this.stub.fetch(
      new Request("https://user-graph.internal/getMirror", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          canonical_event_id: canonicalEventId,
          target_account_id: targetAccountId,
        }),
      }),
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`UserGraphDO.getMirror failed (${response.status}): ${text}`);
    }
    const data = (await response.json()) as { mirror: MirrorRow | null };
    return data.mirror;
  }

  async updateMirrorStateAsync(
    canonicalEventId: string,
    targetAccountId: string,
    update: MirrorUpdate,
  ): Promise<void> {
    const response = await this.stub.fetch(
      new Request("https://user-graph.internal/updateMirrorState", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          canonical_event_id: canonicalEventId,
          target_account_id: targetAccountId,
          update,
        }),
      }),
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `UserGraphDO.updateMirrorState failed (${response.status}): ${text}`,
      );
    }
  }

  async getBusyOverlayCalendarAsync(accountId: string): Promise<string | null> {
    const response = await this.stub.fetch(
      new Request("https://user-graph.internal/getBusyOverlayCalendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: accountId }),
      }),
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `UserGraphDO.getBusyOverlayCalendar failed (${response.status}): ${text}`,
      );
    }
    const data = (await response.json()) as {
      provider_calendar_id: string | null;
    };
    return data.provider_calendar_id;
  }

  async storeBusyOverlayCalendarAsync(
    accountId: string,
    providerCalendarId: string,
  ): Promise<void> {
    const response = await this.stub.fetch(
      new Request("https://user-graph.internal/storeBusyOverlayCalendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: accountId,
          provider_calendar_id: providerCalendarId,
        }),
      }),
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `UserGraphDO.storeBusyOverlayCalendar failed (${response.status}): ${text}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// DO-backed TokenProvider -- communicates with AccountDO via fetch()
// ---------------------------------------------------------------------------

/**
 * TokenProvider implementation that delegates to AccountDO via DO stub fetch().
 */
export class DOBackedTokenProvider implements TokenProvider {
  private readonly accountNamespace: DurableObjectNamespace;

  constructor(accountNamespace: DurableObjectNamespace) {
    this.accountNamespace = accountNamespace;
  }

  async getAccessToken(accountId: string): Promise<string> {
    const doId = this.accountNamespace.idFromName(accountId);
    const stub = this.accountNamespace.get(doId);

    const response = await stub.fetch(
      new Request("https://account.internal/getAccessToken", {
        method: "POST",
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `AccountDO.getAccessToken failed (${response.status}): ${body}`,
      );
    }

    const data = (await response.json()) as { access_token: string };
    return data.access_token;
  }
}

// ---------------------------------------------------------------------------
// Queue handler factory
// ---------------------------------------------------------------------------

/**
 * Injectable dependencies for write-consumer queue handler.
 * Allows tests to inject mock fetch for Google Calendar API.
 */
export interface WriteConsumerDeps {
  fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

/**
 * Create the write-consumer queue handler. Factory pattern for testability.
 */
export function createWriteQueueHandler(deps: WriteConsumerDeps = {}) {
  return {
    /**
     * Health check endpoint. Returns worker name.
     */
    async fetch(
      _request: Request,
      _env: Env,
      _ctx: ExecutionContext,
    ): Promise<Response> {
      return new Response(`${APP_NAME} Write Consumer worker`, { status: 200 });
    },

    /**
     * Queue consumer handler. Processes batches of write-queue messages.
     *
     * For each message:
     * 1. Resolve the UserGraphDO stub for the message's user
     * 2. Create DO-backed MirrorStore and TokenProvider
     * 3. Create WriteConsumer and process the message
     * 4. Handle retry/ack based on ProcessResult
     */
    async queue(
      batch: MessageBatch<UpsertMirrorMessage | DeleteMirrorMessage>,
      env: Env,
    ): Promise<void> {
      for (const msg of batch.messages) {
        try {
          const body = msg.body;

          // Look up user_id and provider type from D1 registry for the target account.
          // user_id is needed to resolve the correct UserGraphDO instance.
          // provider is needed to create the correct CalendarProvider (Google or Microsoft).
          const accountRow = await env.DB
            .prepare("SELECT user_id, provider FROM accounts WHERE account_id = ?1")
            .bind(body.target_account_id as string)
            .first<{ user_id: string; provider: string }>();

          if (!accountRow) {
            console.error(
              `write-consumer: no user_id found for account ${body.target_account_id}`,
            );
            msg.ack(); // permanent failure -- ack to prevent infinite retry
            continue;
          }

          const providerType: ProviderType = accountRow.provider === "microsoft" ? "microsoft" : "google";

          // Resolve UserGraphDO stub
          const userGraphId = env.USER_GRAPH.idFromName(accountRow.user_id);
          const userGraphStub = env.USER_GRAPH.get(userGraphId);

          // Create DO-backed dependencies
          const doMirrorStore = new DOBackedMirrorStore(userGraphStub);
          const doTokenProvider = new DOBackedTokenProvider(env.ACCOUNT);

          // Pre-fetch mirror state (since WriteConsumer expects sync getMirror)
          // We wrap the DO-backed store in a caching proxy that makes the
          // first getMirror call async, then caches the result for sync access.
          const cachedMirrorStore = await createCachedMirrorStore(
            doMirrorStore,
            body,
          );

          // Create WriteConsumer with DO-backed dependencies.
          // The calendarClientFactory dispatches to the correct provider (Google or Microsoft).
          const consumer = new WriteConsumer({
            mirrorStore: cachedMirrorStore,
            tokenProvider: doTokenProvider,
            calendarClientFactory: deps.fetchFn
              ? (token: string) => createCalendarProvider(providerType, token, deps.fetchFn)
              : (token: string) => createCalendarProvider(providerType, token),
          });

          const result = await consumer.processMessage(body);

          // Flush buffered mirror state updates to DO
          await cachedMirrorStore.flush();

          if (result.retry) {
            msg.retry();
          } else {
            msg.ack();
          }
        } catch (err) {
          console.error("write-consumer: message processing failed", err);
          msg.retry();
        }
      }
    },
  };
}

/**
 * Create a MirrorStore that pre-fetches state from the DO and caches it
 * for synchronous access by WriteConsumer.
 *
 * The WriteConsumer interface uses synchronous methods (designed for direct
 * SQLite access). When backed by a DO, we pre-fetch the mirror state and
 * cache it, then write updates back to the DO asynchronously after the
 * WriteConsumer completes.
 *
 * This adapter bridges the sync/async gap by:
 * 1. Pre-loading mirror state before WriteConsumer.processMessage()
 * 2. Buffering state updates during processMessage()
 * 3. Flushing buffered updates to DO after processMessage()
 */
async function createCachedMirrorStore(
  doStore: DOBackedMirrorStore,
  msg: UpsertMirrorMessage | DeleteMirrorMessage,
): Promise<MirrorStore & { flush(): Promise<void> }> {
  // Pre-fetch the mirror for this message
  const targetAccountId =
    msg.type === "UPSERT_MIRROR" || msg.type === "DELETE_MIRROR"
      ? msg.target_account_id
      : "";
  const canonicalEventId = msg.canonical_event_id;

  let cachedMirror = await doStore.getMirrorAsync(
    canonicalEventId as string,
    targetAccountId as string,
  );

  // Pre-fetch busy overlay calendar if this is an UPSERT
  let cachedBusyCalendar: string | null = null;
  if (msg.type === "UPSERT_MIRROR") {
    cachedBusyCalendar = await doStore.getBusyOverlayCalendarAsync(
      targetAccountId as string,
    );
  }

  // Buffer for updates to flush later
  const pendingUpdates: Array<{
    type: "updateMirrorState";
    canonicalEventId: string;
    targetAccountId: string;
    update: MirrorUpdate;
  } | {
    type: "storeBusyOverlayCalendar";
    accountId: string;
    providerCalendarId: string;
  }> = [];

  return {
    getMirror(
      ceId: string,
      taId: string,
    ): MirrorRow | null {
      // Return cached value if it matches, otherwise null
      if (
        cachedMirror &&
        ceId === (canonicalEventId as string) &&
        taId === (targetAccountId as string)
      ) {
        return cachedMirror;
      }
      return null;
    },

    updateMirrorState(
      ceId: string,
      taId: string,
      update: MirrorUpdate,
    ): void {
      // Buffer the update for async flushing
      pendingUpdates.push({
        type: "updateMirrorState",
        canonicalEventId: ceId,
        targetAccountId: taId,
        update,
      });

      // Also update the cached mirror to reflect the change immediately
      if (
        cachedMirror &&
        ceId === (canonicalEventId as string) &&
        taId === (targetAccountId as string)
      ) {
        cachedMirror = {
          ...cachedMirror,
          ...(update.provider_event_id !== undefined
            ? { provider_event_id: update.provider_event_id }
            : {}),
          ...(update.state !== undefined ? { state: update.state } : {}),
          ...(update.last_write_ts !== undefined
            ? { last_write_ts: update.last_write_ts }
            : {}),
          ...(update.error_message !== undefined
            ? { error_message: update.error_message ?? null }
            : {}),
          ...(update.target_calendar_id !== undefined
            ? { target_calendar_id: update.target_calendar_id }
            : {}),
        };
      }
    },

    getBusyOverlayCalendar(accountId: string): string | null {
      if (accountId === (targetAccountId as string)) {
        return cachedBusyCalendar;
      }
      return null;
    },

    storeBusyOverlayCalendar(
      accountId: string,
      providerCalendarId: string,
    ): void {
      // Buffer for async flushing
      pendingUpdates.push({
        type: "storeBusyOverlayCalendar",
        accountId,
        providerCalendarId,
      });
      // Update cache
      if (accountId === (targetAccountId as string)) {
        cachedBusyCalendar = providerCalendarId;
      }
    },

    async flush(): Promise<void> {
      for (const op of pendingUpdates) {
        if (op.type === "updateMirrorState") {
          await doStore.updateMirrorStateAsync(
            op.canonicalEventId,
            op.targetAccountId,
            op.update,
          );
        } else if (op.type === "storeBusyOverlayCalendar") {
          await doStore.storeBusyOverlayCalendarAsync(
            op.accountId,
            op.providerCalendarId,
          );
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Default export for Cloudflare Workers runtime
// ---------------------------------------------------------------------------

const handler = createWriteQueueHandler();
export default handler;
