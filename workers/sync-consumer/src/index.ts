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
  /**
   * Shared delete guard state across queue messages in the same batch run.
   * Optional for tests; when omitted, queue handler creates one per batch.
   */
  deleteGuardState?: DeleteGuardSharedState;
}

interface DeleteGuardSharedState {
  batchDeleteCount: number;
  accountDeleteCounts: Map<AccountId, number>;
}

function createDeleteGuardSharedState(): DeleteGuardSharedState {
  return {
    batchDeleteCount: 0,
    accountDeleteCounts: new Map<AccountId, number>(),
  };
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
      const sharedDeleteGuardState =
        deps.deleteGuardState ?? createDeleteGuardSharedState();
      const runtimeDeps: SyncConsumerDeps = {
        ...deps,
        deleteGuardState: sharedDeleteGuardState,
      };

      for (const msg of batch.messages) {
        try {
          switch (msg.body.type) {
            case "SYNC_INCREMENTAL":
              await handleIncrementalSync(msg.body, env, runtimeDeps);
              break;
            case "SYNC_FULL":
              await handleFullSync(msg.body, env, runtimeDeps);
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
  const deleteGuard = createDeleteSafetyGuard(account_id, env, deps);
  const microsoftWebhookCandidateEventIds =
    provider === "microsoft" ? getMicrosoftWebhookDeleteEventIds(message) : [];
  const microsoftWebhookDeleteCandidateCount =
    microsoftWebhookCandidateEventIds.length;
  let microsoftWebhookDeleteResolvedCount = 0;

  // TM-9fc9: Webhook-hinted mirror deletion (Microsoft only).
  // When a Microsoft webhook notification has changeType "deleted", the
  // incremental sync delta from the provider will NOT contain the deleted
  // event. However, the webhook notification's resource path contains the
  // specific event ID (or resourceData.id). If that ID is a known managed
  // mirror, we can delete the canonical immediately without waiting for a
  // full sync.
  if (provider === "microsoft" && isWebhookDeleteChangeType(message.webhook_change_type)) {
    if (microsoftWebhookCandidateEventIds.length > 0) {
      try {
        const userId = await lookupUserId(account_id, env);
        if (userId) {
          const managedMirrorIds = await loadManagedMirrorEventIds(account_id, userId, env);
          const userGraphId = env.USER_GRAPH.idFromName(userId);
          const userGraphStub = env.USER_GRAPH.get(userGraphId);
          const resolvedMirrorDeleteIds = new Set<string>();

          for (const eventId of microsoftWebhookCandidateEventIds) {
            const isManagedMirror = providerEventIdVariants(eventId).some(
              (candidateId) => managedMirrorIds.has(candidateId),
            );

            if (isManagedMirror) {
              console.log("sync-consumer: webhook-hinted mirror deletion", {
                account_id,
                provider_event_id: eventId,
              });
              resolvedMirrorDeleteIds.add(eventId);
              continue;
            }

            // Fallback: mirror state might not be ACTIVE, try direct lookup.
            // This remains safe because no delete occurs unless a canonical
            // mapping exists for this specific mirror event ID.
            const canonicalId = await findCanonicalIdByMirror(
              userGraphStub,
              account_id,
              eventId,
            );
            if (!canonicalId) {
              continue;
            }
            console.log("sync-consumer: webhook-hinted mirror deletion (fallback lookup)", {
              account_id,
              provider_event_id: eventId,
              canonical_event_id: canonicalId,
            });
            resolvedMirrorDeleteIds.add(eventId);
          }

          if (resolvedMirrorDeleteIds.size > 0) {
            microsoftWebhookDeleteResolvedCount = resolvedMirrorDeleteIds.size;
            await applyManagedMirrorDeletes(
              account_id,
              userId,
              [...resolvedMirrorDeleteIds],
              env,
              deleteGuard,
              {
                provider,
                stage: "incremental",
                reason: "webhook_hint",
              },
            );
          }
        }
      } catch (err) {
        // Fail safe: log and continue with normal incremental sync.
        // Never delete based on uncertainty.
        console.warn("sync-consumer: webhook-hinted mirror deletion failed, continuing with normal sync", {
          account_id,
          resource_id: message.resource_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Continue with normal incremental sync -- other events may have changed too
  }

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

  // Safety-first fallback: Microsoft webhook payloads can occasionally carry
  // non-"deleted" change types for events that were actually removed. Probe
  // the specific event ID; only treat as delete when provider confirms the
  // mirror event no longer exists.
  if (
    provider === "microsoft" &&
    !isWebhookDeleteChangeType(message.webhook_change_type) &&
    microsoftWebhookCandidateEventIds.length > 0
  ) {
    try {
      const userId = await lookupUserId(account_id, env);
      if (userId) {
        const managedMirrorIds = await loadManagedMirrorEventIds(
          account_id,
          userId,
          env,
        );
        const userGraphId = env.USER_GRAPH.idFromName(userId);
        const userGraphStub = env.USER_GRAPH.get(userGraphId);
        const resolvedMirrorDeleteIds = new Set<string>();

        for (const eventId of microsoftWebhookCandidateEventIds) {
          let isManagedMirror = providerEventIdVariants(eventId).some(
            (candidateId) => managedMirrorIds.has(candidateId),
          );

          if (!isManagedMirror) {
            const canonicalId = await findCanonicalIdByMirror(
              userGraphStub,
              account_id,
              eventId,
            );
            isManagedMirror = canonicalId !== null;
          }
          if (!isManagedMirror) {
            continue;
          }

          const exists = await microsoftEventExists(
            eventId,
            accessToken,
            deps.fetchFn,
          );
          if (exists) {
            continue;
          }

          console.log(
            "sync-consumer: webhook mirror event missing at provider, treating as delete",
            {
              account_id,
              provider_event_id: eventId,
              webhook_change_type: message.webhook_change_type,
            },
          );
          resolvedMirrorDeleteIds.add(eventId);
        }

        if (resolvedMirrorDeleteIds.size > 0) {
          microsoftWebhookDeleteResolvedCount += resolvedMirrorDeleteIds.size;
          await applyManagedMirrorDeletes(
            account_id,
            userId,
            [...resolvedMirrorDeleteIds],
            env,
            deleteGuard,
            {
              provider,
              stage: "incremental",
              reason: "webhook_missing_probe",
            },
          );
        }
      }
    } catch (err) {
      console.warn(
        "sync-consumer: webhook mirror missing probe failed, continuing with normal sync",
        {
          account_id,
          resource_id: message.resource_id,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  // Step 3: Fetch incremental changes via provider-specific client.
  // Both Google and Microsoft read enabled sync scopes (primary + overlays)
  // using per-calendar scoped cursors.
  const client = createCalendarProvider(provider, accessToken, deps.fetchFn);

  let events: GoogleCalendarEvent[];
  let cursorUpdates: SyncCursorUpdate[] = [];
  const retryOpts = deps.sleepFn ? { sleepFn: deps.sleepFn } : {};
  const includeMirrorScopeFallback =
    !(provider === "microsoft" && typeof message.webhook_change_type === "string");

  try {
    const result = await fetchIncrementalProviderEvents(
      account_id,
      provider,
      client,
      env,
      retryOpts,
      targetCalendarId,
      includeMirrorScopeFallback,
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
          includeMirrorScopeFallback,
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
  const deltaResult = await processAndApplyDeltas(
    account_id,
    events,
    env,
    provider,
    deleteGuard,
    "incremental",
  );
  const deltasApplied = deltaResult.appliedDeltaCount;

  // Step 6: Persist sync cursors.
  await persistSyncCursorUpdates(account_id, provider, env, cursorUpdates);

  // Safety-first behavior: never auto-enqueue SYNC_FULL reconcile for unresolved
  // mirror delete hints. We keep processing incremental deltas and wait for
  // subsequent webhook/sweep evidence to avoid broad destructive syncs.
  if (
    provider === "microsoft" &&
    isWebhookDeleteChangeType(message.webhook_change_type) &&
    microsoftWebhookDeleteCandidateCount > 0 &&
    microsoftWebhookDeleteResolvedCount === 0
  ) {
    console.warn(
      "sync-consumer: webhook delete hint unresolved; skipping SYNC_FULL reconcile for safety",
      {
        account_id,
        resource_id: message.resource_id,
      },
    );

    // Safety-first bounded fallback: run mirror-only snapshot reconcile now.
    // This keeps delete handling atomic (max 1) while recovering unresolved
    // webhook delete hints without broad SYNC_FULL behavior.
    try {
      const reconciledDeletes =
        await reconcileMissingManagedMirrorsFromMicrosoftSweep(
          account_id,
          accessToken,
          env,
          deps,
          deleteGuard,
          retryOpts,
        );
      if (reconciledDeletes > 0) {
        console.log(
          "sync-consumer: webhook delete hint recovered via bounded mirror snapshot reconcile",
          {
            account_id,
            reconciled_deletes: reconciledDeletes,
            resource_id: message.resource_id,
          },
        );
      }
    } catch (err) {
      console.warn(
        "sync-consumer: webhook delete hint bounded reconcile failed; continuing",
        {
          account_id,
          resource_id: message.resource_id,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  // Scheduled Microsoft sweeps are the webhook safety net. Use a bounded
  // mirror-only snapshot reconcile (no SYNC_FULL) to recover deletes that
  // disappear from delta feeds.
  if (provider === "microsoft" && isScheduledMicrosoftSweepMessage(message.resource_id)) {
    try {
      const reconciledDeletes =
        await reconcileMissingManagedMirrorsFromMicrosoftSweep(
          account_id,
          accessToken,
          env,
          deps,
          deleteGuard,
          retryOpts,
        );
      if (reconciledDeletes > 0) {
        console.log(
          "sync-consumer: scheduled microsoft sweep reconciled missing managed mirrors",
          {
            account_id,
            reconciled_deletes: reconciledDeletes,
          },
        );
      }
    } catch (err) {
      console.warn(
        "sync-consumer: scheduled microsoft mirror reconcile failed; continuing",
        {
          account_id,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  if (deleteGuard.hasBlockedDeletes()) {
    const guardError = buildDeleteGuardErrorMessage(deleteGuard.getBlockedEvents());
    await markSyncFailure(account_id, env, guardError);
    if (targetCalendarId && cursorUpdates.length === 0) {
      await markScopedSyncFailure(account_id, env, targetCalendarId, guardError);
    }
    for (const update of cursorUpdates) {
      await markScopedSyncFailure(
        account_id,
        env,
        update.providerCalendarId,
        guardError,
      );
    }
  } else {
    // Step 6b: Mark per-scope sync success for each updated cursor.
    for (const update of cursorUpdates) {
      await markScopedSyncSuccess(account_id, env, update.providerCalendarId);
    }

    // Step 7: Mark sync success.
    await markSyncSuccess(account_id, env);
  }

  const scopeLabel = targetCalendarId ? ` (scope: ${targetCalendarId})` : " (all scopes)";
  console.log(
    `sync-consumer: SYNC_INCREMENTAL complete for account ${account_id}${scopeLabel} -- ${events.length} events fetched, ${deltasApplied} deltas applied, ${cursorUpdates.length} cursors updated, delete_guard_blocked=${deleteGuard.hasBlockedDeletes()}`,
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
 * - Paginated: loop through page tokens per provider scope
 * - Stores scoped cursors and legacy-compatible default cursor
 */
export async function handleFullSync(
  message: SyncFullMessage,
  env: Env,
  deps: SyncConsumerDeps = {},
): Promise<void> {
  const { account_id } = message;

  // Look up provider type from D1
  const provider = await lookupProvider(account_id, env);
  const deleteGuard = createDeleteSafetyGuard(account_id, env, deps);

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
  const deltaResult = await processAndApplyDeltas(
    account_id,
    allEvents,
    env,
    provider,
    deleteGuard,
    "full",
  );
  const deltasApplied = deltaResult.appliedDeltaCount;

  let staleManagedMirrorDeletes = 0;
  const userId = await lookupUserId(account_id, env);
  if (userId) {
    const missingMirrorProviderIds = await findMissingManagedMirrorProviderEventIds(
      account_id,
      userId,
      allEvents,
      env,
      {
        skippedCalendarIds,
        syncedCalendarIds: cursorUpdates.map((update) => update.providerCalendarId),
      },
    );
    if (missingMirrorProviderIds.length > 0) {
      staleManagedMirrorDeletes = await applyManagedMirrorDeletes(
        account_id,
        userId,
        missingMirrorProviderIds,
        env,
        deleteGuard,
        {
          provider,
          stage: "full",
          reason: "stale_managed_mirror_reconcile",
        },
      );
    }
  }

  // Full sync convergence: prune stale provider-origin canonicals that no longer
  // exist upstream. Without this, explicit full resyncs can still leave deletes behind.
  const prunedDeleted = await pruneMissingOriginEvents(
    account_id,
    allEvents,
    env,
    provider,
    deleteGuard,
    {
      provider,
      stage: "full",
      reason: "prune_missing_origin",
    },
  );

  // Update sync cursor(s): scoped for provider scopes and legacy-compatible
  // default cursor for account-level paths.
  await persistSyncCursorUpdates(account_id, provider, env, cursorUpdates);

  if (deleteGuard.hasBlockedDeletes()) {
    const guardError = buildDeleteGuardErrorMessage(deleteGuard.getBlockedEvents());
    await markSyncFailure(account_id, env, guardError);
    for (const update of cursorUpdates) {
      await markScopedSyncFailure(
        account_id,
        env,
        update.providerCalendarId,
        guardError,
      );
    }
  } else {
    // Mark per-scope sync success for each updated cursor.
    for (const update of cursorUpdates) {
      await markScopedSyncSuccess(account_id, env, update.providerCalendarId);
    }

    // Mark sync success
    await markSyncSuccess(account_id, env);
  }

  console.log(
    `sync-consumer: SYNC_FULL complete for account ${account_id} -- ${allEvents.length} events fetched, ${deltasApplied} deltas applied, ${staleManagedMirrorDeletes} stale managed mirrors deleted, ${prunedDeleted} stale origin events pruned, ${cursorUpdates.length} cursors updated, delete_guard_blocked=${deleteGuard.hasBlockedDeletes()}`,
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

interface DeleteGuardConfig {
  enabled: boolean;
  maxDeletesPerSyncRun: number;
  maxDeletesPerAccountBatch: number;
  maxDeletesPerBatch: number;
}

interface DeleteGuardMetadata {
  readonly provider?: ProviderType;
  readonly stage?: "incremental" | "full";
  readonly reason?: string;
}

interface DeleteGuardBlockEvent {
  readonly account_id: AccountId;
  readonly operation: string;
  readonly attempted_deletes: number;
  readonly run_count_before: number;
  readonly run_limit: number;
  readonly account_batch_count_before: number;
  readonly account_batch_limit: number;
  readonly batch_count_before: number;
  readonly batch_limit: number;
  readonly ts: string;
  readonly metadata: DeleteGuardMetadata;
}

const DEFAULT_DELETE_GUARD_ENABLED = true;
const HARD_MAX_DELETES_PER_OPERATION = 1;
const DEFAULT_MAX_DELETES_PER_SYNC_RUN = HARD_MAX_DELETES_PER_OPERATION;
const DEFAULT_MAX_DELETES_PER_ACCOUNT_BATCH = HARD_MAX_DELETES_PER_OPERATION;
const DEFAULT_MAX_DELETES_PER_BATCH = HARD_MAX_DELETES_PER_OPERATION;

function limitAtomicDeleteCandidates<T>(
  candidates: readonly T[],
  operation: string,
  context: Record<string, unknown> = {},
): T[] {
  if (candidates.length <= HARD_MAX_DELETES_PER_OPERATION) {
    return [...candidates];
  }
  console.warn("sync-consumer: delete candidates truncated to atomic limit", {
    operation,
    attempted: candidates.length,
    allowed: HARD_MAX_DELETES_PER_OPERATION,
    ...context,
  });
  return [...candidates.slice(0, HARD_MAX_DELETES_PER_OPERATION)];
}

class DeleteSafetyGuard {
  private runDeleteCount = 0;
  private readonly blockedEvents: DeleteGuardBlockEvent[] = [];

  constructor(
    private readonly accountId: AccountId,
    private readonly config: DeleteGuardConfig,
    private readonly sharedState: DeleteGuardSharedState,
  ) {}

  reserve(
    operation: string,
    attemptedDeletes: number,
    metadata: DeleteGuardMetadata = {},
  ): boolean {
    if (attemptedDeletes <= 0 || !this.config.enabled) {
      return true;
    }

    const accountBatchCountBefore =
      this.sharedState.accountDeleteCounts.get(this.accountId) ?? 0;
    const batchCountBefore = this.sharedState.batchDeleteCount;

    const wouldExceedRun =
      this.runDeleteCount + attemptedDeletes > this.config.maxDeletesPerSyncRun;
    const wouldExceedAccountBatch =
      accountBatchCountBefore + attemptedDeletes >
      this.config.maxDeletesPerAccountBatch;
    const wouldExceedBatch =
      batchCountBefore + attemptedDeletes > this.config.maxDeletesPerBatch;

    if (wouldExceedRun || wouldExceedAccountBatch || wouldExceedBatch) {
      const block: DeleteGuardBlockEvent = {
        account_id: this.accountId,
        operation,
        attempted_deletes: attemptedDeletes,
        run_count_before: this.runDeleteCount,
        run_limit: this.config.maxDeletesPerSyncRun,
        account_batch_count_before: accountBatchCountBefore,
        account_batch_limit: this.config.maxDeletesPerAccountBatch,
        batch_count_before: batchCountBefore,
        batch_limit: this.config.maxDeletesPerBatch,
        ts: new Date().toISOString(),
        metadata,
      };
      this.blockedEvents.push(block);
      console.error("sync-consumer: delete_guard_blocked", block);
      return false;
    }

    this.runDeleteCount += attemptedDeletes;
    this.sharedState.batchDeleteCount = batchCountBefore + attemptedDeletes;
    this.sharedState.accountDeleteCounts.set(
      this.accountId,
      accountBatchCountBefore + attemptedDeletes,
    );
    return true;
  }

  hasBlockedDeletes(): boolean {
    return this.blockedEvents.length > 0;
  }

  getBlockedEvents(): DeleteGuardBlockEvent[] {
    return [...this.blockedEvents];
  }
}

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (typeof raw !== "string") return fallback;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (typeof raw !== "string") return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function resolveDeleteGuardConfig(env: Env): DeleteGuardConfig {
  const maxDeletesPerSyncRun = Math.min(
    parsePositiveIntEnv(
      env.DELETE_GUARD_MAX_DELETES_PER_SYNC_RUN,
      DEFAULT_MAX_DELETES_PER_SYNC_RUN,
    ),
    HARD_MAX_DELETES_PER_OPERATION,
  );
  const maxDeletesPerAccountBatch = Math.min(
    parsePositiveIntEnv(
      env.DELETE_GUARD_MAX_DELETES_PER_ACCOUNT_BATCH,
      DEFAULT_MAX_DELETES_PER_ACCOUNT_BATCH,
    ),
    HARD_MAX_DELETES_PER_OPERATION,
  );
  const maxDeletesPerBatch = Math.min(
    parsePositiveIntEnv(
      env.DELETE_GUARD_MAX_DELETES_PER_BATCH,
      DEFAULT_MAX_DELETES_PER_BATCH,
    ),
    HARD_MAX_DELETES_PER_OPERATION,
  );

  return {
    enabled: parseBooleanEnv(
      env.DELETE_GUARD_ENABLED,
      DEFAULT_DELETE_GUARD_ENABLED,
    ),
    maxDeletesPerSyncRun,
    maxDeletesPerAccountBatch,
    maxDeletesPerBatch,
  };
}

function resolveDeleteGuardState(deps: SyncConsumerDeps): DeleteGuardSharedState {
  return deps.deleteGuardState ?? createDeleteGuardSharedState();
}

function createDeleteSafetyGuard(
  accountId: AccountId,
  env: Env,
  deps: SyncConsumerDeps,
): DeleteSafetyGuard {
  return new DeleteSafetyGuard(
    accountId,
    resolveDeleteGuardConfig(env),
    resolveDeleteGuardState(deps),
  );
}

function buildDeleteGuardErrorMessage(
  blockedEvents: DeleteGuardBlockEvent[],
): string {
  if (blockedEvents.length === 0) {
    return "Delete guard triggered: destructive delete operation blocked.";
  }

  const summary = blockedEvents
    .map((event) => `${event.operation}:${event.attempted_deletes}`)
    .join(",");
  return `Delete guard triggered: blocked ${blockedEvents.length} delete operation(s) [${summary}]`;
}

async function fetchIncrementalProviderEvents(
  accountId: AccountId,
  provider: ProviderType,
  client: ReturnType<typeof createCalendarProvider>,
  env: Env,
  retryOpts: RetryOptions,
  targetCalendarId: string | null = null,
  includeMirrorScopeFallback = true,
): Promise<ProviderFetchResult> {
  // When targetCalendarId is set, only sync that specific scope.
  // Otherwise, sync all registered calendar scopes (plus legacy mirror
  // fallback scopes derived from UserGraph active mirrors).
  const calendarIds = targetCalendarId
    ? [targetCalendarId]
    : await listSyncCalendarIds(accountId, env, includeMirrorScopeFallback);
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
      if (
        (provider === "google" &&
          err instanceof GoogleApiError &&
          err.statusCode === 404) ||
        (provider === "microsoft" &&
          err instanceof MicrosoftApiError &&
          err.statusCode === 404)
      ) {
        console.warn(
          `sync-consumer: skipping unavailable ${provider} calendar scope ${calendarId} for account ${accountId}`,
        );
        skippedCalendarIds.push(calendarId);
        continue;
      }
      throw err;
    }

    // Non-primary scope bootstrap must be promoted to SYNC_FULL so stale
    // managed mirrors are reconciled from a full snapshot before we trust
    // incremental deltas on that scope.
    if (
      !syncToken &&
      calendarId !== "primary" &&
      (provider === "google" || provider === "microsoft")
    ) {
      needsScopedBootstrapFullSync = true;
    }

    if (calendarId === "primary") {
      events.push(...response.events);
    } else {
      events.push(
        ...response.events.map(
          (event) =>
            ({
              ...event,
              _provider_calendar_id: calendarId,
            }) as GoogleCalendarEvent,
        ),
      );
    }
    if (response.nextSyncToken) {
      cursorUpdates.push({
        providerCalendarId: calendarId,
        token: response.nextSyncToken,
      });
    }
  }

  if (needsScopedBootstrapFullSync) {
    throw new SyncTokenExpiredError(
      `${provider} scoped sync bootstrap required for non-primary calendars`,
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
  const calendarIds = await listSyncCalendarIds(accountId, env);
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
        if (
          (provider === "google" &&
            err instanceof GoogleApiError &&
            err.statusCode === 404) ||
          (provider === "microsoft" &&
            err instanceof MicrosoftApiError &&
            err.statusCode === 404)
        ) {
          console.warn(
            `sync-consumer: skipping unavailable ${provider} calendar scope ${calendarId} for account ${accountId}`,
          );
          skippedCalendarIds.push(calendarId);
          break;
        }
        throw err;
      }
      if (calendarId === "primary") {
        events.push(...response.events);
      } else {
        events.push(
          ...response.events.map(
            (event) =>
              ({
                ...event,
                _provider_calendar_id: calendarId,
              }) as GoogleCalendarEvent,
          ),
        );
      }
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

  for (const update of cursorUpdates) {
    await setScopedSyncToken(
      accountId,
      env,
      update.providerCalendarId,
      update.token,
    );
  }

  const defaultUpdate = cursorUpdates.find(
    (update) => update.providerCalendarId === "primary",
  ) ?? (provider === "microsoft" ? cursorUpdates[0] : undefined);
  if (defaultUpdate) {
    await setSyncToken(accountId, env, defaultUpdate.token);
  }
}

async function listSyncCalendarIds(
  accountId: AccountId,
  env: Env,
  includeMirrorScopeFallback = true,
): Promise<string[]> {
  const calendarIds = new Set(
    (await listCalendarScopes(accountId, env))
      .filter((scope) => scope.enabled && scope.syncEnabled)
      .map((scope) => scope.providerCalendarId)
      .filter((calendarId) => calendarId.length > 0),
  );

  // Legacy fallback:
  // only derive mirror target calendars when there are no explicitly enabled
  // sync scopes. This preserves backward compatibility for pre-scope accounts
  // without overriding explicit single-scope configurations.
  if (includeMirrorScopeFallback && calendarIds.size === 0) {
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
interface ProcessDeltaResult {
  appliedDeltaCount: number;
  managedMirrorDeletedCount: number;
  managedMirrorModifiedCount: number;
}

async function processAndApplyDeltas(
  accountId: AccountId,
  events: GoogleCalendarEvent[],
  env: Env,
  provider: ProviderType = "google",
  deleteGuard?: DeleteSafetyGuard,
  stage: "incremental" | "full" = "incremental",
): Promise<ProcessDeltaResult> {
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
    const originCalendarId =
      typeof (event as Record<string, unknown>)._provider_calendar_id === "string" &&
      ((event as Record<string, unknown>)._provider_calendar_id as string).length > 0 &&
      (event as Record<string, unknown>)._provider_calendar_id !== "primary"
        ? ((event as Record<string, unknown>)._provider_calendar_id as string)
        : undefined;
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
    const delta: ProviderDelta = {
      ...rawDelta,
      origin_event_id: canonicalizeProviderEventId(rawDelta.origin_event_id),
      ...(originCalendarId ? { origin_calendar_id: originCalendarId } : {}),
    };

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
        // Safety: only do writeback on true incremental deltas. Full-sync
        // snapshots can contain large managed-mirror inventories and must not
        // trigger bulk canonical rewrites.
        stage === "incremental" &&
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

  const originDeleteDeltas = deltas.filter((delta) => delta.type === "deleted");
  const nonDeleteDeltas = deltas.filter((delta) => delta.type !== "deleted");
  const originDeleteDeltasToApply = limitAtomicDeleteCandidates(
    originDeleteDeltas,
    "apply_provider_deleted_deltas",
    {
      account_id: accountId,
      provider,
      stage,
    },
  );
  let deltasToApply = deltas;
  if (originDeleteDeltasToApply.length !== originDeleteDeltas.length) {
    let retainedDeleteCount = 0;
    deltasToApply = deltas.filter((delta) => {
      if (delta.type !== "deleted") return true;
      if (retainedDeleteCount < originDeleteDeltasToApply.length) {
        retainedDeleteCount += 1;
        return true;
      }
      return false;
    });
  }

  if (
    originDeleteDeltasToApply.length > 0 &&
    deleteGuard &&
    !deleteGuard.reserve(
      "apply_provider_deleted_deltas",
      originDeleteDeltasToApply.length,
      {
      provider,
      stage,
      reason: "provider_origin_delete_delta",
      },
    )
  ) {
    deltasToApply = nonDeleteDeltas;
  }

  if (deltasToApply.length > 0) {
    const applyResult = await applyProviderDeltas(accountId, userId!, deltasToApply, env);
    console.log("sync-consumer: applyProviderDelta result", {
      account_id: accountId,
      provider,
      stage,
      deltas_applied: deltasToApply.length,
      created: applyResult.created,
      updated: applyResult.updated,
      deleted: applyResult.deleted,
      mirrors_enqueued: applyResult.mirrors_enqueued,
      apply_errors: applyResult.errors.length,
    });
    if (
      applyResult.mirrors_enqueued === 0 &&
      (applyResult.created > 0 || applyResult.updated > 0)
    ) {
      console.warn("sync-consumer: no mirrors enqueued after origin delta apply", {
        account_id: accountId,
        provider,
        stage,
        created: applyResult.created,
        updated: applyResult.updated,
        hint: "projection_policy_or_mirror_target_missing",
      });
    }
  }

  if (managedMirrorDeletedEventIds.size > 0) {
    await applyManagedMirrorDeletes(
      accountId,
      userId!,
      [...managedMirrorDeletedEventIds],
      env,
      deleteGuard,
      {
        provider,
        stage,
        reason: "managed_mirror_delete",
      },
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

  return {
    appliedDeltaCount: deltasToApply.length,
    managedMirrorDeletedCount: managedMirrorDeletedEventIds.size,
    managedMirrorModifiedCount: managedMirrorModifiedEvents.length,
  };
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
  deleteGuard?: DeleteSafetyGuard,
  metadata: DeleteGuardMetadata = {},
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

  const prunableByRecency = [...prunable].sort((a, b) => {
    const aStart = a.startTs ? Date.parse(a.startTs) : Number.NaN;
    const bStart = b.startTs ? Date.parse(b.startTs) : Number.NaN;
    const aScore = Number.isFinite(aStart) ? aStart : 0;
    const bScore = Number.isFinite(bStart) ? bStart : 0;
    return bScore - aScore;
  });
  const prunableToDelete = limitAtomicDeleteCandidates(
    prunableByRecency,
    "prune_missing_origin_events",
    {
      account_id: accountId,
      provider,
      stage: metadata.stage,
      reason: metadata.reason,
    },
  );

  if (
    deleteGuard &&
    !deleteGuard.reserve(
      "prune_missing_origin_events",
      prunableToDelete.length,
      metadata,
    )
  ) {
    return 0;
  }

  return applyDeletedOriginDeltas(
    accountId,
    userId,
    prunableToDelete.map((origin) => origin.originEventId),
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
  if (typeof eventId === "string" && eventId.length > 0) {
    if (managedMirrorEventIds?.has(eventId)) {
      return "managed_mirror";
    }
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
  canonical_event_id?: string | null;
  last_write_ts?: string | null;
  state?: string | null;
}

async function loadActiveMirrors(
  accountId: AccountId,
  userId: string,
  env: Env,
  options: { includePendingWithProviderId?: boolean } = {},
): Promise<ActiveMirrorRow[]> {
  const userGraphId = env.USER_GRAPH.idFromName(userId);
  const userGraphStub = env.USER_GRAPH.get(userGraphId);
  const response = await userGraphStub.fetch(
    new Request("https://user-graph.internal/getActiveMirrors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target_account_id: accountId,
        include_pending_with_provider_id:
          options.includePendingWithProviderId === true,
      }),
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
  options: {
    skippedCalendarIds?: readonly string[];
    syncedCalendarIds?: readonly string[];
  } = {},
): Promise<string[]> {
  const mirrors = await loadActiveMirrors(accountId, userId, env);
  if (mirrors.length === 0) {
    return [];
  }
  const skipped = new Set(options.skippedCalendarIds ?? []);
  const syncedCalendarIds = options.syncedCalendarIds ?? [];
  const synced =
    syncedCalendarIds.length > 0 ? new Set(syncedCalendarIds) : null;

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
    const targetCalendarId =
      typeof mirror.target_calendar_id === "string"
        ? mirror.target_calendar_id
        : "";
    if (synced && (targetCalendarId.length === 0 || !synced.has(targetCalendarId))) {
      // Safety: only reconcile "missing" mirrors for calendars that were
      // explicitly synced in this run.
      continue;
    }
    if (targetCalendarId.length > 0 && skipped.has(targetCalendarId)) {
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

function isWebhookDeleteChangeType(changeType: string | undefined): boolean {
  return changeType?.trim().toLowerCase() === "deleted";
}

function isScheduledMicrosoftSweepMessage(resourceId: string): boolean {
  return resourceId.startsWith("scheduled-ms:");
}

function getMicrosoftWebhookDeleteEventIds(
  message: SyncIncrementalMessage,
): string[] {
  const candidates = new Set<string>();

  if (
    typeof message.webhook_resource_data_id === "string" &&
    message.webhook_resource_data_id.length > 0
  ) {
    candidates.add(canonicalizeProviderEventId(message.webhook_resource_data_id));
  }

  const extractedResourceId = extractMicrosoftEventId(message.resource_id);
  if (extractedResourceId) {
    candidates.add(canonicalizeProviderEventId(extractedResourceId));
  }

  return [...candidates];
}

async function microsoftEventExists(
  providerEventId: string,
  accessToken: string,
  fetchFn?: FetchFn,
): Promise<boolean> {
  const encodedEventId = encodeURIComponent(providerEventId);
  const response = await (fetchFn ?? globalThis.fetch.bind(globalThis))(
    `https://graph.microsoft.com/v1.0/me/events/${encodedEventId}?$select=id,isCancelled`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'IdType="ImmutableId"',
      },
    },
  );

  if (response.status === 404 || response.status === 410) {
    return false;
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Microsoft event probe failed (${response.status}): ${body}`,
    );
  }

  // Deletion/cancellation can still surface as a 200 response for some
  // Microsoft mailbox states. Treat cancelled/removed payloads as missing.
  try {
    const payload = (await response.json()) as {
      isCancelled?: boolean;
      "@removed"?: unknown;
    } | null;
    if (payload?.isCancelled === true || payload?.["@removed"] !== undefined) {
      return false;
    }
  } catch {
    // Best-effort parsing only; 200 with non-JSON payload is treated as exists.
  }

  return true;
}

const MS_SWEEP_RECONCILE_MISSING_RATIO_LIMIT = 0.3;
const MS_SWEEP_RECONCILE_MIN_SAMPLE_SIZE = 20;
const MS_SWEEP_RECONCILE_MAX_DELETE_CANDIDATES = HARD_MAX_DELETES_PER_OPERATION;
const MS_SWEEP_RECONCILE_MAX_RECENCY_EVAL_CANDIDATES = 200;
const MS_SWEEP_RECONCILE_MAX_PROBE_CANDIDATES = MS_SWEEP_RECONCILE_MAX_RECENCY_EVAL_CANDIDATES;
const MS_SWEEP_RECONCILE_RECENT_UPDATE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MS_SWEEP_RECONCILE_START_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const MS_SWEEP_RECONCILE_START_LOOKAHEAD_MS = 45 * 24 * 60 * 60 * 1000;

function normalizeMicrosoftMirrorScopeCalendarId(
  accountId: AccountId,
  targetCalendarId: string,
): string {
  // Legacy rows can persist placeholder target calendars equal to account_id.
  // For Microsoft mirrors those events live on the default calendar, so use
  // "primary" for bounded snapshot reconcile.
  if (targetCalendarId === accountId) {
    return "primary";
  }
  return targetCalendarId;
}

async function reconcileMissingManagedMirrorsFromMicrosoftSweep(
  accountId: AccountId,
  accessToken: string,
  env: Env,
  deps: SyncConsumerDeps,
  deleteGuard: DeleteSafetyGuard | undefined,
  retryOpts: RetryOptions,
): Promise<number> {
  const userId = await lookupUserId(accountId, env);
  if (!userId) {
    return 0;
  }

  const activeMirrors = await loadActiveMirrors(accountId, userId, env, {
    includePendingWithProviderId: true,
  });
  const snapshotsByCalendar = new Map<string, Set<string>>();
  const mirrorScopes = new Map<string, ActiveMirrorRow[]>();

  for (const mirror of activeMirrors) {
    if (
      typeof mirror.provider_event_id !== "string" ||
      mirror.provider_event_id.length === 0 ||
      typeof mirror.target_calendar_id !== "string" ||
      mirror.target_calendar_id.length === 0
    ) {
      continue;
    }
    const normalizedCalendarId = normalizeMicrosoftMirrorScopeCalendarId(
      accountId,
      mirror.target_calendar_id,
    );
    const scopeRows = mirrorScopes.get(normalizedCalendarId) ?? [];
    scopeRows.push(mirror);
    mirrorScopes.set(normalizedCalendarId, scopeRows);
  }

  if (mirrorScopes.size === 0) {
    return 0;
  }

  const snapshotClient = createCalendarProvider("microsoft", accessToken, deps.fetchFn);
  let reconciledDeletes = 0;

  for (const [calendarId, mirrorRows] of mirrorScopes.entries()) {
    const mirrorRowsByProviderEventId = new Map<string, ActiveMirrorRow>();
    for (const mirror of mirrorRows) {
      if (
        typeof mirror.provider_event_id !== "string" ||
        mirror.provider_event_id.length === 0
      ) {
        continue;
      }
      const existing = mirrorRowsByProviderEventId.get(mirror.provider_event_id);
      if (!existing) {
        mirrorRowsByProviderEventId.set(mirror.provider_event_id, mirror);
        continue;
      }

      const existingWriteMs =
        typeof existing.last_write_ts === "string"
          ? Date.parse(existing.last_write_ts)
          : Number.NaN;
      const incomingWriteMs =
        typeof mirror.last_write_ts === "string"
          ? Date.parse(mirror.last_write_ts)
          : Number.NaN;
      if (Number.isFinite(incomingWriteMs) && incomingWriteMs > existingWriteMs) {
        mirrorRowsByProviderEventId.set(mirror.provider_event_id, mirror);
      }
    }

    const scopedMirrorRows = [...mirrorRowsByProviderEventId.values()];
    const mirrorEventIds = scopedMirrorRows
      .map((mirror) => mirror.provider_event_id)
      .filter((providerEventId): providerEventId is string =>
        typeof providerEventId === "string" && providerEventId.length > 0
      );
    if (mirrorEventIds.length === 0) continue;

    let snapshotIds = snapshotsByCalendar.get(calendarId);
    if (!snapshotIds) {
      try {
        snapshotIds = await fetchMicrosoftCalendarSnapshotEventIds(
          snapshotClient,
          calendarId,
          retryOpts,
        );
        snapshotsByCalendar.set(calendarId, snapshotIds);
      } catch (snapshotErr) {
        if (
          snapshotErr instanceof MicrosoftApiError &&
          snapshotErr.statusCode === 404
        ) {
          console.warn(
            "sync-consumer: scheduled microsoft mirror reconcile skipping unavailable calendar scope",
            {
              account_id: accountId,
              calendar_id: calendarId,
            },
          );
          continue;
        }
        throw snapshotErr;
      }
    }

    const missingMirrorRows = scopedMirrorRows.filter((mirror) => {
      if (
        typeof mirror.provider_event_id !== "string" ||
        mirror.provider_event_id.length === 0
      ) {
        return false;
      }
      return !providerEventIdVariants(mirror.provider_event_id).some((candidateId) =>
        snapshotIds?.has(candidateId),
      );
    });

    if (missingMirrorRows.length === 0) {
      continue;
    }

    // Guardrail: if a large fraction of mirrors in this calendar appears
    // missing, skip reconciliation to avoid destructive behavior on partial
    // provider snapshots.
    const missingRatio = missingMirrorRows.length / mirrorEventIds.length;
    if (
      mirrorEventIds.length >= MS_SWEEP_RECONCILE_MIN_SAMPLE_SIZE &&
      missingRatio > MS_SWEEP_RECONCILE_MISSING_RATIO_LIMIT
    ) {
      console.warn(
        "sync-consumer: scheduled microsoft mirror reconcile skipped due high missing ratio",
        {
          account_id: accountId,
          calendar_id: calendarId,
          missing: missingMirrorRows.length,
          total: mirrorEventIds.length,
          missing_ratio: missingRatio,
        },
      );
      continue;
    }

    const recentMissingMirrorIds = await filterRecentMissingMirrorDeleteCandidates(
      accountId,
      userId,
      missingMirrorRows,
      env,
    );
    if (recentMissingMirrorIds.length === 0) {
      continue;
    }

    // Safety: snapshot "missing" candidates are advisory only.
    // Confirm via direct provider GET before deleting.
    const probeCandidateIds = recentMissingMirrorIds.slice(
      0,
      MS_SWEEP_RECONCILE_MAX_PROBE_CANDIDATES,
    );
    const confirmedMissingMirrorIds: string[] = [];
    for (const providerEventId of probeCandidateIds) {
      try {
        const exists = await microsoftEventExists(providerEventId, accessToken, deps.fetchFn);
        if (exists) {
          continue;
        }
        confirmedMissingMirrorIds.push(providerEventId);
        if (confirmedMissingMirrorIds.length >= MS_SWEEP_RECONCILE_MAX_DELETE_CANDIDATES) {
          break;
        }
      } catch (probeErr) {
        console.warn(
          "sync-consumer: scheduled microsoft mirror reconcile probe failed; skipping candidate",
          {
            account_id: accountId,
            calendar_id: calendarId,
            provider_event_id: providerEventId,
            error: probeErr instanceof Error ? probeErr.message : String(probeErr),
          },
        );
      }
    }
    if (confirmedMissingMirrorIds.length === 0) {
      console.log(
        "sync-consumer: scheduled microsoft mirror reconcile found no confirmed missing events after provider probe",
        {
          account_id: accountId,
          calendar_id: calendarId,
          recent_missing_candidates: recentMissingMirrorIds.length,
          probe_candidates: probeCandidateIds.length,
        },
      );
      continue;
    }
    console.log(
      "sync-consumer: scheduled microsoft mirror reconcile confirmed missing events after provider probe",
      {
        account_id: accountId,
        calendar_id: calendarId,
        recent_missing_candidates: recentMissingMirrorIds.length,
        probe_candidates: probeCandidateIds.length,
        confirmed_missing_candidates: confirmedMissingMirrorIds.length,
      },
    );

    const confirmedMissingMirrorIdsToDelete = limitAtomicDeleteCandidates(
      confirmedMissingMirrorIds,
      "scheduled_snapshot_reconcile",
      {
        account_id: accountId,
        calendar_id: calendarId,
        max_allowed: MS_SWEEP_RECONCILE_MAX_DELETE_CANDIDATES,
      },
    );

    reconciledDeletes += await applyManagedMirrorDeletes(
      accountId,
      userId,
      confirmedMissingMirrorIdsToDelete,
      env,
      deleteGuard,
      {
        provider: "microsoft",
        stage: "incremental",
        reason: "scheduled_snapshot_reconcile",
      },
    );
  }

  return reconciledDeletes;
}

async function fetchMicrosoftCalendarSnapshotEventIds(
  client: ReturnType<typeof createCalendarProvider>,
  calendarId: string,
  retryOpts: RetryOptions,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let pageToken: string | undefined;

  do {
    const response = await retryWithBackoff(
      () => client.listEvents(calendarId, undefined, pageToken),
      retryOpts,
    );
    for (const event of response.events) {
      const raw = ((event as Record<string, unknown>)._msRaw ?? event) as Record<
        string,
        unknown
      >;
      const eventId =
        typeof raw.id === "string" && raw.id.length > 0
          ? raw.id
          : typeof (event as Record<string, unknown>).id === "string"
            ? (event as Record<string, string>).id
            : "";
      if (!eventId) continue;
      for (const variant of providerEventIdVariants(eventId)) {
        ids.add(variant);
      }
    }
    pageToken = response.nextPageToken;
  } while (pageToken);

  return ids;
}

async function filterRecentMissingMirrorDeleteCandidates(
  accountId: AccountId,
  userId: string,
  mirrors: ActiveMirrorRow[],
  env: Env,
): Promise<string[]> {
  if (mirrors.length === 0) return [];

  const userGraphId = env.USER_GRAPH.idFromName(userId);
  const userGraphStub = env.USER_GRAPH.get(userGraphId);
  const dedupedMirrors = new Map<string, ActiveMirrorRow>();
  for (const mirror of mirrors) {
    if (
      typeof mirror.provider_event_id !== "string" ||
      mirror.provider_event_id.length === 0
    ) {
      continue;
    }
    const existing = dedupedMirrors.get(mirror.provider_event_id);
    if (!existing) {
      dedupedMirrors.set(mirror.provider_event_id, mirror);
      continue;
    }
    const existingWriteMs =
      typeof existing.last_write_ts === "string"
        ? Date.parse(existing.last_write_ts)
        : Number.NaN;
    const incomingWriteMs =
      typeof mirror.last_write_ts === "string"
        ? Date.parse(mirror.last_write_ts)
        : Number.NaN;
    if (Number.isFinite(incomingWriteMs) && incomingWriteMs > existingWriteMs) {
      dedupedMirrors.set(mirror.provider_event_id, mirror);
    }
  }

  const sortedMirrors = [...dedupedMirrors.values()].sort((a, b) => {
    const aWriteMs =
      typeof a.last_write_ts === "string" ? Date.parse(a.last_write_ts) : Number.NaN;
    const bWriteMs =
      typeof b.last_write_ts === "string" ? Date.parse(b.last_write_ts) : Number.NaN;
    const aSafe = Number.isFinite(aWriteMs) ? aWriteMs : 0;
    const bSafe = Number.isFinite(bWriteMs) ? bWriteMs : 0;
    return bSafe - aSafe;
  });

  const mirrorsToEvaluate = sortedMirrors.slice(
    0,
    MS_SWEEP_RECONCILE_MAX_RECENCY_EVAL_CANDIDATES,
  );
  const candidates: Array<{
    providerEventId: string;
    mirrorWriteMs: number;
    canonicalUpdatedMs: number;
    startMs: number;
  }> = [];
  const now = Date.now();

  for (const mirror of mirrorsToEvaluate) {
    if (
      typeof mirror.provider_event_id !== "string" ||
      mirror.provider_event_id.length === 0
    ) {
      continue;
    }
    const providerEventId = mirror.provider_event_id;
    try {
      let canonicalEventId =
        typeof mirror.canonical_event_id === "string" &&
          mirror.canonical_event_id.length > 0
          ? mirror.canonical_event_id
          : null;
      if (!canonicalEventId) {
        canonicalEventId = await findCanonicalIdByMirror(
          userGraphStub,
          accountId,
          providerEventId,
        );
      }
      if (!canonicalEventId) {
        continue;
      }

      const canonicalResponse = await userGraphStub.fetch(
        new Request("https://user-graph.internal/getCanonicalEvent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ canonical_event_id: canonicalEventId }),
        }),
      );
      if (!canonicalResponse.ok) {
        continue;
      }

      const canonicalPayload = (await canonicalResponse.json()) as {
        event?: Record<string, unknown>;
      } | null;
      const canonicalEvent = canonicalPayload?.event;
      if (!canonicalEvent) {
        continue;
      }

      const startTs = extractStartTimestamp(
        canonicalEvent.start as
          | { dateTime?: string; date?: string }
          | string
          | null
          | undefined,
      );

      // Safety: never reconcile-delete historical tails from scheduled snapshots.
      if (!isPruneWindowEvent(startTs)) {
        continue;
      }

      const startMs = startTs ? Date.parse(startTs) : Number.NaN;
      const updatedAtRaw = canonicalEvent.updated_at;
      const updatedMs =
        typeof updatedAtRaw === "string" ? Date.parse(updatedAtRaw) : Number.NaN;
      const mirrorWriteMs =
        typeof mirror.last_write_ts === "string"
          ? Date.parse(mirror.last_write_ts)
          : Number.NaN;
      const updatedIsRecent =
        Number.isFinite(updatedMs) &&
        now - updatedMs <= MS_SWEEP_RECONCILE_RECENT_UPDATE_WINDOW_MS;
      const mirrorWriteIsRecent =
        Number.isFinite(mirrorWriteMs) &&
        now - mirrorWriteMs <= MS_SWEEP_RECONCILE_RECENT_UPDATE_WINDOW_MS;
      const startIsNearNow =
        Number.isFinite(startMs) &&
        startMs >= now - MS_SWEEP_RECONCILE_START_LOOKBACK_MS &&
        startMs <= now + MS_SWEEP_RECONCILE_START_LOOKAHEAD_MS;

      // Scheduled fallback should only reconcile events we touched recently
      // or that occur near now. This avoids broad historical sweeps.
      if (!updatedIsRecent && !startIsNearNow && !mirrorWriteIsRecent) {
        continue;
      }

      candidates.push({
        providerEventId,
        mirrorWriteMs,
        canonicalUpdatedMs: updatedMs,
        startMs,
      });
    } catch (candidateErr) {
      console.warn(
        "sync-consumer: scheduled microsoft mirror candidate evaluation failed; skipping candidate",
        {
          account_id: accountId,
          provider_event_id: providerEventId,
          error: candidateErr instanceof Error ? candidateErr.message : String(candidateErr),
        },
      );
    }
  }

  const finiteDesc = (left: number, right: number): number => {
    const leftSafe = Number.isFinite(left) ? left : Number.NEGATIVE_INFINITY;
    const rightSafe = Number.isFinite(right) ? right : Number.NEGATIVE_INFINITY;
    return rightSafe - leftSafe;
  };

  // Prioritize likely user-intent deletes first:
  // 1) Most recent mirror writes (strongest signal of fresh projection activity)
  // 2) Most recent canonical updates
  // 3) Start time closest to now (tie-breaker only; far-future start should not outrank fresh writes)
  // 4) Latest start time as final deterministic tie-breaker
  candidates.sort((a, b) => {
    const byMirrorWrite = finiteDesc(a.mirrorWriteMs, b.mirrorWriteMs);
    if (byMirrorWrite !== 0) return byMirrorWrite;

    const byCanonicalUpdated = finiteDesc(a.canonicalUpdatedMs, b.canonicalUpdatedMs);
    if (byCanonicalUpdated !== 0) return byCanonicalUpdated;

    const aStartDistanceMs = Number.isFinite(a.startMs)
      ? Math.abs(a.startMs - now)
      : Number.POSITIVE_INFINITY;
    const bStartDistanceMs = Number.isFinite(b.startMs)
      ? Math.abs(b.startMs - now)
      : Number.POSITIVE_INFINITY;
    if (aStartDistanceMs !== bStartDistanceMs) {
      return aStartDistanceMs - bStartDistanceMs;
    }

    return finiteDesc(a.startMs, b.startMs);
  });
  return candidates.map((candidate) => candidate.providerEventId);
}

/**
 * Extract the event ID from a Microsoft Graph resource path.
 *
 * Handles Graph resource variants including:
 * - "me/events/{id}"
 * - "users/{uid}/events/{id}"
 * - "users/{uid}/events('{id}')"
 *
 * Path matching is case-insensitive and tolerates query strings.
 * Returns null if the resource path does not contain an event ID.
 */
export function extractMicrosoftEventId(resource: string): string | null {
  const trimmed = resource.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const withoutQuery = trimmed.split(/[?#]/, 1)[0]?.replace(/\/+$/, "") ?? "";
  if (withoutQuery.length === 0) {
    return null;
  }

  const parenMatch = withoutQuery.match(/(?:^|\/)events\('(.+)'\)$/i);
  if (parenMatch?.[1]) {
    return parenMatch[1];
  }

  const slashMatch = withoutQuery.match(/(?:^|\/)events\/(.+)$/i);
  if (slashMatch?.[1]) {
    return slashMatch[1];
  }

  return null;
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
  const originEventIdsToDelete = limitAtomicDeleteCandidates(
    originEventIds,
    "apply_deleted_origin_deltas",
    {
      account_id: accountId,
    },
  );

  const userGraphId = env.USER_GRAPH.idFromName(userId);
  const userGraphStub = env.USER_GRAPH.get(userGraphId);
  const deltas: ProviderDelta[] = originEventIdsToDelete.map((originEventId) => ({
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

  return originEventIdsToDelete.length;
}

interface ApplyProviderDeltasResult {
  created: number;
  updated: number;
  deleted: number;
  mirrors_enqueued: number;
  errors: Array<{ origin_event_id: string; error: string }>;
}

async function applyProviderDeltas(
  accountId: AccountId,
  userId: string,
  deltas: ProviderDelta[],
  env: Env,
): Promise<ApplyProviderDeltasResult> {
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

  let parsed: Partial<ApplyProviderDeltasResult> = {};
  try {
    parsed = (await response.json()) as Partial<ApplyProviderDeltasResult>;
  } catch {
    // Keep defaults when UserGraphDO returns an empty/non-JSON body.
  }

  return {
    created: Number(parsed.created) || 0,
    updated: Number(parsed.updated) || 0,
    deleted: Number(parsed.deleted) || 0,
    mirrors_enqueued: Number(parsed.mirrors_enqueued) || 0,
    errors: Array.isArray(parsed.errors)
      ? parsed.errors.filter((row): row is { origin_event_id: string; error: string } =>
        !!row &&
        typeof row === "object" &&
        typeof (row as { origin_event_id?: unknown }).origin_event_id === "string" &&
        typeof (row as { error?: unknown }).error === "string"
      )
      : [],
  };
}

async function applyManagedMirrorDeletes(
  accountId: AccountId,
  userId: string,
  providerEventIds: string[],
  env: Env,
  deleteGuard?: DeleteSafetyGuard,
  metadata: DeleteGuardMetadata = {},
): Promise<number> {
  if (providerEventIds.length === 0) return 0;

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

  const canonicalIdsToDelete = limitAtomicDeleteCandidates(
    [...canonicalIds],
    "delete_managed_mirror_canonicals",
    {
      account_id: accountId,
      provider: metadata.provider,
      stage: metadata.stage,
      reason: metadata.reason,
    },
  );

  if (
    canonicalIdsToDelete.length > 0 &&
    deleteGuard &&
    !deleteGuard.reserve(
      "delete_managed_mirror_canonicals",
      canonicalIdsToDelete.length,
      metadata,
    )
  ) {
    return 0;
  }

  let deletedCount = 0;
  for (const canonicalEventId of canonicalIdsToDelete) {
    const deleted = await deleteCanonicalById(userGraphStub, canonicalEventId, source);
    console.info("sync-consumer: canonical delete result", {
      canonical_event_id: canonicalEventId,
      source,
      deleted,
    });
    if (deleted) {
      deletedCount += 1;
    }
    if (!deleted) {
      console.warn(
        `sync-consumer: managed mirror delete resolved canonical but delete returned false (canonical_event_id=${canonicalEventId})`,
      );
    }
  }

  return deletedCount;
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
      event?: Record<string, unknown>;
    } | null;

    const canonicalEvent = canonicalResult?.event;
    if (
      !canonicalEvent ||
      typeof canonicalEvent.origin_account_id !== "string" ||
      canonicalEvent.origin_account_id.length === 0 ||
      typeof canonicalEvent.origin_event_id !== "string" ||
      canonicalEvent.origin_event_id.length === 0
    ) {
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

    if (
      isNoOpMirrorWriteback(
        canonicalEvent,
        originDelta.event as Record<string, unknown>,
      )
    ) {
      console.info(
        `sync-consumer: mirror writeback skipped, no-op change (account=${accountId}, provider_event_id=${providerEventId}, canonical_event_id=${canonicalEventId})`,
      );
      continue;
    }

    // Step 4: Construct writeback delta using canonical's origin keys
    // so the DO's handleUpdated can look up the right canonical event.
    const writebackDelta: ProviderDelta = {
      type: "updated",
      origin_event_id: canonicalEvent.origin_event_id,
      origin_account_id: canonicalEvent.origin_account_id as AccountId,
      ...(typeof canonicalEvent.origin_calendar_id === "string" &&
      canonicalEvent.origin_calendar_id.length > 0
        ? { origin_calendar_id: canonicalEvent.origin_calendar_id }
        : {}),
      event: originDelta.event,
    };

    writebackDeltas.push(writebackDelta);

    // AC4: Audit log for mirror writeback traceability
    console.info(
      `sync-consumer: mirror_writeback (account=${accountId}, provider_event_id=${providerEventId}, canonical_event_id=${canonicalEventId}, origin_account_id=${canonicalEvent.origin_account_id})`,
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

function isNoOpMirrorWriteback(
  canonicalEvent: Record<string, unknown>,
  updatedEvent: Record<string, unknown>,
): boolean {
  const comparableScalarFields = [
    "title",
    "description",
    "location",
    "all_day",
    "status",
    "visibility",
    "transparency",
    "recurrence_rule",
  ] as const;

  let comparedField = false;

  for (const field of comparableScalarFields) {
    if (field in canonicalEvent || field in updatedEvent) {
      comparedField = true;
      if ((canonicalEvent[field] ?? null) !== (updatedEvent[field] ?? null)) {
        return false;
      }
    }
  }

  if ("start" in canonicalEvent || "start" in updatedEvent) {
    comparedField = true;
    if (
      !isDateTimeEnvelopeEqual(
        canonicalEvent.start,
        updatedEvent.start,
      )
    ) {
      return false;
    }
  }

  if ("end" in canonicalEvent || "end" in updatedEvent) {
    comparedField = true;
    if (
      !isDateTimeEnvelopeEqual(
        canonicalEvent.end,
        updatedEvent.end,
      )
    ) {
      return false;
    }
  }

  return comparedField;
}

function isDateTimeEnvelopeEqual(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown): Record<string, string | null> => {
    if (typeof value !== "object" || value === null) {
      return {
        date: null,
        dateTime: null,
        timeZone: null,
      };
    }
    const record = value as Record<string, unknown>;
    return {
      date: typeof record.date === "string" ? record.date : null,
      dateTime: typeof record.dateTime === "string" ? record.dateTime : null,
      timeZone: typeof record.timeZone === "string" ? record.timeZone : null,
    };
  };

  const a = normalize(left);
  const b = normalize(right);
  return (
    a.date === b.date &&
    a.dateTime === b.dateTime &&
    a.timeZone === b.timeZone
  );
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
