/**
 * ReconcileWorkflow -- daily drift detection and repair per AD-6.
 *
 * Runs daily via reconcile-queue (03:00 UTC cron) or manual API trigger.
 * Detects and repairs drift between canonical state and provider (Google Calendar).
 *
 * Steps (from ARCHITECTURE.md Section 7.4, Flow D):
 * 1. Full sync (no syncToken): fetch ALL events from Google, classify each
 * 2. Cross-check:
 *    a) Origin events in provider -> verify canonical_events has matching row
 *    b) Managed mirrors in provider -> verify event_mirrors, compare hash
 *    c) ACTIVE mirrors in event_mirrors -> verify provider still has the event
 * 3. Fix discrepancies: create missing canonicals, enqueue mirror ops, tombstone stale
 * 4. Log all discrepancies to event_journal, update AccountDO timestamps
 *
 * Injectable-dependency pattern for testability: Google API via FetchFn,
 * DOs via fetch stubs, queue via QueueLike.
 */

import {
  GoogleCalendarClient,
  classifyEvent,
  normalizeGoogleEvent,
  compileProjection,
  computeProjectionHash,
  computeIdempotencyKey,
} from "@tminus/shared";
import type {
  GoogleCalendarEvent,
  ProviderDelta,
  AccountId,
  FetchFn,
  DetailLevel,
  CalendarKind,
  ReconcileReasonCode,
} from "@tminus/shared";

// ---------------------------------------------------------------------------
// Env bindings (matches wrangler.toml)
// ---------------------------------------------------------------------------

export interface ReconcileEnv {
  USER_GRAPH: DurableObjectNamespace;
  ACCOUNT: DurableObjectNamespace;
  DB: D1Database;
  WRITE_QUEUE: Queue;
}

// ---------------------------------------------------------------------------
// Workflow parameters
// ---------------------------------------------------------------------------

/** Input parameters for the reconcile workflow. */
export interface ReconcileParams {
  readonly account_id: AccountId;
  readonly reason: ReconcileReasonCode;
  /**
   * Optional: restrict reconciliation to a single calendar scope.
   * When null/undefined, reconcile iterates all scoped calendars
   * registered with the account's AccountDO.
   */
  readonly scope?: string | null;
}

// ---------------------------------------------------------------------------
// Injectable dependencies (for testability)
// ---------------------------------------------------------------------------

export interface ReconcileDeps {
  /** Fetch function for GoogleCalendarClient (injectable for mocking Google API). */
  fetchFn?: FetchFn;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Discrepancy detected during reconciliation. */
export interface Discrepancy {
  readonly type:
    | "missing_canonical"
    | "missing_mirror"
    | "orphaned_mirror"
    | "hash_mismatch"
    | "stale_mirror";
  readonly origin_event_id?: string;
  readonly canonical_event_id?: string;
  readonly target_account_id?: string;
  readonly details?: string;
}

/** Result of the reconciliation workflow. */
export interface ReconcileResult {
  readonly totalProviderEvents: number;
  readonly originEvents: number;
  readonly managedMirrors: number;
  readonly discrepancies: readonly Discrepancy[];
  readonly missingCanonicalsCreated: number;
  readonly missingMirrorsEnqueued: number;
  readonly orphanedMirrorsEnqueued: number;
  readonly hashMismatchesCorrected: number;
  readonly staleMirrorsTombstoned: number;
  readonly syncToken: string | null;
}

// ---------------------------------------------------------------------------
// Internal types for provider event classification
// ---------------------------------------------------------------------------

interface ClassifiedOriginEvent {
  readonly classification: "origin" | "foreign_managed";
  readonly event: GoogleCalendarEvent;
}

interface ClassifiedManagedMirror {
  readonly classification: "managed_mirror";
  readonly event: GoogleCalendarEvent;
  readonly canonical_event_id: string;
  readonly origin_account_id: string;
}

// ---------------------------------------------------------------------------
// Types from UserGraphDO responses
// ---------------------------------------------------------------------------

interface CanonicalEventRow {
  canonical_event_id: string;
  origin_account_id: string;
  origin_event_id: string;
  title?: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  all_day: boolean;
  status: string;
  visibility: string;
  transparency: string;
  recurrence_rule?: string;
  source: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface EventMirrorRow {
  canonical_event_id: string;
  target_account_id: string;
  target_calendar_id: string;
  provider_event_id: string | null;
  last_projected_hash: string | null;
  last_write_ts: string | null;
  state: string;
  error_message: string | null;
}

interface PolicyEdgeRow {
  policy_id: string;
  from_account_id: string;
  to_account_id: string;
  detail_level: string;
  calendar_kind: string;
}

// ---------------------------------------------------------------------------
// ReconcileWorkflow class
// ---------------------------------------------------------------------------

export class ReconcileWorkflow {
  private readonly env: ReconcileEnv;
  private readonly deps: ReconcileDeps;

  constructor(env: ReconcileEnv, deps: ReconcileDeps = {}) {
    this.env = env;
    this.deps = deps;
  }

  /**
   * Run the reconciliation flow for a single account.
   *
   * Steps execute sequentially. If any step fails, the error propagates
   * and the cron runtime can retry.
   */
  async run(params: ReconcileParams): Promise<ReconcileResult> {
    const { account_id } = params;
    const targetScope = params.scope ?? null;

    // Look up user_id for this account
    const userId = await this.lookupUserId(account_id);
    if (!userId) {
      throw new Error(
        `reconcile: no user_id found for account ${account_id}`,
      );
    }

    // Step 1: Get access token and fetch ALL events from Google (no syncToken)
    const accessToken = await this.getAccessToken(account_id);
    const client = new GoogleCalendarClient(accessToken, this.deps.fetchFn);

    // Determine which calendar scopes to reconcile.
    const calendarIds = targetScope
      ? [targetScope]
      : await this.listReconcileCalendarIds(account_id);

    // Iterate all scopes, merging results with cross-scope deduplication.
    const originEvents: ClassifiedOriginEvent[] = [];
    const managedMirrors: ClassifiedManagedMirror[] = [];
    let totalEvents = 0;
    let syncToken: string | null = null;
    const seenOriginEventIds = new Set<string>();

    for (const calendarId of calendarIds) {
      const scopeResult = await this.fetchAndClassifyAllEvents(
        client,
        account_id,
        calendarId,
      );

      totalEvents += scopeResult.totalEvents;

      // Deduplicate origin events by event ID across scopes.
      for (const origin of scopeResult.originEvents) {
        const eventId = origin.event.id ?? "";
        if (eventId && seenOriginEventIds.has(eventId)) {
          continue;
        }
        if (eventId) {
          seenOriginEventIds.add(eventId);
        }
        originEvents.push(origin);
      }

      // Managed mirrors are scope-specific; no dedup needed.
      managedMirrors.push(...scopeResult.managedMirrors);

      // Keep the last non-null syncToken.
      if (scopeResult.syncToken) {
        syncToken = scopeResult.syncToken;
      }
    }

    const discrepancies: Discrepancy[] = [];
    let missingCanonicalsCreated = 0;
    let missingMirrorsEnqueued = 0;
    let orphanedMirrorsEnqueued = 0;
    let hashMismatchesCorrected = 0;
    let staleMirrorsTombstoned = 0;

    // Step 2a: Cross-check origin events against canonical store
    for (const { event } of originEvents) {
      const originEventId = event.id ?? "";

      // Check if canonical event exists
      const canonical = await this.findCanonicalByOrigin(
        account_id,
        originEventId,
        userId,
      );

      if (canonical === null) {
        // Missing canonical -- create it via applyProviderDelta
        const delta = normalizeGoogleEvent(event, account_id, "origin");
        await this.applyDeltas(account_id, userId, [delta]);

        discrepancies.push({
          type: "missing_canonical",
          origin_event_id: originEventId,
          details: "Origin event in provider but no canonical event found",
        });
        missingCanonicalsCreated++;

        // Log to journal
        await this.logDiscrepancy(
          userId,
          `reconcile:${originEventId}`,
          "missing_canonical",
          { origin_event_id: originEventId, account_id },
        );
      } else {
        // Canonical exists -- check if mirrors exist per policy_edges
        const missingMirrorCount = await this.checkMirrorsForCanonical(
          canonical.canonical_event_id,
          account_id,
          userId,
          discrepancies,
        );
        missingMirrorsEnqueued += missingMirrorCount;
      }
    }

    // Step 2b: Cross-check managed mirrors in provider against event_mirrors
    for (const mirror of managedMirrors) {
      const canonicalEventId = mirror.canonical_event_id;
      const mirrorRow = await this.getMirror(
        canonicalEventId,
        account_id,
        userId,
      );

      if (mirrorRow === null) {
        // Orphaned mirror in provider (no matching event_mirrors row)
        // Enqueue DELETE_MIRROR to clean it up
        const providerEventId = mirror.event.id ?? "";
        await this.enqueueDeleteMirror(
          canonicalEventId,
          account_id,
          providerEventId,
        );

        discrepancies.push({
          type: "orphaned_mirror",
          canonical_event_id: canonicalEventId,
          target_account_id: account_id,
          details: `Managed mirror in provider but no event_mirrors row. Provider event: ${providerEventId}`,
        });
        orphanedMirrorsEnqueued++;

        await this.logDiscrepancy(
          userId,
          canonicalEventId,
          "orphaned_mirror",
          {
            provider_event_id: providerEventId,
            target_account_id: account_id,
          },
        );
      } else {
        // Mirror row exists -- verify projected_hash matches
        const hashMatch = await this.verifyMirrorHash(
          canonicalEventId,
          account_id,
          userId,
          mirrorRow,
        );

        if (!hashMatch) {
          discrepancies.push({
            type: "hash_mismatch",
            canonical_event_id: canonicalEventId,
            target_account_id: account_id,
            details: "Projected hash mismatch between canonical and mirror",
          });
          hashMismatchesCorrected++;

          await this.logDiscrepancy(
            userId,
            canonicalEventId,
            "hash_mismatch",
            {
              target_account_id: account_id,
              old_hash: mirrorRow.last_projected_hash,
            },
          );
        }
      }
    }

    // Step 2c: Check ACTIVE mirrors in event_mirrors that should exist in provider
    // Build a set of provider event IDs for managed mirrors seen in provider
    const providerMirrorEventIds = new Set(
      managedMirrors
        .map((m) => m.event.id)
        .filter((id): id is string => id !== undefined),
    );

    const activeMirrors = await this.getActiveMirrorsForAccount(
      account_id,
      userId,
    );

    for (const activeMirror of activeMirrors) {
      if (
        activeMirror.provider_event_id &&
        !providerMirrorEventIds.has(activeMirror.provider_event_id)
      ) {
        // Mirror is ACTIVE in our state but provider no longer has the event
        // Tombstone it
        await this.tombstoneMirror(
          activeMirror.canonical_event_id,
          account_id,
          userId,
        );

        discrepancies.push({
          type: "stale_mirror",
          canonical_event_id: activeMirror.canonical_event_id,
          target_account_id: account_id,
          details: `ACTIVE mirror but provider event ${activeMirror.provider_event_id} not found`,
        });
        staleMirrorsTombstoned++;

        await this.logDiscrepancy(
          userId,
          activeMirror.canonical_event_id,
          "stale_mirror",
          {
            provider_event_id: activeMirror.provider_event_id,
            target_account_id: account_id,
          },
        );
      }
    }

    // Step 4: Update AccountDO timestamps and store new syncToken
    if (syncToken) {
      await this.setSyncToken(account_id, syncToken);
    }
    await this.markSyncSuccess(account_id);

    return {
      totalProviderEvents: totalEvents,
      originEvents: originEvents.length,
      managedMirrors: managedMirrors.length,
      discrepancies,
      missingCanonicalsCreated,
      missingMirrorsEnqueued,
      orphanedMirrorsEnqueued,
      hashMismatchesCorrected,
      staleMirrorsTombstoned,
      syncToken,
    };
  }

  // -------------------------------------------------------------------------
  // Step 1: Fetch and classify all events
  // -------------------------------------------------------------------------

  /**
   * Fetch all events from Google (paginated, no syncToken) and classify each.
   * Returns separate arrays for origin events and managed mirrors.
   */
  private async fetchAndClassifyAllEvents(
    client: GoogleCalendarClient,
    accountId: AccountId,
    calendarId: string = "primary",
  ): Promise<{
    originEvents: ClassifiedOriginEvent[];
    managedMirrors: ClassifiedManagedMirror[];
    totalEvents: number;
    syncToken: string | null;
  }> {
    const originEvents: ClassifiedOriginEvent[] = [];
    const managedMirrors: ClassifiedManagedMirror[] = [];
    let totalEvents = 0;
    let syncToken: string | null = null;
    let pageToken: string | undefined;

    do {
      const response = await client.listEvents(
        calendarId,
        undefined, // no syncToken -- full listing
        pageToken,
      );

      totalEvents += response.events.length;

      for (const event of response.events) {
        const classification = classifyEvent(event);

        if (classification === "managed_mirror") {
          // Extract canonical_event_id and origin_account_id from extended props
          const extProps = event.extendedProperties?.private;
          const canonicalEventId =
            extProps?.canonical_event_id ?? "";
          const originAccountId =
            extProps?.origin_account_id ?? "";

          managedMirrors.push({
            classification,
            event,
            canonical_event_id: canonicalEventId,
            origin_account_id: originAccountId,
          });
        } else {
          originEvents.push({ classification, event });
        }
      }

      pageToken = response.nextPageToken;
      if (response.nextSyncToken) {
        syncToken = response.nextSyncToken;
      }
    } while (pageToken);

    return { originEvents, managedMirrors, totalEvents, syncToken };
  }

  // -------------------------------------------------------------------------
  // Step 2a helpers: Cross-check origin events
  // -------------------------------------------------------------------------

  /**
   * Find a canonical event by its origin keys (account_id + origin_event_id).
   * Returns the canonical event data or null if not found.
   */
  private async findCanonicalByOrigin(
    accountId: AccountId,
    originEventId: string,
    userId: string,
  ): Promise<CanonicalEventRow | null> {
    const userGraphStub = this.getUserGraphStub(userId);

    const response = await userGraphStub.fetch(
      new Request("https://user-graph.internal/findCanonicalByOrigin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin_account_id: accountId,
          origin_event_id: originEventId,
        }),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `UserGraphDO.findCanonicalByOrigin failed (${response.status}): ${body}`,
      );
    }

    const data = (await response.json()) as {
      event: CanonicalEventRow | null;
    };
    return data.event;
  }

  /**
   * Check if all required mirrors exist for a canonical event.
   * Returns the number of missing mirrors that were enqueued.
   */
  private async checkMirrorsForCanonical(
    canonicalEventId: string,
    originAccountId: string,
    userId: string,
    discrepancies: Discrepancy[],
  ): Promise<number> {
    const userGraphStub = this.getUserGraphStub(userId);

    // Get policy edges for this origin account
    const edgesResp = await userGraphStub.fetch(
      new Request("https://user-graph.internal/getPolicyEdges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_account_id: originAccountId }),
      }),
    );

    if (!edgesResp.ok) {
      const body = await edgesResp.text();
      throw new Error(
        `UserGraphDO.getPolicyEdges failed (${edgesResp.status}): ${body}`,
      );
    }

    const { edges } = (await edgesResp.json()) as {
      edges: PolicyEdgeRow[];
    };

    let enqueued = 0;

    for (const edge of edges) {
      // Check if mirror exists
      const mirror = await this.getMirror(
        canonicalEventId,
        edge.to_account_id,
        userId,
      );

      if (mirror === null) {
        // Missing mirror -- trigger recompute for this event
        // which will create the mirror and enqueue UPSERT_MIRROR
        await this.recomputeProjection(userId, canonicalEventId);

        discrepancies.push({
          type: "missing_mirror",
          canonical_event_id: canonicalEventId,
          target_account_id: edge.to_account_id,
          details: `No mirror row for policy edge ${edge.policy_id}`,
        });
        enqueued++;

        await this.logDiscrepancy(
          userId,
          canonicalEventId,
          "missing_mirror",
          {
            target_account_id: edge.to_account_id,
            policy_id: edge.policy_id,
          },
        );
      }
    }

    return enqueued;
  }

  // -------------------------------------------------------------------------
  // Step 2b helpers: Cross-check managed mirrors
  // -------------------------------------------------------------------------

  /**
   * Verify that a mirror's projected hash matches what we'd compute now.
   * If mismatch, triggers recomputeProjections for the canonical event.
   * Returns true if hash matches, false if mismatch was detected and corrected.
   */
  private async verifyMirrorHash(
    canonicalEventId: string,
    targetAccountId: string,
    userId: string,
    mirrorRow: EventMirrorRow,
  ): Promise<boolean> {
    // Get the canonical event to recompute projection
    const userGraphStub = this.getUserGraphStub(userId);

    const evtResp = await userGraphStub.fetch(
      new Request("https://user-graph.internal/getCanonicalEvent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canonical_event_id: canonicalEventId }),
      }),
    );

    if (!evtResp.ok) {
      // If we can't find the canonical event, that's a problem but not a hash mismatch
      return true;
    }

    const evtData = (await evtResp.json()) as {
      event: CanonicalEventRow;
      mirrors: EventMirrorRow[];
    } | null;

    if (!evtData || !evtData.event) {
      return true;
    }

    // Get the policy edge for this mirror to compute projection
    const edgesResp = await userGraphStub.fetch(
      new Request("https://user-graph.internal/getPolicyEdges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_account_id: evtData.event.origin_account_id,
        }),
      }),
    );

    if (!edgesResp.ok) {
      return true; // Can't verify without edges
    }

    const { edges } = (await edgesResp.json()) as {
      edges: PolicyEdgeRow[];
    };

    const relevantEdge = edges.find(
      (e) => e.to_account_id === targetAccountId,
    );

    if (!relevantEdge) {
      return true; // No edge found, nothing to compare
    }

    // Recompute the projection and hash
    const projection = compileProjection(evtData.event as any, {
      detail_level: relevantEdge.detail_level as DetailLevel,
      calendar_kind: relevantEdge.calendar_kind as CalendarKind,
    });

    const expectedHash = await computeProjectionHash(
      canonicalEventId,
      relevantEdge.detail_level as DetailLevel,
      relevantEdge.calendar_kind as CalendarKind,
      projection,
    );

    if (mirrorRow.last_projected_hash === expectedHash) {
      return true;
    }

    // Hash mismatch -- trigger recompute which will enqueue UPSERT_MIRROR
    await this.recomputeProjection(userId, canonicalEventId);
    return false;
  }

  // -------------------------------------------------------------------------
  // Step 2c helpers: Check stale mirrors
  // -------------------------------------------------------------------------

  /**
   * Get all ACTIVE mirrors targeting a specific account.
   */
  private async getActiveMirrorsForAccount(
    targetAccountId: string,
    userId: string,
  ): Promise<EventMirrorRow[]> {
    const userGraphStub = this.getUserGraphStub(userId);

    const response = await userGraphStub.fetch(
      new Request("https://user-graph.internal/getActiveMirrors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_account_id: targetAccountId }),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `UserGraphDO.getActiveMirrors failed (${response.status}): ${body}`,
      );
    }

    const data = (await response.json()) as { mirrors: EventMirrorRow[] };
    return data.mirrors;
  }

  /**
   * Tombstone a mirror that no longer exists in the provider.
   */
  private async tombstoneMirror(
    canonicalEventId: string,
    targetAccountId: string,
    userId: string,
  ): Promise<void> {
    const userGraphStub = this.getUserGraphStub(userId);

    const response = await userGraphStub.fetch(
      new Request("https://user-graph.internal/updateMirrorState", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          canonical_event_id: canonicalEventId,
          target_account_id: targetAccountId,
          update: { state: "TOMBSTONED" },
        }),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `UserGraphDO.updateMirrorState failed (${response.status}): ${body}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Shared helpers: UserGraphDO interactions
  // -------------------------------------------------------------------------

  private getUserGraphStub(userId: string) {
    const userGraphId = this.env.USER_GRAPH.idFromName(userId);
    return this.env.USER_GRAPH.get(userGraphId);
  }

  /**
   * Get a mirror row by canonical_event_id + target_account_id.
   */
  private async getMirror(
    canonicalEventId: string,
    targetAccountId: string,
    userId: string,
  ): Promise<EventMirrorRow | null> {
    const userGraphStub = this.getUserGraphStub(userId);

    const response = await userGraphStub.fetch(
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
      const body = await response.text();
      throw new Error(
        `UserGraphDO.getMirror failed (${response.status}): ${body}`,
      );
    }

    const data = (await response.json()) as {
      mirror: EventMirrorRow | null;
    };
    return data.mirror;
  }

  /**
   * Apply provider deltas to canonical store via UserGraphDO.
   */
  private async applyDeltas(
    accountId: AccountId,
    userId: string,
    deltas: ProviderDelta[],
  ): Promise<void> {
    const userGraphStub = this.getUserGraphStub(userId);

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
   * Recompute projection for a specific canonical event.
   */
  private async recomputeProjection(
    userId: string,
    canonicalEventId: string,
  ): Promise<void> {
    const userGraphStub = this.getUserGraphStub(userId);

    const response = await userGraphStub.fetch(
      new Request("https://user-graph.internal/recomputeProjections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canonical_event_id: canonicalEventId }),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `UserGraphDO.recomputeProjections failed (${response.status}): ${body}`,
      );
    }
  }

  /**
   * Log a drift discrepancy to the event journal.
   */
  private async logDiscrepancy(
    userId: string,
    canonicalEventId: string,
    discrepancyType: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const userGraphStub = this.getUserGraphStub(userId);

    const response = await userGraphStub.fetch(
      new Request("https://user-graph.internal/logReconcileDiscrepancy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          canonical_event_id: canonicalEventId,
          discrepancy_type: discrepancyType,
          details,
        }),
      }),
    );

    if (!response.ok) {
      // Log failure is non-fatal -- log to console but continue
      console.error(
        `reconcile: failed to log discrepancy for ${canonicalEventId}:`,
        await response.text(),
      );
    }
  }

  /**
   * Enqueue a DELETE_MIRROR message for an orphaned mirror.
   */
  private async enqueueDeleteMirror(
    canonicalEventId: string,
    targetAccountId: string,
    providerEventId: string,
  ): Promise<void> {
    const idempotencyKey = await computeIdempotencyKey(
      canonicalEventId,
      targetAccountId,
      `delete:${providerEventId}`,
    );

    await this.env.WRITE_QUEUE.send({
      type: "DELETE_MIRROR",
      canonical_event_id: canonicalEventId,
      target_account_id: targetAccountId,
      provider_event_id: providerEventId,
      idempotency_key: idempotencyKey,
    });
  }

  // -------------------------------------------------------------------------
  // AccountDO interactions
  // -------------------------------------------------------------------------

  private async getAccessToken(accountId: AccountId): Promise<string> {
    const doId = this.env.ACCOUNT.idFromName(accountId);
    const stub = this.env.ACCOUNT.get(doId);

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

  private async setSyncToken(
    accountId: AccountId,
    token: string,
  ): Promise<void> {
    const doId = this.env.ACCOUNT.idFromName(accountId);
    const stub = this.env.ACCOUNT.get(doId);

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

  private async markSyncSuccess(accountId: AccountId): Promise<void> {
    const doId = this.env.ACCOUNT.idFromName(accountId);
    const stub = this.env.ACCOUNT.get(doId);

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

  // -------------------------------------------------------------------------
  // Calendar scope discovery
  // -------------------------------------------------------------------------

  /**
   * Resolve which calendar IDs to reconcile for a Google account.
   *
   * Calls AccountDO /listCalendarScopes to get the registered scopes.
   * Falls back to ["primary"] when the DO returns no scopes (pre-scope
   * accounts or non-Google providers).
   */
  private async listReconcileCalendarIds(
    accountId: AccountId,
  ): Promise<string[]> {
    const doId = this.env.ACCOUNT.idFromName(accountId);
    const stub = this.env.ACCOUNT.get(doId);

    try {
      const response = await stub.fetch(
        new Request("https://account.internal/listCalendarScopes", {
          method: "POST",
        }),
      );

      if (!response.ok) {
        console.warn(
          `reconcile: listCalendarScopes failed (${response.status}) for ${accountId}, falling back to primary`,
        );
        return ["primary"];
      }

      const data = (await response.json()) as {
        scopes: Array<{
          providerCalendarId: string;
          enabled: boolean;
          syncEnabled: boolean;
        }>;
      };

      const syncableIds = data.scopes
        .filter((s) => s.enabled && s.syncEnabled)
        .map((s) => s.providerCalendarId);

      return syncableIds.length > 0 ? syncableIds : ["primary"];
    } catch {
      console.warn(
        `reconcile: listCalendarScopes threw for ${accountId}, falling back to primary`,
      );
      return ["primary"];
    }
  }

  // -------------------------------------------------------------------------
  // D1 interactions
  // -------------------------------------------------------------------------

  private async lookupUserId(accountId: AccountId): Promise<string | null> {
    const result = await this.env.DB.prepare(
      "SELECT user_id FROM accounts WHERE account_id = ?1",
    )
      .bind(accountId)
      .first<{ user_id: string }>();

    return result?.user_id ?? null;
  }
}
