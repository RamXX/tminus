/**
 * tminus-sync-consumer -- Queue consumer for sync-queue.
 *
 * Processes SYNC_INCREMENTAL and SYNC_FULL messages:
 * 1. Fetches events from Google Calendar API via GoogleCalendarClient
 * 2. Classifies events (origin vs managed_mirror) via classifyEvent()
 * 3. Normalizes origin events to ProviderDelta via normalizeGoogleEvent()
 * 4. Calls UserGraphDO.applyProviderDelta() via RPC (fetch to DO stub)
 * 5. Updates AccountDO sync cursor
 *
 * Error handling per DESIGN.md Section 8:
 * - 429: retry with exponential backoff (1s, 2s, 4s, 8s, 16s, max 5)
 * - 500/503: retry with backoff (2s, 4s, 8s, max 3)
 * - 401: refresh token via AccountDO, retry once
 * - 410: enqueue SYNC_FULL, discard current message
 * - 403 (insufficient scope): mark sync failure, no retry
 */

import {
  GoogleCalendarClient,
  SyncTokenExpiredError,
  TokenExpiredError,
  RateLimitError,
  GoogleApiError,
  classifyEvent,
  normalizeGoogleEvent,
} from "@tminus/shared";
import type {
  SyncIncrementalMessage,
  SyncFullMessage,
  GoogleCalendarEvent,
  ProviderDelta,
  AccountId,
  FetchFn,
} from "@tminus/shared";

// ---------------------------------------------------------------------------
// Queue message union
// ---------------------------------------------------------------------------

export type SyncQueueMessage = SyncIncrementalMessage | SyncFullMessage;

// ---------------------------------------------------------------------------
// Injectable dependencies (for testability)
// ---------------------------------------------------------------------------

/**
 * Dependencies that can be injected for testing.
 * In production these resolve to real Cloudflare bindings.
 */
export interface SyncConsumerDeps {
  /** Fetch function for GoogleCalendarClient (injectable for mocking Google API). */
  fetchFn?: FetchFn;
  /** Sleep function override for testing (avoids real delays in retryWithBackoff). */
  sleepFn?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Queue consumer export
// ---------------------------------------------------------------------------

/**
 * Create the queue consumer handler. Accepts optional dependencies for testing.
 */
export function createQueueHandler(deps: SyncConsumerDeps = {}) {
  return {
    async queue(
      batch: MessageBatch<SyncQueueMessage>,
      env: Env,
    ): Promise<void> {
      for (const msg of batch.messages) {
        try {
          switch (msg.body.type) {
            case "SYNC_INCREMENTAL":
              await handleIncrementalSync(msg.body, env, deps);
              break;
            case "SYNC_FULL":
              await handleFullSync(msg.body, env, deps);
              break;
            default:
              // Unknown message type -- ack to prevent infinite retry
              console.error(
                "sync-consumer: unknown message type",
                (msg.body as Record<string, unknown>).type,
              );
              break;
          }
          msg.ack();
        } catch (err) {
          console.error("sync-consumer: message processing failed", err);
          msg.retry();
        }
      }
    },
  };
}

// Default export for Cloudflare Workers runtime
const handler = createQueueHandler();
export default handler;

// ---------------------------------------------------------------------------
// Incremental sync handler (Flow A from ARCHITECTURE.md Section 7.1)
// ---------------------------------------------------------------------------

/**
 * Handle an incremental sync message.
 *
 * Flow:
 * 1. Get access token from AccountDO
 * 2. Get sync token from AccountDO
 * 3. Fetch events.list(syncToken=...) via GoogleCalendarClient
 * 4. If 410 Gone: enqueue SYNC_FULL, return
 * 5. Classify, normalize, and apply deltas
 * 6. Update sync cursor
 * 7. Mark sync success
 */
export async function handleIncrementalSync(
  message: SyncIncrementalMessage,
  env: Env,
  deps: SyncConsumerDeps = {},
): Promise<void> {
  const { account_id } = message;

  // Step 1: Get access token from AccountDO
  const accessToken = await getAccessToken(account_id, env);

  // Step 2: Get sync token
  const syncToken = await getSyncToken(account_id, env);

  // Step 3: Fetch incremental changes from Google
  const client = new GoogleCalendarClient(accessToken, deps.fetchFn);

  let events: GoogleCalendarEvent[];
  let nextSyncToken: string | undefined;

  try {
    const retryOpts = deps.sleepFn ? { sleepFn: deps.sleepFn } : {};
    const response = await retryWithBackoff(
      () => client.listEvents("primary", syncToken ?? undefined),
      retryOpts,
    );
    events = response.events;
    nextSyncToken = response.nextSyncToken;
  } catch (err) {
    // Step 4: Handle 410 Gone -- enqueue SYNC_FULL
    if (err instanceof SyncTokenExpiredError) {
      await env.SYNC_QUEUE.send({
        type: "SYNC_FULL",
        account_id,
        reason: "token_410",
      } satisfies SyncFullMessage);
      return;
    }

    // Handle 401 -- refresh token and retry once
    if (err instanceof TokenExpiredError) {
      const freshToken = await refreshAndGetToken(account_id, env);
      const freshClient = new GoogleCalendarClient(freshToken, deps.fetchFn);
      try {
        const response = await freshClient.listEvents(
          "primary",
          syncToken ?? undefined,
        );
        events = response.events;
        nextSyncToken = response.nextSyncToken;
      } catch (retryErr) {
        if (retryErr instanceof SyncTokenExpiredError) {
          await env.SYNC_QUEUE.send({
            type: "SYNC_FULL",
            account_id,
            reason: "token_410",
          } satisfies SyncFullMessage);
          return;
        }
        throw retryErr;
      }
    } else if (
      err instanceof GoogleApiError &&
      err.statusCode === 403
    ) {
      // 403: insufficient scope -- mark failure, do not retry
      await markSyncFailure(account_id, env, "Insufficient scope (403)");
      return;
    } else {
      throw err;
    }
  }

  // Steps 5-7: Process events and update state
  await processAndApplyDeltas(account_id, events, env);

  // Update sync cursor
  if (nextSyncToken) {
    await setSyncToken(account_id, env, nextSyncToken);
  }

  // Mark sync success
  await markSyncSuccess(account_id, env);
}

// ---------------------------------------------------------------------------
// Full sync handler
// ---------------------------------------------------------------------------

/**
 * Handle a full sync message.
 *
 * Same as incremental but:
 * - No syncToken (fetches ALL events)
 * - Paginated: loop through pageTokens until exhausted
 */
export async function handleFullSync(
  message: SyncFullMessage,
  env: Env,
  deps: SyncConsumerDeps = {},
): Promise<void> {
  const { account_id } = message;

  // Get access token
  const accessToken = await getAccessToken(account_id, env);
  const client = new GoogleCalendarClient(accessToken, deps.fetchFn);

  let pageToken: string | undefined;
  let lastSyncToken: string | undefined;
  const allEvents: GoogleCalendarEvent[] = [];

  // Paginate through all events
  const retryOpts = deps.sleepFn ? { sleepFn: deps.sleepFn } : {};
  try {
    do {
      const response = await retryWithBackoff(
        () => client.listEvents("primary", undefined, pageToken),
        retryOpts,
      );
      allEvents.push(...response.events);
      pageToken = response.nextPageToken;
      // The sync token is only on the last page
      if (response.nextSyncToken) {
        lastSyncToken = response.nextSyncToken;
      }
    } while (pageToken);
  } catch (err) {
    // Handle 401 -- refresh token and retry
    if (err instanceof TokenExpiredError) {
      const freshToken = await refreshAndGetToken(account_id, env);
      const freshClient = new GoogleCalendarClient(freshToken, deps.fetchFn);
      // Restart pagination from where we left off
      // (In practice we start over since the token changed)
      allEvents.length = 0;
      pageToken = undefined;
      do {
        const response = await retryWithBackoff(
          () => freshClient.listEvents("primary", undefined, pageToken),
          retryOpts,
        );
        allEvents.push(...response.events);
        pageToken = response.nextPageToken;
        if (response.nextSyncToken) {
          lastSyncToken = response.nextSyncToken;
        }
      } while (pageToken);
    } else if (
      err instanceof GoogleApiError &&
      err.statusCode === 403
    ) {
      await markSyncFailure(account_id, env, "Insufficient scope (403)");
      return;
    } else {
      throw err;
    }
  }

  // Process all events
  await processAndApplyDeltas(account_id, allEvents, env);

  // Update sync cursor with the new syncToken from the full sync
  if (lastSyncToken) {
    await setSyncToken(account_id, env, lastSyncToken);
  }

  // Mark sync success
  await markSyncSuccess(account_id, env);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Classify, normalize, and apply provider deltas for a batch of events.
 *
 * - Origin events: normalize to ProviderDelta and include in batch
 * - Managed mirrors: skip (Invariant E -- never treat as origin)
 * - foreign_managed: treated as origin (per classifyEvent docs)
 */
async function processAndApplyDeltas(
  accountId: AccountId,
  events: GoogleCalendarEvent[],
  env: Env,
): Promise<void> {
  const deltas: ProviderDelta[] = [];

  for (const event of events) {
    const classification = classifyEvent(event);

    if (classification === "managed_mirror") {
      // Invariant E: managed mirrors are NOT treated as new origins.
      // Skip entirely -- drift detection is handled by reconciliation.
      continue;
    }

    // Origin or foreign_managed: normalize to ProviderDelta
    const delta = normalizeGoogleEvent(event, accountId, classification);
    deltas.push(delta);
  }

  if (deltas.length === 0) {
    return;
  }

  // Look up user_id from D1 accounts table for the account_id
  const userId = await lookupUserId(accountId, env);
  if (!userId) {
    throw new Error(
      `sync-consumer: no user_id found for account ${accountId}`,
    );
  }

  // Call UserGraphDO.applyProviderDelta via DO stub
  const userGraphId = env.USER_GRAPH.idFromName(userId);
  const userGraphStub = env.USER_GRAPH.get(userGraphId);

  const response = await userGraphStub.fetch(
    new Request("https://user-graph.internal/applyProviderDelta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: accountId, deltas }),
    }),
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `UserGraphDO.applyProviderDelta failed (${response.status}): ${body}`,
    );
  }
}

/**
 * Look up user_id for an account_id in the D1 registry.
 */
async function lookupUserId(
  accountId: AccountId,
  env: Env,
): Promise<string | null> {
  const result = await env.DB.prepare(
    "SELECT user_id FROM accounts WHERE account_id = ?1",
  )
    .bind(accountId)
    .first<{ user_id: string }>();

  return result?.user_id ?? null;
}

// ---------------------------------------------------------------------------
// AccountDO interaction helpers
// ---------------------------------------------------------------------------

/**
 * Get an access token from AccountDO.
 */
async function getAccessToken(
  accountId: AccountId,
  env: Env,
): Promise<string> {
  const doId = env.ACCOUNT.idFromName(accountId);
  const stub = env.ACCOUNT.get(doId);

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

/**
 * Refresh and get a fresh access token from AccountDO.
 * This is the same as getAccessToken -- AccountDO automatically refreshes.
 */
async function refreshAndGetToken(
  accountId: AccountId,
  env: Env,
): Promise<string> {
  return getAccessToken(accountId, env);
}

/**
 * Get the sync token from AccountDO.
 */
async function getSyncToken(
  accountId: AccountId,
  env: Env,
): Promise<string | null> {
  const doId = env.ACCOUNT.idFromName(accountId);
  const stub = env.ACCOUNT.get(doId);

  const response = await stub.fetch(
    new Request("https://account.internal/getSyncToken", {
      method: "POST",
    }),
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `AccountDO.getSyncToken failed (${response.status}): ${body}`,
    );
  }

  const data = (await response.json()) as { sync_token: string | null };
  return data.sync_token;
}

/**
 * Set the sync token on AccountDO after a successful sync.
 */
async function setSyncToken(
  accountId: AccountId,
  env: Env,
  token: string,
): Promise<void> {
  const doId = env.ACCOUNT.idFromName(accountId);
  const stub = env.ACCOUNT.get(doId);

  const response = await stub.fetch(
    new Request("https://account.internal/setSyncToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sync_token: token }),
    }),
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `AccountDO.setSyncToken failed (${response.status}): ${body}`,
    );
  }
}

/**
 * Mark sync as successful on AccountDO.
 */
async function markSyncSuccess(
  accountId: AccountId,
  env: Env,
): Promise<void> {
  const doId = env.ACCOUNT.idFromName(accountId);
  const stub = env.ACCOUNT.get(doId);

  const response = await stub.fetch(
    new Request("https://account.internal/markSyncSuccess", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ts: new Date().toISOString() }),
    }),
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `AccountDO.markSyncSuccess failed (${response.status}): ${body}`,
    );
  }
}

/**
 * Mark sync as failed on AccountDO.
 */
async function markSyncFailure(
  accountId: AccountId,
  env: Env,
  error: string,
): Promise<void> {
  const doId = env.ACCOUNT.idFromName(accountId);
  const stub = env.ACCOUNT.get(doId);

  const response = await stub.fetch(
    new Request("https://account.internal/markSyncFailure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error }),
    }),
  );

  if (!response.ok) {
    // Log but don't throw -- the original error is more important
    console.error("Failed to mark sync failure on AccountDO", response.status);
  }
}

// ---------------------------------------------------------------------------
// Retry with exponential backoff
// ---------------------------------------------------------------------------

/** Options for retryWithBackoff. */
export interface RetryOptions {
  maxRetries429?: number;
  maxRetries5xx?: number;
  /** Injectable sleep function for testing. Defaults to real setTimeout. */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Retry a function with exponential backoff for retryable errors.
 *
 * - 429: backoff 1s, 2s, 4s, 8s, 16s (max 5 retries)
 * - 500/503: backoff 2s, 4s, 8s (max 3 retries)
 * - Other errors: thrown immediately
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxRetries429 = 5,
    maxRetries5xx = 3,
    sleepFn = sleep,
  } = options;

  let attempt429 = 0;
  let attempt5xx = 0;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RateLimitError) {
        attempt429++;
        if (attempt429 > maxRetries429) {
          throw err;
        }
        const delayMs = 1000 * Math.pow(2, attempt429 - 1); // 1s, 2s, 4s, 8s, 16s
        await sleepFn(delayMs);
        continue;
      }

      if (
        err instanceof GoogleApiError &&
        (err.statusCode === 500 || err.statusCode === 503)
      ) {
        attempt5xx++;
        if (attempt5xx > maxRetries5xx) {
          throw err;
        }
        const delayMs = 2000 * Math.pow(2, attempt5xx - 1); // 2s, 4s, 8s
        await sleepFn(delayMs);
        continue;
      }

      // Non-retryable error -- throw immediately
      throw err;
    }
  }
}

/** Sleep for the given number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
