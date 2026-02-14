/**
 * UserGraphDO -- per-user Durable Object for the canonical event store,
 * event journal, mirror projection engine, and sync health.
 *
 * This is the primary per-user data layer (AD-1). It receives provider
 * deltas from sync-consumer, maintains the canonical event store,
 * computes projections via policy edges, and enqueues mirror writes
 * to write-queue.
 *
 * Key invariants enforced:
 * - Invariant B: canonical_event_id is a ULID, generated once, never changed
 * - Invariant C: projection hash compared before enqueuing (write-skipping)
 * - ADR-5: every mutation produces a journal entry
 * - BR-2: canonical_event_id is stable across sync cycles
 * - BR-7: hard deletes (no soft deletes) + journal entry
 */

import {
  applyMigrations,
  USER_GRAPH_DO_MIGRATIONS,
  generateId,
  compileProjection,
  computeProjectionHash,
  computeIdempotencyKey,
  BUSY_OVERLAY_CALENDAR_NAME,
} from "@tminus/shared";
import type {
  SqlStorageLike,
  CanonicalEvent,
  ProviderDelta,
  ProjectedEvent,
  PolicyEdge,
  ApplyResult,
  EventId,
  AccountId,
  DetailLevel,
  CalendarKind,
  MirrorState,
} from "@tminus/shared";

// ---------------------------------------------------------------------------
// Queue interface (minimal, matches Cloudflare Queue API surface we use)
// ---------------------------------------------------------------------------

/**
 * Minimal queue interface for enqueuing mirror write messages.
 * In production this is the Cloudflare Queue binding; in tests it is a mock.
 */
export interface QueueLike {
  send(message: unknown): Promise<void>;
  sendBatch(messages: { body: unknown }[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal DB row types
// ---------------------------------------------------------------------------

// Row types include index signatures to satisfy SqlStorageLike's
// Record<string, unknown> constraint on exec<T>.

interface CanonicalEventRow {
  [key: string]: unknown;
  canonical_event_id: string;
  origin_account_id: string;
  origin_event_id: string;
  title: string | null;
  description: string | null;
  location: string | null;
  start_ts: string;
  end_ts: string;
  timezone: string | null;
  all_day: number;
  status: string;
  visibility: string;
  transparency: string;
  recurrence_rule: string | null;
  source: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface EventMirrorRow {
  [key: string]: unknown;
  canonical_event_id: string;
  target_account_id: string;
  target_calendar_id: string;
  provider_event_id: string | null;
  last_projected_hash: string | null;
  last_write_ts: string | null;
  state: string;
  error_message: string | null;
}

interface PolicyRow {
  [key: string]: unknown;
  policy_id: string;
  name: string;
  is_default: number;
  created_at: string;
}

interface PolicyEdgeRow {
  [key: string]: unknown;
  policy_id: string;
  from_account_id: string;
  to_account_id: string;
  detail_level: string;
  calendar_kind: string;
}

interface JournalRow {
  [key: string]: unknown;
  journal_id: string;
  canonical_event_id: string;
  ts: string;
  actor: string;
  change_type: string;
  patch_json: string | null;
  reason: string | null;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Query parameters for listing canonical events. */
export interface ListEventsQuery {
  readonly time_min?: string;
  readonly time_max?: string;
  readonly origin_account_id?: string;
  readonly limit?: number;
  /** Cursor: "start_ts|canonical_event_id" */
  readonly cursor?: string;
}

/** Paginated result for event listing. */
export interface ListEventsResult {
  readonly items: CanonicalEvent[];
  readonly cursor: string | null;
  readonly has_more: boolean;
}

/** Query parameters for the journal. */
export interface JournalQuery {
  readonly canonical_event_id?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** Paginated journal result. */
export interface JournalResult {
  readonly items: JournalEntry[];
  readonly cursor: string | null;
  readonly has_more: boolean;
}

/** A journal entry as returned to callers. */
export interface JournalEntry {
  readonly journal_id: string;
  readonly canonical_event_id: string;
  readonly ts: string;
  readonly actor: string;
  readonly change_type: string;
  readonly patch_json: string | null;
  readonly reason: string | null;
}

/** Sync health summary. */
export interface SyncHealth {
  readonly total_events: number;
  readonly total_mirrors: number;
  readonly total_journal_entries: number;
  readonly pending_mirrors: number;
  readonly error_mirrors: number;
  readonly last_journal_ts: string | null;
}

/** Scope for recomputeProjections. */
export interface RecomputeScope {
  readonly canonical_event_id?: string;
}

/** Result of an account unlink cascade. */
export interface UnlinkResult {
  readonly events_deleted: number;
  readonly mirrors_deleted: number;
  readonly policy_edges_removed: number;
  readonly calendars_removed: number;
}

/** A policy as returned by createPolicy / listPolicies. */
export interface Policy {
  readonly policy_id: string;
  readonly name: string;
  readonly is_default: boolean;
  readonly created_at: string;
}

/** A policy with its edges, as returned by getPolicy. */
export interface PolicyWithEdges extends Policy {
  readonly edges: PolicyEdgeRecord[];
}

/** A stored policy edge record (full DB row shape). */
export interface PolicyEdgeRecord {
  readonly policy_id: string;
  readonly from_account_id: string;
  readonly to_account_id: string;
  readonly detail_level: string;
  readonly calendar_kind: string;
}

/** Input for creating/replacing policy edges. */
export interface PolicyEdgeInput {
  readonly from_account_id: string;
  readonly to_account_id: string;
  readonly detail_level: string;
  readonly calendar_kind: string;
}

/** Fields that can be updated on a mirror row via RPC. */
export interface MirrorStateUpdate {
  provider_event_id?: string;
  last_projected_hash?: string;
  last_write_ts?: string;
  state?: MirrorState;
  error_message?: string | null;
  target_calendar_id?: string;
}

// ---------------------------------------------------------------------------
// UserGraphDO class
// ---------------------------------------------------------------------------

/**
 * UserGraphDO manages the canonical event store for a single user.
 *
 * In production, this extends DurableObject and uses ctx.storage.sql.
 * For testing, it can be constructed with a SqlStorageLike adapter
 * and a mock queue.
 */
export class UserGraphDO {
  private readonly sql: SqlStorageLike;
  private readonly writeQueue: QueueLike;
  private migrated = false;

  constructor(sql: SqlStorageLike, writeQueue: QueueLike) {
    this.sql = sql;
    this.writeQueue = writeQueue;
  }

  // -------------------------------------------------------------------------
  // Schema initialization
  // -------------------------------------------------------------------------

  /** Ensure schema is applied. Called lazily before any DB operation. */
  private ensureMigrated(): void {
    if (this.migrated) return;
    applyMigrations(this.sql, USER_GRAPH_DO_MIGRATIONS, "user_graph");
    this.migrated = true;
  }

  // -------------------------------------------------------------------------
  // applyProviderDelta -- PRIMARY SYNC PATH
  // -------------------------------------------------------------------------

  /**
   * Apply a batch of provider deltas to the canonical event store.
   *
   * For each delta:
   * - created: generate canonical_event_id, INSERT canonical_events, journal
   * - updated: find by origin keys, UPDATE canonical_events, bump version, journal
   * - deleted: find by origin keys, DELETE (hard, per BR-7), journal
   *
   * After mutation, compute projections via policy edges and enqueue
   * mirror writes to write-queue when hash differs (Invariant C).
   */
  async applyProviderDelta(
    accountId: string,
    deltas: readonly ProviderDelta[],
  ): Promise<ApplyResult> {
    this.ensureMigrated();

    let created = 0;
    let updated = 0;
    let deleted = 0;
    let mirrorsEnqueued = 0;
    const errors: { origin_event_id: string; error: string }[] = [];

    for (const delta of deltas) {
      try {
        switch (delta.type) {
          case "created": {
            const canonicalId = await this.handleCreated(accountId, delta);
            created++;
            mirrorsEnqueued += await this.projectAndEnqueue(
              canonicalId,
              accountId,
            );
            break;
          }
          case "updated": {
            const canonicalId = await this.handleUpdated(accountId, delta);
            if (canonicalId !== null) {
              updated++;
              mirrorsEnqueued += await this.projectAndEnqueue(
                canonicalId,
                accountId,
              );
            }
            break;
          }
          case "deleted": {
            const result = await this.handleDeleted(accountId, delta);
            if (result !== null) {
              deleted++;
              mirrorsEnqueued += result.mirrorsDeleted;
            }
            break;
          }
        }
      } catch (err) {
        errors.push({
          origin_event_id: delta.origin_event_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      created,
      updated,
      deleted,
      mirrors_enqueued: mirrorsEnqueued,
      errors,
    };
  }

  // -------------------------------------------------------------------------
  // handleCreated / handleUpdated / handleDeleted
  // -------------------------------------------------------------------------

  private async handleCreated(
    accountId: string,
    delta: ProviderDelta,
  ): Promise<string> {
    if (!delta.event) {
      throw new Error("Created delta must include event payload");
    }

    const canonicalId = generateId("event");
    const evt = delta.event;

    // Extract start/end timestamps from EventDateTime
    const startTs = evt.start.dateTime ?? evt.start.date ?? "";
    const endTs = evt.end.dateTime ?? evt.end.date ?? "";

    this.sql.exec(
      `INSERT INTO canonical_events (
        canonical_event_id, origin_account_id, origin_event_id,
        title, description, location, start_ts, end_ts, timezone,
        all_day, status, visibility, transparency, recurrence_rule,
        source, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'provider', 1, datetime('now'), datetime('now'))`,
      canonicalId,
      accountId,
      delta.origin_event_id,
      evt.title ?? null,
      evt.description ?? null,
      evt.location ?? null,
      startTs,
      endTs,
      evt.start.timeZone ?? null,
      evt.all_day ? 1 : 0,
      evt.status ?? "confirmed",
      evt.visibility ?? "default",
      evt.transparency ?? "opaque",
      evt.recurrence_rule ?? null,
    );

    this.writeJournal(canonicalId, "created", `provider:${accountId}`, {
      origin_event_id: delta.origin_event_id,
    });

    return canonicalId;
  }

  private async handleUpdated(
    accountId: string,
    delta: ProviderDelta,
  ): Promise<string | null> {
    if (!delta.event) {
      throw new Error("Updated delta must include event payload");
    }

    // Find existing canonical event by origin keys
    const rows = this.sql
      .exec<{ canonical_event_id: string; version: number }>(
        `SELECT canonical_event_id, version FROM canonical_events
         WHERE origin_account_id = ? AND origin_event_id = ?`,
        accountId,
        delta.origin_event_id,
      )
      .toArray();

    if (rows.length === 0) {
      // Not found -- treat as create (could be a race or missed initial sync)
      return this.handleCreated(accountId, delta);
    }

    const canonicalId = rows[0].canonical_event_id;
    const newVersion = rows[0].version + 1;
    const evt = delta.event;

    const startTs = evt.start.dateTime ?? evt.start.date ?? "";
    const endTs = evt.end.dateTime ?? evt.end.date ?? "";

    this.sql.exec(
      `UPDATE canonical_events SET
        title = ?, description = ?, location = ?,
        start_ts = ?, end_ts = ?, timezone = ?,
        all_day = ?, status = ?, visibility = ?,
        transparency = ?, recurrence_rule = ?,
        version = ?, updated_at = datetime('now')
       WHERE canonical_event_id = ?`,
      evt.title ?? null,
      evt.description ?? null,
      evt.location ?? null,
      startTs,
      endTs,
      evt.start.timeZone ?? null,
      evt.all_day ? 1 : 0,
      evt.status ?? "confirmed",
      evt.visibility ?? "default",
      evt.transparency ?? "opaque",
      evt.recurrence_rule ?? null,
      newVersion,
      canonicalId,
    );

    this.writeJournal(canonicalId, "updated", `provider:${accountId}`, {
      origin_event_id: delta.origin_event_id,
      new_version: newVersion,
    });

    return canonicalId;
  }

  private async handleDeleted(
    accountId: string,
    delta: ProviderDelta,
  ): Promise<{ mirrorsDeleted: number } | null> {
    // Find existing canonical event by origin keys
    const rows = this.sql
      .exec<{ canonical_event_id: string }>(
        `SELECT canonical_event_id FROM canonical_events
         WHERE origin_account_id = ? AND origin_event_id = ?`,
        accountId,
        delta.origin_event_id,
      )
      .toArray();

    if (rows.length === 0) {
      return null; // Nothing to delete
    }

    const canonicalId = rows[0].canonical_event_id;

    // Enqueue DELETE_MIRROR for all existing mirrors BEFORE deleting the event
    const mirrors = this.sql
      .exec<EventMirrorRow>(
        `SELECT * FROM event_mirrors WHERE canonical_event_id = ?`,
        canonicalId,
      )
      .toArray();

    let mirrorsDeleted = 0;
    for (const mirror of mirrors) {
      await this.writeQueue.send({
        type: "DELETE_MIRROR",
        canonical_event_id: canonicalId,
        target_account_id: mirror.target_account_id,
        target_calendar_id: mirror.target_calendar_id,
        provider_event_id: mirror.provider_event_id ?? "",
      });
      mirrorsDeleted++;
    }

    // Delete mirrors first (FK constraint)
    this.sql.exec(
      `DELETE FROM event_mirrors WHERE canonical_event_id = ?`,
      canonicalId,
    );

    // Hard delete per BR-7
    this.sql.exec(
      `DELETE FROM canonical_events WHERE canonical_event_id = ?`,
      canonicalId,
    );

    // Journal entry records the deletion
    this.writeJournal(canonicalId, "deleted", `provider:${accountId}`, {
      origin_event_id: delta.origin_event_id,
    });

    return { mirrorsDeleted };
  }

  // -------------------------------------------------------------------------
  // Projection engine
  // -------------------------------------------------------------------------

  /**
   * For a given canonical event and its origin account, find all policy edges
   * where from_account_id matches, compute projections, compare hashes,
   * and enqueue UPSERT_MIRROR writes when hash differs.
   *
   * Returns the number of mirror writes enqueued.
   */
  private async projectAndEnqueue(
    canonicalEventId: string,
    originAccountId: string,
  ): Promise<number> {
    // Load the canonical event
    const eventRows = this.sql
      .exec<CanonicalEventRow>(
        `SELECT * FROM canonical_events WHERE canonical_event_id = ?`,
        canonicalEventId,
      )
      .toArray();

    if (eventRows.length === 0) return 0;
    const evtRow = eventRows[0];
    const canonicalEvent = this.rowToCanonicalEvent(evtRow);

    // Find all policy edges where this account is the source
    const edges = this.sql
      .exec<PolicyEdgeRow>(
        `SELECT * FROM policy_edges WHERE from_account_id = ?`,
        originAccountId,
      )
      .toArray();

    let enqueued = 0;

    for (const edge of edges) {
      const policyEdge: PolicyEdge = {
        detail_level: edge.detail_level as DetailLevel,
        calendar_kind: edge.calendar_kind as CalendarKind,
      };

      // Compute projection
      const projection = compileProjection(canonicalEvent, policyEdge);

      // Compute projection hash (Invariant C)
      const projectedHash = await computeProjectionHash(
        canonicalEventId,
        edge.detail_level as DetailLevel,
        edge.calendar_kind as CalendarKind,
        projection,
      );

      // Look up existing mirror
      const mirrorRows = this.sql
        .exec<EventMirrorRow>(
          `SELECT * FROM event_mirrors
           WHERE canonical_event_id = ? AND target_account_id = ?`,
          canonicalEventId,
          edge.to_account_id,
        )
        .toArray();

      if (mirrorRows.length > 0) {
        const existing = mirrorRows[0];
        // Write-skipping: if hash is identical, skip (Invariant C)
        if (existing.last_projected_hash === projectedHash) {
          continue;
        }
        // Hash differs -- update mirror record and enqueue write
        this.sql.exec(
          `UPDATE event_mirrors SET
            last_projected_hash = ?, state = 'PENDING'
           WHERE canonical_event_id = ? AND target_account_id = ?`,
          projectedHash,
          canonicalEventId,
          edge.to_account_id,
        );

        const idempotencyKey = await computeIdempotencyKey(
          canonicalEventId,
          edge.to_account_id,
          projectedHash,
        );

        await this.writeQueue.send({
          type: "UPSERT_MIRROR",
          canonical_event_id: canonicalEventId,
          target_account_id: edge.to_account_id,
          target_calendar_id: existing.target_calendar_id,
          projected_payload: projection,
          idempotency_key: idempotencyKey,
        });

        enqueued++;
      } else {
        // New mirror -- create record and enqueue
        // Use to_account_id as default target_calendar_id (will be resolved by write-consumer)
        const targetCalendarId = edge.to_account_id;

        this.sql.exec(
          `INSERT INTO event_mirrors (
            canonical_event_id, target_account_id, target_calendar_id,
            last_projected_hash, state
          ) VALUES (?, ?, ?, ?, 'PENDING')`,
          canonicalEventId,
          edge.to_account_id,
          targetCalendarId,
          projectedHash,
        );

        const idempotencyKey = await computeIdempotencyKey(
          canonicalEventId,
          edge.to_account_id,
          projectedHash,
        );

        await this.writeQueue.send({
          type: "UPSERT_MIRROR",
          canonical_event_id: canonicalEventId,
          target_account_id: edge.to_account_id,
          target_calendar_id: targetCalendarId,
          projected_payload: projection,
          idempotency_key: idempotencyKey,
        });

        enqueued++;
      }
    }

    return enqueued;
  }

  // -------------------------------------------------------------------------
  // upsertCanonicalEvent -- User-initiated CRUD
  // -------------------------------------------------------------------------

  /**
   * Insert or update a canonical event from a user-initiated source.
   *
   * If canonical_event_id already exists, updates it. Otherwise inserts.
   * Triggers projection for all applicable policy edges.
   */
  async upsertCanonicalEvent(
    event: CanonicalEvent,
    source: string,
  ): Promise<string> {
    this.ensureMigrated();

    const startTs = event.start.dateTime ?? event.start.date ?? "";
    const endTs = event.end.dateTime ?? event.end.date ?? "";

    // Check if event already exists
    const existing = this.sql
      .exec<{ canonical_event_id: string; version: number }>(
        `SELECT canonical_event_id, version FROM canonical_events
         WHERE canonical_event_id = ?`,
        event.canonical_event_id as string,
      )
      .toArray();

    if (existing.length > 0) {
      const newVersion = existing[0].version + 1;
      this.sql.exec(
        `UPDATE canonical_events SET
          title = ?, description = ?, location = ?,
          start_ts = ?, end_ts = ?, timezone = ?,
          all_day = ?, status = ?, visibility = ?,
          transparency = ?, recurrence_rule = ?,
          version = ?, updated_at = datetime('now')
         WHERE canonical_event_id = ?`,
        event.title ?? null,
        event.description ?? null,
        event.location ?? null,
        startTs,
        endTs,
        event.start.timeZone ?? null,
        event.all_day ? 1 : 0,
        event.status ?? "confirmed",
        event.visibility ?? "default",
        event.transparency ?? "opaque",
        event.recurrence_rule ?? null,
        newVersion,
        event.canonical_event_id as string,
      );

      this.writeJournal(
        event.canonical_event_id as string,
        "updated",
        source,
        { new_version: newVersion },
      );
    } else {
      this.sql.exec(
        `INSERT INTO canonical_events (
          canonical_event_id, origin_account_id, origin_event_id,
          title, description, location, start_ts, end_ts, timezone,
          all_day, status, visibility, transparency, recurrence_rule,
          source, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
        event.canonical_event_id as string,
        event.origin_account_id as string,
        event.origin_event_id,
        event.title ?? null,
        event.description ?? null,
        event.location ?? null,
        startTs,
        endTs,
        event.start.timeZone ?? null,
        event.all_day ? 1 : 0,
        event.status ?? "confirmed",
        event.visibility ?? "default",
        event.transparency ?? "opaque",
        event.recurrence_rule ?? null,
        event.source,
      );

      this.writeJournal(
        event.canonical_event_id as string,
        "created",
        source,
        {},
      );
    }

    // Trigger projections
    await this.projectAndEnqueue(
      event.canonical_event_id as string,
      event.origin_account_id as string,
    );

    return event.canonical_event_id as string;
  }

  // -------------------------------------------------------------------------
  // deleteCanonicalEvent -- User-initiated delete
  // -------------------------------------------------------------------------

  /**
   * Delete a canonical event by ID. Hard delete per BR-7.
   * Enqueues DELETE_MIRROR for all existing mirrors.
   */
  async deleteCanonicalEvent(
    canonicalEventId: string,
    source: string,
  ): Promise<boolean> {
    this.ensureMigrated();

    // Check event exists
    const rows = this.sql
      .exec<{ canonical_event_id: string }>(
        `SELECT canonical_event_id FROM canonical_events WHERE canonical_event_id = ?`,
        canonicalEventId,
      )
      .toArray();

    if (rows.length === 0) return false;

    // Enqueue DELETE_MIRROR for all existing mirrors
    const mirrors = this.sql
      .exec<EventMirrorRow>(
        `SELECT * FROM event_mirrors WHERE canonical_event_id = ?`,
        canonicalEventId,
      )
      .toArray();

    for (const mirror of mirrors) {
      await this.writeQueue.send({
        type: "DELETE_MIRROR",
        canonical_event_id: canonicalEventId,
        target_account_id: mirror.target_account_id,
        target_calendar_id: mirror.target_calendar_id,
        provider_event_id: mirror.provider_event_id ?? "",
      });
    }

    // Delete mirrors first (FK constraint)
    this.sql.exec(
      `DELETE FROM event_mirrors WHERE canonical_event_id = ?`,
      canonicalEventId,
    );

    // Hard delete
    this.sql.exec(
      `DELETE FROM canonical_events WHERE canonical_event_id = ?`,
      canonicalEventId,
    );

    // Journal entry
    this.writeJournal(canonicalEventId, "deleted", source, {});

    return true;
  }

  // -------------------------------------------------------------------------
  // listCanonicalEvents -- Query with time range + cursor pagination
  // -------------------------------------------------------------------------

  /**
   * List canonical events with optional time range filtering and cursor pagination.
   * Cursor-based pagination uses composite (start_ts, canonical_event_id).
   */
  listCanonicalEvents(query: ListEventsQuery = {}): ListEventsResult {
    this.ensureMigrated();

    const limit = query.limit ?? 50;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.time_min) {
      conditions.push("end_ts > ?");
      params.push(query.time_min);
    }
    if (query.time_max) {
      conditions.push("start_ts < ?");
      params.push(query.time_max);
    }
    if (query.origin_account_id) {
      conditions.push("origin_account_id = ?");
      params.push(query.origin_account_id);
    }

    // Cursor: "start_ts|canonical_event_id"
    if (query.cursor) {
      const parts = query.cursor.split("|");
      if (parts.length === 2) {
        conditions.push("(start_ts > ? OR (start_ts = ? AND canonical_event_id > ?))");
        params.push(parts[0], parts[0], parts[1]);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Fetch limit+1 to determine has_more
    const sql = `SELECT * FROM canonical_events ${where}
                 ORDER BY start_ts ASC, canonical_event_id ASC
                 LIMIT ?`;
    params.push(limit + 1);

    const rows = this.sql
      .exec<CanonicalEventRow>(sql, ...params)
      .toArray();

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((r) => this.rowToCanonicalEvent(r));

    let cursor: string | null = null;
    if (hasMore && items.length > 0) {
      const last = items[items.length - 1];
      const lastTs = last.start.dateTime ?? last.start.date ?? "";
      cursor = `${lastTs}|${last.canonical_event_id}`;
    }

    return { items, cursor, has_more: hasMore };
  }

  // -------------------------------------------------------------------------
  // getCanonicalEvent -- Single event with mirrors
  // -------------------------------------------------------------------------

  /**
   * Get a single canonical event by ID, including its mirrors.
   * Returns null if not found.
   */
  getCanonicalEvent(
    canonicalEventId: string,
  ): { event: CanonicalEvent; mirrors: EventMirrorRow[] } | null {
    this.ensureMigrated();

    const rows = this.sql
      .exec<CanonicalEventRow>(
        `SELECT * FROM canonical_events WHERE canonical_event_id = ?`,
        canonicalEventId,
      )
      .toArray();

    if (rows.length === 0) return null;

    const event = this.rowToCanonicalEvent(rows[0]);

    const mirrors = this.sql
      .exec<EventMirrorRow>(
        `SELECT * FROM event_mirrors WHERE canonical_event_id = ?`,
        canonicalEventId,
      )
      .toArray();

    return { event, mirrors };
  }

  // -------------------------------------------------------------------------
  // recomputeProjections -- Re-project and enqueue writes
  // -------------------------------------------------------------------------

  /**
   * Recompute projections for a single event or all events.
   * Compares hashes and enqueues writes for changed projections.
   */
  async recomputeProjections(scope: RecomputeScope = {}): Promise<number> {
    this.ensureMigrated();

    let events: CanonicalEventRow[];

    if (scope.canonical_event_id) {
      events = this.sql
        .exec<CanonicalEventRow>(
          `SELECT * FROM canonical_events WHERE canonical_event_id = ?`,
          scope.canonical_event_id,
        )
        .toArray();
    } else {
      events = this.sql
        .exec<CanonicalEventRow>(`SELECT * FROM canonical_events`)
        .toArray();
    }

    let totalEnqueued = 0;

    for (const evtRow of events) {
      totalEnqueued += await this.projectAndEnqueue(
        evtRow.canonical_event_id,
        evtRow.origin_account_id,
      );
    }

    return totalEnqueued;
  }

  // -------------------------------------------------------------------------
  // queryJournal -- Journal query with pagination
  // -------------------------------------------------------------------------

  /**
   * Query the event journal with optional filtering and cursor pagination.
   */
  queryJournal(query: JournalQuery = {}): JournalResult {
    this.ensureMigrated();

    const limit = query.limit ?? 50;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.canonical_event_id) {
      conditions.push("canonical_event_id = ?");
      params.push(query.canonical_event_id);
    }

    if (query.cursor) {
      conditions.push("journal_id > ?");
      params.push(query.cursor);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM event_journal ${where}
                 ORDER BY journal_id ASC LIMIT ?`;
    params.push(limit + 1);

    const rows = this.sql
      .exec<JournalRow>(sql, ...params)
      .toArray();

    const hasMore = rows.length > limit;
    const items: JournalEntry[] = rows.slice(0, limit).map((r) => ({
      journal_id: r.journal_id,
      canonical_event_id: r.canonical_event_id,
      ts: r.ts,
      actor: r.actor,
      change_type: r.change_type,
      patch_json: r.patch_json,
      reason: r.reason,
    }));

    let cursor: string | null = null;
    if (hasMore && items.length > 0) {
      cursor = items[items.length - 1].journal_id;
    }

    return { items, cursor, has_more: hasMore };
  }

  // -------------------------------------------------------------------------
  // getSyncHealth -- Return counts and last sync timestamps
  // -------------------------------------------------------------------------

  /**
   * Get sync health information: event counts, mirror states, journal size.
   */
  getSyncHealth(): SyncHealth {
    this.ensureMigrated();

    const eventCount = this.sql
      .exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM canonical_events")
      .toArray()[0].cnt;

    const mirrorCount = this.sql
      .exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM event_mirrors")
      .toArray()[0].cnt;

    const journalCount = this.sql
      .exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM event_journal")
      .toArray()[0].cnt;

    const pendingMirrors = this.sql
      .exec<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM event_mirrors WHERE state = 'PENDING'",
      )
      .toArray()[0].cnt;

    const errorMirrors = this.sql
      .exec<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM event_mirrors WHERE state = 'ERROR'",
      )
      .toArray()[0].cnt;

    const lastJournalRows = this.sql
      .exec<{ ts: string }>(
        "SELECT ts FROM event_journal ORDER BY ts DESC LIMIT 1",
      )
      .toArray();

    return {
      total_events: eventCount,
      total_mirrors: mirrorCount,
      total_journal_entries: journalCount,
      pending_mirrors: pendingMirrors,
      error_mirrors: errorMirrors,
      last_journal_ts: lastJournalRows.length > 0 ? lastJournalRows[0].ts : null,
    };
  }

  // -------------------------------------------------------------------------
  // Policy CRUD
  // -------------------------------------------------------------------------

  /** Valid detail levels for edge validation. */
  private static readonly VALID_DETAIL_LEVELS: ReadonlySet<string> = new Set([
    "BUSY",
    "TITLE",
    "FULL",
  ]);

  /** Valid calendar kinds for edge validation. */
  private static readonly VALID_CALENDAR_KINDS: ReadonlySet<string> = new Set([
    "BUSY_OVERLAY",
    "TRUE_MIRROR",
  ]);

  /**
   * Create a new (non-default) policy.
   * Returns the created policy record.
   */
  async createPolicy(name: string): Promise<Policy> {
    this.ensureMigrated();

    const policyId = generateId("policy");
    this.sql.exec(
      `INSERT INTO policies (policy_id, name, is_default, created_at)
       VALUES (?, ?, 0, datetime('now'))`,
      policyId,
      name,
    );

    const rows = this.sql
      .exec<PolicyRow>(
        `SELECT * FROM policies WHERE policy_id = ?`,
        policyId,
      )
      .toArray();

    return this.rowToPolicy(rows[0]);
  }

  /**
   * Get a policy by ID, including its edges.
   * Returns null if not found.
   */
  async getPolicy(policyId: string): Promise<PolicyWithEdges | null> {
    this.ensureMigrated();

    const policyRows = this.sql
      .exec<PolicyRow>(
        `SELECT * FROM policies WHERE policy_id = ?`,
        policyId,
      )
      .toArray();

    if (policyRows.length === 0) return null;

    const edgeRows = this.sql
      .exec<PolicyEdgeRow>(
        `SELECT * FROM policy_edges WHERE policy_id = ?`,
        policyId,
      )
      .toArray();

    const policy = this.rowToPolicy(policyRows[0]);

    return {
      ...policy,
      edges: edgeRows.map((e) => ({
        policy_id: e.policy_id,
        from_account_id: e.from_account_id,
        to_account_id: e.to_account_id,
        detail_level: e.detail_level,
        calendar_kind: e.calendar_kind,
      })),
    };
  }

  /**
   * List all policies (without edges).
   */
  async listPolicies(): Promise<Policy[]> {
    this.ensureMigrated();

    const rows = this.sql
      .exec<PolicyRow>(`SELECT * FROM policies ORDER BY created_at ASC`)
      .toArray();

    return rows.map((r) => this.rowToPolicy(r));
  }

  /**
   * Replace ALL edges for a policy, then recompute projections.
   *
   * Validates:
   * - Policy must exist
   * - No self-loops (from_account_id === to_account_id)
   * - Valid detail_level and calendar_kind values
   */
  async setPolicyEdges(
    policyId: string,
    edges: PolicyEdgeInput[],
  ): Promise<void> {
    this.ensureMigrated();

    // Verify policy exists
    const policyRows = this.sql
      .exec<PolicyRow>(
        `SELECT * FROM policies WHERE policy_id = ?`,
        policyId,
      )
      .toArray();

    if (policyRows.length === 0) {
      throw new Error(`Policy not found: ${policyId}`);
    }

    // Validate edges before mutating
    for (const edge of edges) {
      if (edge.from_account_id === edge.to_account_id) {
        throw new Error(
          `Self-loop not allowed: from_account_id and to_account_id are both "${edge.from_account_id}"`,
        );
      }
      if (!UserGraphDO.VALID_DETAIL_LEVELS.has(edge.detail_level)) {
        throw new Error(
          `Invalid detail_level "${edge.detail_level}". Must be one of: BUSY, TITLE, FULL`,
        );
      }
      if (!UserGraphDO.VALID_CALENDAR_KINDS.has(edge.calendar_kind)) {
        throw new Error(
          `Invalid calendar_kind "${edge.calendar_kind}". Must be one of: BUSY_OVERLAY, TRUE_MIRROR`,
        );
      }
    }

    // Delete all existing edges for this policy
    this.sql.exec(
      `DELETE FROM policy_edges WHERE policy_id = ?`,
      policyId,
    );

    // Insert new edges
    for (const edge of edges) {
      this.sql.exec(
        `INSERT INTO policy_edges (policy_id, from_account_id, to_account_id, detail_level, calendar_kind)
         VALUES (?, ?, ?, ?, ?)`,
        policyId,
        edge.from_account_id,
        edge.to_account_id,
        edge.detail_level,
        edge.calendar_kind,
      );
    }

    // Recompute all projections: re-evaluate all canonical events against
    // the updated policy edges and enqueue UPSERT_MIRROR for changes.
    await this.recomputeProjections();
  }

  /**
   * Ensure a default policy exists with bidirectional BUSY overlay edges
   * between all provided accounts.
   *
   * - Creates the default policy if it does not yet exist.
   * - Replaces all edges with the full mesh of bidirectional BUSY edges
   *   for the given accounts. This makes it idempotent and additive:
   *   calling with [A, B] then [A, B, C] extends to include C.
   */
  async ensureDefaultPolicy(accounts: string[]): Promise<void> {
    this.ensureMigrated();

    // Find or create the default policy
    const existing = this.sql
      .exec<PolicyRow>(
        `SELECT * FROM policies WHERE is_default = 1 LIMIT 1`,
      )
      .toArray();

    let policyId: string;
    if (existing.length > 0) {
      policyId = existing[0].policy_id;
    } else {
      policyId = generateId("policy");
      this.sql.exec(
        `INSERT INTO policies (policy_id, name, is_default, created_at)
         VALUES (?, 'Default Policy', 1, datetime('now'))`,
        policyId,
      );
    }

    // Build bidirectional edges between all distinct pairs
    // Delete existing edges and replace with the full mesh
    this.sql.exec(
      `DELETE FROM policy_edges WHERE policy_id = ?`,
      policyId,
    );

    for (let i = 0; i < accounts.length; i++) {
      for (let j = 0; j < accounts.length; j++) {
        if (i === j) continue;
        this.sql.exec(
          `INSERT OR IGNORE INTO policy_edges
             (policy_id, from_account_id, to_account_id, detail_level, calendar_kind)
           VALUES (?, ?, ?, 'BUSY', 'BUSY_OVERLAY')`,
          policyId,
          accounts[i],
          accounts[j],
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // unlinkAccount -- Cascade deletion for account removal
  // -------------------------------------------------------------------------

  /**
   * Remove all data associated with an account from the UserGraphDO.
   *
   * Cascade order:
   * 1. Delete mirrors FROM this account (enqueue DELETE_MIRROR for each)
   * 2. Delete mirrors TO this account (remove mirror rows)
   * 3. Hard delete canonical events from this account (BR-7)
   * 4. Remove policy edges referencing this account
   * 5. Trigger recomputeProjections for remaining events
   * 6. Remove calendar entries for this account
   * 7. Write journal entries recording the unlinking
   *
   * Error handling:
   * - Mirror deletion failures: mirrors marked TOMBSTONED, reconciliation cleans up
   * - Proceeds through all steps even if individual steps have partial failures
   *
   * Note: OAuth token revocation and watch channel stopping are handled by
   * AccountDO, not here. D1 registry update is handled by the API worker.
   */
  async unlinkAccount(accountId: string): Promise<UnlinkResult> {
    this.ensureMigrated();

    let eventsDeleted = 0;
    let mirrorsDeleted = 0;
    let policyEdgesRemoved = 0;
    let calendarsRemoved = 0;

    // Step 1: Delete mirrors FROM this account
    // For each canonical event owned by this account, enqueue DELETE_MIRROR
    // for every mirror that was created from it.
    const ownedEvents = this.sql
      .exec<{ canonical_event_id: string }>(
        `SELECT canonical_event_id FROM canonical_events WHERE origin_account_id = ?`,
        accountId,
      )
      .toArray();

    for (const evt of ownedEvents) {
      const mirrors = this.sql
        .exec<EventMirrorRow>(
          `SELECT * FROM event_mirrors WHERE canonical_event_id = ?`,
          evt.canonical_event_id,
        )
        .toArray();

      for (const mirror of mirrors) {
        await this.writeQueue.send({
          type: "DELETE_MIRROR",
          canonical_event_id: evt.canonical_event_id,
          target_account_id: mirror.target_account_id,
          target_calendar_id: mirror.target_calendar_id,
          provider_event_id: mirror.provider_event_id ?? "",
        });
        mirrorsDeleted++;
      }

      // Remove mirror rows for this event
      this.sql.exec(
        `DELETE FROM event_mirrors WHERE canonical_event_id = ?`,
        evt.canonical_event_id,
      );
    }

    // Step 2: Delete mirrors TO this account
    // These are mirror rows where this account is the target (receiving mirrors)
    const inboundMirrors = this.sql
      .exec<EventMirrorRow>(
        `SELECT * FROM event_mirrors WHERE target_account_id = ?`,
        accountId,
      )
      .toArray();

    for (const mirror of inboundMirrors) {
      // Enqueue DELETE_MIRROR so the provider-side mirror event gets removed
      await this.writeQueue.send({
        type: "DELETE_MIRROR",
        canonical_event_id: mirror.canonical_event_id,
        target_account_id: mirror.target_account_id,
        target_calendar_id: mirror.target_calendar_id,
        provider_event_id: mirror.provider_event_id ?? "",
      });
      mirrorsDeleted++;
    }

    this.sql.exec(
      `DELETE FROM event_mirrors WHERE target_account_id = ?`,
      accountId,
    );

    // Step 3: Hard delete canonical events from this account (BR-7)
    // Journal entries for each deletion
    for (const evt of ownedEvents) {
      this.writeJournal(
        evt.canonical_event_id,
        "deleted",
        "system",
        { reason: "account_unlinked", account_id: accountId },
        "account_unlinked",
      );
      eventsDeleted++;
    }

    this.sql.exec(
      `DELETE FROM canonical_events WHERE origin_account_id = ?`,
      accountId,
    );

    // Step 4: Remove policy edges referencing this account
    const edgesToRemove = this.sql
      .exec<PolicyEdgeRow>(
        `SELECT * FROM policy_edges WHERE from_account_id = ? OR to_account_id = ?`,
        accountId,
        accountId,
      )
      .toArray();

    policyEdgesRemoved = edgesToRemove.length;

    this.sql.exec(
      `DELETE FROM policy_edges WHERE from_account_id = ? OR to_account_id = ?`,
      accountId,
      accountId,
    );

    // Step 5: Recompute projections for remaining events
    // After edges are removed, some mirrors may be orphaned -- recompute
    // will clean up by re-evaluating all remaining events against remaining edges.
    await this.recomputeProjections();

    // Step 6: Remove calendar entries for this account
    const calCount = this.sql
      .exec<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM calendars WHERE account_id = ?`,
        accountId,
      )
      .toArray()[0].cnt;
    calendarsRemoved = calCount;

    this.sql.exec(
      `DELETE FROM calendars WHERE account_id = ?`,
      accountId,
    );

    // Step 7: Write a summary journal entry for the unlinking
    // Use a synthetic canonical_event_id since this is an account-level operation
    const syntheticId = `unlink:${accountId}`;
    this.writeJournal(
      syntheticId,
      "account_unlinked",
      "system",
      {
        account_id: accountId,
        events_deleted: eventsDeleted,
        mirrors_deleted: mirrorsDeleted,
        policy_edges_removed: policyEdgesRemoved,
        calendars_removed: calendarsRemoved,
      },
      "account_unlinked",
    );

    return {
      events_deleted: eventsDeleted,
      mirrors_deleted: mirrorsDeleted,
      policy_edges_removed: policyEdgesRemoved,
      calendars_removed: calendarsRemoved,
    };
  }

  // -------------------------------------------------------------------------
  // Mirror state RPC methods (for write-consumer via DO fetch)
  // -------------------------------------------------------------------------

  /**
   * Get a mirror row by canonical_event_id + target_account_id.
   * Returns null if not found.
   */
  getMirror(
    canonicalEventId: string,
    targetAccountId: string,
  ): EventMirrorRow | null {
    this.ensureMigrated();

    const rows = this.sql
      .exec<EventMirrorRow>(
        `SELECT * FROM event_mirrors
         WHERE canonical_event_id = ? AND target_account_id = ?`,
        canonicalEventId,
        targetAccountId,
      )
      .toArray();

    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Update mirror state fields. Used by write-consumer after Google API calls.
   */
  updateMirrorState(
    canonicalEventId: string,
    targetAccountId: string,
    update: MirrorStateUpdate,
  ): void {
    this.ensureMigrated();

    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (update.provider_event_id !== undefined) {
      setClauses.push("provider_event_id = ?");
      params.push(update.provider_event_id);
    }
    if (update.last_projected_hash !== undefined) {
      setClauses.push("last_projected_hash = ?");
      params.push(update.last_projected_hash);
    }
    if (update.last_write_ts !== undefined) {
      setClauses.push("last_write_ts = ?");
      params.push(update.last_write_ts);
    }
    if (update.state !== undefined) {
      setClauses.push("state = ?");
      params.push(update.state);
    }
    if (update.error_message !== undefined) {
      setClauses.push("error_message = ?");
      params.push(update.error_message);
    }
    if (update.target_calendar_id !== undefined) {
      setClauses.push("target_calendar_id = ?");
      params.push(update.target_calendar_id);
    }

    if (setClauses.length === 0) return;

    params.push(canonicalEventId, targetAccountId);
    this.sql.exec(
      `UPDATE event_mirrors SET ${setClauses.join(", ")}
       WHERE canonical_event_id = ? AND target_account_id = ?`,
      ...params,
    );
  }

  /**
   * Look up the busy overlay calendar's provider ID for a given account.
   * Returns null if no busy overlay calendar has been created yet.
   */
  getBusyOverlayCalendar(accountId: string): string | null {
    this.ensureMigrated();

    const rows = this.sql
      .exec<{ provider_calendar_id: string }>(
        `SELECT provider_calendar_id FROM calendars
         WHERE account_id = ? AND kind = 'BUSY_OVERLAY'`,
        accountId,
      )
      .toArray();

    return rows.length > 0 ? rows[0].provider_calendar_id : null;
  }

  /**
   * Store a busy overlay calendar's provider ID for a given account.
   * Called after write-consumer auto-creates the calendar via Google API.
   */
  storeBusyOverlayCalendar(
    accountId: string,
    providerCalendarId: string,
  ): void {
    this.ensureMigrated();

    const calendarId = generateId("calendar");
    this.sql.exec(
      `INSERT OR REPLACE INTO calendars
       (calendar_id, account_id, provider_calendar_id, role, kind, display_name)
       VALUES (?, ?, ?, 'writer', 'BUSY_OVERLAY', ?)`,
      calendarId,
      accountId,
      providerCalendarId,
      BUSY_OVERLAY_CALENDAR_NAME,
    );
  }

  // -------------------------------------------------------------------------
  // ReconcileWorkflow data access methods
  // -------------------------------------------------------------------------

  /**
   * Find a canonical event by its origin keys (origin_account_id + origin_event_id).
   * Used by ReconcileWorkflow to cross-check provider events against canonical store.
   * Returns the full canonical event or null if not found.
   */
  findCanonicalByOrigin(
    originAccountId: string,
    originEventId: string,
  ): CanonicalEvent | null {
    this.ensureMigrated();

    const rows = this.sql
      .exec<CanonicalEventRow>(
        `SELECT * FROM canonical_events
         WHERE origin_account_id = ? AND origin_event_id = ?`,
        originAccountId,
        originEventId,
      )
      .toArray();

    if (rows.length === 0) return null;
    return this.rowToCanonicalEvent(rows[0]);
  }

  /**
   * Get all policy edges where from_account_id matches the given account.
   * Used by ReconcileWorkflow to determine which mirrors should exist for an event.
   */
  getPolicyEdges(fromAccountId: string): PolicyEdgeRecord[] {
    this.ensureMigrated();

    const rows = this.sql
      .exec<PolicyEdgeRow>(
        `SELECT * FROM policy_edges WHERE from_account_id = ?`,
        fromAccountId,
      )
      .toArray();

    return rows.map((r) => ({
      policy_id: r.policy_id,
      from_account_id: r.from_account_id,
      to_account_id: r.to_account_id,
      detail_level: r.detail_level,
      calendar_kind: r.calendar_kind,
    }));
  }

  /**
   * Get all ACTIVE event mirrors targeting a specific account.
   * Used by ReconcileWorkflow to detect stale mirrors that no longer exist in the provider.
   */
  getActiveMirrors(targetAccountId: string): EventMirrorRow[] {
    this.ensureMigrated();

    return this.sql
      .exec<EventMirrorRow>(
        `SELECT * FROM event_mirrors
         WHERE target_account_id = ? AND state = 'ACTIVE'`,
        targetAccountId,
      )
      .toArray();
  }

  /**
   * Log a reconciliation discrepancy to the event journal.
   * Creates a journal entry with change_type "reconcile:<discrepancy_type>"
   * and actor "reconcile". Details are stored in patch_json.
   */
  logReconcileDiscrepancy(
    canonicalEventId: string,
    discrepancyType: string,
    details: Record<string, unknown>,
  ): void {
    this.ensureMigrated();

    this.writeJournal(
      canonicalEventId,
      `reconcile:${discrepancyType}`,
      "reconcile",
      details,
      `reconcile:${discrepancyType}`,
    );
  }

  // -------------------------------------------------------------------------
  // fetch() handler -- RPC-style routing for DO stub communication
  // -------------------------------------------------------------------------

  /**
   * Handle fetch requests from DO stubs. Routes requests by URL pathname
   * to the appropriate method.
   *
   * This is the entry point for all inter-worker communication with
   * UserGraphDO. Workers call `stub.fetch(new Request(url, { body }))`.
   */
  async handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      switch (pathname) {
        case "/applyProviderDelta": {
          const body = (await request.json()) as {
            account_id: string;
            deltas: ProviderDelta[];
          };
          const result = await this.applyProviderDelta(
            body.account_id,
            body.deltas,
          );
          return Response.json(result);
        }

        case "/getMirror": {
          const body = (await request.json()) as {
            canonical_event_id: string;
            target_account_id: string;
          };
          const mirror = this.getMirror(
            body.canonical_event_id,
            body.target_account_id,
          );
          return Response.json({ mirror });
        }

        case "/updateMirrorState": {
          const body = (await request.json()) as {
            canonical_event_id: string;
            target_account_id: string;
            update: MirrorStateUpdate;
          };
          this.updateMirrorState(
            body.canonical_event_id,
            body.target_account_id,
            body.update,
          );
          return Response.json({ ok: true });
        }

        case "/getBusyOverlayCalendar": {
          const body = (await request.json()) as { account_id: string };
          const calId = this.getBusyOverlayCalendar(body.account_id);
          return Response.json({ provider_calendar_id: calId });
        }

        case "/storeBusyOverlayCalendar": {
          const body = (await request.json()) as {
            account_id: string;
            provider_calendar_id: string;
          };
          this.storeBusyOverlayCalendar(
            body.account_id,
            body.provider_calendar_id,
          );
          return Response.json({ ok: true });
        }

        case "/listCanonicalEvents": {
          const body = (await request.json()) as ListEventsQuery;
          const result = this.listCanonicalEvents(body);
          return Response.json(result);
        }

        case "/getCanonicalEvent": {
          const body = (await request.json()) as {
            canonical_event_id: string;
          };
          const result = this.getCanonicalEvent(body.canonical_event_id);
          return Response.json(result);
        }

        case "/queryJournal": {
          const body = (await request.json()) as JournalQuery;
          const result = this.queryJournal(body);
          return Response.json(result);
        }

        case "/getSyncHealth": {
          const result = this.getSyncHealth();
          return Response.json(result);
        }

        case "/createPolicy": {
          const body = (await request.json()) as { name: string };
          const result = await this.createPolicy(body.name);
          return Response.json(result);
        }

        case "/setPolicyEdges": {
          const body = (await request.json()) as {
            policy_id: string;
            edges: PolicyEdgeInput[];
          };
          await this.setPolicyEdges(body.policy_id, body.edges);
          return Response.json({ ok: true });
        }

        case "/ensureDefaultPolicy": {
          const body = (await request.json()) as { accounts: string[] };
          await this.ensureDefaultPolicy(body.accounts);
          return Response.json({ ok: true });
        }

        // ---------------------------------------------------------------
        // ReconcileWorkflow RPC endpoints
        // ---------------------------------------------------------------

        case "/findCanonicalByOrigin": {
          const body = (await request.json()) as {
            origin_account_id: string;
            origin_event_id: string;
          };
          const event = this.findCanonicalByOrigin(
            body.origin_account_id,
            body.origin_event_id,
          );
          return Response.json({ event });
        }

        case "/getPolicyEdges": {
          const body = (await request.json()) as {
            from_account_id: string;
          };
          const edges = this.getPolicyEdges(body.from_account_id);
          return Response.json({ edges });
        }

        case "/getActiveMirrors": {
          const body = (await request.json()) as {
            target_account_id: string;
          };
          const mirrors = this.getActiveMirrors(body.target_account_id);
          return Response.json({ mirrors });
        }

        case "/logReconcileDiscrepancy": {
          const body = (await request.json()) as {
            canonical_event_id: string;
            discrepancy_type: string;
            details: Record<string, unknown>;
          };
          this.logReconcileDiscrepancy(
            body.canonical_event_id,
            body.discrepancy_type,
            body.details,
          );
          return Response.json({ ok: true });
        }

        case "/recomputeProjections": {
          const body = (await request.json()) as RecomputeScope;
          const enqueued = await this.recomputeProjections(body);
          return Response.json({ enqueued });
        }

        default:
          return new Response(`Unknown action: ${pathname}`, { status: 404 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 500 });
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Convert a DB row to a Policy domain object. */
  private rowToPolicy(row: PolicyRow): Policy {
    return {
      policy_id: row.policy_id,
      name: row.name,
      is_default: row.is_default === 1,
      created_at: row.created_at,
    };
  }

  /** Write a journal entry (ADR-5: every mutation produces a journal entry). */
  private writeJournal(
    canonicalEventId: string,
    changeType: string,
    actor: string,
    patch: Record<string, unknown>,
    reason?: string,
  ): void {
    const journalId = generateId("journal");
    this.sql.exec(
      `INSERT INTO event_journal (
        journal_id, canonical_event_id, ts, actor, change_type, patch_json, reason
      ) VALUES (?, ?, datetime('now'), ?, ?, ?, ?)`,
      journalId,
      canonicalEventId,
      actor,
      changeType,
      JSON.stringify(patch),
      reason ?? null,
    );
  }

  /** Convert a DB row to a CanonicalEvent domain object. */
  private rowToCanonicalEvent(row: CanonicalEventRow): CanonicalEvent {
    const allDay = row.all_day === 1;

    return {
      canonical_event_id: row.canonical_event_id as EventId,
      origin_account_id: row.origin_account_id as AccountId,
      origin_event_id: row.origin_event_id,
      title: row.title ?? undefined,
      description: row.description ?? undefined,
      location: row.location ?? undefined,
      start: allDay
        ? { date: row.start_ts }
        : { dateTime: row.start_ts, ...(row.timezone ? { timeZone: row.timezone } : {}) },
      end: allDay
        ? { date: row.end_ts }
        : { dateTime: row.end_ts, ...(row.timezone ? { timeZone: row.timezone } : {}) },
      all_day: allDay,
      status: row.status as CanonicalEvent["status"],
      visibility: row.visibility as CanonicalEvent["visibility"],
      transparency: row.transparency as CanonicalEvent["transparency"],
      recurrence_rule: row.recurrence_rule ?? undefined,
      source: row.source as CanonicalEvent["source"],
      version: row.version,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
