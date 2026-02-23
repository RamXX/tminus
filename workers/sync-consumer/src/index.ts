/**
 * tminus-sync-consumer -- Queue consumer for sync-queue.
 *
 * Provider-aware: dispatches to Google or Microsoft Calendar APIs based on
 * the account's provider type (looked up from D1 registry at consumption time).
 *
 * Processes SYNC_INCREMENTAL and SYNC_FULL messages:
 * 1. Looks up provider type from D1 accounts table
 * 2. Fetches events via provider-specific client (Google listEvents or Microsoft delta query)
 * 3. Classifies events using provider-specific strategy (extended properties or open extensions)
 * 4. Normalizes origin events to ProviderDelta via provider-specific normalizer
 * 5. Calls UserGraphDO.applyProviderDelta() via RPC (fetch to DO stub)
 * 6. Updates AccountDO sync cursor (syncToken for Google, deltaLink for Microsoft)
 *
 * Error handling (both Google and Microsoft):
 * - 429: retry with exponential backoff (1s, 2s, 4s, 8s, 16s, max 5)
 * - 500/503: retry with backoff (2s, 4s, 8s, max 3)
 * - 401: refresh token via AccountDO, retry once
 * - 410 (Google): enqueue SYNC_FULL, discard current message
 * - 403 (insufficient scope/privileges): mark sync failure, no retry
 */

import {
  SyncTokenExpiredError,
  TokenExpiredError,
  RateLimitError,
  GoogleApiError,
  MicrosoftApiError,
  MicrosoftTokenExpiredError,
  MicrosoftDeltaTokenExpiredError,
  MicrosoftRateLimitError,
  createCalendarProvider,
  getClassificationStrategy,
  normalizeProviderEvent,
  canonicalizeProviderEventId,
} from "@tminus/shared";
import type {
  SyncIncrementalMessage,
  SyncFullMessage,
  GoogleCalendarEvent,
  EventClassification,
  ProviderDelta,
  AccountId,
  FetchFn,
  ProviderType,
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
  /** Fetch function for CalendarProvider (injectable for mocking Google/Microsoft APIs). */
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
 * 1. Look up provider type from D1
 * 2. Get access token from AccountDO
 * 3. Get sync token from AccountDO
 * 4. Fetch events via provider-specific client (Google listEvents or Microsoft delta query)
 * 5. If 410 Gone (Google) or delta token expired: enqueue SYNC_FULL, return
 * 6. Classify, normalize, and apply deltas (using provider-specific strategies)
 * 7. Update sync cursor (syncToken for Google, deltaLink for Microsoft)
 * 8. Mark sync success
 */
export async function handleIncrementalSync(
  message: SyncIncrementalMessage,
  env: Env,
  deps: SyncConsumerDeps = {},
): Promise<void> {
  const { account_id } = message;
  const targetCalendarId = message.calendar_id ?? null;

  // Step 1: Look up provider type from D1
  const provider = await lookupProvider(account_id, env);

  // Step 2: Get access token from AccountDO
  let accessToken: string;
  try {
    accessToken = await getAccessToken(account_id, provider, env);
  } catch (err) {
    if (isPermanentAccessTokenFailure(err)) {
      console.error(
        `sync-consumer: permanent token failure for account ${account_id}`,
        err instanceof Error ? err.message : err,
      );
      await markSyncFailure(
        account_id,
        env,
        "Token refresh failed (invalid_grant). Re-link this account.",
      );
      return;
    }
    throw err;
  }

  // Step 3: Fetch incremental changes via provider-specific client.
  // Google reads every enabled sync scope (primary + overlays) using
  // per-calendar scoped cursors; Microsoft keeps single-cursor behavior.
  const client = createCalendarProvider(provider, accessToken, deps.fetchFn);

  let events: GoogleCalendarEvent[];
  let cursorUpdates: SyncCursorUpdate[] = [];
  const retryOpts = deps.sleepFn ? { sleepFn: deps.sleepFn } : {};

  try {
    const result = await fetchIncrementalProviderEvents(
      account_id,
      provider,
      client,
      env,
      retryOpts,
      targetCalendarId,
    );
    events = result.events;
    cursorUpdates = result.cursorUpdates;
  } catch (err) {
    // Step 4: Handle 410/delta token expiry -- enqueue SYNC_FULL.
    if (
      err instanceof SyncTokenExpiredError ||
      err instanceof MicrosoftDeltaTokenExpiredError
    ) {
      await env.SYNC_QUEUE.send({
        type: "SYNC_FULL",
        account_id,
        reason: "token_410",
      } satisfies SyncFullMessage);
      return;
    }

    // Handle 401 -- refresh token and retry once (both Google and Microsoft)
    if (err instanceof TokenExpiredError || err instanceof MicrosoftTokenExpiredError) {
      const freshToken = await refreshAndGetToken(account_id, provider, env);
      const freshClient = createCalendarProvider(provider, freshToken, deps.fetchFn);
      try {
        const result = await fetchIncrementalProviderEvents(
          account_id,
          provider,
          freshClient,
          env,
          retryOpts,
          targetCalendarId,
        );
        events = result.events;
        cursorUpdates = result.cursorUpdates;
      } catch (retryErr) {
        if (
          retryErr instanceof SyncTokenExpiredError ||
          retryErr instanceof MicrosoftDeltaTokenExpiredError
        ) {
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
      (err instanceof GoogleApiError && err.statusCode === 403) ||
      (err instanceof MicrosoftApiError && err.statusCode === 403)
    ) {
      // 403: insufficient scope/privileges -- mark failure, do not retry
      console.error(
        `sync-consumer: 403 scope failure for account ${account_id} (${provider})`,
        err.message,
      );
      await markSyncFailure(account_id, env, `Insufficient scope (403)`);
      return;
    } else {
      throw err;
    }
  }

  // Step 5: Process events and apply deltas.
  const deltasApplied = await processAndApplyDeltas(account_id, events, env, provider);

  // Step 6: Persist sync cursors.
  await persistSyncCursorUpdates(account_id, provider, env, cursorUpdates);

  // Step 6b: Mark per-scope sync success for each updated cursor.
  for (const update of cursorUpdates) {
    await markScopedSyncSuccess(account_id, env, update.providerCalendarId);
  }

  // Step 7: Mark sync success.
  await markSyncSuccess(account_id, env);

  const scopeLabel = targetCalendarId ? ` (scope: ${targetCalendarId})` : " (all scopes)";
  console.log(
    `sync-consumer: SYNC_INCREMENTAL complete for account ${account_id}${scopeLabel} -- ${events.length} events fetched, ${deltasApplied} deltas applied, ${cursorUpdates.length} cursors updated`,
  );
}

// ---------------------------------------------------------------------------
// Full sync handler
// ---------------------------------------------------------------------------

/**
 * Handle a full sync message.
 *
 * Same as incremental but:
 * - No syncToken/deltaToken (fetches ALL events)
 * - Paginated: loop through pageTokens (Google) or @odata.nextLink (Microsoft)
 * - Stores final syncToken (Google) or @odata.deltaLink (Microsoft)
 */
export async function handleFullSync(
  message: SyncFullMessage,
  env: Env,
  deps: SyncConsumerDeps = {},
): Promise<void> {
  const { account_id } = message;

  // Look up provider type from D1
  const provider = await lookupProvider(account_id, env);

  // Get access token
  let accessToken: string;
  try {
    accessToken = await getAccessToken(account_id, provider, env);
  } catch (err) {
    if (isPermanentAccessTokenFailure(err)) {
      console.error(
        `sync-consumer: permanent token failure for account ${account_id}`,
        err instanceof Error ? err.message : err,
      );
      await markSyncFailure(
        account_id,
        env,
        "Token refresh failed (invalid_grant). Re-link this account.",
      );
      return;
    }
    throw err;
  }
  const client = createCalendarProvider(provider, accessToken, deps.fetchFn);

  let allEvents: GoogleCalendarEvent[] = [];
  let cursorUpdates: SyncCursorUpdate[] = [];
  let skippedCalendarIds: string[] = [];
  const retryOpts = deps.sleepFn ? { sleepFn: deps.sleepFn } : {};

  try {
    const result = await fetchFullProviderEvents(
      account_id,
      provider,
      client,
      env,
      retryOpts,
    );
    allEvents = result.events;
    cursorUpdates = result.cursorUpdates;
    skippedCalendarIds = result.skippedCalendarIds;
  } catch (err) {
    // Handle 401 -- refresh token and retry (both Google and Microsoft)
    if (err instanceof TokenExpiredError || err instanceof MicrosoftTokenExpiredError) {
      const freshToken = await refreshAndGetToken(account_id, provider, env);
      const freshClient = createCalendarProvider(provider, freshToken, deps.fetchFn);
      const result = await fetchFullProviderEvents(
        account_id,
        provider,
        freshClient,
        env,
        retryOpts,
      );
      allEvents = result.events;
      cursorUpdates = result.cursorUpdates;
      skippedCalendarIds = result.skippedCalendarIds;
    } else if (
      (err instanceof GoogleApiError && err.statusCode === 403) ||
      (err instanceof MicrosoftApiError && err.statusCode === 403)
    ) {
      console.error(
        `sync-consumer: 403 scope failure during full sync for account ${account_id} (${provider})`,
        err.message,
      );
      await markSyncFailure(account_id, env, "Insufficient scope (403)");
      return;
    } else {
      throw err;
    }
  }

  // Process all events using provider-specific classification/normalization
  const deltasApplied = await processAndApplyDeltas(account_id, allEvents, env, provider);

  let staleManagedMirrorDeletes = 0;
  if (provider === "google") {
    const userId = await lookupUserId(account_id, env);
    if (userId) {
      const missingMirrorProviderIds = await findMissingManagedMirrorProviderEventIds(
        account_id,
        userId,
        allEvents,
        env,
        skippedCalendarIds,
      );
      if (missingMirrorProviderIds.length > 0) {
        await applyManagedMirrorDeletes(
          account_id,
          userId,
          missingMirrorProviderIds,
          env,
        );
        staleManagedMirrorDeletes = missingMirrorProviderIds.length;
      }
    }
  }

  // Full sync convergence: prune stale provider-origin canonicals that no longer
  // exist upstream. Without this, explicit full resyncs can still leave deletes behind.
  const prunedDeleted = await pruneMissingOriginEvents(
    account_id,
    allEvents,
    env,
    provider,
  );

  // Update sync cursor(s): scoped for Google, legacy-compatible for primary.
  await persistSyncCursorUpdates(account_id, provider, env, cursorUpdates);

  // Mark per-scope sync success for each updated cursor.
  for (const update of cursorUpdates) {
    await markScopedSyncSuccess(account_id, env, update.providerCalendarId);
  }

  // Mark sync success
  await markSyncSuccess(account_id, env);

  console.log(
    `sync-consumer: SYNC_FULL complete for account ${account_id} -- ${allEvents.length} events fetched, ${deltasApplied} deltas applied, ${staleManagedMirrorDeletes} stale managed mirrors deleted, ${prunedDeleted} stale origin events pruned, ${cursorUpdates.length} cursors updated`,
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface SyncCursorUpdate {
  providerCalendarId: string;
  token: string;
}

interface CalendarScopeRecord {
  providerCalendarId: string;
  enabled: boolean;
  syncEnabled: boolean;
}

interface ProviderFetchResult {
  events: GoogleCalendarEvent[];
  cursorUpdates: SyncCursorUpdate[];
  skippedCalendarIds: string[];
}

async function fetchIncrementalProviderEvents(
  accountId: AccountId,
  provider: ProviderType,
  client: ReturnType<typeof createCalendarProvider>,
  env: Env,
  retryOpts: RetryOptions,
  targetCalendarId: string | null = null,
): Promise<ProviderFetchResult> {
  if (provider !== "google") {
    const syncToken = await getSyncToken(accountId, env);
    const response = await retryWithBackoff(
      () => client.listEvents("primary", syncToken ?? undefined),
      retryOpts,
    );
    return {
      events: response.events,
      cursorUpdates: response.nextSyncToken
        ? [{ providerCalendarId: "primary", token: response.nextSyncToken }]
        : [],
      skippedCalendarIds: [],
    };
  }

  // When targetCalendarId is set, only sync that specific scope.
  // Otherwise, sync all registered Google calendar scopes.
  const calendarIds = targetCalendarId
    ? [targetCalendarId]
    : await listGoogleSyncCalendarIds(accountId, env);
  const events: GoogleCalendarEvent[] = [];
  const cursorUpdates: SyncCursorUpdate[] = [];
  const skippedCalendarIds: string[] = [];
  let needsScopedBootstrapFullSync = false;

  for (const calendarId of calendarIds) {
    const syncToken = await getScopedSyncToken(accountId, env, calendarId);
    let response: Awaited<ReturnType<ReturnType<typeof createCalendarProvider>["listEvents"]>>;
    try {
      response = await retryWithBackoff(
        () => client.listEvents(calendarId, syncToken ?? undefined),
        retryOpts,
      );
    } catch (err) {
      if (err instanceof GoogleApiError && err.statusCode === 404) {
        console.warn(
          `sync-consumer: skipping unavailable google calendar scope ${calendarId} for account ${accountId}`,
        );
        skippedCalendarIds.push(calendarId);
        continue;
      }
      throw err;
    }

    if (!syncToken && calendarId !== "primary") {
      needsScopedBootstrapFullSync = true;
    }

    events.push(...response.events);
    if (response.nextSyncToken) {
      cursorUpdates.push({
        providerCalendarId: calendarId,
        token: response.nextSyncToken,
      });
    }
  }

  if (needsScopedBootstrapFullSync) {
    throw new SyncTokenExpiredError(
      "google scoped sync bootstrap required for non-primary calendars",
    );
  }

  return { events, cursorUpdates, skippedCalendarIds };
}

async function fetchFullProviderEvents(
  accountId: AccountId,
  provider: ProviderType,
  client: ReturnType<typeof createCalendarProvider>,
  env: Env,
  retryOpts: RetryOptions,
): Promise<ProviderFetchResult> {
  if (provider !== "google") {
    let pageToken: string | undefined;
    let lastSyncToken: string | undefined;
    const events: GoogleCalendarEvent[] = [];

    do {
      const response = await retryWithBackoff(
        () => client.listEvents("primary", undefined, pageToken),
        retryOpts,
      );
      events.push(...response.events);
      pageToken = response.nextPageToken;
      if (response.nextSyncToken) {
        lastSyncToken = response.nextSyncToken;
      }
    } while (pageToken);

    return {
      events,
      cursorUpdates: lastSyncToken
        ? [{ providerCalendarId: "primary", token: lastSyncToken }]
        : [],
      skippedCalendarIds: [],
    };
  }

  const calendarIds = await listGoogleSyncCalendarIds(accountId, env);
  const events: GoogleCalendarEvent[] = [];
  const cursorUpdates: SyncCursorUpdate[] = [];
  const skippedCalendarIds: string[] = [];

  for (const calendarId of calendarIds) {
    let pageToken: string | undefined;
    let lastSyncToken: string | undefined;

    do {
      let response: Awaited<ReturnType<ReturnType<typeof createCalendarProvider>["listEvents"]>>;
      try {
        response = await retryWithBackoff(
          () => client.listEvents(calendarId, undefined, pageToken),
          retryOpts,
        );
      } catch (err) {
        if (err instanceof GoogleApiError && err.statusCode === 404) {
          console.warn(
            `sync-consumer: skipping unavailable google calendar scope ${calendarId} for account ${accountId}`,
          );
          skippedCalendarIds.push(calendarId);
          break;
        }
        throw err;
      }
      events.push(...response.events);
      pageToken = response.nextPageToken;
      if (response.nextSyncToken) {
        lastSyncToken = response.nextSyncToken;
      }
    } while (pageToken);

    if (lastSyncToken) {
      cursorUpdates.push({
        providerCalendarId: calendarId,
        token: lastSyncToken,
      });
    }
  }

  return { events, cursorUpdates, skippedCalendarIds };
}

async function persistSyncCursorUpdates(
  accountId: AccountId,
  provider: ProviderType,
  env: Env,
  cursorUpdates: SyncCursorUpdate[],
): Promise<void> {
  if (cursorUpdates.length === 0) {
    return;
  }

  if (provider === "google") {
    for (const update of cursorUpdates) {
      await setScopedSyncToken(
        accountId,
        env,
        update.providerCalendarId,
        update.token,
      );
    }

    const primaryUpdate = cursorUpdates.find(
      (update) => update.providerCalendarId === "primary",
    );
    if (primaryUpdate) {
      await setSyncToken(accountId, env, primaryUpdate.token);
    }
    return;
  }

  const defaultUpdate = cursorUpdates.find(
    (update) => update.providerCalendarId === "primary",
  );
  if (defaultUpdate) {
    await setSyncToken(accountId, env, defaultUpdate.token);
  }
}

async function listGoogleSyncCalendarIds(
  accountId: AccountId,
  env: Env,
): Promise<string[]> {
  const calendarIds = new Set(
    (await listCalendarScopes(accountId, env))
      .filter((scope) => scope.enabled && scope.syncEnabled)
      .map((scope) => scope.providerCalendarId)
      .filter((calendarId) => calendarId.length > 0),
  );

  // Fallback for legacy accounts that predate scoped calendar registration:
  // derive active target calendars from mirror rows (overlay calendars).
  const userId = await lookupUserId(accountId, env);
  if (userId) {
    const mirrorCalendarIds = await loadManagedMirrorCalendarIds(
      accountId,
      userId,
      env,
    );
    for (const calendarId of mirrorCalendarIds) {
      calendarIds.add(calendarId);
    }
  }

  if (calendarIds.size === 0) {
    return ["primary"];
  }

  return [...calendarIds];
}

async function listCalendarScopes(
  accountId: AccountId,
  env: Env,
): Promise<CalendarScopeRecord[]> {
  const doId = env.ACCOUNT.idFromName(accountId);
  const stub = env.ACCOUNT.get(doId);
  const response = await stub.fetch(
    new Request("https://account.internal/listCalendarScopes", {
      method: "POST",
    }),
  );

  if (!response.ok) {
    // Compatibility fallback for older AccountDO deployments.
    if (response.status === 404 || response.status === 405) {
      return [
        {
          providerCalendarId: "primary",
          enabled: true,
          syncEnabled: true,
        },
      ];
    }
    const body = await response.text();
    throw new Error(
      `AccountDO.listCalendarScopes failed (${response.status}): ${body}`,
    );
  }

  const payload = (await response.json()) as {
    scopes?: Array<{
      providerCalendarId?: string;
      provider_calendar_id?: string;
      enabled?: boolean;
      syncEnabled?: boolean;
      sync_enabled?: boolean;
    }>;
  };

  const scopes = payload.scopes ?? [];
  if (scopes.length === 0) {
    return [
      {
        providerCalendarId: "primary",
        enabled: true,
        syncEnabled: true,
      },
    ];
  }

  return scopes
    .map((scope) => ({
      providerCalendarId:
        scope.providerCalendarId ?? scope.provider_calendar_id ?? "primary",
      enabled: scope.enabled ?? true,
      syncEnabled: scope.syncEnabled ?? scope.sync_enabled ?? true,
    }))
    .filter((scope) => scope.providerCalendarId.length > 0);
}

/**
 * Classify, normalize, and apply provider deltas for a batch of events.
 *
 * Provider-aware: uses the correct classification strategy and normalizer
 * based on the provider type (Google or Microsoft).
 *
 * - Origin events: normalize to ProviderDelta and include in batch
 * - Managed mirrors: skip (Invariant E -- never treat as origin)
 * - foreign_managed: treated as origin (per classifyEvent docs)
 */
async function processAndApplyDeltas(
  accountId: AccountId,
  events: GoogleCalendarEvent[],
  env: Env,
  provider: ProviderType = "google",
): Promise<number> {
  const deltas: ProviderDelta[] = [];
  const managedMirrorDeletedEventIds = new Set<string>();
  // TM-9eu: Collect modified mirror events for writeback to canonical.
  // Each entry holds the raw provider event (for re-normalization) and the
  // mirror's provider_event_id (for canonical resolution).
  const managedMirrorModifiedEvents: Array<{
    rawEvent: unknown;
    providerEventId: string;
  }> = [];
  // Cross-scope dedup: track origin_event_ids already seen so that the same
  // event appearing in multiple calendar views produces only one delta.
  const seenOriginEventIds = new Set<string>();
  const classificationStrategy = getClassificationStrategy(provider);
  let userId: string | null = null;
  let userGraphStub: DurableObjectStub | null = null;
  let managedMirrorEventIds: Set<string> | null = null;

  const ensureUserGraphStub = async (): Promise<DurableObjectStub> => {
    if (userGraphStub) return userGraphStub;
    if (!userId) {
      userId = await lookupUserId(accountId, env);
    }
    if (!userId) {
      throw new Error(
        `sync-consumer: no user_id found for account ${accountId}`,
      );
    }
    const userGraphId = env.USER_GRAPH.idFromName(userId);
    userGraphStub = env.USER_GRAPH.get(userGraphId);
    return userGraphStub;
  };

  const ensureManagedMirrorEventIds = async (): Promise<Set<string>> => {
    if (managedMirrorEventIds) return managedMirrorEventIds;
    if (!userId) {
      userId = await lookupUserId(accountId, env);
    }
    if (!userId) {
      throw new Error(
        `sync-consumer: no user_id found for account ${accountId}`,
      );
    }
    managedMirrorEventIds = await loadManagedMirrorEventIds(
      accountId,
      userId,
      env,
    );
    return managedMirrorEventIds;
  };

  if (events.length > 0) {
    managedMirrorEventIds = await ensureManagedMirrorEventIds();
  }

  for (const event of events) {
    // For Microsoft events, the MicrosoftCalendarClient stores raw event data
    // under _msRaw. Use that for classification and normalization when available.
    const rawEvent = (event as Record<string, unknown>)._msRaw ?? event;
    const classification = classifyProviderEvent(
      provider,
      rawEvent as Record<string, unknown>,
      classificationStrategy,
      managedMirrorEventIds,
    );
    const rawDelta = normalizeProviderEvent(provider, rawEvent, accountId, classification);

    // TM-08pp: Canonicalize provider_event_id at ingestion to eliminate
    // encoding variants. All downstream storage and lookups use this
    // canonical (fully-decoded) form.
    const delta = {
      ...rawDelta,
      origin_event_id: canonicalizeProviderEventId(rawDelta.origin_event_id),
    };

    // TM-9fc9 diagnostic: log every event entering the processing loop so we
    // can trace what delta.type and classification the provider assigned.
    const rawObj = rawEvent as Record<string, unknown>;
    const hasManagedMarkers = provider === "google"
      ? Boolean(
          (rawObj.extendedProperties as Record<string, unknown> | undefined)
            ?.private,
        )
      : Boolean(
          (rawObj.extensions as unknown[] | undefined)?.length ||
          (Array.isArray(rawObj.categories) && rawObj.categories.length > 0),
        );
    console.info("sync-consumer: event_loop_entry", {
      account_id: accountId,
      provider_event_id: rawObj.id,
      delta_type: delta.type,
      classification,
      has_managed_markers: hasManagedMarkers,
      provider,
    });

    if (classification === "managed_mirror") {
      // Managed mirrors are never treated as origins (Invariant E), but if a
      // managed mirror was deleted at the provider, that is a user intent to
      // remove the underlying canonical event globally.
      if (
        delta.type === "deleted" &&
        typeof delta.origin_event_id === "string" &&
        delta.origin_event_id.length > 0
      ) {
        console.info("sync-consumer: managed_mirror delete detected", {
          account_id: accountId,
          provider_event_id: delta.origin_event_id,
          provider,
        });
        managedMirrorDeletedEventIds.add(delta.origin_event_id);
      } else if (
        // TM-9eu: Mirror-side modifications write back to the canonical event.
        // Collect the raw event for re-normalization with full payload.
        delta.type === "updated" &&
        typeof delta.origin_event_id === "string" &&
        delta.origin_event_id.length > 0
      ) {
        managedMirrorModifiedEvents.push({
          rawEvent,
          providerEventId: delta.origin_event_id,
        });
      }
      continue;
    }

    // TM-9fc9 diagnostic: log every non-mirror event reaching the fallback
    // check so we can see what delta.type deletions actually carry.
    console.info("sync-consumer: pre_fallback_check", {
      account_id: accountId,
      provider_event_id: delta.origin_event_id,
      delta_type: delta.type,
      provider,
    });

    // Fallback for providers (notably Google cancelled payloads) that can omit
    // managed markers on delete deltas. If the deleted provider_event_id is a
    // known managed mirror, treat it as a managed delete intent.
    if (
      delta.type === "deleted" &&
      typeof delta.origin_event_id === "string" &&
      delta.origin_event_id.length > 0
    ) {
      const mirrorIds = await ensureManagedMirrorEventIds();
      let managedDelete = providerEventIdVariants(delta.origin_event_id).some(
        (candidateId) => mirrorIds.has(candidateId),
      );

      // Fallback: mirror state can drift out of ACTIVE while the provider
      // event still exists. Resolve directly by mirror lookup before treating
      // this as an origin delete.
      if (!managedDelete) {
        const stub = await ensureUserGraphStub();
        const canonicalId = await findCanonicalIdByMirror(
          stub,
          accountId,
          delta.origin_event_id,
        );
        managedDelete = canonicalId !== null;
        if (managedDelete) {
          console.info("sync-consumer: managed_mirror delete detected via fallback lookup", {
            account_id: accountId,
            provider_event_id: delta.origin_event_id,
            canonical_event_id: canonicalId,
            provider,
          });
        }
      } else {
        console.info("sync-consumer: managed_mirror delete detected via mirror ID set", {
          account_id: accountId,
          provider_event_id: delta.origin_event_id,
          provider,
        });
      }

      if (managedDelete) {
        managedMirrorDeletedEventIds.add(delta.origin_event_id);
        continue;
      }
    }

    // Cross-scope dedup: skip if we already have a delta for this origin event.
    if (
      typeof delta.origin_event_id === "string" &&
      delta.origin_event_id.length > 0
    ) {
      if (seenOriginEventIds.has(delta.origin_event_id)) {
        continue;
      }
      seenOriginEventIds.add(delta.origin_event_id);
    }

    // Origin or foreign_managed: include in ProviderDelta batch
    deltas.push(delta);
  }

  if (deltas.length > 0 || managedMirrorDeletedEventIds.size > 0 || managedMirrorModifiedEvents.length > 0) {
    // Look up user_id from D1 accounts table for the account_id
    if (!userId) {
      userId = await lookupUserId(accountId, env);
    }
    if (!userId) {
      throw new Error(
        `sync-consumer: no user_id found for account ${accountId}`,
      );
    }
  }

  if (deltas.length > 0) {
    await applyProviderDeltas(accountId, userId!, deltas, env);
  }

  if (managedMirrorDeletedEventIds.size > 0) {
    await applyManagedMirrorDeletes(
      accountId,
      userId!,
      [...managedMirrorDeletedEventIds],
      env,
    );
  }

  // TM-9eu: Write back mirror-side modifications to their canonical events.
  if (managedMirrorModifiedEvents.length > 0) {
    await applyManagedMirrorModifications(
      accountId,
      userId!,
      managedMirrorModifiedEvents,
      env,
      provider,
    );
  }

  return deltas.length;
}

/**
 * During full sync, remove stale canonical origin events that no longer exist
 * in the upstream provider.
 */
async function pruneMissingOriginEvents(
  accountId: AccountId,
  providerEvents: GoogleCalendarEvent[],
  env: Env,
  provider: ProviderType,
): Promise<number> {
  const userId = await lookupUserId(accountId, env);
  if (!userId) return 0;
  const managedMirrorEventIds = provider === "microsoft"
    ? await loadManagedMirrorEventIds(accountId, userId, env)
    : null;
  const providerOriginIds = collectOriginEventIds(
    providerEvents,
    provider,
    managedMirrorEventIds,
  );

  const canonicalOrigins = await listCanonicalOriginEvents(accountId, userId, env);
  if (canonicalOrigins.length === 0) return 0;

  const missing = canonicalOrigins.filter((origin) => !providerOriginIds.has(origin.originEventId));
  if (missing.length === 0) return 0;

  // Google full list responses can omit some historical/special entries even
  // though direct GET by event ID still succeeds. Restrict pruning to events
  // that are recent or in the future to avoid deleting valid long-tail history.
  const pruneBase = canonicalOrigins.filter((origin) => isPruneWindowEvent(origin.startTs));
  const prunable = missing.filter((origin) => isPruneWindowEvent(origin.startTs));
  if (prunable.length === 0) return 0;

  // Guardrail: if a large fraction appears missing, skip pruning to avoid
  // accidental mass-deletes on partial provider responses.
  const denominator = pruneBase.length;
  const missingRatio = denominator > 0 ? prunable.length / denominator : 0;
  if (denominator >= 50 && missingRatio > 0.3) {
    console.warn(
      `sync-consumer: prune skipped for account ${accountId} -- suspiciously high missing ratio (${prunable.length}/${denominator})`,
    );
    return 0;
  }

  return applyDeletedOriginDeltas(
    accountId,
    userId,
    prunable.map((origin) => origin.originEventId),
    env,
  );
}

/**
 * Collect origin event IDs from provider payloads (managed mirrors excluded).
 */
function collectOriginEventIds(
  providerEvents: readonly GoogleCalendarEvent[],
  provider: ProviderType,
  managedMirrorEventIds: Set<string> | null = null,
): Set<string> {
  const ids = new Set<string>();
  const classificationStrategy = getClassificationStrategy(provider);

  for (const event of providerEvents) {
    const rawEvent = ((event as Record<string, unknown>)._msRaw ?? event) as Record<string, unknown>;
    const classification = classifyProviderEvent(
      provider,
      rawEvent,
      classificationStrategy,
      managedMirrorEventIds,
    );
    if (classification === "managed_mirror") continue;

    const originEventId = rawEvent.id;
    if (typeof originEventId === "string" && originEventId.length > 0) {
      ids.add(originEventId);
    }
  }

  return ids;
}

function classifyProviderEvent(
  _provider: ProviderType,
  rawEvent: Record<string, unknown>,
  classificationStrategy: ReturnType<typeof getClassificationStrategy>,
  managedMirrorEventIds: Set<string> | null,
): EventClassification {
  const baseClassification = classificationStrategy.classify(rawEvent);
  if (baseClassification === "managed_mirror") {
    return baseClassification;
  }

  const eventId = rawEvent.id;
  if (
    typeof eventId === "string" &&
    eventId.length > 0 &&
    managedMirrorEventIds?.has(eventId)
  ) {
    return "managed_mirror";
  }

  return baseClassification;
}

async function loadManagedMirrorEventIds(
  accountId: AccountId,
  userId: string,
  env: Env,
): Promise<Set<string>> {
  const mirrors = await loadActiveMirrors(accountId, userId, env);
  const ids = new Set<string>();
  for (const mirror of mirrors) {
    if (typeof mirror.provider_event_id === "string" && mirror.provider_event_id.length > 0) {
      for (const variant of providerEventIdVariants(mirror.provider_event_id)) {
        ids.add(variant);
      }
    }
  }
  return ids;
}

async function loadManagedMirrorCalendarIds(
  accountId: AccountId,
  userId: string,
  env: Env,
): Promise<Set<string>> {
  const mirrors = await loadActiveMirrors(accountId, userId, env);
  const calendarIds = new Set<string>();
  for (const mirror of mirrors) {
    if (
      typeof mirror.target_calendar_id === "string" &&
      mirror.target_calendar_id.length > 0
    ) {
      calendarIds.add(mirror.target_calendar_id);
    }
  }

  return calendarIds;
}

interface ActiveMirrorRow {
  provider_event_id?: string | null;
  target_calendar_id?: string | null;
}

async function loadActiveMirrors(
  accountId: AccountId,
  userId: string,
  env: Env,
): Promise<ActiveMirrorRow[]> {
  const userGraphId = env.USER_GRAPH.idFromName(userId);
  const userGraphStub = env.USER_GRAPH.get(userGraphId);
  const response = await userGraphStub.fetch(
    new Request("https://user-graph.internal/getActiveMirrors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_account_id: accountId }),
    }),
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `UserGraphDO.getActiveMirrors failed (${response.status}): ${body}`,
    );
  }

  const payload = (await response.json()) as {
    mirrors?: ActiveMirrorRow[];
  };
  return payload.mirrors ?? [];
}

async function findMissingManagedMirrorProviderEventIds(
  accountId: AccountId,
  userId: string,
  providerEvents: readonly GoogleCalendarEvent[],
  env: Env,
  skippedCalendarIds: readonly string[] = [],
): Promise<string[]> {
  const mirrors = await loadActiveMirrors(accountId, userId, env);
  if (mirrors.length === 0) {
    return [];
  }
  const skipped = new Set(skippedCalendarIds);

  const providerIds = new Set<string>();
  for (const event of providerEvents) {
    const rawEvent = ((event as Record<string, unknown>)._msRaw ?? event) as Record<
      string,
      unknown
    >;
    const providerEventId = rawEvent.id;
    if (typeof providerEventId !== "string" || providerEventId.length === 0) {
      continue;
    }
    for (const variant of providerEventIdVariants(providerEventId)) {
      providerIds.add(variant);
    }
  }

  const missing = new Set<string>();
  for (const mirror of mirrors) {
    if (
      typeof mirror.target_calendar_id === "string" &&
      skipped.has(mirror.target_calendar_id)
    ) {
      continue;
    }
    if (
      typeof mirror.provider_event_id !== "string" ||
      mirror.provider_event_id.length === 0
    ) {
      continue;
    }
    const exists = providerEventIdVariants(mirror.provider_event_id).some(
      (variant) => providerIds.has(variant),
    );
    if (!exists) {
      missing.add(mirror.provider_event_id);
    }
  }

  return [...missing];
}

// TODO(Phase 3, TM-08pp): Remove providerEventIdVariants and decodeProviderEventIdSafe
// after cron migration has canonicalized all stored provider_event_id values.
// Once all data is canonical, lookups should use exact-match only.
function providerEventIdVariants(providerEventId: string): string[] {
  const variants = [providerEventId];
  const decoded = decodeProviderEventIdSafe(providerEventId);
  if (decoded !== providerEventId) {
    variants.push(decoded);
  }
  const encoded = providerEventId.includes("%")
    ? providerEventId
    : encodeURIComponent(providerEventId);
  if (!variants.includes(encoded)) {
    variants.push(encoded);
  }
  return variants;
}

function decodeProviderEventIdSafe(providerEventId: string): string {
  if (!providerEventId.includes("%")) {
    return providerEventId;
  }
  try {
    const decoded = decodeURIComponent(providerEventId);
    return decoded.length > 0 ? decoded : providerEventId;
  } catch {
    return providerEventId;
  }
}

/**
 * Detect non-retryable AccountDO token refresh failures.
 *
 * invalid_grant means the upstream refresh token is revoked/expired and no
 * amount of queue retries will recover without user re-auth.
 */
function isPermanentAccessTokenFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message ?? "";
  return msg.includes("AccountDO.getAccessToken failed") && msg.includes("invalid_grant");
}

const PRUNE_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

function isPruneWindowEvent(startTs: string | null): boolean {
  if (!startTs) return false;
  const startMs = Date.parse(startTs);
  if (Number.isNaN(startMs)) return false;
  return startMs >= Date.now() - PRUNE_LOOKBACK_MS;
}

function extractStartTimestamp(
  start: { dateTime?: string; date?: string } | string | null | undefined,
): string | null {
  if (!start) return null;
  if (typeof start === "string") return start;
  if (typeof start.dateTime === "string") return start.dateTime;
  if (typeof start.date === "string") return start.date;
  return null;
}

interface CanonicalOriginEvent {
  originEventId: string;
  startTs: string | null;
}

/**
 * List canonical provider-origin events for an account from UserGraphDO.
 */
async function listCanonicalOriginEvents(
  accountId: AccountId,
  userId: string,
  env: Env,
): Promise<CanonicalOriginEvent[]> {
  const userGraphId = env.USER_GRAPH.idFromName(userId);
  const userGraphStub = env.USER_GRAPH.get(userGraphId);

  const events: CanonicalOriginEvent[] = [];
  let cursor: string | null = null;

  do {
    const response = await userGraphStub.fetch(
      new Request("https://user-graph.internal/listCanonicalEvents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin_account_id: accountId,
          source: "provider",
          limit: 500,
          ...(cursor ? { cursor } : {}),
        }),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `UserGraphDO.listCanonicalEvents failed (${response.status}): ${body}`,
      );
    }

    const data = (await response.json()) as {
      items: Array<{
        origin_event_id?: string;
        start?: {
          dateTime?: string;
          date?: string;
        } | string | null;
      }>;
      cursor: string | null;
      has_more: boolean;
    };

    for (const item of data.items ?? []) {
      if (typeof item.origin_event_id === "string" && item.origin_event_id.length > 0) {
        events.push({
          originEventId: item.origin_event_id,
          startTs: extractStartTimestamp(item.start),
        });
      }
    }

    cursor = data.cursor ?? null;
  } while (cursor);

  return events;
}

/**
 * Apply synthetic delete deltas for stale origin events, in chunks.
 */
async function applyDeletedOriginDeltas(
  accountId: AccountId,
  userId: string,
  originEventIds: string[],
  env: Env,
): Promise<number> {
  if (originEventIds.length === 0) return 0;

  const userGraphId = env.USER_GRAPH.idFromName(userId);
  const userGraphStub = env.USER_GRAPH.get(userGraphId);
  const chunkSize = 200;
  let deleted = 0;

  for (let i = 0; i < originEventIds.length; i += chunkSize) {
    const chunk = originEventIds.slice(i, i + chunkSize);
    const deltas: ProviderDelta[] = chunk.map((originEventId) => ({
      type: "deleted",
      origin_account_id: accountId,
      origin_event_id: originEventId,
    }));

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
        `UserGraphDO.applyProviderDelta (prune) failed (${response.status}): ${body}`,
      );
    }

    deleted += chunk.length;
  }

  return deleted;
}

async function applyProviderDeltas(
  accountId: AccountId,
  userId: string,
  deltas: ProviderDelta[],
  env: Env,
): Promise<void> {
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

async function applyManagedMirrorDeletes(
  accountId: AccountId,
  userId: string,
  providerEventIds: string[],
  env: Env,
): Promise<void> {
  if (providerEventIds.length === 0) return;

  const userGraphId = env.USER_GRAPH.idFromName(userId);
  const userGraphStub = env.USER_GRAPH.get(userGraphId);
  const source = `provider:${accountId}`;
  const canonicalIds = new Set<string>();

  for (const providerEventId of providerEventIds) {
    const canonicalEventId = await findCanonicalIdByMirror(
      userGraphStub,
      accountId,
      providerEventId,
    );
    if (!canonicalEventId) {
      console.warn(
        `sync-consumer: managed mirror delete could not resolve canonical (account=${accountId}, provider_event_id=${providerEventId})`,
      );
      continue;
    }
    console.info("sync-consumer: mirror delete resolved canonical", {
      account_id: accountId,
      provider_event_id: providerEventId,
      canonical_event_id: canonicalEventId,
    });
    canonicalIds.add(canonicalEventId);
  }

  for (const canonicalEventId of canonicalIds) {
    const deleted = await deleteCanonicalById(userGraphStub, canonicalEventId, source);
    console.info("sync-consumer: canonical delete result", {
      canonical_event_id: canonicalEventId,
      source,
      deleted,
    });
    if (!deleted) {
      console.warn(
        `sync-consumer: managed mirror delete resolved canonical but delete returned false (canonical_event_id=${canonicalEventId})`,
      );
    }
  }
}

/**
 * TM-9eu: Write back mirror-side modifications to their canonical events.
 *
 * When a user edits a mirrored event in the target calendar, the change
 * must propagate back to the canonical event so the projection engine can
 * cascade it to all other mirrors.
 *
 * For each modified mirror:
 * 1. Resolve provider_event_id -> canonical_event_id via findCanonicalByMirror
 * 2. Fetch the canonical event to obtain its origin keys
 * 3. Re-normalize the raw provider event as "origin" to extract the full payload
 * 4. Emit an "updated" ProviderDelta using the canonical's origin keys
 * 5. The existing projection engine cascades to all mirrors automatically
 */
async function applyManagedMirrorModifications(
  accountId: AccountId,
  userId: string,
  modifiedEvents: Array<{ rawEvent: unknown; providerEventId: string }>,
  env: Env,
  provider: ProviderType,
): Promise<void> {
  if (modifiedEvents.length === 0) return;

  const userGraphId = env.USER_GRAPH.idFromName(userId);
  const userGraphStub = env.USER_GRAPH.get(userGraphId);
  const writebackDeltas: ProviderDelta[] = [];

  for (const { rawEvent, providerEventId } of modifiedEvents) {
    // Step 1: Resolve mirror -> canonical
    const canonicalEventId = await findCanonicalIdByMirror(
      userGraphStub,
      accountId,
      providerEventId,
    );
    if (!canonicalEventId) {
      // AC5: Orphaned mirror -- graceful degradation with warning log
      console.warn(
        `sync-consumer: mirror writeback skipped, orphaned mirror (account=${accountId}, provider_event_id=${providerEventId})`,
      );
      continue;
    }

    // Step 2: Fetch canonical event to get origin keys
    const canonicalResponse = await userGraphStub.fetch(
      new Request("https://user-graph.internal/getCanonicalEvent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canonical_event_id: canonicalEventId }),
      }),
    );

    if (!canonicalResponse.ok) {
      const body = await canonicalResponse.text();
      console.warn(
        `sync-consumer: mirror writeback skipped, getCanonicalEvent failed (canonical_event_id=${canonicalEventId}): ${body}`,
      );
      continue;
    }

    const canonicalResult = (await canonicalResponse.json()) as {
      event: { origin_account_id: string; origin_event_id: string };
    } | null;

    if (!canonicalResult?.event) {
      console.warn(
        `sync-consumer: mirror writeback skipped, canonical event not found (canonical_event_id=${canonicalEventId})`,
      );
      continue;
    }

    // Step 3: Re-normalize the raw provider event as "origin" to get the full
    // event payload (managed_mirror classification strips the payload).
    const originDelta = normalizeProviderEvent(
      provider,
      rawEvent,
      accountId,
      "origin",
    );

    if (!originDelta.event) {
      console.warn(
        `sync-consumer: mirror writeback skipped, no event payload after re-normalization (provider_event_id=${providerEventId})`,
      );
      continue;
    }

    // Step 4: Construct writeback delta using canonical's origin keys
    // so the DO's handleUpdated can look up the right canonical event.
    const writebackDelta: ProviderDelta = {
      type: "updated",
      origin_event_id: canonicalResult.event.origin_event_id,
      origin_account_id: canonicalResult.event.origin_account_id as AccountId,
      event: originDelta.event,
    };

    writebackDeltas.push(writebackDelta);

    // AC4: Audit log for mirror writeback traceability
    console.info(
      `sync-consumer: mirror_writeback (account=${accountId}, provider_event_id=${providerEventId}, canonical_event_id=${canonicalEventId}, origin_account_id=${canonicalResult.event.origin_account_id})`,
    );
  }

  if (writebackDeltas.length === 0) return;

  // Step 5: Apply writeback deltas through the standard path, grouped by
  // origin_account_id (deltas from different canonical sources must be
  // sent with the correct account_id for the DO lookup).
  const deltasByOriginAccount = new Map<AccountId, ProviderDelta[]>();
  for (const delta of writebackDeltas) {
    const existing = deltasByOriginAccount.get(delta.origin_account_id) ?? [];
    existing.push(delta);
    deltasByOriginAccount.set(delta.origin_account_id, existing);
  }

  for (const [originAccountId, groupedDeltas] of deltasByOriginAccount) {
    const response = await userGraphStub.fetch(
      new Request("https://user-graph.internal/applyProviderDelta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: originAccountId,
          deltas: groupedDeltas,
        }),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `UserGraphDO.applyProviderDelta (mirror_writeback) failed (${response.status}): ${body}`,
      );
    }
  }
}

async function findCanonicalIdByMirror(
  userGraphStub: DurableObjectStub,
  accountId: AccountId,
  providerEventId: string,
): Promise<string | null> {
  for (const candidateId of providerEventIdVariants(providerEventId)) {
    const response = await userGraphStub.fetch(
      new Request("https://user-graph.internal/findCanonicalByMirror", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_account_id: accountId,
          provider_event_id: candidateId,
        }),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `UserGraphDO.findCanonicalByMirror failed (${response.status}): ${body}`,
      );
    }

    const payload = (await response.json()) as {
      canonical_event_id?: string | null;
    };

    if (
      typeof payload.canonical_event_id === "string" &&
      payload.canonical_event_id.length > 0
    ) {
      return payload.canonical_event_id;
    }
  }
  return null;
}

async function deleteCanonicalById(
  userGraphStub: DurableObjectStub,
  canonicalEventId: string,
  source: string,
): Promise<boolean> {
  const response = await userGraphStub.fetch(
    new Request("https://user-graph.internal/deleteCanonicalEvent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        canonical_event_id: canonicalEventId,
        source,
      }),
    }),
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `UserGraphDO.deleteCanonicalEvent failed (${response.status}): ${body}`,
    );
  }

  return (await response.json()) as boolean;
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

/**
 * Look up provider type for an account_id in the D1 registry.
 * Returns 'google' as default if the provider column is missing or unrecognized.
 */
async function lookupProvider(
  accountId: AccountId,
  env: Env,
): Promise<ProviderType> {
  const result = await env.DB.prepare(
    "SELECT provider FROM accounts WHERE account_id = ?1",
  )
    .bind(accountId)
    .first<{ provider: string }>();

  const provider = result?.provider;
  if (provider === "microsoft") {
    return "microsoft";
  }
  // Default to google for backward compatibility
  return "google";
}

// ---------------------------------------------------------------------------
// AccountDO interaction helpers
// ---------------------------------------------------------------------------

/**
 * Get an access token from AccountDO.
 */
async function getAccessToken(
  accountId: AccountId,
  provider: ProviderType,
  env: Env,
): Promise<string> {
  const doId = env.ACCOUNT.idFromName(accountId);
  const stub = env.ACCOUNT.get(doId);

  const response = await stub.fetch(
    new Request("https://account.internal/getAccessToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider }),
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
  provider: ProviderType,
  env: Env,
): Promise<string> {
  return getAccessToken(accountId, provider, env);
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

async function getScopedSyncToken(
  accountId: AccountId,
  env: Env,
  providerCalendarId: string,
): Promise<string | null> {
  const doId = env.ACCOUNT.idFromName(accountId);
  const stub = env.ACCOUNT.get(doId);

  const response = await stub.fetch(
    new Request("https://account.internal/getScopedSyncToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider_calendar_id: providerCalendarId }),
    }),
  );

  if (!response.ok) {
    // Compatibility fallback for legacy AccountDOs.
    if (
      (response.status === 404 || response.status === 405) &&
      providerCalendarId === "primary"
    ) {
      return getSyncToken(accountId, env);
    }
    const body = await response.text();
    throw new Error(
      `AccountDO.getScopedSyncToken failed (${response.status}): ${body}`,
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

async function setScopedSyncToken(
  accountId: AccountId,
  env: Env,
  providerCalendarId: string,
  token: string,
): Promise<void> {
  const doId = env.ACCOUNT.idFromName(accountId);
  const stub = env.ACCOUNT.get(doId);

  const response = await stub.fetch(
    new Request("https://account.internal/setScopedSyncToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider_calendar_id: providerCalendarId,
        sync_token: token,
      }),
    }),
  );

  if (!response.ok) {
    // Compatibility fallback for legacy AccountDOs.
    if (
      (response.status === 404 || response.status === 405) &&
      providerCalendarId === "primary"
    ) {
      await setSyncToken(accountId, env, token);
      return;
    }
    const body = await response.text();
    throw new Error(
      `AccountDO.setScopedSyncToken failed (${response.status}): ${body}`,
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

  // Convergence signal: successful sync should recover account UI state from
  // stale "error" flags set by prior transient incidents.
  await env.DB
    .prepare("UPDATE accounts SET status = ?1 WHERE account_id = ?2")
    .bind("active", accountId)
    .run();
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
// Per-scope sync health reporting (AC4)
// ---------------------------------------------------------------------------

/** Health state for a single calendar scope. */
export interface ScopedSyncHealth {
  readonly providerCalendarId: string;
  readonly lastSyncTs: string | null;
  readonly lastSuccessTs: string | null;
  readonly errorMessage: string | null;
  readonly hasCursor: boolean;
}

/** Aggregated sync health report for an account. */
export interface SyncHealthReport {
  readonly accountId: AccountId;
  readonly provider: ProviderType;
  readonly accountLevel: {
    readonly lastSyncTs: string | null;
    readonly lastSuccessTs: string | null;
    readonly errorMessage: string | null;
  };
  readonly scopes: ScopedSyncHealth[];
}

/**
 * Build a sync health report for an account, including per-scope freshness.
 *
 * Calls AccountDO endpoints for account-level and per-scope health.
 * Non-fatal: 404/405 from AccountDO is treated as empty data.
 */
export async function getSyncHealthReport(
  accountId: AccountId,
  env: Env,
): Promise<SyncHealthReport> {
  const provider = await lookupProvider(accountId, env);
  const doId = env.ACCOUNT.idFromName(accountId);
  const stub = env.ACCOUNT.get(doId);

  // Account-level health
  let accountLevel = {
    lastSyncTs: null as string | null,
    lastSuccessTs: null as string | null,
    errorMessage: null as string | null,
  };
  try {
    const response = await stub.fetch(
      new Request("https://account.internal/getSyncHealth", {
        method: "POST",
      }),
    );
    if (response.ok) {
      const data = (await response.json()) as {
        last_sync_ts?: string | null;
        last_success_ts?: string | null;
        error_message?: string | null;
      };
      accountLevel = {
        lastSyncTs: data.last_sync_ts ?? null,
        lastSuccessTs: data.last_success_ts ?? null,
        errorMessage: data.error_message ?? null,
      };
    }
  } catch {
    // Non-fatal: account health unavailable
  }

  // Per-scope health
  const scopes: ScopedSyncHealth[] = [];
  const calendarScopes = await listCalendarScopes(accountId, env);
  for (const scope of calendarScopes) {
    try {
      const response = await stub.fetch(
        new Request("https://account.internal/getScopedSyncHealth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider_calendar_id: scope.providerCalendarId }),
        }),
      );
      if (response.ok) {
        const data = (await response.json()) as {
          last_sync_ts?: string | null;
          last_success_ts?: string | null;
          error_message?: string | null;
          has_cursor?: boolean;
        };
        scopes.push({
          providerCalendarId: scope.providerCalendarId,
          lastSyncTs: data.last_sync_ts ?? null,
          lastSuccessTs: data.last_success_ts ?? null,
          errorMessage: data.error_message ?? null,
          hasCursor: data.has_cursor ?? false,
        });
      } else {
        scopes.push({
          providerCalendarId: scope.providerCalendarId,
          lastSyncTs: null,
          lastSuccessTs: null,
          errorMessage: null,
          hasCursor: false,
        });
      }
    } catch {
      scopes.push({
        providerCalendarId: scope.providerCalendarId,
        lastSyncTs: null,
        lastSuccessTs: null,
        errorMessage: null,
        hasCursor: false,
      });
    }
  }

  return {
    accountId,
    provider,
    accountLevel,
    scopes,
  };
}

/**
 * Mark a specific calendar scope as successfully synced on AccountDO.
 * Non-fatal: 404/405 responses are silently ignored for backward compatibility.
 */
export async function markScopedSyncSuccess(
  accountId: AccountId,
  env: Env,
  providerCalendarId: string,
): Promise<void> {
  const doId = env.ACCOUNT.idFromName(accountId);
  const stub = env.ACCOUNT.get(doId);

  try {
    const response = await stub.fetch(
      new Request("https://account.internal/markScopedSyncSuccess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider_calendar_id: providerCalendarId,
          ts: new Date().toISOString(),
        }),
      }),
    );

    if (!response.ok && response.status !== 404 && response.status !== 405) {
      console.warn(
        `sync-consumer: markScopedSyncSuccess failed for ${accountId}/${providerCalendarId} (${response.status})`,
      );
    }
  } catch {
    // Non-fatal: scoped health tracking is best-effort
  }
}

/**
 * Mark a specific calendar scope as failed on AccountDO.
 * Non-fatal: 404/405 responses are silently ignored for backward compatibility.
 */
export async function markScopedSyncFailure(
  accountId: AccountId,
  env: Env,
  providerCalendarId: string,
  error: string,
): Promise<void> {
  const doId = env.ACCOUNT.idFromName(accountId);
  const stub = env.ACCOUNT.get(doId);

  try {
    const response = await stub.fetch(
      new Request("https://account.internal/markScopedSyncFailure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider_calendar_id: providerCalendarId,
          error,
        }),
      }),
    );

    if (!response.ok && response.status !== 404 && response.status !== 405) {
      console.warn(
        `sync-consumer: markScopedSyncFailure failed for ${accountId}/${providerCalendarId} (${response.status})`,
      );
    }
  } catch {
    // Non-fatal: scoped health tracking is best-effort
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
 * Handles both Google and Microsoft provider errors:
 * - 429 (rate limit): backoff 1s, 2s, 4s, 8s, 16s (max 5 retries)
 * - 500/503 (server error): backoff 2s, 4s, 8s (max 3 retries)
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
      // Rate limit errors (Google RateLimitError or Microsoft MicrosoftRateLimitError)
      if (err instanceof RateLimitError || err instanceof MicrosoftRateLimitError) {
        attempt429++;
        if (attempt429 > maxRetries429) {
          throw err;
        }
        const delayMs = 1000 * Math.pow(2, attempt429 - 1); // 1s, 2s, 4s, 8s, 16s
        await sleepFn(delayMs);
        continue;
      }

      // Server errors (Google or Microsoft 500/503)
      if (
        (err instanceof GoogleApiError &&
          (err.statusCode === 500 || err.statusCode === 503)) ||
        (err instanceof MicrosoftApiError &&
          (err.statusCode === 500 || err.statusCode === 503))
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
