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
  simulate,
  canonicalizeProviderEventId,
} from "@tminus/shared";
import type { DriftReport } from "@tminus/shared";
import type { SimulationScenario, ImpactReport } from "@tminus/shared";
import type { MergedEvent, ProviderEvent as UpgradeProviderEvent, IcsEvent as UpgradeIcsEvent } from "@tminus/shared";
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
import { OnboardingSessionMixin } from "./onboarding-session-mixin";
export type { OnboardingSessionRow, OnboardingAccount } from "./onboarding-session-mixin";
import { SchedulingMixin } from "./scheduling-mixin";
export { SchedulingMixin } from "./scheduling-mixin";
export type {
  SchedulingCandidate,
  SchedulingSessionResult,
  SchedulingSessionListItem,
  HoldRecord,
  StoreSchedulingSessionInput,
  StoreHoldInput,
} from "./scheduling-mixin";
import { RelationshipMixin } from "./relationship-mixin";
export { RelationshipMixin } from "./relationship-mixin";
export type { Relationship, LedgerEntry, ReconnectionReport } from "./relationship-mixin";
import { GovernanceMixin } from "./governance-mixin";
export { GovernanceMixin } from "./governance-mixin";
export type {
  TimeAllocation,
  TimeCommitment,
  CommitmentStatus,
  CommitmentProofData,
  ProofEvent,
  CommitmentReport,
  CommitmentComplianceStatus,
  WindowType,
} from "./governance-mixin";
export { WINDOW_TYPES } from "./governance-mixin";
import { AnalyticsMixin } from "./analytics-mixin";
export { AnalyticsMixin } from "./analytics-mixin";
import { ConstraintMixin } from "./constraint-mixin";
export { ConstraintMixin } from "./constraint-mixin";
export type { Constraint, ConstraintDeps } from "./constraint-mixin";
import type { AvailabilityQuery } from "./availability-helpers";
export type {
  AvailabilityQuery,
  AvailabilityResult,
  BusyInterval,
  FreeInterval,
  WorkingHoursConfig,
  BufferConfig,
  EventRowForBuffer,
  NoMeetingsAfterConfig,
} from "./availability-helpers";
export {
  mergeIntervals,
  computeFreeIntervals,
  expandWorkingHoursToOutsideBusy,
  expandBuffersToBusy,
  expandTripConstraintsToBusy,
  expandNoMeetingsAfterToBusy,
} from "./availability-helpers";

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

/** Maximum queue messages per sendBatch call. */
const WRITE_QUEUE_BATCH_SIZE = 100;
/** Provider error substring used when queue batch payload exceeds limits. */
const PAYLOAD_TOO_LARGE_HINT = "payload too large";
/** Older than this many days is treated as low-priority historical churn. */
const OUT_OF_WINDOW_PAST_DAYS = 30;
/** Beyond this many days ahead is treated as low-priority far-future churn. */
const OUT_OF_WINDOW_FUTURE_DAYS = 365;
/** Near-term upserts within this horizon use the priority queue. */
const UPSERT_PRIORITY_LOOKAHEAD_DAYS = 30;
/** Recently-ended upserts within this lookback still use priority queue. */
const UPSERT_PRIORITY_LOOKBACK_DAYS = 1;

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
  constraint_id: string | null;
  authority_markers: string;
}

// ConstraintRow is now defined in constraint-mixin.ts.

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

// AllocationRow, VipPolicyRow, and CommitmentRow are now defined in governance-mixin.ts.

// RelationshipRow, LedgerRow, and DriftAlertRow are now defined in relationship-mixin.ts.

// OnboardingSessionRow is now defined in onboarding-session-mixin.ts
// and re-exported from this module.
import type { OnboardingSessionRow } from "./onboarding-session-mixin";

interface PolicyRow {
  [key: string]: unknown;
  policy_id: string;
  name: string;
  is_default: number;
  created_at: string;
}

function isPayloadTooLargeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return message.includes(PAYLOAD_TOO_LARGE_HINT) || message.includes("status 413");
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
  conflict_type: string;
  resolution: string | null;
}

// ---------------------------------------------------------------------------
// Authority tracking types and pure functions
// ---------------------------------------------------------------------------

/**
 * Maps field names to authority strings.
 * Authority format: "provider:<account_id>" or "tminus".
 * Empty {} means all fields are provider-owned (backward compat).
 */
export type AuthorityMarkers = Record<string, string>;

/**
 * The set of mutable fields on canonical_events that authority tracking
 * applies to. These are the fields providers can modify via delta sync.
 */
export const AUTHORITY_TRACKED_FIELDS = [
  "title",
  "description",
  "location",
  "start_ts",
  "end_ts",
  "timezone",
  "status",
  "visibility",
  "transparency",
  "recurrence_rule",
] as const;

export type AuthorityTrackedField = (typeof AUTHORITY_TRACKED_FIELDS)[number];

/**
 * Result of conflict detection for a single field.
 */
export interface FieldConflict {
  readonly field: AuthorityTrackedField;
  readonly current_authority: string;
  readonly incoming_authority: string;
  readonly old_value: unknown;
  readonly new_value: unknown;
}

/**
 * Build authority markers for a new INSERT. All non-null fields are
 * marked as owned by the given provider account.
 */
export function buildAuthorityMarkersForInsert(
  accountId: string,
  fieldValues: Record<string, unknown>,
): AuthorityMarkers {
  const markers: AuthorityMarkers = {};
  const authority = `provider:${accountId}`;

  for (const field of AUTHORITY_TRACKED_FIELDS) {
    if (fieldValues[field] !== null && fieldValues[field] !== undefined) {
      markers[field] = authority;
    }
  }

  return markers;
}

/**
 * Resolve authority markers for an existing event. If markers are empty
 * (legacy/backward compat), treat all existing non-null fields as
 * provider-owned by the origin account.
 */
export function resolveAuthorityMarkers(
  raw: string | null | undefined,
  originAccountId: string,
  currentRow: Record<string, unknown>,
): AuthorityMarkers {
  const parsed: AuthorityMarkers = raw ? JSON.parse(raw) : {};

  // If markers exist and are populated, use as-is
  if (Object.keys(parsed).length > 0) return parsed;

  // Backward compatibility: treat all non-null fields as provider-owned
  const markers: AuthorityMarkers = {};
  const authority = `provider:${originAccountId}`;
  for (const field of AUTHORITY_TRACKED_FIELDS) {
    if (currentRow[field] !== null && currentRow[field] !== undefined) {
      markers[field] = authority;
    }
  }

  return markers;
}

/**
 * Detect authority conflicts when a provider update modifies fields
 * owned by a different authority. Returns the list of conflicting fields.
 *
 * Resolution rules:
 * - Provider modifies provider-owned field (same authority): ALLOW, no conflict
 * - Provider modifies tminus-owned field: CONFLICT, provider wins but logged
 * - Provider modifies field owned by different provider: CONFLICT, incoming wins but logged
 */
export function detectAuthorityConflicts(
  incomingAccountId: string,
  currentMarkers: AuthorityMarkers,
  currentRow: Record<string, unknown>,
  incomingValues: Record<string, unknown>,
): FieldConflict[] {
  const conflicts: FieldConflict[] = [];
  const incomingAuthority = `provider:${incomingAccountId}`;

  for (const field of AUTHORITY_TRACKED_FIELDS) {
    const incomingVal = incomingValues[field];
    const currentVal = currentRow[field];

    // Skip fields not being changed
    if (incomingVal === undefined) continue;

    // Normalize for comparison: null == null, same string == same
    if (incomingVal === currentVal) continue;
    // Also handle numeric vs boolean (all_day is stored as 0/1)
    if (String(incomingVal) === String(currentVal)) continue;

    // Field is being changed -- check authority
    const currentAuthority = currentMarkers[field];

    // No authority recorded = provider-owned by default (backward compat)
    if (!currentAuthority) continue;

    // Same authority = no conflict
    if (currentAuthority === incomingAuthority) continue;

    // Different authority = conflict (provider wins, but we log it)
    conflicts.push({
      field,
      current_authority: currentAuthority,
      incoming_authority: incomingAuthority,
      old_value: currentVal,
      new_value: incomingVal,
    });
  }

  return conflicts;
}

/**
 * Compute updated authority markers after an update. The incoming
 * provider claims authority over all non-null fields it provides.
 * Fields not being changed retain their existing authority.
 */
export function updateAuthorityMarkers(
  currentMarkers: AuthorityMarkers,
  incomingAccountId: string,
  incomingValues: Record<string, unknown>,
): AuthorityMarkers {
  const updated = { ...currentMarkers };
  const authority = `provider:${incomingAccountId}`;

  for (const field of AUTHORITY_TRACKED_FIELDS) {
    const val = incomingValues[field];
    if (val !== undefined && val !== null) {
      updated[field] = authority;
    }
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Query parameters for listing canonical events. */
export interface ListEventsQuery {
  readonly time_min?: string;
  readonly time_max?: string;
  readonly origin_account_id?: string;
  /** Exact match on the provider-specific event ID. */
  readonly origin_event_id?: string;
  /** Only return events updated after this ISO 8601 timestamp. */
  readonly updated_after?: string;
  /** Filter by event source (e.g. "provider", "ics_feed", "ui", "mcp", "system"). */
  readonly source?: string;
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
  /** Type of authority conflict, if any. "none" for normal entries. */
  readonly conflict_type: string;
  /** JSON string with resolution details when conflict_type != "none". */
  readonly resolution: string | null;
}

/** Query parameters for conflict journal entries. */
export interface ConflictQuery {
  readonly canonical_event_id: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** Paginated conflict journal result. */
export interface ConflictResult {
  readonly items: JournalEntry[];
  readonly cursor: string | null;
  readonly has_more: boolean;
}

/** Sync health summary. */
export interface SyncHealth {
  readonly total_events: number;
  readonly total_mirrors: number;
  readonly total_journal_entries: number;
  readonly pending_mirrors: number;
  readonly deleting_mirrors: number;
  readonly error_mirrors: number;
  readonly last_journal_ts: string | null;
}

/** Aggregated mirror diagnostics grouped by state + target account. */
export interface MirrorStateBreakdown {
  readonly state: string;
  readonly target_account_id: string;
  readonly count: number;
  readonly missing_provider_event_id: number;
  readonly missing_canonical: number;
  readonly missing_policy_edge: number;
}

/** Expanded mirror diagnostics for operational debugging. */
export interface MirrorDiagnostics {
  readonly totals: SyncHealth;
  readonly pending_without_provider_event_id: number;
  readonly pending_with_provider_event_id: number;
  readonly pending_non_projectable: number;
  readonly pending_past_window: number;
  readonly pending_far_future_window: number;
  readonly pending_in_window: number;
  readonly oldest_pending_ts: string | null;
  readonly by_target: MirrorStateBreakdown[];
  readonly sample_pending: Array<{
    canonical_event_id: string;
    target_account_id: string;
    target_calendar_id: string;
    provider_event_id: string | null;
    last_write_ts: string | null;
    origin_account_id: string | null;
    start_ts: string | null;
    end_ts: string | null;
  }>;
}

/** Result for settling historical pending mirrors without provider writes. */
export interface SettleHistoricalPendingResult {
  readonly settled: number;
  readonly cutoff_days: number;
}

/** Result for settling out-of-window pending mirrors. */
export interface SettleOutOfWindowPendingResult {
  readonly settled: number;
  readonly settled_past: number;
  readonly settled_far_future: number;
  readonly past_days: number;
  readonly future_days: number;
}

/** Result for settling stuck pending mirrors by age. */
export interface SettleStuckPendingResult {
  readonly settled: number;
  readonly min_age_minutes: number;
}

/** Scope for recomputeProjections. */
export interface RecomputeScope {
  readonly canonical_event_id?: string;
  readonly force_requeue_non_active?: boolean;
  readonly force_requeue_pending?: boolean;
}

/** Result for bounded pending replay operations. */
export interface RequeuePendingResult {
  readonly canonical_events: number;
  readonly enqueued: number;
  readonly limit: number;
}

/** Result for bounded DELETING mirror replay operations. */
export interface RequeueDeletingResult {
  readonly mirrors: number;
  readonly enqueued: number;
  readonly limit: number;
}

/** Result for retrying a single mirror currently in ERROR/PENDING state. */
export interface RetryErrorMirrorResult {
  readonly retried: boolean;
  readonly enqueued: number;
  readonly reason?: "not_found" | "not_retryable_state" | "missing_canonical";
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

// Constraint type is now defined in constraint-mixin.ts and re-exported above.
import type { Constraint } from "./constraint-mixin";

// Relationship and LedgerEntry types are now defined in relationship-mixin.ts
// and re-exported from this module via the export statement above.

// ReconnectionReport type is now defined in relationship-mixin.ts
// and re-exported from this module via the export statement above.

/** Fields that can be updated on a mirror row via RPC. */
export interface MirrorStateUpdate {
  provider_event_id?: string;
  last_projected_hash?: string;
  last_write_ts?: string;
  state?: MirrorState;
  error_message?: string | null;
  target_calendar_id?: string;
}

// TimeAllocation, TimeCommitment, CommitmentStatus, CommitmentProofData,
// ProofEvent, CommitmentReport, CommitmentComplianceStatus, WindowType,
// and WINDOW_TYPES are now defined in governance-mixin.ts and re-exported above.

/** Result of a GDPR full-user deletion step. */
export interface DeletionCounts {
  readonly deleted: number;
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
  private readonly deleteQueue: QueueLike;
  private migrated = false;
  private readonly onboarding: OnboardingSessionMixin;
  private readonly scheduling: SchedulingMixin;
  readonly relationships: RelationshipMixin;
  private readonly governance: GovernanceMixin;
  private readonly analytics: AnalyticsMixin;
  private readonly constraints: ConstraintMixin;

  constructor(sql: SqlStorageLike, writeQueue: QueueLike, deleteQueue?: QueueLike) {
    this.sql = sql;
    this.writeQueue = writeQueue;
    this.deleteQueue = deleteQueue ?? writeQueue;
    this.onboarding = new OnboardingSessionMixin(sql, () => this.ensureMigrated());
    this.scheduling = new SchedulingMixin(sql, () => this.ensureMigrated());
    this.relationships = new RelationshipMixin(sql, () => this.ensureMigrated());
    this.governance = new GovernanceMixin(sql, () => this.ensureMigrated());
    this.analytics = new AnalyticsMixin(sql, () => this.ensureMigrated());
    this.constraints = new ConstraintMixin(sql, () => this.ensureMigrated(), {
      writeJournal: (canonicalEventId, changeType, actor, patch) =>
        this.writeJournal(canonicalEventId, changeType, actor, patch),
      enqueueDeleteMirror: (message) => this.enqueueDeleteMirror(message),
    });
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
    deltas: readonly (ProviderDelta & { participant_hashes?: string[] })[],
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
            // Store participant hashes for briefing lookups
            if (delta.participant_hashes && delta.participant_hashes.length > 0) {
              this.relationships.storeEventParticipants(canonicalId, delta.participant_hashes);
            }
            // Interaction detection: update relationships when event has
            // participant hashes matching known relationships
            if (delta.participant_hashes && delta.participant_hashes.length > 0 && delta.event) {
              const eventStartTs = delta.event.start.dateTime ?? delta.event.start.date ?? new Date().toISOString();
              this.relationships.updateInteractions(delta.participant_hashes, eventStartTs);
            }
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
              // Update participant hashes for briefing lookups
              if (delta.participant_hashes && delta.participant_hashes.length > 0) {
                this.relationships.storeEventParticipants(canonicalId, delta.participant_hashes);
              }
              // Interaction detection on update
              if (delta.participant_hashes && delta.participant_hashes.length > 0 && delta.event) {
                const eventStartTs = delta.event.start.dateTime ?? delta.event.start.date ?? new Date().toISOString();
                this.relationships.updateInteractions(delta.participant_hashes, eventStartTs);
              }
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

    // Drain outbox: deliver queued messages after all state changes committed.
    const drainedOutbox = await this.drainOutbox();
    if (mirrorsEnqueued > 0 && drainedOutbox === 0) {
      console.warn("user-graph: applyProviderDelta enqueued mirrors but drained none", {
        account_id: accountId,
        mirrors_enqueued: mirrorsEnqueued,
      });
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

  /**
   * Returns true when an origin account appears detached from the active graph.
   *
   * This is used as a safety gate for legacy origin-account rebinds:
   * we only auto-rebind events when the old account has no calendars and no
   * policy edges, which indicates stale/orphaned ownership metadata.
   */
  private isLikelyOrphanOriginAccount(accountId: string): boolean {
    if (!accountId || accountId === "internal") return false;

    const calendarCount = this.sql
      .exec<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM calendars WHERE account_id = ?`,
        accountId,
      )
      .toArray()[0].cnt;

    if (calendarCount > 0) return false;

    const policyEdgeCount = this.sql
      .exec<{ cnt: number }>(
        `SELECT COUNT(*) as cnt
         FROM policy_edges
         WHERE from_account_id = ? OR to_account_id = ?`,
        accountId,
        accountId,
      )
      .toArray()[0].cnt;

    return policyEdgeCount === 0;
  }

  /** True when the account has at least one known calendar in the graph. */
  private hasCalendar(accountId: string): boolean {
    const count = this.sql
      .exec<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM calendars WHERE account_id = ?`,
        accountId,
      )
      .toArray()[0].cnt;
    return count > 0;
  }

  /**
   * Extract the tracked field values from a delta event payload into a flat
   * Record suitable for authority marker functions. Maps the EventDateTime
   * structure to the start_ts/end_ts/timezone column names.
   */
  private extractFieldValues(
    evt: NonNullable<ProviderDelta["event"]>,
  ): Record<string, unknown> {
    return {
      title: evt.title ?? null,
      description: evt.description ?? null,
      location: evt.location ?? null,
      start_ts: evt.start.dateTime ?? evt.start.date ?? "",
      end_ts: evt.end.dateTime ?? evt.end.date ?? "",
      timezone: evt.start.timeZone ?? null,
      status: evt.status ?? "confirmed",
      visibility: evt.visibility ?? "default",
      transparency: evt.transparency ?? "opaque",
      recurrence_rule: evt.recurrence_rule ?? null,
    };
  }

  /**
   * Find a single legacy canonical event for the same origin_event_id that can
   * be safely rebound to the current account.
   *
   * Guardrails:
   * - candidate must be source='provider'
   * - candidate must belong to a different origin_account_id
   * - there must be exactly ONE such candidate
   * - candidate origin account must look orphaned in this graph
   */
  private findLegacyRebindCandidate(
    accountId: string,
    originEventId: string,
  ): { canonical_event_id: string; origin_account_id: string; version: number } | null {
    // Only attempt auto-rebind for accounts that are already fully represented
    // in the graph (calendar metadata exists). This avoids rebinds during
    // partial onboarding and preserves legitimate cross-account duplicates.
    if (!this.hasCalendar(accountId)) return null;

    const rows = this.sql
      .exec<{
        canonical_event_id: string;
        origin_account_id: string;
        source: string;
        version: number;
      }>(
        `SELECT canonical_event_id, origin_account_id, source, version
         FROM canonical_events
         WHERE origin_event_id = ?`,
        originEventId,
      )
      .toArray()
      .filter(
        (row) =>
          row.origin_account_id !== accountId &&
          row.source === "provider",
      );

    if (rows.length !== 1) return null;

    const candidate = rows[0];
    if (!this.isLikelyOrphanOriginAccount(candidate.origin_account_id)) {
      return null;
    }

    return {
      canonical_event_id: candidate.canonical_event_id,
      origin_account_id: candidate.origin_account_id,
      version: candidate.version,
    };
  }

  private async handleCreated(
    accountId: string,
    delta: ProviderDelta,
  ): Promise<string> {
    if (!delta.event) {
      throw new Error("Created delta must include event payload");
    }

    const evt = delta.event;

    // Extract start/end timestamps from EventDateTime
    const startTs = evt.start.dateTime ?? evt.start.date ?? "";
    const endTs = evt.end.dateTime ?? evt.end.date ?? "";

    // Check if event already exists for this (origin_account_id, origin_event_id).
    // This handles deduplication: retries, overlapping syncs, or repeated
    // "created" deltas for the same provider event won't produce duplicates.
    const existingRows = this.sql
      .exec<{ canonical_event_id: string; version: number }>(
        `SELECT canonical_event_id, version FROM canonical_events
         WHERE origin_account_id = ? AND origin_event_id = ?`,
        accountId,
        delta.origin_event_id,
      )
      .toArray();

    if (existingRows.length > 0) {
      // Event already exists -- update it instead of inserting a duplicate.
      const canonicalId = existingRows[0].canonical_event_id;
      const newVersion = existingRows[0].version + 1;

      // Compute updated authority markers for dedup update
      const fieldValues = this.extractFieldValues(evt);
      const dedupMarkers = buildAuthorityMarkersForInsert(accountId, fieldValues);

      this.sql.exec(
        `UPDATE canonical_events SET
          title = ?, description = ?, location = ?,
          start_ts = ?, end_ts = ?, timezone = ?,
          all_day = ?, status = ?, visibility = ?,
          transparency = ?, recurrence_rule = ?,
          version = ?, authority_markers = ?, updated_at = datetime('now')
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
        JSON.stringify(dedupMarkers),
        canonicalId,
      );

      this.writeJournal(canonicalId, "updated", `provider:${accountId}`, {
        origin_event_id: delta.origin_event_id,
        dedup: true,
      });

      return canonicalId;
    }

    // Legacy recovery path:
    // if an event exists under a stale/orphaned origin account with the same
    // origin_event_id, rebind ownership to the current account and update
    // in-place instead of inserting a duplicate canonical event.
    const legacy = this.findLegacyRebindCandidate(
      accountId,
      delta.origin_event_id,
    );
    if (legacy) {
      const canonicalId = legacy.canonical_event_id;
      const newVersion = legacy.version + 1;

      // On legacy rebind, all fields become owned by the new provider
      const fieldValues = this.extractFieldValues(evt);
      const rebindMarkers = buildAuthorityMarkersForInsert(accountId, fieldValues);

      this.sql.exec(
        `UPDATE canonical_events SET
          origin_account_id = ?,
          title = ?, description = ?, location = ?,
          start_ts = ?, end_ts = ?, timezone = ?,
          all_day = ?, status = ?, visibility = ?,
          transparency = ?, recurrence_rule = ?,
          version = ?, authority_markers = ?, updated_at = datetime('now')
         WHERE canonical_event_id = ?`,
        accountId,
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
        JSON.stringify(rebindMarkers),
        canonicalId,
      );

      this.writeJournal(canonicalId, "updated", `provider:${accountId}`, {
        origin_event_id: delta.origin_event_id,
        dedup: true,
        legacy_rebind_from: legacy.origin_account_id,
      });

      return canonicalId;
    }

    // New event -- insert with a fresh canonical_event_id
    const canonicalId = generateId("event");

    // Build authority markers: all non-null fields owned by this provider
    const fieldValues = this.extractFieldValues(evt);
    const markers = buildAuthorityMarkersForInsert(accountId, fieldValues);

    this.sql.exec(
      `INSERT INTO canonical_events (
        canonical_event_id, origin_account_id, origin_event_id,
        title, description, location, start_ts, end_ts, timezone,
        all_day, status, visibility, transparency, recurrence_rule,
        source, version, authority_markers, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'provider', 1, ?, datetime('now'), datetime('now'))`,
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
      JSON.stringify(markers),
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

    // Find existing canonical event by origin keys -- fetch full row for
    // authority conflict detection
    const rows = this.sql
      .exec<CanonicalEventRow>(
        `SELECT * FROM canonical_events
         WHERE origin_account_id = ? AND origin_event_id = ?`,
        accountId,
        delta.origin_event_id,
      )
      .toArray();

    let canonicalId: string;
    let newVersion: number;
    let legacyRebindFrom: string | null = null;
    let currentRow: CanonicalEventRow | null = null;

    if (rows.length > 0) {
      currentRow = rows[0];
      canonicalId = currentRow.canonical_event_id;
      newVersion = currentRow.version + 1;
    } else {
      const legacy = this.findLegacyRebindCandidate(
        accountId,
        delta.origin_event_id,
      );
      if (!legacy) {
        // Not found -- treat as create (could be a race or missed initial sync)
        return this.handleCreated(accountId, delta);
      }

      canonicalId = legacy.canonical_event_id;
      newVersion = legacy.version + 1;
      legacyRebindFrom = legacy.origin_account_id;

      // Fetch full row for the legacy candidate for authority tracking
      const legacyRows = this.sql
        .exec<CanonicalEventRow>(
          `SELECT * FROM canonical_events WHERE canonical_event_id = ?`,
          canonicalId,
        )
        .toArray();
      currentRow = legacyRows.length > 0 ? legacyRows[0] : null;
    }

    const evt = delta.event;

    const startTs = evt.start.dateTime ?? evt.start.date ?? "";
    const endTs = evt.end.dateTime ?? evt.end.date ?? "";

    // Authority conflict detection: compare incoming field values against
    // current authority markers before applying the update
    const incomingValues = this.extractFieldValues(evt);
    let conflicts: FieldConflict[] = [];
    let currentMarkers: AuthorityMarkers = {};

    if (currentRow) {
      currentMarkers = resolveAuthorityMarkers(
        currentRow.authority_markers,
        currentRow.origin_account_id,
        currentRow as unknown as Record<string, unknown>,
      );

      // Skip conflict detection for legacy rebinds: the old account is
      // orphaned and the rebind is an intentional ownership transfer,
      // not an authority dispute.
      if (!legacyRebindFrom) {
        conflicts = detectAuthorityConflicts(
          accountId,
          currentMarkers,
          currentRow as unknown as Record<string, unknown>,
          incomingValues,
        );
      }
    }

    // Compute updated authority markers: incoming provider claims all
    // fields it provides (provider wins, conflicts are logged)
    const updatedMarkers = updateAuthorityMarkers(
      currentMarkers,
      accountId,
      incomingValues,
    );

    if (legacyRebindFrom) {
      this.sql.exec(
        `UPDATE canonical_events SET
          origin_account_id = ?,
          title = ?, description = ?, location = ?,
          start_ts = ?, end_ts = ?, timezone = ?,
          all_day = ?, status = ?, visibility = ?,
          transparency = ?, recurrence_rule = ?,
          version = ?, authority_markers = ?, updated_at = datetime('now')
         WHERE canonical_event_id = ?`,
        accountId,
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
        JSON.stringify(updatedMarkers),
        canonicalId,
      );
    } else {
      this.sql.exec(
        `UPDATE canonical_events SET
          title = ?, description = ?, location = ?,
          start_ts = ?, end_ts = ?, timezone = ?,
          all_day = ?, status = ?, visibility = ?,
          transparency = ?, recurrence_rule = ?,
          version = ?, authority_markers = ?, updated_at = datetime('now')
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
        JSON.stringify(updatedMarkers),
        canonicalId,
      );
    }

    // Standard journal entry for the update
    const patch: Record<string, unknown> = {
      origin_event_id: delta.origin_event_id,
      new_version: newVersion,
    };
    if (legacyRebindFrom) {
      patch.legacy_rebind_from = legacyRebindFrom;
    }
    this.writeJournal(canonicalId, "updated", `provider:${accountId}`, patch);

    // Record authority conflicts as separate journal entries and emit telemetry
    if (conflicts.length > 0) {
      const resolution = {
        strategy: "provider_wins",
        conflicts: conflicts.map((c) => ({
          field: c.field,
          current_authority: c.current_authority,
          incoming_authority: c.incoming_authority,
          old_value: c.old_value,
          new_value: c.new_value,
        })),
      };

      // Structured conflict telemetry (TM-teqr)
      for (const c of conflicts) {
        console.info("authority_conflict", {
          canonical_event_id: canonicalId,
          conflicting_field: c.field,
          old_authority: c.current_authority,
          new_authority: c.incoming_authority,
          resolution: "provider_wins",
        });
      }

      this.writeJournal(
        canonicalId,
        "authority_conflict",
        `provider:${accountId}`,
        { origin_event_id: delta.origin_event_id },
        undefined,
        "field_override",
        JSON.stringify(resolution),
      );
    }

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

    let canonicalId: string;
    let legacyRebindFrom: string | null = null;
    if (rows.length > 0) {
      canonicalId = rows[0].canonical_event_id;
    } else {
      const legacy = this.findLegacyRebindCandidate(
        accountId,
        delta.origin_event_id,
      );
      if (!legacy) {
        return null; // Nothing to delete
      }
      canonicalId = legacy.canonical_event_id;
      legacyRebindFrom = legacy.origin_account_id;
    }

    // Enqueue DELETE_MIRROR for all existing mirrors BEFORE deleting the event
    const mirrors = this.sql
      .exec<EventMirrorRow>(
        `SELECT * FROM event_mirrors WHERE canonical_event_id = ?`,
        canonicalId,
      )
      .toArray();

    let mirrorsDeleted = 0;
    for (const mirror of mirrors) {
      const deleteIdempotencyKey = await computeIdempotencyKey(
        canonicalId,
        mirror.target_account_id,
        `delete:${mirror.provider_event_id ?? ""}:${mirror.target_calendar_id}`,
      );

      this.enqueueDeleteMirror({
        type: "DELETE_MIRROR",
        canonical_event_id: canonicalId,
        target_account_id: mirror.target_account_id,
        target_calendar_id: mirror.target_calendar_id,
        provider_event_id: mirror.provider_event_id ?? "",
        idempotency_key: deleteIdempotencyKey,
      });
      mirrorsDeleted++;
    }

    // Soft-delete mirrors: transition to DELETING so write-consumer
    // can confirm provider-side deletion before marking DELETED.
    this.sql.exec(
      `UPDATE event_mirrors SET state = 'DELETING'
       WHERE canonical_event_id = ? AND state NOT IN ('DELETED', 'TOMBSTONED')`,
      canonicalId,
    );

    // Drop the FK constraint reference so canonical_events can be hard-deleted.
    // Mirrors in DELETING state are retained for write-consumer to process;
    // mirrors already in DELETED/TOMBSTONED are safe to remove.
    this.sql.exec(
      `DELETE FROM event_mirrors
       WHERE canonical_event_id = ? AND state IN ('DELETED', 'TOMBSTONED')`,
      canonicalId,
    );

    // Hard delete per BR-7
    // Note: DELETING mirrors no longer reference this event via FK because
    // we only keep rows that write-consumer still needs to process.
    this.sql.exec(
      `DELETE FROM canonical_events WHERE canonical_event_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM event_mirrors
         WHERE event_mirrors.canonical_event_id = canonical_events.canonical_event_id
       )`,
      canonicalId,
    );

    // Journal entry records the deletion
    const patch: Record<string, unknown> = {
      origin_event_id: delta.origin_event_id,
    };
    if (legacyRebindFrom) {
      patch.legacy_rebind_from = legacyRebindFrom;
    }
    this.writeJournal(canonicalId, "deleted", `provider:${accountId}`, patch);

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
    opts: { forceRequeueNonActive?: boolean; forceRequeuePending?: boolean } = {},
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
    const canonicalEventEndMs = this.parseCanonicalEventEndMs(canonicalEvent);

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

        // Mirrors in deletion lifecycle are off-limits for projection.
        // DELETING means write-consumer is processing provider-side deletion;
        // DELETED/TOMBSTONED are terminal. Never re-enqueue upserts for these.
        if (
          existing.state === "DELETING" ||
          existing.state === "DELETED" ||
          existing.state === "TOMBSTONED"
        ) {
          continue;
        }

        // Write-skipping:
        // - ACTIVE + identical hash => skip (already converged)
        // - PENDING + identical hash => replay by default (self-heal for
        //   dropped queue messages). Callers can explicitly disable replay
        //   with forceRequeuePending=false.
        // - other non-ACTIVE states (ERROR) replay only
        //   when explicitly forced.
        if (existing.last_projected_hash === projectedHash) {
          if (existing.state === "ACTIVE") {
            continue;
          }
          if (
            existing.state === "PENDING" &&
            opts.forceRequeuePending === false
          ) {
            continue;
          }
          if (existing.state !== "PENDING" && !opts.forceRequeueNonActive) {
            continue;
          }
        }
        const nowIso = new Date().toISOString();
        // Hash differs for an already-created mirror.
        // For out-of-window events with provider_event_id already present,
        // converge hash/state locally to avoid flooding provider PATCH churn.
        if (
          existing.provider_event_id &&
          this.isOutOfWindowProjection(canonicalEventEndMs)
        ) {
          this.sql.exec(
            `UPDATE event_mirrors SET
              last_projected_hash = ?, state = 'ACTIVE',
              error_message = NULL, last_write_ts = ?
             WHERE canonical_event_id = ? AND target_account_id = ?`,
            projectedHash,
            nowIso,
            canonicalEventId,
            edge.to_account_id,
          );
          continue;
        }

        // Hash differs -- update mirror record and enqueue write
        this.sql.exec(
          `UPDATE event_mirrors SET
            last_projected_hash = ?, state = 'PENDING', last_write_ts = ?
           WHERE canonical_event_id = ? AND target_account_id = ?`,
          projectedHash,
          nowIso,
          canonicalEventId,
          edge.to_account_id,
        );

        const idempotencyKey = await computeIdempotencyKey(
          canonicalEventId,
          edge.to_account_id,
          projectedHash,
        );

        this.enqueueUpsertMirror({
          type: "UPSERT_MIRROR",
          canonical_event_id: canonicalEventId,
          target_account_id: edge.to_account_id,
          target_calendar_id: existing.target_calendar_id,
          projected_hash: projectedHash,
          projected_payload: projection,
          idempotency_key: idempotencyKey,
        }, canonicalEventEndMs);

        enqueued++;
      } else {
        // New mirror -- create record and enqueue
        // Use to_account_id as default target_calendar_id (will be resolved by write-consumer)
        const targetCalendarId = edge.to_account_id;

        const nowIso = new Date().toISOString();
        this.sql.exec(
          `INSERT INTO event_mirrors (
            canonical_event_id, target_account_id, target_calendar_id,
            last_projected_hash, state, last_write_ts
          ) VALUES (?, ?, ?, ?, 'PENDING', ?)`,
          canonicalEventId,
          edge.to_account_id,
          targetCalendarId,
          projectedHash,
          nowIso,
        );

        const idempotencyKey = await computeIdempotencyKey(
          canonicalEventId,
          edge.to_account_id,
          projectedHash,
        );

        this.enqueueUpsertMirror({
          type: "UPSERT_MIRROR",
          canonical_event_id: canonicalEventId,
          target_account_id: edge.to_account_id,
          target_calendar_id: targetCalendarId,
          projected_hash: projectedHash,
          projected_payload: projection,
          idempotency_key: idempotencyKey,
        }, canonicalEventEndMs);

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

    // For API-created events, generate missing IDs.
    // The API handler passes raw user input which won't have
    // canonical_event_id, origin_account_id, or origin_event_id.
    const canonicalId =
      (event.canonical_event_id as string) || generateId("event");
    const originAccountId =
      (event.origin_account_id as string) || "api";
    const originEventId =
      event.origin_event_id || canonicalId;

    // Guard against partial events (e.g. PATCH with title-only).
    // The PATCH handler should merge before calling, but we defend here too.
    const startTs = event.start?.dateTime ?? event.start?.date ?? "";
    const endTs = event.end?.dateTime ?? event.end?.date ?? "";

    // Check if event already exists
    const existing = this.sql
      .exec<{ canonical_event_id: string; version: number }>(
        `SELECT canonical_event_id, version FROM canonical_events
         WHERE canonical_event_id = ?`,
        canonicalId,
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
        event.start?.timeZone ?? null,
        event.all_day ? 1 : 0,
        event.status ?? "confirmed",
        event.visibility ?? "default",
        event.transparency ?? "opaque",
        event.recurrence_rule ?? null,
        newVersion,
        canonicalId,
      );

      this.writeJournal(
        canonicalId,
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
        canonicalId,
        originAccountId,
        originEventId,
        event.title ?? null,
        event.description ?? null,
        event.location ?? null,
        startTs,
        endTs,
        event.start?.timeZone ?? null,
        event.all_day ? 1 : 0,
        event.status ?? "confirmed",
        event.visibility ?? "default",
        event.transparency ?? "opaque",
        event.recurrence_rule ?? null,
        event.source ?? source,
      );

      this.writeJournal(
        canonicalId,
        "created",
        source,
        {},
      );
    }

    // Trigger projections
    await this.projectAndEnqueue(
      canonicalId,
      originAccountId,
    );

    // Drain outbox: deliver queued messages after all state changes committed
    await this.drainOutbox();

    return canonicalId;
  }

  // -------------------------------------------------------------------------
  // deleteCanonicalEvent -- User-initiated delete
  // -------------------------------------------------------------------------

  /**
   * Delete a canonical event by ID. Hard delete per BR-7.
   * Enqueues DELETE_MIRROR for all existing mirrors and for the origin event.
   */
  async deleteCanonicalEvent(
    canonicalEventId: string,
    source: string,
  ): Promise<boolean> {
    this.ensureMigrated();

    // Check event exists
    const rows = this.sql
      .exec<{
        canonical_event_id: string;
        origin_account_id: string;
        origin_event_id: string;
      }>(
        `SELECT canonical_event_id, origin_account_id, origin_event_id
         FROM canonical_events
         WHERE canonical_event_id = ?`,
        canonicalEventId,
      )
      .toArray();

    if (rows.length === 0) return false;
    const event = rows[0];

    // Enqueue DELETE_MIRROR for all existing mirrors
    const mirrors = this.sql
      .exec<EventMirrorRow>(
        `SELECT * FROM event_mirrors WHERE canonical_event_id = ?`,
        canonicalEventId,
      )
      .toArray();

    for (const mirror of mirrors) {
      const deleteIdempotencyKey = await computeIdempotencyKey(
        canonicalEventId,
        mirror.target_account_id,
        `delete:${mirror.provider_event_id ?? ""}:${mirror.target_calendar_id}`,
      );

      this.enqueueDeleteMirror({
        type: "DELETE_MIRROR",
        canonical_event_id: canonicalEventId,
        target_account_id: mirror.target_account_id,
        target_calendar_id: mirror.target_calendar_id,
        provider_event_id: mirror.provider_event_id ?? "",
        idempotency_key: deleteIdempotencyKey,
      });
    }

    let originDeleteEnqueued = false;
    // Also delete the origin provider event so user-initiated deletes from
    // Tminus/API propagate back to the account that originated the canonical.
    if (
      event.origin_account_id.startsWith("acc_") &&
      typeof event.origin_event_id === "string" &&
      event.origin_event_id.length > 0
    ) {
      const originDeleteIdempotencyKey = await computeIdempotencyKey(
        canonicalEventId,
        event.origin_account_id,
        `delete-origin:${event.origin_event_id}:primary`,
      );
      this.enqueueDeleteMirror({
        type: "DELETE_MIRROR",
        canonical_event_id: canonicalEventId,
        target_account_id: event.origin_account_id,
        target_calendar_id: "primary",
        provider_event_id: event.origin_event_id,
        idempotency_key: originDeleteIdempotencyKey,
      });
      originDeleteEnqueued = true;
    }

    console.log("user-graph: deleteCanonicalEvent enqueue summary", {
      canonical_event_id: canonicalEventId,
      source,
      mirrors_enqueued: mirrors.length,
      origin_account_id: event.origin_account_id,
      origin_event_id_present: typeof event.origin_event_id === "string" && event.origin_event_id.length > 0,
      origin_delete_enqueued: originDeleteEnqueued,
    });

    // Soft-delete mirrors: transition to DELETING so write-consumer
    // can confirm provider-side deletion before marking DELETED.
    this.sql.exec(
      `UPDATE event_mirrors SET state = 'DELETING'
       WHERE canonical_event_id = ? AND state NOT IN ('DELETED', 'TOMBSTONED')`,
      canonicalEventId,
    );

    // Remove already-terminal mirrors so canonical event can be hard-deleted
    // if no in-flight deletions remain.
    this.sql.exec(
      `DELETE FROM event_mirrors
       WHERE canonical_event_id = ? AND state IN ('DELETED', 'TOMBSTONED')`,
      canonicalEventId,
    );

    // Hard delete canonical event only if no DELETING mirrors remain (FK safe).
    // If DELETING mirrors exist, the canonical event is retained until
    // write-consumer processes all pending deletions.
    this.sql.exec(
      `DELETE FROM canonical_events WHERE canonical_event_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM event_mirrors
         WHERE event_mirrors.canonical_event_id = canonical_events.canonical_event_id
       )`,
      canonicalEventId,
    );

    // Journal entry
    this.writeJournal(canonicalEventId, "deleted", source, {});

    // Drain outbox: deliver queued messages after all state changes committed
    await this.drainOutbox();

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
    if (query.origin_event_id) {
      conditions.push("origin_event_id = ?");
      params.push(query.origin_event_id);
    }
    if (query.updated_after) {
      conditions.push("updated_at > ?");
      params.push(query.updated_after);
    }
    if (query.source) {
      conditions.push("source = ?");
      params.push(query.source);
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
    this.pruneNonProjectableMirrors();

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
        {
          forceRequeueNonActive: scope.force_requeue_non_active,
          forceRequeuePending: scope.force_requeue_pending,
        },
      );
    }

    // Drain outbox: deliver queued messages after all state changes committed
    await this.drainOutbox();

    return totalEnqueued;
  }

  /**
   * Re-enqueue projections for a bounded set of canonical events that currently
   * have PENDING mirrors.
   *
   * This chunked variant avoids request timeouts caused by full-dataset replay.
   */
  async requeuePendingMirrors(limit = 200): Promise<RequeuePendingResult> {
    this.ensureMigrated();
    this.pruneNonProjectableMirrors();

    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(2000, Math.trunc(limit)))
      : 200;

    const candidates = this.sql
      .exec<{ canonical_event_id: string; origin_account_id: string }>(
        `SELECT DISTINCT c.canonical_event_id, c.origin_account_id
         FROM event_mirrors m
         JOIN canonical_events c
           ON c.canonical_event_id = m.canonical_event_id
         WHERE m.state = 'PENDING'
         ORDER BY COALESCE(m.last_write_ts, c.updated_at, c.created_at) ASC
         LIMIT ?`,
        safeLimit,
      )
      .toArray();

    let totalEnqueued = 0;
    for (const row of candidates) {
      totalEnqueued += await this.projectAndEnqueue(
        row.canonical_event_id,
        row.origin_account_id,
        { forceRequeuePending: true },
      );
    }

    // Sweep: drain any orphaned outbox entries from prior interrupted operations
    const outboxDrained = await this.drainOutbox();

    return {
      canonical_events: candidates.length,
      enqueued: totalEnqueued + outboxDrained,
      limit: safeLimit,
    };
  }

  /**
   * Re-enqueue a bounded set of mirrors stuck in DELETING state.
   *
   * Safety invariant: this path is hard-capped to one deletion replay per call
   * to preserve event-atomic behavior and avoid bulk destructive operations.
   */
  async requeueDeletingMirrors(limit = 1): Promise<RequeueDeletingResult> {
    this.ensureMigrated();

    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(1, Math.trunc(limit)))
      : 1;

    const candidates = this.sql
      .exec<{
        canonical_event_id: string;
        target_account_id: string;
        target_calendar_id: string;
        provider_event_id: string | null;
      }>(
        `SELECT canonical_event_id, target_account_id, target_calendar_id, provider_event_id
         FROM event_mirrors
         WHERE state = 'DELETING'
         ORDER BY COALESCE(last_write_ts, '1970-01-01T00:00:00Z') ASC
         LIMIT ?`,
        safeLimit,
      )
      .toArray();

    if (candidates.length === 0) {
      return { mirrors: 0, enqueued: 0, limit: safeLimit };
    }

    let enqueued = 0;

    for (const row of candidates) {
      const idempotencyKey = await computeIdempotencyKey(
        row.canonical_event_id,
        row.target_account_id,
        `delete:replay:${row.provider_event_id ?? ""}:${row.target_calendar_id}`,
      );

      try {
        await this.deleteQueue.send({
          type: "DELETE_MIRROR",
          canonical_event_id: row.canonical_event_id,
          target_account_id: row.target_account_id,
          target_calendar_id: row.target_calendar_id,
          provider_event_id: row.provider_event_id ?? "",
          idempotency_key: idempotencyKey,
        });

        this.sql.exec(
          `UPDATE event_mirrors
           SET last_write_ts = ?
           WHERE canonical_event_id = ? AND target_account_id = ?`,
          new Date().toISOString(),
          row.canonical_event_id,
          row.target_account_id,
        );

        enqueued++;
      } catch (err) {
        console.error("user-graph: requeueDeletingMirrors queue send failed", {
          canonical_event_id: row.canonical_event_id,
          target_account_id: row.target_account_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      mirrors: candidates.length,
      enqueued,
      limit: safeLimit,
    };
  }

  /**
   * Retry a specific mirror by canonical + target account pair.
   *
   * This transitions the mirror to PENDING and re-runs projection enqueue with
   * forceRequeueNonActive enabled so ERROR hashes are replayed.
   */
  async retryErrorMirror(
    canonicalEventId: string,
    targetAccountId: string,
  ): Promise<RetryErrorMirrorResult> {
    this.ensureMigrated();
    this.pruneNonProjectableMirrors();

    const mirrorRows = this.sql
      .exec<{ state: string }>(
        `SELECT state
         FROM event_mirrors
         WHERE canonical_event_id = ? AND target_account_id = ?`,
        canonicalEventId,
        targetAccountId,
      )
      .toArray();

    if (mirrorRows.length === 0) {
      return { retried: false, enqueued: 0, reason: "not_found" };
    }

    const state = mirrorRows[0].state;
    if (state === "DELETING" || state === "DELETED" || state === "TOMBSTONED") {
      return { retried: false, enqueued: 0, reason: "not_retryable_state" };
    }

    const canonicalRows = this.sql
      .exec<{ origin_account_id: string }>(
        `SELECT origin_account_id
         FROM canonical_events
         WHERE canonical_event_id = ?`,
        canonicalEventId,
      )
      .toArray();

    if (canonicalRows.length === 0) {
      return { retried: false, enqueued: 0, reason: "missing_canonical" };
    }

    this.sql.exec(
      `UPDATE event_mirrors
       SET state = 'PENDING',
           error_message = NULL,
           last_write_ts = ?
       WHERE canonical_event_id = ? AND target_account_id = ?`,
      new Date().toISOString(),
      canonicalEventId,
      targetAccountId,
    );

    const enqueued = await this.projectAndEnqueue(
      canonicalEventId,
      canonicalRows[0].origin_account_id,
      {
        forceRequeueNonActive: true,
        forceRequeuePending: true,
      },
    );
    const outboxDrained = await this.drainOutbox();

    return {
      retried: true,
      enqueued: enqueued + outboxDrained,
    };
  }

  /**
   * Remove mirror rows that can no longer be projected:
   * - canonical event no longer exists, or
   * - no active policy edge exists for (origin_account_id -> target_account_id).
   *
   * Without this cleanup, legacy ERROR/PENDING rows can linger indefinitely
   * after account/policy changes and keep aggregate health degraded forever.
   */
  private pruneNonProjectableMirrors(): void {
    // Only prune mirrors that are NOT in an active deletion lifecycle.
    // DELETING mirrors must be retained until write-consumer confirms
    // provider-side deletion (state machine: DELETING -> DELETED).
    this.sql.exec(
      `DELETE FROM event_mirrors
       WHERE state NOT IN ('DELETING')
         AND (
           NOT EXISTS (
             SELECT 1
             FROM canonical_events c
             WHERE c.canonical_event_id = event_mirrors.canonical_event_id
           )
           OR NOT EXISTS (
             SELECT 1
             FROM canonical_events c
             JOIN policy_edges e
               ON e.from_account_id = c.origin_account_id
              AND e.to_account_id = event_mirrors.target_account_id
             WHERE c.canonical_event_id = event_mirrors.canonical_event_id
           )
         )`,
    );
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
      conflict_type: r.conflict_type,
      resolution: r.resolution,
    }));

    let cursor: string | null = null;
    if (hasMore && items.length > 0) {
      cursor = items[items.length - 1].journal_id;
    }

    return { items, cursor, has_more: hasMore };
  }

  // -------------------------------------------------------------------------
  // getEventConflicts -- Query conflict journal entries for a canonical event
  // -------------------------------------------------------------------------

  /**
   * Returns journal entries with conflict_type != 'none' for a given
   * canonical_event_id. Provides visibility into authority conflicts
   * that occurred during provider delta processing.
   */
  getEventConflicts(query: ConflictQuery): ConflictResult {
    this.ensureMigrated();

    const limit = query.limit ?? 50;
    const conditions: string[] = [
      "canonical_event_id = ?",
      "conflict_type != 'none'",
    ];
    const params: unknown[] = [query.canonical_event_id];

    if (query.cursor) {
      conditions.push("journal_id > ?");
      params.push(query.cursor);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;
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
      conflict_type: r.conflict_type,
      resolution: r.resolution,
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
    this.pruneNonProjectableMirrors();

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

    const deletingMirrors = this.sql
      .exec<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM event_mirrors WHERE state = 'DELETING'",
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
      deleting_mirrors: deletingMirrors,
      error_mirrors: errorMirrors,
      last_journal_ts: lastJournalRows.length > 0 ? lastJournalRows[0].ts : null,
    };
  }

  /**
   * List mirrors currently in ERROR state for operational debugging/recovery.
   */
  listErrorMirrors(limit = 100): Array<{
    canonical_event_id: string;
    target_account_id: string;
    target_calendar_id: string;
    provider_event_id: string | null;
    last_projected_hash: string | null;
    last_write_ts: string | null;
    error_message: string | null;
    title: string | null;
    start_ts: string | null;
    end_ts: string | null;
  }> {
    this.ensureMigrated();
    this.pruneNonProjectableMirrors();
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.trunc(limit))) : 100;

    return this.sql
      .exec<{
        canonical_event_id: string;
        target_account_id: string;
        target_calendar_id: string;
        provider_event_id: string | null;
        last_projected_hash: string | null;
        last_write_ts: string | null;
        error_message: string | null;
        title: string | null;
        start_ts: string | null;
        end_ts: string | null;
      }>(
        `SELECT
           m.canonical_event_id,
           m.target_account_id,
           m.target_calendar_id,
           m.provider_event_id,
           m.last_projected_hash,
           m.last_write_ts,
           m.error_message,
           c.title,
           c.start_ts,
           c.end_ts
         FROM event_mirrors m
         LEFT JOIN canonical_events c
           ON c.canonical_event_id = m.canonical_event_id
         WHERE m.state = 'ERROR'
         ORDER BY COALESCE(m.last_write_ts, c.updated_at, c.created_at) DESC
         LIMIT ?`,
        safeLimit,
      )
      .toArray();
  }

  /**
   * Return a detailed mirror-state breakdown for diagnosing sync degradation.
   */
  getMirrorDiagnostics(sampleLimit = 25): MirrorDiagnostics {
    this.ensureMigrated();
    this.pruneNonProjectableMirrors();
    const safeSampleLimit = Number.isFinite(sampleLimit)
      ? Math.max(1, Math.min(200, Math.trunc(sampleLimit)))
      : 25;

    const totals = this.getSyncHealth();

    const pendingWithoutProvider = this.sql
      .exec<{ cnt: number }>(
        `SELECT COUNT(*) as cnt
         FROM event_mirrors
         WHERE state = 'PENDING'
           AND (provider_event_id IS NULL OR provider_event_id = '')`,
      )
      .toArray()[0].cnt;

    const pendingWithProvider = this.sql
      .exec<{ cnt: number }>(
        `SELECT COUNT(*) as cnt
         FROM event_mirrors
         WHERE state = 'PENDING'
           AND provider_event_id IS NOT NULL
           AND provider_event_id != ''`,
      )
      .toArray()[0].cnt;

    const pendingNonProjectable = this.sql
      .exec<{ cnt: number }>(
        `SELECT COUNT(*) as cnt
         FROM event_mirrors m
         LEFT JOIN canonical_events c
           ON c.canonical_event_id = m.canonical_event_id
         LEFT JOIN policy_edges e
           ON e.from_account_id = c.origin_account_id
          AND e.to_account_id = m.target_account_id
         WHERE m.state = 'PENDING'
           AND (
             c.canonical_event_id IS NULL
             OR e.policy_id IS NULL
           )`,
      )
      .toArray()[0].cnt;

    const pendingWindowRows = this.sql
      .exec<{
        past_window: number;
        far_future_window: number;
        in_window: number;
      }>(
        `SELECT
           SUM(
             CASE
               WHEN c.end_ts IS NOT NULL
                    AND c.end_ts != ''
                    AND julianday(c.end_ts) <= julianday('now', '-30 days')
               THEN 1 ELSE 0
             END
           ) as past_window,
           SUM(
             CASE
               WHEN c.end_ts IS NOT NULL
                    AND c.end_ts != ''
                    AND julianday(c.end_ts) >= julianday('now', '+365 days')
               THEN 1 ELSE 0
             END
           ) as far_future_window,
           SUM(
             CASE
               WHEN c.end_ts IS NOT NULL
                    AND c.end_ts != ''
                    AND julianday(c.end_ts) > julianday('now', '-30 days')
                    AND julianday(c.end_ts) < julianday('now', '+365 days')
               THEN 1 ELSE 0
             END
           ) as in_window
         FROM event_mirrors m
         JOIN canonical_events c
           ON c.canonical_event_id = m.canonical_event_id
         WHERE m.state = 'PENDING'`,
      )
      .toArray();
    const pendingWindow = pendingWindowRows[0] ?? {
      past_window: 0,
      far_future_window: 0,
      in_window: 0,
    };

    const oldestPendingRows = this.sql
      .exec<{ oldest: string | null }>(
        `SELECT MIN(COALESCE(m.last_write_ts, c.updated_at, c.created_at)) as oldest
         FROM event_mirrors m
         LEFT JOIN canonical_events c
           ON c.canonical_event_id = m.canonical_event_id
         WHERE m.state = 'PENDING'`,
      )
      .toArray();
    const oldestPendingTs =
      oldestPendingRows.length > 0 ? oldestPendingRows[0].oldest : null;

    const byTarget = this.sql
      .exec<{
        state: string;
        target_account_id: string;
        count: number;
        missing_provider_event_id: number;
        missing_canonical: number;
        missing_policy_edge: number;
      }>(
        `SELECT
           m.state as state,
           m.target_account_id as target_account_id,
           COUNT(*) as count,
           SUM(CASE WHEN m.provider_event_id IS NULL OR m.provider_event_id = '' THEN 1 ELSE 0 END) as missing_provider_event_id,
           SUM(CASE WHEN c.canonical_event_id IS NULL THEN 1 ELSE 0 END) as missing_canonical,
           SUM(CASE WHEN c.canonical_event_id IS NOT NULL AND e.policy_id IS NULL THEN 1 ELSE 0 END) as missing_policy_edge
         FROM event_mirrors m
         LEFT JOIN canonical_events c
           ON c.canonical_event_id = m.canonical_event_id
         LEFT JOIN policy_edges e
           ON e.from_account_id = c.origin_account_id
          AND e.to_account_id = m.target_account_id
         GROUP BY m.state, m.target_account_id
         ORDER BY count DESC`,
      )
      .toArray()
      .map((row) => ({
        ...row,
        count: Number(row.count) || 0,
        missing_provider_event_id: Number(row.missing_provider_event_id) || 0,
        missing_canonical: Number(row.missing_canonical) || 0,
        missing_policy_edge: Number(row.missing_policy_edge) || 0,
      }));

    const samplePending = this.sql
      .exec<{
        canonical_event_id: string;
        target_account_id: string;
        target_calendar_id: string;
        provider_event_id: string | null;
        last_write_ts: string | null;
        origin_account_id: string | null;
        start_ts: string | null;
        end_ts: string | null;
      }>(
        `SELECT
           m.canonical_event_id,
           m.target_account_id,
           m.target_calendar_id,
           m.provider_event_id,
           m.last_write_ts,
           c.origin_account_id,
           c.start_ts,
           c.end_ts
         FROM event_mirrors m
         LEFT JOIN canonical_events c
           ON c.canonical_event_id = m.canonical_event_id
         WHERE m.state = 'PENDING'
         ORDER BY COALESCE(m.last_write_ts, c.updated_at, c.created_at) ASC
         LIMIT ?`,
        safeSampleLimit,
      )
      .toArray();

    return {
      totals,
      pending_without_provider_event_id: pendingWithoutProvider,
      pending_with_provider_event_id: pendingWithProvider,
      pending_non_projectable: pendingNonProjectable,
      pending_past_window: Number(pendingWindow.past_window) || 0,
      pending_far_future_window: Number(pendingWindow.far_future_window) || 0,
      pending_in_window: Number(pendingWindow.in_window) || 0,
      oldest_pending_ts: oldestPendingTs,
      by_target: byTarget,
      sample_pending: samplePending,
    };
  }

  /**
   * Mark old PENDING mirrors as ACTIVE when they already have provider IDs.
   *
   * This is used to converge historical backlog after policy changes where
   * replaying years-old patches has low user value and high quota cost.
   */
  settleHistoricalPending(cutoffDays = 30): SettleHistoricalPendingResult {
    this.ensureMigrated();
    const safeDays = Number.isFinite(cutoffDays)
      ? Math.max(1, Math.min(3650, Math.trunc(cutoffDays)))
      : 30;
    const cutoffExpr = `-${safeDays} days`;

    const eligible = this.sql
      .exec<{ cnt: number }>(
        `SELECT COUNT(*) as cnt
         FROM event_mirrors m
         JOIN canonical_events c
           ON c.canonical_event_id = m.canonical_event_id
         WHERE m.state = 'PENDING'
           AND m.provider_event_id IS NOT NULL
           AND m.provider_event_id != ''
           AND c.end_ts IS NOT NULL
           AND c.end_ts != ''
           AND julianday(c.end_ts) <= julianday('now', ?)`,
        cutoffExpr,
      )
      .toArray()[0].cnt;

    if (eligible > 0) {
      const nowIso = new Date().toISOString();
      this.sql.exec(
        `UPDATE event_mirrors
         SET state = 'ACTIVE',
             error_message = NULL,
             last_write_ts = ?
         WHERE state = 'PENDING'
           AND provider_event_id IS NOT NULL
           AND provider_event_id != ''
           AND canonical_event_id IN (
             SELECT canonical_event_id
             FROM canonical_events
             WHERE end_ts IS NOT NULL
               AND end_ts != ''
               AND julianday(end_ts) <= julianday('now', ?)
           )`,
        nowIso,
        cutoffExpr,
      );
    }

    return {
      settled: eligible,
      cutoff_days: safeDays,
    };
  }

  /**
   * Mark out-of-window PENDING mirrors as ACTIVE when they already have
   * provider IDs.
   *
   * Window defaults:
   * - past: older than 30 days
   * - far future: more than 365 days ahead
   */
  settleOutOfWindowPending(
    pastDays = 30,
    futureDays = 365,
  ): SettleOutOfWindowPendingResult {
    this.ensureMigrated();

    const safePastDays = Number.isFinite(pastDays)
      ? Math.max(1, Math.min(3650, Math.trunc(pastDays)))
      : 30;
    const safeFutureDays = Number.isFinite(futureDays)
      ? Math.max(1, Math.min(36500, Math.trunc(futureDays)))
      : 365;
    const pastExpr = `-${safePastDays} days`;
    const futureExpr = `+${safeFutureDays} days`;

    const counts = this.sql
      .exec<{ past_cnt: number; future_cnt: number }>(
        `SELECT
           SUM(
             CASE
               WHEN julianday(c.end_ts) <= julianday('now', ?)
               THEN 1 ELSE 0
             END
           ) as past_cnt,
           SUM(
             CASE
               WHEN julianday(c.end_ts) >= julianday('now', ?)
               THEN 1 ELSE 0
             END
           ) as future_cnt
         FROM event_mirrors m
         JOIN canonical_events c
           ON c.canonical_event_id = m.canonical_event_id
         WHERE m.state = 'PENDING'
           AND m.provider_event_id IS NOT NULL
           AND m.provider_event_id != ''
           AND c.end_ts IS NOT NULL
           AND c.end_ts != ''
           AND (
             julianday(c.end_ts) <= julianday('now', ?)
             OR julianday(c.end_ts) >= julianday('now', ?)
           )`,
        pastExpr,
        futureExpr,
        pastExpr,
        futureExpr,
      )
      .toArray()[0] ?? { past_cnt: 0, future_cnt: 0 };

    const settledPast = Number(counts.past_cnt) || 0;
    const settledFuture = Number(counts.future_cnt) || 0;
    const totalSettled = settledPast + settledFuture;

    if (totalSettled > 0) {
      const nowIso = new Date().toISOString();
      this.sql.exec(
        `UPDATE event_mirrors
         SET state = 'ACTIVE',
             error_message = NULL,
             last_write_ts = ?
         WHERE state = 'PENDING'
           AND provider_event_id IS NOT NULL
           AND provider_event_id != ''
           AND canonical_event_id IN (
             SELECT canonical_event_id
             FROM canonical_events
             WHERE end_ts IS NOT NULL
               AND end_ts != ''
               AND (
                 julianday(end_ts) <= julianday('now', ?)
                 OR julianday(end_ts) >= julianday('now', ?)
               )
           )`,
        nowIso,
        pastExpr,
        futureExpr,
      );
    }

    return {
      settled: totalSettled,
      settled_past: settledPast,
      settled_far_future: settledFuture,
      past_days: safePastDays,
      future_days: safeFutureDays,
    };
  }

  /**
   * Mark aged PENDING mirrors as ACTIVE when a provider_event_id already
   * exists and no terminal error is recorded.
   *
   * This repairs mirrors that became permanently stuck in PENDING after
   * dropped/out-of-order queue messages.
   */
  settleStuckPending(minAgeMinutes = 120): SettleStuckPendingResult {
    this.ensureMigrated();
    const safeMinutes = Number.isFinite(minAgeMinutes)
      ? Math.max(1, Math.min(7 * 24 * 60, Math.trunc(minAgeMinutes)))
      : 120;
    const ageExpr = `-${safeMinutes} minutes`;

    const eligible = this.sql
      .exec<{ cnt: number }>(
        `SELECT COUNT(*) as cnt
         FROM event_mirrors
         WHERE state = 'PENDING'
           AND provider_event_id IS NOT NULL
           AND provider_event_id != ''
           AND (error_message IS NULL OR error_message = '')
           AND julianday(COALESCE(last_write_ts, '1970-01-01T00:00:00Z')) <= julianday('now', ?)`,
        ageExpr,
      )
      .toArray()[0]?.cnt ?? 0;

    if (eligible > 0) {
      const nowIso = new Date().toISOString();
      this.sql.exec(
        `UPDATE event_mirrors
         SET state = 'ACTIVE',
             error_message = NULL,
             last_write_ts = ?
         WHERE state = 'PENDING'
           AND provider_event_id IS NOT NULL
           AND provider_event_id != ''
           AND (error_message IS NULL OR error_message = '')
           AND julianday(COALESCE(last_write_ts, '1970-01-01T00:00:00Z')) <= julianday('now', ?)`,
        nowIso,
        ageExpr,
      );
    }

    return {
      settled: Number(eligible) || 0,
      min_age_minutes: safeMinutes,
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
    // Force requeue for non-ACTIVE mirrors so policy saves can recover
    // stale PENDING/ERROR rows that otherwise hash-skip forever.
    await this.recomputeProjections({ force_requeue_non_active: true });
  }

  /**
   * Ensure a default policy exists with bidirectional BUSY overlay edges
   * between all provided accounts.
   *
   * - Creates the default policy if it does not yet exist.
   * - Preserves any existing edge detail/calendar settings and only inserts
   *   missing edges as BUSY/BUSY_OVERLAY defaults.
   * - Calling with [A, B] then [A, B, C] extends to include C without
   *   resetting previously customized edges back to BUSY.
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

    // Build bidirectional edges between all distinct pairs.
    // Do NOT wipe existing edges -- preserve any customized detail_level
    // and calendar_kind choices that users previously set.
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
  // Constraint CRUD -- delegated to ConstraintMixin
  // -------------------------------------------------------------------------

  // ConstraintRow is now defined in constraint-mixin.ts.
  // VALID_CONSTRAINT_KINDS, all validators, and all CRUD methods are in ConstraintMixin.
  // Static validators are forwarded for backwards compatibility.

  static validateWorkingHoursConfig(configJson: Record<string, unknown>): void {
    ConstraintMixin.validateWorkingHoursConfig(configJson);
  }

  static validateBufferConfig(configJson: Record<string, unknown>): void {
    ConstraintMixin.validateBufferConfig(configJson);
  }

  static validateNoMeetingsAfterConfig(configJson: Record<string, unknown>): void {
    ConstraintMixin.validateNoMeetingsAfterConfig(configJson);
  }

  static validateOverrideConfig(configJson: Record<string, unknown>): void {
    ConstraintMixin.validateOverrideConfig(configJson);
  }

  static validateConstraintConfig(
    kind: string,
    configJson: Record<string, unknown>,
    activeFrom: string | null,
    activeTo: string | null,
  ): void {
    ConstraintMixin.validateConstraintConfig(kind, configJson, activeFrom, activeTo);
  }

  addConstraint(
    kind: string,
    configJson: Record<string, unknown>,
    activeFrom: string | null,
    activeTo: string | null,
  ): Constraint {
    return this.constraints.addConstraint(kind, configJson, activeFrom, activeTo);
  }

  async deleteConstraint(constraintId: string): Promise<boolean> {
    const result = await this.constraints.deleteConstraint(constraintId);
    // Drain outbox: constraint deletion may enqueue DELETE_MIRROR messages
    await this.drainOutbox();
    return result;
  }

  listConstraints(kind?: string): Constraint[] {
    return this.constraints.listConstraints(kind);
  }

  getConstraint(constraintId: string): Constraint | null {
    return this.constraints.getConstraint(constraintId);
  }

  async updateConstraint(
    constraintId: string,
    configJson: Record<string, unknown>,
    activeFrom: string | null,
    activeTo: string | null,
  ): Promise<Constraint | null> {
    const result = await this.constraints.updateConstraint(constraintId, configJson, activeFrom, activeTo);
    // Drain outbox: constraint update may enqueue DELETE_MIRROR messages
    await this.drainOutbox();
    return result;
  }

  // -------------------------------------------------------------------------
  // unlinkAccount -- Cascade deletion for account removal
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // GDPR Deletion Methods (full-user data erasure)
  // -------------------------------------------------------------------------

  /**
   * Delete ALL canonical events from this user's DO SQLite.
   *
   * Also deletes event_mirrors first (FK child rows) to satisfy
   * referential integrity. Step 2 (deleteAllMirrors) becomes a
   * safe no-op after this.
   *
   * Also deletes time_allocations which reference canonical_events.
   *
   * Idempotent: returns 0 if no events exist.
   */
  deleteAllEvents(): DeletionCounts {
    this.ensureMigrated();
    const count = this.sql
      .exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM canonical_events")
      .toArray()[0].cnt;
    // Delete FK children before parent rows
    this.sql.exec("DELETE FROM time_allocations");
    this.sql.exec("DELETE FROM event_mirrors");
    this.sql.exec("DELETE FROM canonical_events");
    return { deleted: count };
  }

  /**
   * Delete ALL event mirrors from this user's DO SQLite.
   * Idempotent: returns 0 if no mirrors exist.
   */
  deleteAllMirrors(): DeletionCounts {
    this.ensureMigrated();
    const count = this.sql
      .exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM event_mirrors")
      .toArray()[0].cnt;
    this.sql.exec("DELETE FROM event_mirrors");
    return { deleted: count };
  }

  /**
   * Delete ALL journal entries from this user's DO SQLite.
   * Idempotent: returns 0 if no journal entries exist.
   *
   * Note: this removes the audit trail as required by GDPR right-to-erasure.
   * The deletion certificate (generated separately) provides proof of deletion.
   */
  deleteJournal(): DeletionCounts {
    this.ensureMigrated();
    const count = this.sql
      .exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM event_journal")
      .toArray()[0].cnt;
    this.sql.exec("DELETE FROM event_journal");
    return { deleted: count };
  }

  /**
   * Delete ALL relationship, ledger, milestone, policy, calendar, constraint,
   * and scheduling data from this user's DO SQLite.
   *
   * Delegates to each domain mixin's deleteAll() method so that each domain
   * owns its own cleanup logic. Tables not yet covered by a mixin (policies,
   * policy_edges, calendars) are deleted directly.
   *
   * Idempotent: returns total rows deleted across all tables.
   */
  deleteRelationshipData(): DeletionCounts {
    this.ensureMigrated();

    let total = 0;

    // Delegate to domain mixins (each handles FK ordering internally)
    total += this.relationships.deleteAll();
    total += this.governance.deleteAll();
    total += this.scheduling.deleteAll();
    total += this.constraints.deleteAll();

    // Tables not yet owned by a mixin -- delete directly
    const coreTables = ["policy_edges", "policies", "calendars"];
    for (const table of coreTables) {
      const count = this.sql
        .exec<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${table}`)
        .toArray()[0].cnt;
      total += count;
    }
    this.sql.exec("DELETE FROM policy_edges");
    this.sql.exec("DELETE FROM policies");
    this.sql.exec("DELETE FROM calendars");

    return { deleted: total };
  }

  // -------------------------------------------------------------------------
  // Account unlinking (per-account, not full-user deletion)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Transactional outbox -- reliable queue message production (TM-66bw)
  // -------------------------------------------------------------------------

  /**
   * Write a queue message to the transactional outbox.
   *
   * This is a synchronous SQL INSERT that participates in the same implicit
   * SQLite transaction as the surrounding state changes. If the transaction
   * commits, the outbox entry is guaranteed to exist. If the DO is evicted
   * before drainOutbox() runs, the entry survives and will be drained on
   * next wake or by the requeuePendingMirrors sweep.
   */
  private writeOutbox(queueName: string, payload: unknown): void {
    const outboxId = `obx_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    this.sql.exec(
      `INSERT INTO outbox (outbox_id, queue_name, payload_json, created_at)
       VALUES (?, ?, ?, datetime('now'))`,
      outboxId,
      queueName,
      JSON.stringify(payload),
    );
  }

  /**
   * Drop an oversize UPSERT outbox entry when it is definitively stale.
   *
   * Safety rule:
   * - Only applies to UPSERT_MIRROR entries.
   * - Never drops entries whose mirror is still PENDING.
   */
  private dropStaleOversizeUpsertOutboxEntry(
    item: { outbox_id: string; payload: unknown },
    queueName: string,
  ): boolean {
    const payload = item.payload && typeof item.payload === "object"
      ? item.payload as {
        type?: unknown;
        canonical_event_id?: unknown;
        target_account_id?: unknown;
      }
      : null;

    if (
      !payload ||
      payload.type !== "UPSERT_MIRROR" ||
      typeof payload.canonical_event_id !== "string" ||
      typeof payload.target_account_id !== "string"
    ) {
      return false;
    }

    const mirrorRows = this.sql
      .exec<{ state: string }>(
        `SELECT state
         FROM event_mirrors
         WHERE canonical_event_id = ? AND target_account_id = ?`,
        payload.canonical_event_id,
        payload.target_account_id,
      )
      .toArray();
    const mirrorState = mirrorRows[0]?.state ?? null;

    if (mirrorState === "PENDING") {
      return false;
    }

    this.sql.exec(
      `DELETE FROM outbox WHERE outbox_id = ?`,
      item.outbox_id,
    );
    console.warn("user-graph: dropped stale oversize outbox entry", {
      queue_name: queueName,
      outbox_id: item.outbox_id,
      canonical_event_id: payload.canonical_event_id,
      target_account_id: payload.target_account_id,
      mirror_state: mirrorState,
    });
    return true;
  }

  /**
   * Drain unsent outbox entries by sending them to the appropriate queue,
   * then delete successfully sent entries.
   *
   * Called AFTER the implicit SQLite transaction commits (at the end of
   * each top-level mutation method). If a queue send fails, the outbox
   * entries remain and will be retried on next drain.
   *
   * Returns the number of entries successfully drained.
   */
  async drainOutbox(): Promise<number> {
    this.ensureMigrated();

    const entries = this.sql
      .exec<{ outbox_id: string; queue_name: string; payload_json: string }>(
        `SELECT outbox_id, queue_name, payload_json FROM outbox
         WHERE sent_at IS NULL
         ORDER BY created_at ASC`,
      )
      .toArray();

    if (entries.length === 0) return 0;

    // Group by queue_name for batch sending
    const byQueue = new Map<string, { outbox_id: string; payload: unknown }[]>();
    for (const entry of entries) {
      const group = byQueue.get(entry.queue_name) ?? [];
      group.push({
        outbox_id: entry.outbox_id,
        payload: JSON.parse(entry.payload_json),
      });
      byQueue.set(entry.queue_name, group);
    }

    let drained = 0;

    for (const [queueName, items] of byQueue) {
      const queue = queueName === "write" ? this.writeQueue : this.deleteQueue;
      let stopQueue = false;

      // Send in batches to respect queue limits
      for (let i = 0; i < items.length; i += WRITE_QUEUE_BATCH_SIZE) {
        if (stopQueue) break;
        const chunk = items.slice(i, i + WRITE_QUEUE_BATCH_SIZE);
        try {
          if (chunk.length === 1) {
            await queue.send(chunk[0].payload);
          } else {
            await queue.sendBatch(chunk.map((item) => ({ body: item.payload })));
          }
          // Delete successfully sent entries
          for (const item of chunk) {
            this.sql.exec(
              `DELETE FROM outbox WHERE outbox_id = ?`,
              item.outbox_id,
            );
          }
          drained += chunk.length;
        } catch (err) {
          const payloadTooLarge = isPayloadTooLargeError(err);
          if (payloadTooLarge && chunk.length > 1) {
            console.warn("user-graph: drainOutbox batch too large, falling back to single sends", {
              queue_name: queueName,
              batch_size: chunk.length,
            });

            for (const item of chunk) {
              try {
                await queue.send(item.payload);
                this.sql.exec(
                  `DELETE FROM outbox WHERE outbox_id = ?`,
                  item.outbox_id,
                );
                drained += 1;
              } catch (singleErr) {
                console.error("user-graph: drainOutbox single queue send failed", {
                  queue_name: queueName,
                  outbox_id: item.outbox_id,
                  error: singleErr instanceof Error ? singleErr.message : String(singleErr),
                });
                if (isPayloadTooLargeError(singleErr)) {
                  // Oversize UPSERT entries can become stale after newer writes
                  // converge. Drop only when mirror is not PENDING.
                  const dropped = this.dropStaleOversizeUpsertOutboxEntry(item, queueName);
                  if (dropped) {
                    continue;
                  }
                  continue;
                }
                // For transient queue failures, stop draining this queue so
                // the remaining entries can retry on a later pass.
                stopQueue = true;
                break;
              }
            }
            continue;
          }
          if (payloadTooLarge && chunk.length === 1) {
            const dropped = this.dropStaleOversizeUpsertOutboxEntry(
              chunk[0],
              queueName,
            );
            if (dropped) {
              continue;
            }
          }
          console.error("user-graph: drainOutbox queue send failed", {
            queue_name: queueName,
            batch_size: chunk.length,
            error: err instanceof Error ? err.message : String(err),
          });
          // Queue send failed -- entries remain in outbox for retry.
          // Break out of this queue's batches to avoid repeated failures.
          stopQueue = true;
        }
      }
    }

    return drained;
  }

  /**
   * Enqueue write-queue messages in bounded batches via the outbox.
   *
   * Durable Object account unlink can emit many DELETE_MIRROR messages.
   * Each message is written to the outbox synchronously in the current
   * transaction; drainOutbox() sends them after commit.
   */
  private enqueueWriteBatch(messages: unknown[]): void {
    for (const msg of messages) {
      this.writeOutbox("write", msg);
    }
  }

  /** Parse canonical event end timestamp for queue-priority/window decisions. */
  private parseCanonicalEventEndMs(event: CanonicalEvent): number | null {
    const end = event.end;
    const raw = end.dateTime ?? end.date;
    if (!raw) return null;
    const normalized = end.date ? `${raw}T00:00:00Z` : raw;
    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? ms : null;
  }

  /** True when event is outside the active sync optimization window. */
  private isOutOfWindowProjection(eventEndMs: number | null): boolean {
    if (eventEndMs === null) return false;
    const now = Date.now();
    const pastCutoff = now - OUT_OF_WINDOW_PAST_DAYS * 24 * 60 * 60 * 1000;
    const futureCutoff = now + OUT_OF_WINDOW_FUTURE_DAYS * 24 * 60 * 60 * 1000;
    return eventEndMs <= pastCutoff || eventEndMs >= futureCutoff;
  }

  /**
   * Write an upsert-mirror message to the outbox, routing to the priority
   * queue for near-term events.
   */
  private enqueueUpsertMirror(
    message: unknown,
    eventEndMs: number | null,
  ): void {
    const messageMeta = message && typeof message === "object"
      ? message as {
        canonical_event_id?: unknown;
        target_account_id?: unknown;
        type?: unknown;
      }
      : null;
    const canonicalEventId =
      typeof messageMeta?.canonical_event_id === "string"
        ? messageMeta.canonical_event_id
        : null;
    const targetAccountId =
      typeof messageMeta?.target_account_id === "string"
        ? messageMeta.target_account_id
        : null;

    if (eventEndMs !== null) {
      const now = Date.now();
      const lookback = now - UPSERT_PRIORITY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
      const lookahead = now + UPSERT_PRIORITY_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000;
      if (eventEndMs >= lookback && eventEndMs <= lookahead) {
        console.log("user-graph: enqueue UPSERT_MIRROR", {
          canonical_event_id: canonicalEventId,
          target_account_id: targetAccountId,
          queue: "delete_priority",
        });
        this.writeOutbox("delete", message);
        return;
      }
    }
    console.log("user-graph: enqueue UPSERT_MIRROR", {
      canonical_event_id: canonicalEventId,
      target_account_id: targetAccountId,
      queue: "write",
    });
    this.writeOutbox("write", message);
  }

  /**
   * Write a mirror deletion message to the outbox.
   * Targets the delete-priority queue during drain.
   */
  private enqueueDeleteMirror(message: unknown): void {
    this.writeOutbox("delete", message);
  }

  /**
   * Write mirror deletion messages to the outbox in bulk.
   * All entries target the delete-priority queue during drain.
   */
  private enqueueDeleteBatch(messages: unknown[]): void {
    for (const msg of messages) {
      this.writeOutbox("delete", msg);
    }
  }

  /**
   * Remove all data associated with an account from the UserGraphDO.
   *
   * Cascade order:
   * 1. Delete mirrors FROM this account (enqueue DELETE_MIRROR for each)
   * 2. Delete mirrors TO this account (remove mirror rows)
   * 3. Hard delete canonical events from this account (BR-7)
   * 4. Remove policy edges referencing this account
   * 5. Prune non-projectable mirrors for remaining events
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

    // Step 1: Delete mirrors FROM this account (set-based for scale)
    const outboundMirrors = this.sql
      .exec<EventMirrorRow>(
        `SELECT m.*
         FROM event_mirrors m
         JOIN canonical_events c
           ON c.canonical_event_id = m.canonical_event_id
         WHERE c.origin_account_id = ?`,
        accountId,
      )
      .toArray();

    const outboundDeletes = outboundMirrors.map((mirror) => ({
      type: "DELETE_MIRROR",
      canonical_event_id: mirror.canonical_event_id,
      target_account_id: mirror.target_account_id,
      target_calendar_id: mirror.target_calendar_id,
      provider_event_id: mirror.provider_event_id ?? "",
    }));
    this.enqueueDeleteBatch(outboundDeletes);
    mirrorsDeleted += outboundDeletes.length;

    // Soft-delete outbound mirrors: transition to DELETING for write-consumer
    this.sql.exec(
      `UPDATE event_mirrors SET state = 'DELETING'
       WHERE canonical_event_id IN (
         SELECT canonical_event_id
         FROM canonical_events
         WHERE origin_account_id = ?
       ) AND state NOT IN ('DELETED', 'TOMBSTONED')`,
      accountId,
    );
    // Remove terminal mirrors so canonical events can be hard-deleted
    this.sql.exec(
      `DELETE FROM event_mirrors
       WHERE canonical_event_id IN (
         SELECT canonical_event_id
         FROM canonical_events
         WHERE origin_account_id = ?
       ) AND state IN ('DELETED', 'TOMBSTONED')`,
      accountId,
    );

    // Step 2: Delete mirrors TO this account
    const inboundMirrors = this.sql
      .exec<EventMirrorRow>(
        `SELECT * FROM event_mirrors WHERE target_account_id = ?`,
        accountId,
      )
      .toArray();

    // Mirrors targeting the unlinked account do not need provider-side cleanup:
    // the account is being removed, and these overlays are no longer user-visible.
    // Removing them from UserGraphDO state is sufficient and avoids large delete storms.
    mirrorsDeleted += inboundMirrors.length;

    this.sql.exec(
      `DELETE FROM event_mirrors WHERE target_account_id = ?`,
      accountId,
    );

    // Step 3: Hard delete canonical events from this account (BR-7)
    eventsDeleted = this.sql
      .exec<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM canonical_events WHERE origin_account_id = ?`,
        accountId,
      )
      .toArray()[0].cnt;

    const deletePatchJson = JSON.stringify({
      reason: "account_unlinked",
      account_id: accountId,
    });
    this.sql.exec(
      `INSERT INTO event_journal (
         journal_id,
         canonical_event_id,
         actor,
         change_type,
         patch_json,
         reason
       )
       SELECT
         (? || ':' || canonical_event_id) as journal_id,
         canonical_event_id,
         'system',
         'deleted',
         ?,
         'account_unlinked'
       FROM canonical_events
       WHERE origin_account_id = ?`,
      `unlinkdel:${accountId}`,
      deletePatchJson,
      accountId,
    );

    // Hard delete canonical events that have no remaining DELETING mirrors.
    // Events with DELETING mirrors are retained until write-consumer processes them.
    this.sql.exec(
      `DELETE FROM canonical_events
       WHERE origin_account_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM event_mirrors
         WHERE event_mirrors.canonical_event_id = canonical_events.canonical_event_id
       )`,
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

    // Step 5: Prune non-projectable mirrors for remaining events.
    this.pruneNonProjectableMirrors();

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

    // Drain outbox: deliver queued messages after all state changes committed
    await this.drainOutbox();

    return {
      events_deleted: eventsDeleted,
      mirrors_deleted: mirrorsDeleted,
      policy_edges_removed: policyEdgesRemoved,
      calendars_removed: calendarsRemoved,
    };
  }

  // -------------------------------------------------------------------------
  // ICS Upgrade Flow (TM-1rs / TM-d17.5)
  // -------------------------------------------------------------------------

  /**
   * Get all canonical events belonging to a specific account.
   *
   * Used by the upgrade/downgrade flow to fetch current events from
   * an ICS feed account or OAuth account before planning the migration.
   *
   * Returns CanonicalEvent[] which satisfies both IcsEvent and ProviderEvent
   * shape expectations (the callers cast as needed).
   */
  private getAccountEvents(accountId: string): CanonicalEvent[] {
    this.ensureMigrated();

    const rows = this.sql
      .exec<CanonicalEventRow>(
        `SELECT * FROM canonical_events WHERE origin_account_id = ? ORDER BY start_ts ASC`,
        accountId,
      )
      .toArray();

    return rows.map((r) => this.rowToCanonicalEvent(r));
  }

  /**
   * Execute an ICS-to-OAuth upgrade plan within a single DO transaction.
   *
   * Steps:
   * 1. Delete all canonical events for the ICS account (they are being replaced)
   * 2. Upsert merged events (ICS events enriched with provider metadata)
   * 3. Upsert new provider events (events not in the ICS feed)
   * 4. Journal the upgrade operation
   *
   * Orphaned ICS events (in ICS but not matched to provider) are preserved
   * per BR-1 by re-inserting them under the OAuth account ID so they are
   * not lost during upgrade.
   *
   * Per ADR-5: every mutation produces a journal entry.
   */
  private async executeUpgradePlan(params: {
    ics_account_id: string;
    oauth_account_id: string;
    merged_events: MergedEvent[];
    new_events: UpgradeProviderEvent[];
    orphaned_events: UpgradeIcsEvent[];
  }): Promise<void> {
    this.ensureMigrated();

    // Step 1: Delete all canonical events for the ICS account
    const icsEvents = this.sql
      .exec<{ canonical_event_id: string }>(
        `SELECT canonical_event_id FROM canonical_events WHERE origin_account_id = ?`,
        params.ics_account_id,
      )
      .toArray();

    for (const evt of icsEvents) {
      // Clean up mirrors first (FK constraint)
      this.sql.exec(
        `DELETE FROM event_mirrors WHERE canonical_event_id = ?`,
        evt.canonical_event_id,
      );

      this.writeJournal(
        evt.canonical_event_id,
        "deleted",
        "upgrade",
        {
          reason: "ics_upgrade",
          ics_account_id: params.ics_account_id,
          oauth_account_id: params.oauth_account_id,
        },
        "ics_upgrade",
      );
    }

    this.sql.exec(
      `DELETE FROM canonical_events WHERE origin_account_id = ?`,
      params.ics_account_id,
    );

    // Step 2: Upsert merged events under the OAuth account
    for (const merged of params.merged_events) {
      const eventId = generateId("event");
      const startTs = merged.start.dateTime ?? merged.start.date ?? "";
      const endTs = merged.end.dateTime ?? merged.end.date ?? "";

      this.sql.exec(
        `INSERT INTO canonical_events (
          canonical_event_id, origin_account_id, origin_event_id,
          title, description, location, start_ts, end_ts, timezone,
          all_day, status, visibility, transparency, recurrence_rule,
          source, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
        eventId,
        merged.origin_account_id,
        merged.origin_event_id,
        merged.title ?? null,
        merged.description ?? null,
        merged.location ?? null,
        startTs,
        endTs,
        merged.start.timeZone ?? null,
        merged.all_day ? 1 : 0,
        merged.status ?? "confirmed",
        merged.visibility ?? "default",
        merged.transparency ?? "opaque",
        merged.recurrence_rule ?? null,
        merged.source,
      );

      this.writeJournal(
        eventId,
        "created",
        "upgrade",
        {
          reason: "ics_upgrade_merged",
          matched_by: merged.matched_by,
          confidence: merged.confidence,
          enriched_fields: merged.enriched_fields,
        },
        "ics_upgrade",
      );
    }

    // Step 3: Upsert new provider events (not in ICS feed)
    for (const newEvt of params.new_events) {
      const eventId = generateId("event");
      const startTs = newEvt.start.dateTime ?? newEvt.start.date ?? "";
      const endTs = newEvt.end.dateTime ?? newEvt.end.date ?? "";

      this.sql.exec(
        `INSERT INTO canonical_events (
          canonical_event_id, origin_account_id, origin_event_id,
          title, description, location, start_ts, end_ts, timezone,
          all_day, status, visibility, transparency, recurrence_rule,
          source, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
        eventId,
        newEvt.origin_account_id,
        newEvt.origin_event_id,
        newEvt.title ?? null,
        newEvt.description ?? null,
        newEvt.location ?? null,
        startTs,
        endTs,
        newEvt.start.timeZone ?? null,
        newEvt.all_day ? 1 : 0,
        newEvt.status ?? "confirmed",
        newEvt.visibility ?? "default",
        newEvt.transparency ?? "opaque",
        newEvt.recurrence_rule ?? null,
        newEvt.source,
      );

      this.writeJournal(
        eventId,
        "created",
        "upgrade",
        { reason: "ics_upgrade_new_provider_event" },
        "ics_upgrade",
      );
    }

    // Step 4: Preserve orphaned ICS events under the OAuth account
    // Per BR-1: all existing event data is preserved during upgrade
    for (const orphan of params.orphaned_events) {
      const eventId = generateId("event");
      const startTs = orphan.start.dateTime ?? orphan.start.date ?? "";
      const endTs = orphan.end.dateTime ?? orphan.end.date ?? "";

      this.sql.exec(
        `INSERT INTO canonical_events (
          canonical_event_id, origin_account_id, origin_event_id,
          title, description, location, start_ts, end_ts, timezone,
          all_day, status, visibility, transparency, recurrence_rule,
          source, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
        eventId,
        params.oauth_account_id,
        orphan.origin_event_id,
        orphan.title ?? null,
        orphan.description ?? null,
        orphan.location ?? null,
        startTs,
        endTs,
        orphan.start.timeZone ?? null,
        orphan.all_day ? 1 : 0,
        orphan.status ?? "confirmed",
        orphan.visibility ?? "default",
        orphan.transparency ?? "opaque",
        orphan.recurrence_rule ?? null,
        "ics_feed",
      );

      this.writeJournal(
        eventId,
        "created",
        "upgrade",
        {
          reason: "ics_upgrade_orphaned_preserved",
          original_account_id: orphan.origin_account_id,
        },
        "ics_upgrade",
      );
    }
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

  /**
   * Batch-store calendar entries for an account.
   * Called by OnboardingWorkflow after discovering primary + overlay calendars.
   */
  storeCalendars(
    calendars: ReadonlyArray<{
      account_id: string;
      provider_calendar_id: string;
      role: string;
      kind: string;
      display_name: string;
    }>,
  ): void {
    this.ensureMigrated();

    for (const cal of calendars) {
      const calendarId = generateId("calendar");
      this.sql.exec(
        `INSERT OR REPLACE INTO calendars
         (calendar_id, account_id, provider_calendar_id, role, kind, display_name)
         VALUES (?, ?, ?, ?, ?, ?)`,
        calendarId,
        cal.account_id,
        cal.provider_calendar_id,
        cal.role,
        cal.kind,
        cal.display_name,
      );
    }
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
   * Find canonical_event_id by mirror lookup keys.
   * Used when a provider reports deletion for a managed mirror event.
   *
   * TODO(Phase 3, TM-08pp): After cron migration canonicalizes all stored
   * provider_event_id values, remove the variant fallback below and use
   * exact-match only (single query, no decode/encode candidates).
   */
  findCanonicalByMirror(
    targetAccountId: string,
    providerEventId: string,
  ): string | null {
    this.ensureMigrated();

    const candidates = [providerEventId];
    if (providerEventId.includes("%")) {
      try {
        const decoded = decodeURIComponent(providerEventId);
        if (decoded.length > 0 && !candidates.includes(decoded)) {
          candidates.push(decoded);
        }
      } catch {
        // Ignore malformed escape sequences and continue with raw key.
      }
    }
    const encoded = providerEventId.includes("%")
      ? providerEventId
      : encodeURIComponent(providerEventId);
    if (!candidates.includes(encoded)) {
      candidates.push(encoded);
    }

    for (const candidate of candidates) {
      const rows = this.sql
        .exec<{ canonical_event_id: string }>(
          `SELECT canonical_event_id
           FROM event_mirrors
           WHERE target_account_id = ? AND provider_event_id = ?
           ORDER BY
             CASE state
               WHEN 'ACTIVE' THEN 0
               WHEN 'PENDING' THEN 1
               ELSE 2
             END,
             COALESCE(last_write_ts, '') DESC
           LIMIT 1`,
          targetAccountId,
          candidate,
        )
        .toArray();

      if (rows.length > 0) {
        return rows[0].canonical_event_id;
      }
    }

    return null;
  }

  /**
   * Batch-normalize provider_event_id values in canonical_events and
   * event_mirrors tables. Called by the daily cron reconciliation pass
   * to migrate existing data to canonical (fully-decoded) form.
   *
   * TM-08pp: Scans for rows containing '%' in origin_event_id /
   * provider_event_id, applies canonicalizeProviderEventId, and updates
   * in-place. Idempotent: rows already in canonical form are skipped.
   *
   * Returns the count of rows actually updated.
   */
  normalizeProviderEventIds(): number {
    this.ensureMigrated();

    let normalized = 0;

    // Normalize canonical_events.origin_event_id
    const canonicalRows = this.sql
      .exec<{ canonical_event_id: string; origin_event_id: string }>(
        `SELECT canonical_event_id, origin_event_id
         FROM canonical_events
         WHERE origin_event_id LIKE '%\\%%' ESCAPE '\\'`,
      )
      .toArray();

    for (const row of canonicalRows) {
      const canonical = canonicalizeProviderEventId(row.origin_event_id);
      if (canonical !== row.origin_event_id) {
        this.sql.exec(
          `UPDATE canonical_events
           SET origin_event_id = ?
           WHERE canonical_event_id = ?`,
          canonical,
          row.canonical_event_id,
        );
        normalized++;
      }
    }

    // Normalize event_mirrors.provider_event_id
    const mirrorRows = this.sql
      .exec<{
        canonical_event_id: string;
        target_account_id: string;
        provider_event_id: string;
      }>(
        `SELECT canonical_event_id, target_account_id, provider_event_id
         FROM event_mirrors
         WHERE provider_event_id LIKE '%\\%%' ESCAPE '\\'`,
      )
      .toArray();

    for (const row of mirrorRows) {
      const canonical = canonicalizeProviderEventId(row.provider_event_id);
      if (canonical !== row.provider_event_id) {
        this.sql.exec(
          `UPDATE event_mirrors
           SET provider_event_id = ?
           WHERE canonical_event_id = ? AND target_account_id = ?`,
          canonical,
          row.canonical_event_id,
          row.target_account_id,
        );
        normalized++;
      }
    }

    return normalized;
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
   * Get reconcile-eligible mirrors targeting a specific account.
   *
   * Default behavior returns ACTIVE rows only.
   * Optional mode includes PENDING rows that already have a provider_event_id,
   * which represent mirrors that were written upstream but may not yet have
   * converged back to ACTIVE state.
   */
  getActiveMirrors(
    targetAccountId: string,
    options: { includePendingWithProviderId?: boolean } = {},
  ): EventMirrorRow[] {
    this.ensureMigrated();

    if (options.includePendingWithProviderId) {
      return this.sql
        .exec<EventMirrorRow>(
          `SELECT * FROM event_mirrors
           WHERE target_account_id = ?
             AND (
               state = 'ACTIVE'
               OR (
                 state = 'PENDING'
                 AND provider_event_id IS NOT NULL
                 AND provider_event_id != ''
               )
             )`,
          targetAccountId,
        )
        .toArray();
    }

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
  // Governance -- delegated to GovernanceMixin
  // (All allocation, VIP policy, and commitment methods live in governance-mixin.ts)
  // -------------------------------------------------------------------------

  createAllocation(
    ...args: Parameters<GovernanceMixin["createAllocation"]>
  ): ReturnType<GovernanceMixin["createAllocation"]> {
    return this.governance.createAllocation(...args);
  }

  getAllocation(
    ...args: Parameters<GovernanceMixin["getAllocation"]>
  ): ReturnType<GovernanceMixin["getAllocation"]> {
    return this.governance.getAllocation(...args);
  }

  updateAllocation(
    ...args: Parameters<GovernanceMixin["updateAllocation"]>
  ): ReturnType<GovernanceMixin["updateAllocation"]> {
    return this.governance.updateAllocation(...args);
  }

  deleteAllocation(
    ...args: Parameters<GovernanceMixin["deleteAllocation"]>
  ): ReturnType<GovernanceMixin["deleteAllocation"]> {
    return this.governance.deleteAllocation(...args);
  }

  listAllocations(
    ...args: Parameters<GovernanceMixin["listAllocations"]>
  ): ReturnType<GovernanceMixin["listAllocations"]> {
    return this.governance.listAllocations(...args);
  }

  createVipPolicy(
    ...args: Parameters<GovernanceMixin["createVipPolicy"]>
  ): ReturnType<GovernanceMixin["createVipPolicy"]> {
    return this.governance.createVipPolicy(...args);
  }

  listVipPolicies(
    ...args: Parameters<GovernanceMixin["listVipPolicies"]>
  ): ReturnType<GovernanceMixin["listVipPolicies"]> {
    return this.governance.listVipPolicies(...args);
  }

  getVipPolicy(
    ...args: Parameters<GovernanceMixin["getVipPolicy"]>
  ): ReturnType<GovernanceMixin["getVipPolicy"]> {
    return this.governance.getVipPolicy(...args);
  }

  deleteVipPolicy(
    ...args: Parameters<GovernanceMixin["deleteVipPolicy"]>
  ): ReturnType<GovernanceMixin["deleteVipPolicy"]> {
    return this.governance.deleteVipPolicy(...args);
  }

  createCommitment(
    ...args: Parameters<GovernanceMixin["createCommitment"]>
  ): ReturnType<GovernanceMixin["createCommitment"]> {
    return this.governance.createCommitment(...args);
  }

  getCommitment(
    ...args: Parameters<GovernanceMixin["getCommitment"]>
  ): ReturnType<GovernanceMixin["getCommitment"]> {
    return this.governance.getCommitment(...args);
  }

  listCommitments(
    ...args: Parameters<GovernanceMixin["listCommitments"]>
  ): ReturnType<GovernanceMixin["listCommitments"]> {
    return this.governance.listCommitments(...args);
  }

  deleteCommitment(
    ...args: Parameters<GovernanceMixin["deleteCommitment"]>
  ): ReturnType<GovernanceMixin["deleteCommitment"]> {
    return this.governance.deleteCommitment(...args);
  }

  getCommitmentStatus(
    ...args: Parameters<GovernanceMixin["getCommitmentStatus"]>
  ): ReturnType<GovernanceMixin["getCommitmentStatus"]> {
    return this.governance.getCommitmentStatus(...args);
  }

  getCommitmentProofData(
    ...args: Parameters<GovernanceMixin["getCommitmentProofData"]>
  ): ReturnType<GovernanceMixin["getCommitmentProofData"]> {
    return this.governance.getCommitmentProofData(...args);
  }

  // -------------------------------------------------------------------------
  // What-If Simulation -- delegated to AnalyticsMixin
  // -------------------------------------------------------------------------

  buildSimulationSnapshot(
    ...args: Parameters<AnalyticsMixin["buildSimulationSnapshot"]>
  ): ReturnType<AnalyticsMixin["buildSimulationSnapshot"]> {
    return this.analytics.buildSimulationSnapshot(...args);
  }

  // -------------------------------------------------------------------------
  // Relationship tracking -- delegated to RelationshipMixin
  // (All relationship, interaction ledger, milestone, participant, drift-alert,
  //  scheduling-history, and briefing methods live in relationship-mixin.ts)
  // -------------------------------------------------------------------------

  createRelationship(
    ...args: Parameters<RelationshipMixin["createRelationship"]>
  ): ReturnType<RelationshipMixin["createRelationship"]> {
    return this.relationships.createRelationship(...args);
  }

  getRelationship(
    ...args: Parameters<RelationshipMixin["getRelationship"]>
  ): ReturnType<RelationshipMixin["getRelationship"]> {
    return this.relationships.getRelationship(...args);
  }

  listRelationships(
    ...args: Parameters<RelationshipMixin["listRelationships"]>
  ): ReturnType<RelationshipMixin["listRelationships"]> {
    return this.relationships.listRelationships(...args);
  }

  updateRelationship(
    ...args: Parameters<RelationshipMixin["updateRelationship"]>
  ): ReturnType<RelationshipMixin["updateRelationship"]> {
    return this.relationships.updateRelationship(...args);
  }

  deleteRelationship(
    ...args: Parameters<RelationshipMixin["deleteRelationship"]>
  ): ReturnType<RelationshipMixin["deleteRelationship"]> {
    return this.relationships.deleteRelationship(...args);
  }

  markOutcome(
    ...args: Parameters<RelationshipMixin["markOutcome"]>
  ): ReturnType<RelationshipMixin["markOutcome"]> {
    return this.relationships.markOutcome(...args);
  }

  listOutcomes(
    ...args: Parameters<RelationshipMixin["listOutcomes"]>
  ): ReturnType<RelationshipMixin["listOutcomes"]> {
    return this.relationships.listOutcomes(...args);
  }

  getTimeline(
    ...args: Parameters<RelationshipMixin["getTimeline"]>
  ): ReturnType<RelationshipMixin["getTimeline"]> {
    return this.relationships.getTimeline(...args);
  }

  getReputation(
    ...args: Parameters<RelationshipMixin["getReputation"]>
  ): ReturnType<RelationshipMixin["getReputation"]> {
    return this.relationships.getReputation(...args);
  }

  listRelationshipsWithReputation(
    ...args: Parameters<RelationshipMixin["listRelationshipsWithReputation"]>
  ): ReturnType<RelationshipMixin["listRelationshipsWithReputation"]> {
    return this.relationships.listRelationshipsWithReputation(...args);
  }

  getDriftReport(
    ...args: Parameters<RelationshipMixin["getDriftReport"]>
  ): ReturnType<RelationshipMixin["getDriftReport"]> {
    return this.relationships.getDriftReport(...args);
  }

  getReconnectionSuggestions(
    ...args: Parameters<RelationshipMixin["getReconnectionSuggestions"]>
  ): ReturnType<RelationshipMixin["getReconnectionSuggestions"]> {
    return this.relationships.getReconnectionSuggestions(...args);
  }

  createMilestone(
    ...args: Parameters<RelationshipMixin["createMilestone"]>
  ): ReturnType<RelationshipMixin["createMilestone"]> {
    return this.relationships.createMilestone(...args);
  }

  listMilestones(
    ...args: Parameters<RelationshipMixin["listMilestones"]>
  ): ReturnType<RelationshipMixin["listMilestones"]> {
    return this.relationships.listMilestones(...args);
  }

  deleteMilestone(
    ...args: Parameters<RelationshipMixin["deleteMilestone"]>
  ): ReturnType<RelationshipMixin["deleteMilestone"]> {
    return this.relationships.deleteMilestone(...args);
  }

  listUpcomingMilestones(
    ...args: Parameters<RelationshipMixin["listUpcomingMilestones"]>
  ): ReturnType<RelationshipMixin["listUpcomingMilestones"]> {
    return this.relationships.listUpcomingMilestones(...args);
  }

  updateInteractions(
    ...args: Parameters<RelationshipMixin["updateInteractions"]>
  ): ReturnType<RelationshipMixin["updateInteractions"]> {
    return this.relationships.updateInteractions(...args);
  }

  storeEventParticipants(
    ...args: Parameters<RelationshipMixin["storeEventParticipants"]>
  ): ReturnType<RelationshipMixin["storeEventParticipants"]> {
    return this.relationships.storeEventParticipants(...args);
  }

  getEventParticipantHashes(
    ...args: Parameters<RelationshipMixin["getEventParticipantHashes"]>
  ): ReturnType<RelationshipMixin["getEventParticipantHashes"]> {
    return this.relationships.getEventParticipantHashes(...args);
  }

  recordSchedulingHistory(
    ...args: Parameters<RelationshipMixin["recordSchedulingHistory"]>
  ): ReturnType<RelationshipMixin["recordSchedulingHistory"]> {
    return this.relationships.recordSchedulingHistory(...args);
  }

  getSchedulingHistory(
    ...args: Parameters<RelationshipMixin["getSchedulingHistory"]>
  ): ReturnType<RelationshipMixin["getSchedulingHistory"]> {
    return this.relationships.getSchedulingHistory(...args);
  }

  getEventBriefing(
    ...args: Parameters<RelationshipMixin["getEventBriefing"]>
  ): ReturnType<RelationshipMixin["getEventBriefing"]> {
    return this.relationships.getEventBriefing(...args);
  }

  storeDriftAlerts(
    ...args: Parameters<RelationshipMixin["storeDriftAlerts"]>
  ): ReturnType<RelationshipMixin["storeDriftAlerts"]> {
    return this.relationships.storeDriftAlerts(...args);
  }

  getDriftAlerts(
    ...args: Parameters<RelationshipMixin["getDriftAlerts"]>
  ): ReturnType<RelationshipMixin["getDriftAlerts"]> {
    return this.relationships.getDriftAlerts(...args);
  }

  // -------------------------------------------------------------------------
  // fetch() handler -- RPC-style routing for DO stub communication
  // -------------------------------------------------------------------------

  /** Handler function type: receives the parsed JSON body, returns a Response. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private routeMap: Record<string, (body: any) => Response | Promise<Response>> | null = null;

  /**
   * Build the route dispatch map. Lazily initialized on first request.
   * Each handler receives the parsed JSON body (or undefined for bodyless
   * routes) and returns a Response directly, preserving exact response
   * shapes per route.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildRouteMap(): Record<string, (body: any) => Response | Promise<Response>> {
    return {
      // --- Core sync & event store ---

      "/applyProviderDelta": async (body) => {
        // TM-08pp: Defense-in-depth canonicalization of provider event IDs.
        // Primary normalization happens at sync-consumer ingestion; this
        // ensures canonical form even for direct DO callers.
        const canonicalizedDeltas = body.deltas.map((d: ProviderDelta) => ({
          ...d,
          origin_event_id: canonicalizeProviderEventId(d.origin_event_id),
        }));
        const result = await this.applyProviderDelta(body.account_id, canonicalizedDeltas);
        return Response.json(result);
      },

      "/getMirror": (body) => {
        const mirror = this.getMirror(body.canonical_event_id, body.target_account_id);
        return Response.json({ mirror });
      },

      "/updateMirrorState": (body) => {
        this.updateMirrorState(body.canonical_event_id, body.target_account_id, body.update);
        return Response.json({ ok: true });
      },

      "/getBusyOverlayCalendar": (body) => {
        const calId = this.getBusyOverlayCalendar(body.account_id);
        return Response.json({ provider_calendar_id: calId });
      },

      "/storeBusyOverlayCalendar": (body) => {
        this.storeBusyOverlayCalendar(body.account_id, body.provider_calendar_id);
        return Response.json({ ok: true });
      },

      "/storeCalendars": (body) => {
        this.storeCalendars(body.calendars);
        return Response.json({ ok: true, stored: body.calendars.length });
      },

      "/listCanonicalEvents": (body) => {
        const result = this.listCanonicalEvents(body);
        return Response.json(result);
      },

      "/getCanonicalEvent": (body) => {
        const result = this.getCanonicalEvent(body.canonical_event_id);
        return Response.json(result);
      },

      "/upsertCanonicalEvent": async (body) => {
        const eventId = await this.upsertCanonicalEvent(body.event, body.source);
        return Response.json(eventId);
      },

      "/deleteCanonicalEvent": async (body) => {
        const deleted = await this.deleteCanonicalEvent(body.canonical_event_id, body.source);
        return Response.json(deleted);
      },

      "/queryJournal": (body) => {
        const result = this.queryJournal(body);
        return Response.json(result);
      },

      "/getEventConflicts": (body) => {
        const result = this.getEventConflicts(body);
        return Response.json(result);
      },

      "/getSyncHealth": () => {
        const result = this.getSyncHealth();
        return Response.json(result);
      },

      "/listErrorMirrors": (body) => {
        const items = this.listErrorMirrors(body?.limit);
        return Response.json({ items });
      },

      "/getMirrorDiagnostics": (body) => {
        const diagnostics = this.getMirrorDiagnostics(body?.sample_limit ?? 25);
        return Response.json(diagnostics);
      },

      "/settleHistoricalPending": (body) => {
        const result = this.settleHistoricalPending(body?.cutoff_days ?? 30);
        return Response.json(result);
      },

      "/settleOutOfWindowPending": (body) => {
        const result = this.settleOutOfWindowPending(
          body?.past_days ?? 30,
          body?.future_days ?? 365,
        );
        return Response.json(result);
      },

      "/settleStuckPending": (body) => {
        const result = this.settleStuckPending(body?.min_age_minutes ?? 120);
        return Response.json(result);
      },

      // --- Policy management ---

      "/createPolicy": async (body) => {
        const result = await this.createPolicy(body.name);
        return Response.json(result);
      },

      "/getPolicy": async (body) => {
        const result = await this.getPolicy(body.policy_id);
        return Response.json(result);
      },

      "/listPolicies": async () => {
        const result = await this.listPolicies();
        return Response.json(result);
      },

      "/setPolicyEdges": async (body) => {
        await this.setPolicyEdges(body.policy_id, body.edges);
        return Response.json({ ok: true });
      },

      "/ensureDefaultPolicy": async (body) => {
        await this.ensureDefaultPolicy(body.accounts);
        return Response.json({ ok: true });
      },

      // --- ReconcileWorkflow RPC endpoints ---

      "/findCanonicalByOrigin": (body) => {
        const event = this.findCanonicalByOrigin(body.origin_account_id, body.origin_event_id);
        return Response.json({ event });
      },

      "/findCanonicalByMirror": (body) => {
        const canonicalEventId = this.findCanonicalByMirror(
          body.target_account_id,
          body.provider_event_id,
        );
        return Response.json({ canonical_event_id: canonicalEventId });
      },

      "/getPolicyEdges": (body) => {
        const edges = this.getPolicyEdges(body.from_account_id);
        return Response.json({ edges });
      },

      "/getActiveMirrors": (body) => {
        const mirrors = this.getActiveMirrors(body.target_account_id, {
          includePendingWithProviderId:
            body?.include_pending_with_provider_id === true,
        });
        return Response.json({ mirrors });
      },

      "/logReconcileDiscrepancy": (body) => {
        this.logReconcileDiscrepancy(body.canonical_event_id, body.discrepancy_type, body.details);
        return Response.json({ ok: true });
      },

      "/recomputeProjections": async (body) => {
        const enqueued = await this.recomputeProjections(body);
        return Response.json({ enqueued });
      },

      "/requeuePendingMirrors": async (body) => {
        const result = await this.requeuePendingMirrors(body?.limit ?? 200);
        return Response.json(result);
      },

      "/requeueDeletingMirrors": async (body) => {
        const result = await this.requeueDeletingMirrors(body?.limit ?? 1);
        return Response.json(result);
      },

      "/retryErrorMirror": async (body) => {
        const result = await this.retryErrorMirror(
          body.canonical_event_id,
          body.target_account_id,
        );
        return Response.json(result);
      },

      // --- Analytics ---

      "/computeAvailability": (body) => {
        const result = this.computeAvailability(body);
        return Response.json(result);
      },

      "/getCognitiveLoad": (body) => {
        const result = this.getCognitiveLoad(body.date, body.range);
        return Response.json(result);
      },

      "/getContextSwitches": (body) => {
        const result = this.getContextSwitches(body.date, body.range);
        return Response.json(result);
      },

      "/getDeepWork": (body) => {
        const result = this.getDeepWork(body.date, body.range, body.min_block_minutes);
        return Response.json(result);
      },

      "/getRiskScores": (body) => {
        const result = this.getRiskScores(body.weeks ?? 4);
        return Response.json(result);
      },

      "/getProbabilisticAvailability": (body) => {
        const result = this.getProbabilisticAvailability(
          body.start,
          body.end,
          body.granularity_minutes,
        );
        return Response.json(result);
      },

      // --- Constraint RPC endpoints ---

      "/addConstraint": (body) => {
        const constraint = this.constraints.addConstraint(
          body.kind,
          body.config_json,
          body.active_from,
          body.active_to,
        );
        return Response.json(constraint);
      },

      "/deleteConstraint": async (body) => {
        const deleted = await this.constraints.deleteConstraint(body.constraint_id);
        return Response.json({ deleted });
      },

      "/listConstraints": (body) => {
        const constraintItems = this.constraints.listConstraints(body.kind);
        return Response.json({ items: constraintItems });
      },

      "/getConstraint": (body) => {
        const constraint = this.constraints.getConstraint(body.constraint_id);
        return Response.json(constraint);
      },

      "/updateConstraint": async (body) => {
        const updated = await this.constraints.updateConstraint(
          body.constraint_id,
          body.config_json,
          body.active_from,
          body.active_to,
        );
        return Response.json(updated);
      },

      "/unlinkAccount": async (body) => {
        const result = await this.unlinkAccount(body.account_id);
        return Response.json(result);
      },

      // --- GDPR Deletion RPC endpoints ---

      "/deleteAllEvents": () => {
        const result = this.deleteAllEvents();
        return Response.json(result);
      },

      "/deleteAllMirrors": () => {
        const result = this.deleteAllMirrors();
        return Response.json(result);
      },

      "/deleteJournal": () => {
        const result = this.deleteJournal();
        return Response.json(result);
      },

      "/deleteRelationshipData": () => {
        const result = this.deleteRelationshipData();
        return Response.json(result);
      },

      // --- Scheduling RPC endpoints (Phase 3) ---

      "/storeSchedulingSession": (body) => {
        this.scheduling.storeSchedulingSession(body);
        return Response.json({ ok: true });
      },

      "/getSchedulingSession": (body) => {
        const session = this.scheduling.getSchedulingSession(body.session_id);
        return Response.json(session);
      },

      "/commitSchedulingSession": (body) => {
        this.scheduling.commitSchedulingSession(body.session_id, body.candidate_id, body.event_id);
        return Response.json({ ok: true });
      },

      "/listSchedulingSessions": (body) => {
        const sessions = this.scheduling.listSchedulingSessions(body.status, body.limit, body.offset);
        return Response.json(sessions);
      },

      "/cancelSchedulingSession": (body) => {
        this.scheduling.cancelSchedulingSession(body.session_id);
        return Response.json({ ok: true });
      },

      "/expireStaleSchedulingSessions": (body) => {
        const count = this.scheduling.expireStaleSchedulingSessions(body.max_age_hours);
        return Response.json({ expired_count: count });
      },

      // --- Hold management RPC endpoints (TM-946.3) ---

      "/storeHolds": (body) => {
        this.scheduling.storeHolds(body.holds);
        return Response.json({ ok: true });
      },

      "/getHoldsBySession": (body) => {
        const holds = this.scheduling.getHoldsBySession(body.session_id);
        return Response.json({ holds });
      },

      "/updateHoldStatus": (body) => {
        this.scheduling.updateHoldStatus(body.hold_id, body.status, body.provider_event_id);
        return Response.json({ ok: true });
      },

      "/getExpiredHolds": () => {
        const holds = this.scheduling.getExpiredHolds();
        return Response.json({ holds });
      },

      "/commitSessionHolds": (body) => {
        const holds = this.scheduling.commitSessionHolds(body.session_id, body.committed_candidate_id);
        return Response.json({ holds });
      },

      "/releaseSessionHolds": (body) => {
        this.scheduling.releaseSessionHolds(body.session_id);
        return Response.json({ ok: true });
      },

      "/extendHolds": (body) => {
        const extended = this.scheduling.extendHolds(body.session_id, body.holds);
        return Response.json({ ok: true, extended });
      },

      "/expireSessionIfAllHoldsTerminal": (body) => {
        const expired = this.scheduling.expireSessionIfAllHoldsTerminal(body.session_id);
        return Response.json({ ok: true, expired });
      },

      // --- Time allocation RPC endpoints ---

      "/createAllocation": (body) => {
        const alloc = this.governance.createAllocation(
          body.allocation_id,
          body.canonical_event_id,
          body.billing_category,
          body.client_id,
          body.rate,
        );
        return Response.json(alloc);
      },

      "/getAllocation": (body) => {
        const alloc = this.governance.getAllocation(body.canonical_event_id);
        return Response.json(alloc);
      },

      "/updateAllocation": (body) => {
        const alloc = this.governance.updateAllocation(body.canonical_event_id, body.updates);
        return Response.json(alloc);
      },

      "/deleteAllocation": (body) => {
        const deleted = this.governance.deleteAllocation(body.canonical_event_id);
        return Response.json({ deleted });
      },

      "/listAllocations": () => {
        const items = this.governance.listAllocations();
        return Response.json({ items });
      },

      // --- VIP policy RPC endpoints ---

      "/createVipPolicy": (body) => {
        const vip = this.governance.createVipPolicy(
          body.vip_id,
          body.participant_hash,
          body.display_name,
          body.priority_weight,
          body.conditions_json,
        );
        return Response.json(vip);
      },

      "/listVipPolicies": () => {
        const items = this.governance.listVipPolicies();
        return Response.json({ items });
      },

      "/getVipPolicy": (body) => {
        const vip = this.governance.getVipPolicy(body.vip_id);
        return Response.json(vip);
      },

      "/deleteVipPolicy": (body) => {
        const deleted = this.governance.deleteVipPolicy(body.vip_id);
        return Response.json({ deleted });
      },

      // --- Commitment tracking RPC endpoints ---

      "/createCommitment": (body) => {
        const commitment = this.governance.createCommitment(
          body.commitment_id,
          body.client_id,
          body.target_hours,
          body.window_type ?? "WEEKLY",
          body.client_name ?? null,
          body.rolling_window_weeks ?? 4,
          body.hard_minimum ?? false,
          body.proof_required ?? false,
        );
        return Response.json(commitment);
      },

      "/getCommitment": (body) => {
        const commitment = this.governance.getCommitment(body.commitment_id);
        return Response.json(commitment);
      },

      "/listCommitments": () => {
        const items = this.governance.listCommitments();
        return Response.json({ items });
      },

      "/deleteCommitment": (body) => {
        const deleted = this.governance.deleteCommitment(body.commitment_id);
        return Response.json({ deleted });
      },

      "/getCommitmentStatus": (body) => {
        const status = this.governance.getCommitmentStatus(body.commitment_id, body.as_of);
        return Response.json(status);
      },

      "/getCommitmentProofData": (body) => {
        const proofData = this.governance.getCommitmentProofData(body.commitment_id, body.as_of);
        return Response.json(proofData);
      },

      // --- What-If Simulation RPC endpoint ---

      "/simulate": (body) => {
        const snapshot = this.buildSimulationSnapshot();
        const impact = simulate(snapshot, body.scenario);
        return Response.json(impact);
      },

      // --- Relationship tracking RPC endpoints (Phase 4) ---

      "/createRelationship": (body) => {
        const relationship = this.relationships.createRelationship(
          body.relationship_id,
          body.participant_hash,
          body.display_name,
          body.category,
          body.closeness_weight ?? 0.5,
          body.city ?? null,
          body.timezone ?? null,
          body.interaction_frequency_target ?? null,
        );
        return Response.json(relationship);
      },

      "/getRelationship": (body) => {
        const relationship = this.relationships.getRelationship(body.relationship_id);
        return Response.json(relationship);
      },

      "/listRelationships": (body) => {
        const items = this.relationships.listRelationships(body.category);
        return Response.json({ items });
      },

      "/updateRelationship": (body) => {
        const { relationship_id, ...updates } = body;
        const updated = this.relationships.updateRelationship(relationship_id, updates);
        return Response.json(updated);
      },

      "/deleteRelationship": (body) => {
        const deleted = this.relationships.deleteRelationship(body.relationship_id);
        return Response.json({ deleted });
      },

      "/markOutcome": (body) => {
        const entry = this.relationships.markOutcome(
          body.relationship_id,
          body.outcome,
          body.canonical_event_id ?? null,
          body.note ?? null,
        );
        return Response.json(entry);
      },

      "/listOutcomes": (body) => {
        const entries = this.relationships.listOutcomes(body.relationship_id, body.outcome);
        return Response.json({ items: entries });
      },

      "/getReputation": (body) => {
        const reputation = this.relationships.getReputation(body.relationship_id, body.as_of);
        return Response.json(reputation);
      },

      "/listRelationshipsWithReputation": (body) => {
        const items = this.relationships.listRelationshipsWithReputation(body.as_of);
        return Response.json({ items });
      },

      "/getDriftReport": (body) => {
        const report = this.relationships.getDriftReport(body.as_of);
        return Response.json(report);
      },

      "/getReconnectionSuggestions": (body) => {
        const suggestions = this.relationships.getReconnectionSuggestions(
          body?.city ?? null,
          body?.trip_id ?? null,
        );
        return Response.json(suggestions);
      },

      // --- Milestone CRUD RPC endpoints (Phase 4B) ---

      "/createMilestone": (body) => {
        const milestone = this.relationships.createMilestone(
          body.milestone_id,
          body.relationship_id,
          body.kind,
          body.date,
          body.recurs_annually ?? false,
          body.note ?? null,
        );
        return Response.json(milestone);
      },

      "/listMilestones": (body) => {
        const milestones = this.relationships.listMilestones(body.relationship_id);
        if (milestones === null) {
          return Response.json({ error: "Relationship not found" }, { status: 404 });
        }
        return Response.json({ items: milestones });
      },

      "/deleteMilestone": (body) => {
        const deleted = this.relationships.deleteMilestone(body.milestone_id);
        return Response.json({ deleted });
      },

      "/listUpcomingMilestones": (body) => {
        const upcoming = this.relationships.listUpcomingMilestones(body.max_days ?? 30);
        return Response.json({ items: upcoming });
      },

      "/updateInteractions": (body) => {
        const count = this.relationships.updateInteractions(
          body.participant_hashes,
          body.interaction_ts,
        );
        return Response.json({ updated: count });
      },

      "/storeDriftAlerts": (body) => {
        const count = this.relationships.storeDriftAlerts(body.report);
        return Response.json({ stored: count });
      },

      "/getDriftAlerts": () => {
        const alerts = this.relationships.getDriftAlerts();
        return Response.json({ alerts });
      },

      "/getEventBriefing": (body) => {
        const briefing = this.relationships.getEventBriefing(body.canonical_event_id);
        if (briefing === null) {
          return Response.json({ error: "Event not found" }, { status: 404 });
        }
        return Response.json(briefing);
      },

      "/storeEventParticipants": (body) => {
        this.relationships.storeEventParticipants(body.canonical_event_id, body.participant_hashes);
        return Response.json({ stored: body.participant_hashes.length });
      },

      "/recordSchedulingHistory": (body) => {
        this.relationships.recordSchedulingHistory(body.entries);
        return Response.json({ recorded: body.entries.length });
      },

      "/getSchedulingHistory": (body) => {
        const history = this.relationships.getSchedulingHistory(body.participant_hashes);
        return Response.json({ history });
      },

      // --- Graph API RPC endpoints (TM-b3i.4) ---

      "/getEventParticipantHashes": (body) => {
        const hashes = this.relationships.getEventParticipantHashes(body.canonical_event_id);
        return Response.json({ hashes });
      },

      "/getTimeline": (body) => {
        const items = this.relationships.getTimeline(
          body.participant_hash,
          body.start_date,
          body.end_date,
        );
        return Response.json({ items });
      },

      // --- Onboarding session RPC endpoints (Phase 6A) ---

      "/createOnboardingSession": (body) => {
        const session = this.createOnboardingSession(body.session_id, body.user_id, body.session_token);
        return Response.json(session);
      },

      "/getOnboardingSession": (body) => {
        const session = this.getOnboardingSession(body.user_id);
        return Response.json(session);
      },

      "/getOnboardingSessionByToken": (body) => {
        const session = this.getOnboardingSessionByToken(body.session_token);
        return Response.json(session);
      },

      "/addOnboardingAccount": (body) => {
        const session = this.addOnboardingAccount(body.user_id, body.account);
        return Response.json(session);
      },

      "/updateOnboardingAccountStatus": (body) => {
        const session = this.updateOnboardingAccountStatus(
          body.user_id,
          body.account_id,
          body.status,
          body.calendar_count,
        );
        return Response.json(session);
      },

      "/completeOnboardingSession": (body) => {
        const session = this.completeOnboardingSession(body.user_id);
        return Response.json(session);
      },

      // --- ICS Upgrade Flow RPC endpoints (TM-1rs / TM-d17.5) ---

      "/getAccountEvents": (body) => {
        const events = this.getAccountEvents(body.account_id);
        return Response.json({ events });
      },

      "/executeUpgrade": async (body) => {
        await this.executeUpgradePlan(body);
        return Response.json({ ok: true });
      },

      // --- TM-08pp: Provider event ID normalization (batch migration) ---

      "/normalizeProviderEventIds": () => {
        const normalized = this.normalizeProviderEventIds();
        return Response.json({ normalized });
      },
    };
  }

  /**
   * Handle fetch requests from DO stubs. Routes requests by URL pathname
   * to the appropriate method via the dispatch map.
   *
   * This is the entry point for all inter-worker communication with
   * UserGraphDO. Workers call `stub.fetch(new Request(url, { body }))`.
   */
  async handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // Lazily initialize route map on first request
    if (!this.routeMap) {
      this.routeMap = this.buildRouteMap();
    }

    const handler = this.routeMap[pathname];
    if (!handler) {
      return new Response(`Unknown action: ${pathname}`, { status: 404 });
    }

    try {
      // Parse body once; bodyless routes receive undefined (handlers
      // that don't use the parameter simply ignore it).
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        // No body or invalid JSON -- pass undefined
        body = undefined;
      }
      return await handler(body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 500 });
    }
  }

  // -------------------------------------------------------------------------
  // Scheduling session and hold management (Phase 3 / TM-946.3)
  // Delegated to SchedulingMixin -- see scheduling-mixin.ts
  // -------------------------------------------------------------------------

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
    conflictType?: string,
    resolution?: string,
  ): void {
    const journalId = generateId("journal");
    this.sql.exec(
      `INSERT INTO event_journal (
        journal_id, canonical_event_id, ts, actor, change_type, patch_json, reason,
        conflict_type, resolution
      ) VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?, ?)`,
      journalId,
      canonicalEventId,
      actor,
      changeType,
      JSON.stringify(patch),
      reason ?? null,
      conflictType ?? "none",
      resolution ?? null,
    );
  }

  // -------------------------------------------------------------------------
  // Analytics -- delegated to AnalyticsMixin
  // -------------------------------------------------------------------------

  computeAvailability(
    ...args: Parameters<AnalyticsMixin["computeAvailability"]>
  ): ReturnType<AnalyticsMixin["computeAvailability"]> {
    return this.analytics.computeAvailability(...args);
  }

  getCognitiveLoad(
    ...args: Parameters<AnalyticsMixin["getCognitiveLoad"]>
  ): ReturnType<AnalyticsMixin["getCognitiveLoad"]> {
    return this.analytics.getCognitiveLoad(...args);
  }

  getContextSwitches(
    ...args: Parameters<AnalyticsMixin["getContextSwitches"]>
  ): ReturnType<AnalyticsMixin["getContextSwitches"]> {
    return this.analytics.getContextSwitches(...args);
  }

  getDeepWork(
    ...args: Parameters<AnalyticsMixin["getDeepWork"]>
  ): ReturnType<AnalyticsMixin["getDeepWork"]> {
    return this.analytics.getDeepWork(...args);
  }

  getRiskScores(
    ...args: Parameters<AnalyticsMixin["getRiskScores"]>
  ): ReturnType<AnalyticsMixin["getRiskScores"]> {
    return this.analytics.getRiskScores(...args);
  }

  getProbabilisticAvailability(
    ...args: Parameters<AnalyticsMixin["getProbabilisticAvailability"]>
  ): ReturnType<AnalyticsMixin["getProbabilisticAvailability"]> {
    return this.analytics.getProbabilisticAvailability(...args);
  }

  // -------------------------------------------------------------------------
  // Onboarding session management (Phase 6A)
  // Delegated to OnboardingSessionMixin -- see onboarding-session-mixin.ts
  // -------------------------------------------------------------------------

  createOnboardingSession(
    sessionId: string,
    userId: string,
    sessionToken: string,
  ): OnboardingSessionRow {
    return this.onboarding.createOnboardingSession(sessionId, userId, sessionToken);
  }

  getOnboardingSession(userId: string): OnboardingSessionRow | null {
    return this.onboarding.getOnboardingSession(userId);
  }

  getOnboardingSessionByToken(sessionToken: string): OnboardingSessionRow | null {
    return this.onboarding.getOnboardingSessionByToken(sessionToken);
  }

  addOnboardingAccount(
    userId: string,
    account: {
      account_id: string;
      provider: string;
      email: string;
      status: string;
      calendar_count?: number;
      connected_at: string;
    },
  ): OnboardingSessionRow | null {
    return this.onboarding.addOnboardingAccount(userId, account);
  }

  updateOnboardingAccountStatus(
    userId: string,
    accountId: string,
    status: string,
    calendarCount?: number,
  ): OnboardingSessionRow | null {
    return this.onboarding.updateOnboardingAccountStatus(userId, accountId, status, calendarCount);
  }

  completeOnboardingSession(userId: string): OnboardingSessionRow | null {
    return this.onboarding.completeOnboardingSession(userId);
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
      authority_markers: row.authority_markers
        ? JSON.parse(row.authority_markers)
        : undefined,
    };
  }
}
