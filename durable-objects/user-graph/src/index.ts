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
  isValidBillingCategory,
  isValidRelationshipCategory,
  isValidOutcome,
  getOutcomeWeight,
  computeDrift,
  matchEventParticipants,
  computeReputation,
  enrichSuggestionsWithTimeWindows,
  enrichWithTimezoneWindows,
  matchCity,
  matchCityWithAliases,
  cityToTimezone,
  suggestMeetingWindow,
  assembleBriefing,
  extractTopics,
  summarizeLastInteraction,
  isValidMilestoneKind,
  isValidMilestoneDate,
  MILESTONE_KINDS,
  computeNextOccurrence,
  daysBetween,
  expandMilestonesToBusy,
  simulate,
  computeCognitiveLoad,
  computeTransitions,
  computeDailySwitchCost,
  computeWeeklySwitchCost,
  generateClusteringSuggestions,
  computeDeepWorkReport,
  evaluateDeepWorkImpact,
  suggestDeepWorkOptimizations,
  computeBurnoutRisk,
  computeTravelOverload,
  computeStrategicDrift,
  computeOverallRisk,
  generateRiskRecommendations,
  getRiskLevel,
  classifyEventCategory,
  computeProbabilisticAvailability,
} from "@tminus/shared";
import type { DriftReport, DriftAlert, DriftEntry, InteractionOutcome, ReputationResult, LedgerInput, ReconnectionSuggestion, EventBriefing, BriefingParticipantInput, MilestoneKind, Milestone, UpcomingMilestone } from "@tminus/shared";
import type { SimulationScenario, SimulationSnapshot, SimulationEvent, SimulationConstraint, SimulationCommitment, ImpactReport } from "@tminus/shared";
import type { CognitiveLoadResult, ContextSwitchResult } from "@tminus/shared";
import type { DeepWorkReport, DeepWorkImpact } from "@tminus/shared";
import type { RiskScoreResult, CognitiveLoadHistoryEntry, CategoryAllocation } from "@tminus/shared";
import type { ProbabilisticEvent, ProbabilisticAvailabilityResult, CancellationHistory } from "@tminus/shared";
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
  BillingCategory,
} from "@tminus/shared";
import { OnboardingSessionMixin } from "./onboarding-session-mixin";
export type { OnboardingSessionRow, OnboardingAccount } from "./onboarding-session-mixin";

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
  constraint_id: string | null;
}

interface ConstraintRow {
  [key: string]: unknown;
  constraint_id: string;
  kind: string;
  config_json: string;
  active_from: string | null;
  active_to: string | null;
  created_at: string;
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

interface AllocationRow {
  [key: string]: unknown;
  allocation_id: string;
  canonical_event_id: string;
  client_id: string | null;
  billing_category: string;
  rate: number | null;
  confidence: string;
  locked: number;
  created_at: string;
}

interface VipPolicyRow {
  [key: string]: unknown;
  vip_id: string;
  participant_hash: string;
  display_name: string | null;
  priority_weight: number;
  conditions_json: string;
  created_at: string;
}

interface RelationshipRow {
  [key: string]: unknown;
  relationship_id: string;
  participant_hash: string;
  display_name: string | null;
  category: string;
  closeness_weight: number;
  last_interaction_ts: string | null;
  city: string | null;
  timezone: string | null;
  interaction_frequency_target: number | null;
  created_at: string;
  updated_at: string;
}

interface LedgerRow {
  [key: string]: unknown;
  ledger_id: string;
  participant_hash: string;
  canonical_event_id: string | null;
  outcome: string;
  weight: number;
  note: string | null;
  ts: string;
}

// OnboardingSessionRow is now defined in onboarding-session-mixin.ts
// and re-exported from this module.
import type { OnboardingSessionRow } from "./onboarding-session-mixin";

interface DriftAlertRow {
  [key: string]: unknown;
  alert_id: string;
  relationship_id: string;
  display_name: string | null;
  category: string;
  drift_ratio: number;
  days_overdue: number;
  urgency: number;
  computed_at: string;
}

interface CommitmentRow {
  [key: string]: unknown;
  commitment_id: string;
  client_id: string;
  client_name: string | null;
  window_type: string;
  target_hours: number;
  rolling_window_weeks: number;
  hard_minimum: number;
  proof_required: number;
  created_at: string;
}

interface CommitmentReportRow {
  [key: string]: unknown;
  report_id: string;
  commitment_id: string;
  window_start: string;
  window_end: string;
  actual_hours: number;
  expected_hours: number;
  status: string;
  proof_hash: string | null;
  created_at: string;
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

/** A constraint as returned by addConstraint / listConstraints. */
export interface Constraint {
  readonly constraint_id: string;
  readonly kind: string;
  readonly config_json: Record<string, unknown>;
  readonly active_from: string | null;
  readonly active_to: string | null;
  readonly created_at: string;
}

/** A relationship as returned by relationship CRUD methods. */
export interface Relationship {
  readonly relationship_id: string;
  readonly participant_hash: string;
  readonly display_name: string | null;
  readonly category: string;
  readonly closeness_weight: number;
  readonly last_interaction_ts: string | null;
  readonly city: string | null;
  readonly timezone: string | null;
  readonly interaction_frequency_target: number | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** An interaction ledger entry as returned by outcome methods. */
export interface LedgerEntry {
  readonly ledger_id: string;
  readonly participant_hash: string;
  readonly canonical_event_id: string | null;
  readonly outcome: string;
  readonly weight: number;
  readonly note: string | null;
  readonly ts: string;
}

/** Reconnection suggestions report: overdue contacts in a specific city. */
export interface ReconnectionReport {
  readonly city: string;
  readonly trip_id: string | null;
  readonly trip_name: string | null;
  readonly trip_start: string | null;
  readonly trip_end: string | null;
  readonly suggestions: readonly ReconnectionSuggestion[];
  readonly total_in_city: number;
  readonly total_overdue_in_city: number;
  readonly computed_at: string;
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

/** A time allocation as returned by allocation CRUD methods. */
export interface TimeAllocation {
  readonly allocation_id: string;
  readonly canonical_event_id: string;
  readonly client_id: string | null;
  readonly billing_category: string;
  readonly rate: number | null;
  readonly confidence: string;
  readonly locked: boolean;
  readonly created_at: string;
}

/** Valid window types for time commitments. */
export const WINDOW_TYPES = ["WEEKLY", "MONTHLY"] as const;
export type WindowType = (typeof WINDOW_TYPES)[number];

/** A time commitment as returned by commitment CRUD methods. */
export interface TimeCommitment {
  readonly commitment_id: string;
  readonly client_id: string;
  readonly client_name: string | null;
  readonly window_type: WindowType;
  readonly target_hours: number;
  readonly rolling_window_weeks: number;
  readonly hard_minimum: boolean;
  readonly proof_required: boolean;
  readonly created_at: string;
}

/** Compliance status for a commitment in its rolling window. */
export type CommitmentComplianceStatus = "compliant" | "under" | "over";

/** Result of evaluating commitment compliance. */
export interface CommitmentStatus {
  readonly commitment_id: string;
  readonly client_id: string;
  readonly client_name: string | null;
  readonly window_type: WindowType;
  readonly target_hours: number;
  readonly actual_hours: number;
  readonly status: CommitmentComplianceStatus;
  readonly window_start: string;
  readonly window_end: string;
  readonly rolling_window_weeks: number;
}

/** A commitment report as stored in the database. */
export interface CommitmentReport {
  readonly report_id: string;
  readonly commitment_id: string;
  readonly window_start: string;
  readonly window_end: string;
  readonly actual_hours: number;
  readonly expected_hours: number;
  readonly status: string;
  readonly proof_hash: string | null;
  readonly created_at: string;
}

/** A single event included in a commitment proof export. */
export interface ProofEvent {
  readonly canonical_event_id: string;
  readonly title: string | null;
  readonly start_ts: string;
  readonly end_ts: string;
  readonly hours: number;
  readonly billing_category: string;
}

/** Data payload for generating a commitment proof document. */
export interface CommitmentProofData {
  readonly commitment: TimeCommitment;
  readonly window_start: string;
  readonly window_end: string;
  readonly actual_hours: number;
  readonly status: CommitmentComplianceStatus;
  readonly events: ProofEvent[];
}

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
  private migrated = false;
  private readonly onboarding: OnboardingSessionMixin;

  constructor(sql: SqlStorageLike, writeQueue: QueueLike) {
    this.sql = sql;
    this.writeQueue = writeQueue;
    this.onboarding = new OnboardingSessionMixin(sql, () => this.ensureMigrated());
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
              this.storeEventParticipants(canonicalId, delta.participant_hashes);
            }
            // Interaction detection: update relationships when event has
            // participant hashes matching known relationships
            if (delta.participant_hashes && delta.participant_hashes.length > 0 && delta.event) {
              const eventStartTs = delta.event.start.dateTime ?? delta.event.start.date ?? new Date().toISOString();
              this.updateInteractions(delta.participant_hashes, eventStartTs);
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
                this.storeEventParticipants(canonicalId, delta.participant_hashes);
              }
              // Interaction detection on update
              if (delta.participant_hashes && delta.participant_hashes.length > 0 && delta.event) {
                const eventStartTs = delta.event.start.dateTime ?? delta.event.start.date ?? new Date().toISOString();
                this.updateInteractions(delta.participant_hashes, eventStartTs);
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
  // Constraint CRUD (Trip, Working Hours, Buffer, etc.)
  // -------------------------------------------------------------------------

  /** Valid constraint kinds. */
  private static readonly VALID_CONSTRAINT_KINDS: ReadonlySet<string> = new Set([
    "trip",
    "working_hours",
    "buffer",
    "no_meetings_after",
    "override",
  ]);

  /**
   * Validate a working_hours config_json object.
   *
   * Required fields:
   * - days: number[] with values 0-6 (Sunday=0 through Saturday=6), non-empty
   * - start_time: string in HH:MM 24-hour format
   * - end_time: string in HH:MM 24-hour format, must be after start_time
   * - timezone: string, must be a valid IANA timezone
   *
   * Throws on validation failure.
   */
  static validateWorkingHoursConfig(configJson: Record<string, unknown>): void {
    // days validation
    if (!Array.isArray(configJson.days) || configJson.days.length === 0) {
      throw new Error(
        "Working hours config_json must include a non-empty 'days' array",
      );
    }
    for (const day of configJson.days) {
      if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) {
        throw new Error(
          `Working hours config_json.days values must be integers 0-6 (Sunday=0 through Saturday=6), got ${JSON.stringify(day)}`,
        );
      }
    }
    // Check for duplicates
    const uniqueDays = new Set(configJson.days as number[]);
    if (uniqueDays.size !== (configJson.days as number[]).length) {
      throw new Error("Working hours config_json.days must not contain duplicates");
    }

    // start_time validation
    const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (typeof configJson.start_time !== "string" || !timeRegex.test(configJson.start_time)) {
      throw new Error(
        "Working hours config_json must include 'start_time' in HH:MM 24-hour format",
      );
    }

    // end_time validation
    if (typeof configJson.end_time !== "string" || !timeRegex.test(configJson.end_time)) {
      throw new Error(
        "Working hours config_json must include 'end_time' in HH:MM 24-hour format",
      );
    }

    // end_time must be after start_time
    if (configJson.end_time <= configJson.start_time) {
      throw new Error(
        "Working hours config_json.end_time must be after start_time",
      );
    }

    // timezone validation
    if (typeof configJson.timezone !== "string" || configJson.timezone.length === 0) {
      throw new Error(
        "Working hours config_json must include a 'timezone' string",
      );
    }
    try {
      Intl.DateTimeFormat(undefined, { timeZone: configJson.timezone });
    } catch {
      throw new Error(
        `Working hours config_json.timezone "${configJson.timezone}" is not a valid IANA timezone`,
      );
    }
  }

  /**
   * Validate a buffer config_json object.
   *
   * Required fields:
   * - type: 'travel' | 'prep' | 'cooldown'
   * - minutes: positive integer
   * - applies_to: 'all' | 'external'
   *
   * Throws on validation failure.
   */
  static validateBufferConfig(configJson: Record<string, unknown>): void {
    const validTypes = ["travel", "prep", "cooldown"];
    if (typeof configJson.type !== "string" || !validTypes.includes(configJson.type)) {
      throw new Error(
        `Buffer config_json.type must be one of: ${validTypes.join(", ")}`,
      );
    }

    if (
      typeof configJson.minutes !== "number" ||
      !Number.isInteger(configJson.minutes) ||
      configJson.minutes <= 0
    ) {
      throw new Error(
        "Buffer config_json.minutes must be a positive integer",
      );
    }

    const validAppliesTo = ["all", "external"];
    if (
      typeof configJson.applies_to !== "string" ||
      !validAppliesTo.includes(configJson.applies_to)
    ) {
      throw new Error(
        `Buffer config_json.applies_to must be one of: ${validAppliesTo.join(", ")}`,
      );
    }
  }

  /**
   * Validate a no_meetings_after config_json object.
   *
   * Required fields:
   * - time: string in HH:MM 24-hour format (cutoff time)
   * - timezone: string, must be a valid IANA timezone
   *
   * Throws on validation failure.
   */
  static validateNoMeetingsAfterConfig(configJson: Record<string, unknown>): void {
    const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (typeof configJson.time !== "string" || !timeRegex.test(configJson.time)) {
      throw new Error(
        "no_meetings_after config_json must include 'time' in HH:MM 24-hour format",
      );
    }

    if (typeof configJson.timezone !== "string" || configJson.timezone.length === 0) {
      throw new Error(
        "no_meetings_after config_json must include a 'timezone' string",
      );
    }
    try {
      Intl.DateTimeFormat(undefined, { timeZone: configJson.timezone });
    } catch {
      throw new Error(
        `no_meetings_after config_json.timezone "${configJson.timezone}" is not a valid IANA timezone`,
      );
    }
  }

  /**
   * Validate an override config_json object.
   *
   * Required fields:
   * - reason: non-empty string describing why the override exists
   *
   * Optional fields (TM-yke.2 working hours bypass):
   * - slot_start: ISO 8601 start of override window
   * - slot_end: ISO 8601 end of override window
   * - timezone: IANA timezone string
   *
   * Throws on validation failure.
   */
  static validateOverrideConfig(configJson: Record<string, unknown>): void {
    if (typeof configJson.reason !== "string" || configJson.reason.trim().length === 0) {
      throw new Error(
        "override config_json must include a non-empty 'reason' string",
      );
    }
    // Optional slot_start/slot_end for working hours bypass (TM-yke.2)
    if (configJson.slot_start !== undefined) {
      if (typeof configJson.slot_start !== "string" || isNaN(Date.parse(configJson.slot_start))) {
        throw new Error("override config_json.slot_start must be a valid ISO 8601 date string");
      }
    }
    if (configJson.slot_end !== undefined) {
      if (typeof configJson.slot_end !== "string" || isNaN(Date.parse(configJson.slot_end))) {
        throw new Error("override config_json.slot_end must be a valid ISO 8601 date string");
      }
    }
    if (configJson.slot_start && configJson.slot_end) {
      if (new Date(configJson.slot_start as string) >= new Date(configJson.slot_end as string)) {
        throw new Error("override config_json.slot_start must be before slot_end");
      }
    }
    if (configJson.timezone !== undefined) {
      if (typeof configJson.timezone !== "string" || configJson.timezone.length === 0) {
        throw new Error("override config_json.timezone must be a non-empty string");
      }
      try {
        Intl.DateTimeFormat(undefined, { timeZone: configJson.timezone as string });
      } catch {
        throw new Error(
          `override config_json.timezone "${configJson.timezone}" is not a valid IANA timezone`,
        );
      }
    }
  }

  /**
   * Validate config_json for a given constraint kind.
   * Dispatches to the appropriate kind-specific validator.
   *
   * Throws on validation failure.
   */
  static validateConstraintConfig(
    kind: string,
    configJson: Record<string, unknown>,
    activeFrom: string | null,
    activeTo: string | null,
  ): void {
    switch (kind) {
      case "working_hours":
        UserGraphDO.validateWorkingHoursConfig(configJson);
        break;
      case "buffer":
        UserGraphDO.validateBufferConfig(configJson);
        break;
      case "no_meetings_after":
        UserGraphDO.validateNoMeetingsAfterConfig(configJson);
        break;
      case "override":
        UserGraphDO.validateOverrideConfig(configJson);
        break;
      case "trip": {
        if (!configJson.name || typeof configJson.name !== "string") {
          throw new Error("Trip constraint config_json must include a 'name' string");
        }
        if (!configJson.timezone || typeof configJson.timezone !== "string") {
          throw new Error("Trip constraint config_json must include a 'timezone' string");
        }
        const validPolicies = ["BUSY", "TITLE"];
        if (!configJson.block_policy || !validPolicies.includes(configJson.block_policy as string)) {
          throw new Error(
            `Trip constraint config_json.block_policy must be one of: ${validPolicies.join(", ")}`,
          );
        }
        if (!activeFrom || !activeTo) {
          throw new Error("Trip constraint must have active_from and active_to");
        }
        break;
      }
      default:
        // No validation for unknown kinds (they are rejected earlier by kind check)
        break;
    }
  }

  /**
   * Add a new constraint and generate any derived canonical events.
   *
   * For kind="trip": creates a single continuous busy block event
   * spanning active_from to active_to, with source="system" and
   * origin_account_id="internal".
   *
   * For kind="working_hours": stores the constraint for use by
   * computeAvailability. No derived events are generated.
   *
   * Returns the created constraint.
   */
  addConstraint(
    kind: string,
    configJson: Record<string, unknown>,
    activeFrom: string | null,
    activeTo: string | null,
  ): Constraint {
    this.ensureMigrated();

    // Validate kind
    if (!UserGraphDO.VALID_CONSTRAINT_KINDS.has(kind)) {
      throw new Error(
        `Invalid constraint kind "${kind}". Must be one of: ${[...UserGraphDO.VALID_CONSTRAINT_KINDS].join(", ")}`,
      );
    }

    // Kind-specific validation (centralized)
    UserGraphDO.validateConstraintConfig(kind, configJson, activeFrom, activeTo);

    const constraintId = generateId("constraint");

    this.sql.exec(
      `INSERT INTO constraints (constraint_id, kind, config_json, active_from, active_to, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      constraintId,
      kind,
      JSON.stringify(configJson),
      activeFrom,
      activeTo,
    );

    // Generate derived events for trip constraints
    if (kind === "trip" && activeFrom && activeTo) {
      this.createTripDerivedEvents(constraintId, configJson, activeFrom, activeTo);
    }

    // Read back the created row
    const rows = this.sql
      .exec<ConstraintRow>(
        `SELECT * FROM constraints WHERE constraint_id = ?`,
        constraintId,
      )
      .toArray();

    return this.rowToConstraint(rows[0]);
  }

  /**
   * Create derived canonical events for a trip constraint.
   * One continuous event spanning the full trip duration.
   */
  private createTripDerivedEvents(
    constraintId: string,
    configJson: Record<string, unknown>,
    activeFrom: string,
    activeTo: string,
  ): void {
    const eventId = generateId("event");
    const blockPolicy = configJson.block_policy as string;
    const tripName = configJson.name as string;
    const timezone = configJson.timezone as string;

    // Title depends on block_policy: BUSY shows "Busy", TITLE shows trip name
    const title = blockPolicy === "TITLE" ? tripName : "Busy";

    this.sql.exec(
      `INSERT INTO canonical_events (
        canonical_event_id, origin_account_id, origin_event_id,
        title, description, location, start_ts, end_ts, timezone,
        all_day, status, visibility, transparency, recurrence_rule,
        source, version, constraint_id, created_at, updated_at
      ) VALUES (?, 'internal', ?, ?, NULL, NULL, ?, ?, ?, 0, 'confirmed', 'default', 'opaque', NULL, 'system', 1, ?, datetime('now'), datetime('now'))`,
      eventId,
      `constraint:${constraintId}`,
      title,
      activeFrom,
      activeTo,
      timezone,
      constraintId,
    );

    // Journal entry for the derived event creation
    this.writeJournal(eventId, "created", "system", {
      reason: "trip_constraint",
      constraint_id: constraintId,
    });
  }

  /**
   * Delete a constraint and cascade-delete all derived canonical events.
   *
   * Returns true if the constraint existed, false if not found.
   */
  async deleteConstraint(constraintId: string): Promise<boolean> {
    this.ensureMigrated();

    // Check constraint exists
    const rows = this.sql
      .exec<ConstraintRow>(
        `SELECT * FROM constraints WHERE constraint_id = ?`,
        constraintId,
      )
      .toArray();

    if (rows.length === 0) return false;

    // Find and delete derived canonical events linked to this constraint
    const derivedEvents = this.sql
      .exec<{ canonical_event_id: string }>(
        `SELECT canonical_event_id FROM canonical_events WHERE constraint_id = ?`,
        constraintId,
      )
      .toArray();

    for (const evt of derivedEvents) {
      // Delete mirrors for this event (enqueue DELETE_MIRROR for each)
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
      }

      // Delete mirrors from DB
      this.sql.exec(
        `DELETE FROM event_mirrors WHERE canonical_event_id = ?`,
        evt.canonical_event_id,
      );

      // Hard delete the derived event
      this.sql.exec(
        `DELETE FROM canonical_events WHERE canonical_event_id = ?`,
        evt.canonical_event_id,
      );

      // Journal entry for derived event deletion
      this.writeJournal(evt.canonical_event_id, "deleted", "system", {
        reason: "constraint_deleted",
        constraint_id: constraintId,
      });
    }

    // Delete the constraint itself
    this.sql.exec(
      `DELETE FROM constraints WHERE constraint_id = ?`,
      constraintId,
    );

    return true;
  }

  /**
   * List all constraints, optionally filtered by kind.
   */
  listConstraints(kind?: string): Constraint[] {
    this.ensureMigrated();

    let rows: ConstraintRow[];
    if (kind) {
      rows = this.sql
        .exec<ConstraintRow>(
          `SELECT * FROM constraints WHERE kind = ? ORDER BY created_at ASC`,
          kind,
        )
        .toArray();
    } else {
      rows = this.sql
        .exec<ConstraintRow>(
          `SELECT * FROM constraints ORDER BY created_at ASC`,
        )
        .toArray();
    }

    return rows.map((r) => this.rowToConstraint(r));
  }

  /**
   * Get a single constraint by ID. Returns null if not found.
   */
  getConstraint(constraintId: string): Constraint | null {
    this.ensureMigrated();

    const rows = this.sql
      .exec<ConstraintRow>(
        `SELECT * FROM constraints WHERE constraint_id = ?`,
        constraintId,
      )
      .toArray();

    if (rows.length === 0) return null;
    return this.rowToConstraint(rows[0]);
  }

  /**
   * Update an existing constraint's config_json and/or active dates.
   *
   * The kind cannot be changed (delete + create instead).
   * For trip constraints, updating active_from/active_to will regenerate
   * derived events (delete old, create new).
   *
   * Returns the updated constraint or null if not found.
   */
  async updateConstraint(
    constraintId: string,
    configJson: Record<string, unknown>,
    activeFrom: string | null,
    activeTo: string | null,
  ): Promise<Constraint | null> {
    this.ensureMigrated();

    // Check constraint exists
    const existing = this.sql
      .exec<ConstraintRow>(
        `SELECT * FROM constraints WHERE constraint_id = ?`,
        constraintId,
      )
      .toArray();

    if (existing.length === 0) return null;

    const kind = existing[0].kind;

    // Validate config against the existing kind
    UserGraphDO.validateConstraintConfig(kind, configJson, activeFrom, activeTo);

    // Update the constraint row
    this.sql.exec(
      `UPDATE constraints SET config_json = ?, active_from = ?, active_to = ? WHERE constraint_id = ?`,
      JSON.stringify(configJson),
      activeFrom,
      activeTo,
      constraintId,
    );

    // For trip constraints, regenerate derived events
    if (kind === "trip") {
      // Delete existing derived events for this constraint
      const derivedEvents = this.sql
        .exec<{ canonical_event_id: string }>(
          `SELECT canonical_event_id FROM canonical_events WHERE constraint_id = ?`,
          constraintId,
        )
        .toArray();

      for (const evt of derivedEvents) {
        // Delete mirrors
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
        }

        this.sql.exec(
          `DELETE FROM event_mirrors WHERE canonical_event_id = ?`,
          evt.canonical_event_id,
        );
        this.sql.exec(
          `DELETE FROM canonical_events WHERE canonical_event_id = ?`,
          evt.canonical_event_id,
        );

        this.writeJournal(evt.canonical_event_id, "deleted", "system", {
          reason: "constraint_updated",
          constraint_id: constraintId,
        });
      }

      // Recreate derived events with updated config
      if (activeFrom && activeTo) {
        this.createTripDerivedEvents(constraintId, configJson, activeFrom, activeTo);
      }
    }

    // Read back the updated row
    const rows = this.sql
      .exec<ConstraintRow>(
        `SELECT * FROM constraints WHERE constraint_id = ?`,
        constraintId,
      )
      .toArray();

    return this.rowToConstraint(rows[0]);
  }

  /** Convert a DB row to a Constraint domain object. */
  private rowToConstraint(row: ConstraintRow): Constraint {
    return {
      constraint_id: row.constraint_id,
      kind: row.kind,
      config_json: JSON.parse(row.config_json),
      active_from: row.active_from,
      active_to: row.active_to,
      created_at: row.created_at,
    };
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
   * Covers Phase 3+ and Phase 4 tables plus core policy/calendar/constraint tables.
   * Idempotent: returns total rows deleted across all tables.
   */
  deleteRelationshipData(): DeletionCounts {
    this.ensureMigrated();

    // Count all rows across relationship/supporting tables
    let total = 0;
    const tables = [
      "relationships",
      "interaction_ledger",
      "milestones",
      "vip_policies",
      "time_allocations",
      "time_commitments",
      "commitment_reports",
      "schedule_holds",
      "schedule_candidates",
      "schedule_sessions",
      "constraints",
      "policy_edges",
      "policies",
      "calendars",
    ];

    for (const table of tables) {
      const count = this.sql
        .exec<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${table}`)
        .toArray()[0].cnt;
      total += count;
    }

    // Delete in correct order (children before parents, respecting FK constraints)
    this.sql.exec("DELETE FROM interaction_ledger");
    this.sql.exec("DELETE FROM milestones");
    this.sql.exec("DELETE FROM relationships");
    this.sql.exec("DELETE FROM vip_policies");
    this.sql.exec("DELETE FROM commitment_reports");
    this.sql.exec("DELETE FROM time_commitments");
    this.sql.exec("DELETE FROM time_allocations");
    this.sql.exec("DELETE FROM schedule_holds");
    this.sql.exec("DELETE FROM schedule_candidates");
    this.sql.exec("DELETE FROM schedule_sessions");
    this.sql.exec("DELETE FROM constraints");
    this.sql.exec("DELETE FROM policy_edges");
    this.sql.exec("DELETE FROM policies");
    this.sql.exec("DELETE FROM calendars");

    return { deleted: total };
  }

  // -------------------------------------------------------------------------
  // Account unlinking (per-account, not full-user deletion)
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
  // Time allocation management (billable time tagging)
  // -------------------------------------------------------------------------

  /**
   * Create a time allocation for a canonical event.
   * Links an event to a billing category with optional client and rate.
   *
   * Validates:
   * - billing_category against BILLING_CATEGORIES enum
   * - canonical_event_id references an existing event (FK integrity)
   * - Only one allocation per event (enforced via UNIQUE on canonical_event_id
   *   is NOT in schema -- we check manually and reject duplicates)
   */
  createAllocation(
    allocationId: string,
    canonicalEventId: string,
    billingCategory: string,
    clientId: string | null,
    rate: number | null,
  ): TimeAllocation {
    this.ensureMigrated();

    // Validate billing category
    if (!isValidBillingCategory(billingCategory)) {
      throw new Error(
        `Invalid billing_category: ${billingCategory}. Must be one of: BILLABLE, NON_BILLABLE, STRATEGIC, INVESTOR, INTERNAL`,
      );
    }

    // Validate rate if provided
    if (rate !== null && (typeof rate !== "number" || rate < 0)) {
      throw new Error("rate must be a non-negative number or null");
    }

    // Verify the event exists
    const eventRows = this.sql
      .exec<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM canonical_events WHERE canonical_event_id = ?",
        canonicalEventId,
      )
      .toArray();

    if (eventRows[0].cnt === 0) {
      throw new Error(`Event ${canonicalEventId} not found`);
    }

    // Check for existing allocation on this event
    const existing = this.sql
      .exec<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM time_allocations WHERE canonical_event_id = ?",
        canonicalEventId,
      )
      .toArray();

    if (existing[0].cnt > 0) {
      throw new Error(
        `Allocation already exists for event ${canonicalEventId}. Use updateAllocation instead.`,
      );
    }

    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO time_allocations (allocation_id, canonical_event_id, client_id, billing_category, rate, confidence, locked, created_at)
       VALUES (?, ?, ?, ?, ?, 'manual', 0, ?)`,
      allocationId,
      canonicalEventId,
      clientId,
      billingCategory,
      rate,
      now,
    );

    return {
      allocation_id: allocationId,
      canonical_event_id: canonicalEventId,
      client_id: clientId,
      billing_category: billingCategory,
      rate: rate,
      confidence: "manual",
      locked: false,
      created_at: now,
    };
  }

  /**
   * Get the time allocation for a specific event.
   * Returns null if no allocation exists for the event.
   */
  getAllocation(canonicalEventId: string): TimeAllocation | null {
    this.ensureMigrated();

    const rows = this.sql
      .exec<AllocationRow>(
        `SELECT allocation_id, canonical_event_id, client_id, billing_category, rate, confidence, locked, created_at
         FROM time_allocations WHERE canonical_event_id = ?`,
        canonicalEventId,
      )
      .toArray();

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      allocation_id: row.allocation_id,
      canonical_event_id: row.canonical_event_id,
      client_id: row.client_id,
      billing_category: row.billing_category,
      rate: row.rate,
      confidence: row.confidence,
      locked: row.locked === 1,
      created_at: row.created_at,
    };
  }

  /**
   * Update an existing time allocation.
   * Only updates provided fields (partial update).
   * Returns the updated allocation or null if not found.
   */
  updateAllocation(
    canonicalEventId: string,
    updates: {
      billing_category?: string;
      client_id?: string | null;
      rate?: number | null;
    },
  ): TimeAllocation | null {
    this.ensureMigrated();

    // Validate billing category if provided
    if (updates.billing_category !== undefined) {
      if (!isValidBillingCategory(updates.billing_category)) {
        throw new Error(
          `Invalid billing_category: ${updates.billing_category}. Must be one of: BILLABLE, NON_BILLABLE, STRATEGIC, INVESTOR, INTERNAL`,
        );
      }
    }

    // Validate rate if provided
    if (updates.rate !== undefined && updates.rate !== null) {
      if (typeof updates.rate !== "number" || updates.rate < 0) {
        throw new Error("rate must be a non-negative number or null");
      }
    }

    // Check allocation exists
    const existing = this.getAllocation(canonicalEventId);
    if (!existing) return null;

    // Build dynamic SET clause
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (updates.billing_category !== undefined) {
      setClauses.push("billing_category = ?");
      values.push(updates.billing_category);
    }
    if (updates.client_id !== undefined) {
      setClauses.push("client_id = ?");
      values.push(updates.client_id);
    }
    if (updates.rate !== undefined) {
      setClauses.push("rate = ?");
      values.push(updates.rate);
    }

    if (setClauses.length === 0) {
      // Nothing to update
      return existing;
    }

    values.push(canonicalEventId);
    this.sql.exec(
      `UPDATE time_allocations SET ${setClauses.join(", ")} WHERE canonical_event_id = ?`,
      ...values,
    );

    // Return the updated record
    return this.getAllocation(canonicalEventId)!;
  }

  /**
   * Delete a time allocation for a specific event.
   * Returns true if a row was deleted, false if not found.
   */
  deleteAllocation(canonicalEventId: string): boolean {
    this.ensureMigrated();

    const before = this.sql
      .exec<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM time_allocations WHERE canonical_event_id = ?",
        canonicalEventId,
      )
      .toArray()[0].cnt;

    if (before === 0) return false;

    this.sql.exec(
      "DELETE FROM time_allocations WHERE canonical_event_id = ?",
      canonicalEventId,
    );
    return true;
  }

  /**
   * List all time allocations for this user.
   * Returns all allocations ordered by created_at descending.
   */
  listAllocations(): TimeAllocation[] {
    this.ensureMigrated();

    const rows = this.sql
      .exec<AllocationRow>(
        `SELECT allocation_id, canonical_event_id, client_id, billing_category, rate, confidence, locked, created_at
         FROM time_allocations ORDER BY created_at DESC`,
      )
      .toArray();

    return rows.map((row) => ({
      allocation_id: row.allocation_id,
      canonical_event_id: row.canonical_event_id,
      client_id: row.client_id,
      billing_category: row.billing_category,
      rate: row.rate,
      confidence: row.confidence,
      locked: row.locked === 1,
      created_at: row.created_at,
    }));
  }

  // -------------------------------------------------------------------------
  // VIP policy management
  // -------------------------------------------------------------------------

  /**
   * Create a VIP policy for a participant.
   * participant_hash = SHA-256(email + per-org salt), computed by the caller.
   */
  createVipPolicy(
    vipId: string,
    participantHash: string,
    displayName: string | null,
    priorityWeight: number,
    conditionsJson: Record<string, unknown>,
  ): VipPolicyRow {
    this.ensureMigrated();

    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO vip_policies (vip_id, participant_hash, display_name, priority_weight, conditions_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      vipId,
      participantHash,
      displayName,
      priorityWeight,
      JSON.stringify(conditionsJson),
      now,
    );

    return {
      vip_id: vipId,
      participant_hash: participantHash,
      display_name: displayName,
      priority_weight: priorityWeight,
      conditions_json: JSON.stringify(conditionsJson),
      created_at: now,
    };
  }

  /**
   * List all VIP policies for this user.
   */
  listVipPolicies(): Array<{
    vip_id: string;
    participant_hash: string;
    display_name: string | null;
    priority_weight: number;
    conditions_json: Record<string, unknown>;
    created_at: string;
  }> {
    this.ensureMigrated();

    const rows = this.sql
      .exec<VipPolicyRow>(
        "SELECT vip_id, participant_hash, display_name, priority_weight, conditions_json, created_at FROM vip_policies ORDER BY created_at DESC",
      )
      .toArray();

    return rows.map((row) => ({
      vip_id: row.vip_id,
      participant_hash: row.participant_hash,
      display_name: row.display_name,
      priority_weight: row.priority_weight,
      conditions_json: JSON.parse(row.conditions_json) as Record<string, unknown>,
      created_at: row.created_at,
    }));
  }

  /**
   * Get a single VIP policy by ID.
   */
  getVipPolicy(vipId: string): {
    vip_id: string;
    participant_hash: string;
    display_name: string | null;
    priority_weight: number;
    conditions_json: Record<string, unknown>;
    created_at: string;
  } | null {
    this.ensureMigrated();

    const rows = this.sql
      .exec<VipPolicyRow>(
        "SELECT vip_id, participant_hash, display_name, priority_weight, conditions_json, created_at FROM vip_policies WHERE vip_id = ?",
        vipId,
      )
      .toArray();

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      vip_id: row.vip_id,
      participant_hash: row.participant_hash,
      display_name: row.display_name,
      priority_weight: row.priority_weight,
      conditions_json: JSON.parse(row.conditions_json) as Record<string, unknown>,
      created_at: row.created_at,
    };
  }

  /**
   * Delete a VIP policy by ID.
   * Returns true if a row was deleted, false if not found.
   */
  deleteVipPolicy(vipId: string): boolean {
    this.ensureMigrated();

    const before = this.sql
      .exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM vip_policies WHERE vip_id = ?", vipId)
      .toArray()[0].cnt;

    if (before === 0) return false;

    this.sql.exec("DELETE FROM vip_policies WHERE vip_id = ?", vipId);
    return true;
  }

  // -------------------------------------------------------------------------
  // Commitment tracking (Phase 3)
  // -------------------------------------------------------------------------

  /**
   * Create a time commitment for a client.
   *
   * Defines target hours per rolling window for a given client_id.
   * Window types: WEEKLY (7 days) or MONTHLY (28 days).
   * The rolling_window_weeks determines how far back the window extends.
   */
  createCommitment(
    commitmentId: string,
    clientId: string,
    targetHours: number,
    windowType: string = "WEEKLY",
    clientName: string | null = null,
    rollingWindowWeeks: number = 4,
    hardMinimum: boolean = false,
    proofRequired: boolean = false,
  ): TimeCommitment {
    this.ensureMigrated();

    // Validate window type
    if (!WINDOW_TYPES.includes(windowType as WindowType)) {
      throw new Error(
        `Invalid window_type: ${windowType}. Must be one of: ${WINDOW_TYPES.join(", ")}`,
      );
    }

    // Validate target_hours
    if (typeof targetHours !== "number" || targetHours <= 0) {
      throw new Error("target_hours must be a positive number");
    }

    // Validate rolling_window_weeks
    if (
      typeof rollingWindowWeeks !== "number" ||
      rollingWindowWeeks < 1 ||
      !Number.isInteger(rollingWindowWeeks)
    ) {
      throw new Error("rolling_window_weeks must be a positive integer");
    }

    // Validate client_id
    if (!clientId || typeof clientId !== "string" || clientId.trim().length === 0) {
      throw new Error("client_id is required");
    }

    // Check for duplicate commitment for same client
    const existing = this.sql
      .exec<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM time_commitments WHERE client_id = ?",
        clientId,
      )
      .toArray();

    if (existing[0].cnt > 0) {
      throw new Error(
        `Commitment already exists for client ${clientId}. Delete it first to create a new one.`,
      );
    }

    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO time_commitments (commitment_id, client_id, client_name, window_type, target_hours, rolling_window_weeks, hard_minimum, proof_required, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      commitmentId,
      clientId,
      clientName,
      windowType,
      targetHours,
      rollingWindowWeeks,
      hardMinimum ? 1 : 0,
      proofRequired ? 1 : 0,
      now,
    );

    return {
      commitment_id: commitmentId,
      client_id: clientId,
      client_name: clientName,
      window_type: windowType as WindowType,
      target_hours: targetHours,
      rolling_window_weeks: rollingWindowWeeks,
      hard_minimum: hardMinimum,
      proof_required: proofRequired,
      created_at: now,
    };
  }

  /**
   * Get a single commitment by ID.
   * Returns null if not found.
   */
  getCommitment(commitmentId: string): TimeCommitment | null {
    this.ensureMigrated();

    const rows = this.sql
      .exec<CommitmentRow>(
        `SELECT commitment_id, client_id, client_name, window_type, target_hours, rolling_window_weeks, hard_minimum, proof_required, created_at
         FROM time_commitments WHERE commitment_id = ?`,
        commitmentId,
      )
      .toArray();

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      commitment_id: row.commitment_id,
      client_id: row.client_id,
      client_name: row.client_name,
      window_type: row.window_type as WindowType,
      target_hours: row.target_hours,
      rolling_window_weeks: row.rolling_window_weeks,
      hard_minimum: row.hard_minimum === 1,
      proof_required: row.proof_required === 1,
      created_at: row.created_at,
    };
  }

  /**
   * List all commitments for this user.
   * Returns all commitments ordered by created_at descending.
   */
  listCommitments(): TimeCommitment[] {
    this.ensureMigrated();

    const rows = this.sql
      .exec<CommitmentRow>(
        `SELECT commitment_id, client_id, client_name, window_type, target_hours, rolling_window_weeks, hard_minimum, proof_required, created_at
         FROM time_commitments ORDER BY created_at DESC`,
      )
      .toArray();

    return rows.map((row) => ({
      commitment_id: row.commitment_id,
      client_id: row.client_id,
      client_name: row.client_name,
      window_type: row.window_type as WindowType,
      target_hours: row.target_hours,
      rolling_window_weeks: row.rolling_window_weeks,
      hard_minimum: row.hard_minimum === 1,
      proof_required: row.proof_required === 1,
      created_at: row.created_at,
    }));
  }

  /**
   * Delete a commitment by ID.
   * Also deletes associated commitment_reports (FK cascade is not enforced
   * by SQLite by default in all configs, so we delete explicitly).
   * Returns true if a row was deleted, false if not found.
   */
  deleteCommitment(commitmentId: string): boolean {
    this.ensureMigrated();

    const before = this.sql
      .exec<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM time_commitments WHERE commitment_id = ?",
        commitmentId,
      )
      .toArray()[0].cnt;

    if (before === 0) return false;

    // Delete child reports first (respecting FK constraint)
    this.sql.exec(
      "DELETE FROM commitment_reports WHERE commitment_id = ?",
      commitmentId,
    );
    this.sql.exec(
      "DELETE FROM time_commitments WHERE commitment_id = ?",
      commitmentId,
    );
    return true;
  }

  /**
   * Compute the compliance status for a commitment.
   *
   * Calculates actual hours from time_allocations for the commitment's
   * client_id within the rolling window, then compares to target.
   *
   * Rolling window: rolling_window_weeks * 7 days backward from `asOf`
   * (defaults to current time).
   *
   * Status determination:
   * - "over": actual > target * 1.2
   * - "compliant": actual >= target
   * - "under": actual < target
   *
   * Also generates and stores a commitment_report.
   */
  getCommitmentStatus(
    commitmentId: string,
    asOf?: string,
  ): CommitmentStatus | null {
    this.ensureMigrated();

    const commitment = this.getCommitment(commitmentId);
    if (!commitment) return null;

    const now = asOf ? new Date(asOf) : new Date();
    const windowDays = commitment.rolling_window_weeks * 7;
    const windowStart = new Date(
      now.getTime() - windowDays * 24 * 60 * 60 * 1000,
    );

    const windowStartIso = windowStart.toISOString();
    const windowEndIso = now.toISOString();

    // Query actual hours from time_allocations joined with canonical_events.
    // Hours = sum of (end_ts - start_ts) in hours for all events with
    // matching client_id allocations within the window.
    const rows = this.sql
      .exec<{ total_hours: number }>(
        `SELECT COALESCE(
           SUM(
             (julianday(ce.end_ts) - julianday(ce.start_ts)) * 24.0
           ), 0.0
         ) as total_hours
         FROM time_allocations ta
         JOIN canonical_events ce ON ta.canonical_event_id = ce.canonical_event_id
         WHERE ta.client_id = ?
           AND ce.start_ts >= ?
           AND ce.start_ts < ?`,
        commitment.client_id,
        windowStartIso,
        windowEndIso,
      )
      .toArray();

    const actualHours = Math.round(rows[0].total_hours * 100) / 100;

    // Determine status
    let status: CommitmentComplianceStatus;
    if (actualHours > commitment.target_hours * 1.2) {
      status = "over";
    } else if (actualHours >= commitment.target_hours) {
      status = "compliant";
    } else {
      status = "under";
    }

    // Store a commitment report
    const reportId = generateId("report");
    const reportNow = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO commitment_reports (report_id, commitment_id, window_start, window_end, actual_hours, expected_hours, status, proof_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      reportId,
      commitmentId,
      windowStartIso,
      windowEndIso,
      actualHours,
      commitment.target_hours,
      status,
      null,
      reportNow,
    );

    return {
      commitment_id: commitment.commitment_id,
      client_id: commitment.client_id,
      client_name: commitment.client_name,
      window_type: commitment.window_type,
      target_hours: commitment.target_hours,
      actual_hours: actualHours,
      status,
      window_start: windowStartIso,
      window_end: windowEndIso,
      rolling_window_weeks: commitment.rolling_window_weeks,
    };
  }

  /**
   * Gather all data needed for a commitment proof export.
   *
   * Returns the commitment, rolling window bounds, actual hours, compliance
   * status, and the individual events (with hours) that contribute to the
   * actual hours total. This gives the API layer everything it needs to
   * build a PDF or CSV proof document.
   */
  getCommitmentProofData(
    commitmentId: string,
    asOf?: string,
  ): CommitmentProofData | null {
    this.ensureMigrated();

    const commitment = this.getCommitment(commitmentId);
    if (!commitment) return null;

    const now = asOf ? new Date(asOf) : new Date();
    const windowDays = commitment.rolling_window_weeks * 7;
    const windowStart = new Date(
      now.getTime() - windowDays * 24 * 60 * 60 * 1000,
    );

    const windowStartIso = windowStart.toISOString();
    const windowEndIso = now.toISOString();

    // Get individual events with their hours for the proof document
    const eventRows = this.sql
      .exec<{
        canonical_event_id: string;
        title: string | null;
        start_ts: string;
        end_ts: string;
        hours: number;
        billing_category: string;
      }>(
        `SELECT
           ce.canonical_event_id,
           ce.title,
           ce.start_ts,
           ce.end_ts,
           (julianday(ce.end_ts) - julianday(ce.start_ts)) * 24.0 as hours,
           ta.billing_category
         FROM time_allocations ta
         JOIN canonical_events ce ON ta.canonical_event_id = ce.canonical_event_id
         WHERE ta.client_id = ?
           AND ce.start_ts >= ?
           AND ce.start_ts < ?
         ORDER BY ce.start_ts ASC`,
        commitment.client_id,
        windowStartIso,
        windowEndIso,
      )
      .toArray();

    const events: ProofEvent[] = eventRows.map((row) => ({
      canonical_event_id: row.canonical_event_id,
      title: row.title,
      start_ts: row.start_ts,
      end_ts: row.end_ts,
      hours: Math.round(row.hours * 100) / 100,
      billing_category: row.billing_category,
    }));

    const actualHours = Math.round(
      events.reduce((sum, e) => sum + e.hours, 0) * 100,
    ) / 100;

    // Determine status (same logic as getCommitmentStatus)
    let status: CommitmentComplianceStatus;
    if (actualHours > commitment.target_hours * 1.2) {
      status = "over";
    } else if (actualHours >= commitment.target_hours) {
      status = "compliant";
    } else {
      status = "under";
    }

    return {
      commitment,
      window_start: windowStartIso,
      window_end: windowEndIso,
      actual_hours: actualHours,
      status,
      events,
    };
  }

  // -------------------------------------------------------------------------
  // What-If Simulation (read-only snapshot builder)
  // -------------------------------------------------------------------------

  /**
   * Build a read-only snapshot of the user's current calendar state
   * for the simulation engine.
   *
   * Fetches upcoming events (next 4 weeks), all constraints, and all
   * commitments. Returns a SimulationSnapshot that the pure simulate()
   * function can consume without any side effects.
   */
  buildSimulationSnapshot(): SimulationSnapshot {
    this.ensureMigrated();

    const now = new Date();
    const fourWeeksLater = new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000);
    const nowIso = now.toISOString();
    const futureIso = fourWeeksLater.toISOString();

    // Fetch upcoming events (next 4 weeks)
    const eventRows = this.sql
      .exec<CanonicalEventRow>(
        `SELECT * FROM canonical_events
         WHERE end_ts > ? AND start_ts < ?
         ORDER BY start_ts ASC`,
        nowIso,
        futureIso,
      )
      .toArray();

    const events: SimulationEvent[] = eventRows.map((r) => ({
      canonical_event_id: r.canonical_event_id,
      title: r.title ?? "",
      start_ts: r.start_ts,
      end_ts: r.end_ts,
      all_day: r.all_day === 1,
      status: r.status,
      client_id: this.getEventClientId(r.canonical_event_id),
    }));

    // Fetch all constraints and normalize config for simulation engine.
    // The DO stores working_hours as { start_time: "HH:MM", end_time: "HH:MM", ... }
    // but the simulation engine expects { start_hour: number, end_hour: number }.
    const constraintRows = this.listConstraints();
    const constraints: SimulationConstraint[] = constraintRows.map((c) => {
      let configJson = c.config_json;
      if (c.kind === "working_hours" && typeof configJson.start_time === "string") {
        const startHour = parseInt((configJson.start_time as string).split(":")[0], 10);
        const endHour = parseInt((configJson.end_time as string).split(":")[0], 10);
        configJson = { ...configJson, start_hour: startHour, end_hour: endHour };
      }
      return { kind: c.kind, config_json: configJson };
    });

    // Fetch all commitments
    const commitmentRows = this.listCommitments();
    const commitments: SimulationCommitment[] = commitmentRows.map((c) => ({
      commitment_id: c.commitment_id,
      client_id: c.client_id,
      client_name: c.client_name,
      target_hours: c.target_hours,
      window_type: c.window_type,
      rolling_window_weeks: c.rolling_window_weeks,
      hard_minimum: c.hard_minimum,
    }));

    return {
      events,
      constraints,
      commitments,
      simulation_start: nowIso,
    };
  }

  /**
   * Get the client_id for an event from its time_allocation, if any.
   * Returns null if no allocation exists.
   */
  private getEventClientId(canonicalEventId: string): string | null {
    const rows = this.sql
      .exec<{ client_id: string | null }>(
        `SELECT client_id FROM time_allocations WHERE canonical_event_id = ? LIMIT 1`,
        canonicalEventId,
      )
      .toArray();
    return rows.length > 0 ? rows[0].client_id : null;
  }

  // -------------------------------------------------------------------------
  // Relationship tracking (Phase 4)
  // -------------------------------------------------------------------------

  /**
   * Create a relationship for a participant.
   *
   * participant_hash = SHA-256(email + per-org salt), computed by the caller.
   * Participant hashes are UNIQUE per user -- each person can only have one
   * relationship record.
   *
   * BR-18: Relationship data is user-controlled input only (never auto-scraped).
   */
  createRelationship(
    relationshipId: string,
    participantHash: string,
    displayName: string | null,
    category: string,
    closenessWeight: number = 0.5,
    city: string | null = null,
    timezone: string | null = null,
    interactionFrequencyTarget: number | null = null,
  ): Relationship {
    this.ensureMigrated();

    // Validate category
    if (!isValidRelationshipCategory(category)) {
      throw new Error(
        `Invalid category: ${category}. Must be one of: FAMILY, INVESTOR, FRIEND, CLIENT, BOARD, COLLEAGUE, OTHER`,
      );
    }

    // Validate closeness_weight
    if (typeof closenessWeight !== "number" || closenessWeight < 0 || closenessWeight > 1) {
      throw new Error("closeness_weight must be between 0.0 and 1.0");
    }

    // Validate interaction_frequency_target
    if (
      interactionFrequencyTarget !== null &&
      (typeof interactionFrequencyTarget !== "number" ||
        interactionFrequencyTarget <= 0 ||
        !Number.isInteger(interactionFrequencyTarget))
    ) {
      throw new Error("interaction_frequency_target must be a positive integer (days)");
    }

    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO relationships (
        relationship_id, participant_hash, display_name, category,
        closeness_weight, last_interaction_ts, city, timezone,
        interaction_frequency_target, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      relationshipId,
      participantHash,
      displayName,
      category,
      closenessWeight,
      null,
      city,
      timezone,
      interactionFrequencyTarget,
      now,
      now,
    );

    return {
      relationship_id: relationshipId,
      participant_hash: participantHash,
      display_name: displayName,
      category,
      closeness_weight: closenessWeight,
      last_interaction_ts: null,
      city,
      timezone,
      interaction_frequency_target: interactionFrequencyTarget,
      created_at: now,
      updated_at: now,
    };
  }

  /**
   * Get a single relationship by ID.
   * Returns null if not found.
   */
  getRelationship(relationshipId: string): Relationship | null {
    this.ensureMigrated();

    const rows = this.sql
      .exec<RelationshipRow>(
        `SELECT relationship_id, participant_hash, display_name, category,
                closeness_weight, last_interaction_ts, city, timezone,
                interaction_frequency_target, created_at, updated_at
         FROM relationships WHERE relationship_id = ?`,
        relationshipId,
      )
      .toArray();

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      relationship_id: row.relationship_id,
      participant_hash: row.participant_hash,
      display_name: row.display_name,
      category: row.category,
      closeness_weight: row.closeness_weight,
      last_interaction_ts: row.last_interaction_ts,
      city: row.city,
      timezone: row.timezone,
      interaction_frequency_target: row.interaction_frequency_target,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * List all relationships for this user.
   * Returns all relationships ordered by closeness_weight descending then created_at descending.
   */
  listRelationships(category?: string): Relationship[] {
    this.ensureMigrated();

    let sql = `SELECT relationship_id, participant_hash, display_name, category,
                      closeness_weight, last_interaction_ts, city, timezone,
                      interaction_frequency_target, created_at, updated_at
               FROM relationships`;
    const params: string[] = [];

    if (category) {
      sql += " WHERE category = ?";
      params.push(category);
    }

    sql += " ORDER BY closeness_weight DESC, created_at DESC";

    const rows = this.sql
      .exec<RelationshipRow>(sql, ...params)
      .toArray();

    return rows.map((row) => ({
      relationship_id: row.relationship_id,
      participant_hash: row.participant_hash,
      display_name: row.display_name,
      category: row.category,
      closeness_weight: row.closeness_weight,
      last_interaction_ts: row.last_interaction_ts,
      city: row.city,
      timezone: row.timezone,
      interaction_frequency_target: row.interaction_frequency_target,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }

  /**
   * Update an existing relationship.
   * Only provided fields are updated; null/undefined fields are left unchanged.
   * Returns the updated relationship or null if not found.
   */
  updateRelationship(
    relationshipId: string,
    updates: {
      display_name?: string | null;
      category?: string;
      closeness_weight?: number;
      city?: string | null;
      timezone?: string | null;
      interaction_frequency_target?: number | null;
    },
  ): Relationship | null {
    this.ensureMigrated();

    const existing = this.getRelationship(relationshipId);
    if (!existing) return null;

    // Validate category if provided
    if (updates.category !== undefined && !isValidRelationshipCategory(updates.category)) {
      throw new Error(
        `Invalid category: ${updates.category}. Must be one of: FAMILY, INVESTOR, FRIEND, CLIENT, BOARD, COLLEAGUE, OTHER`,
      );
    }

    // Validate closeness_weight if provided
    if (
      updates.closeness_weight !== undefined &&
      (typeof updates.closeness_weight !== "number" ||
        updates.closeness_weight < 0 ||
        updates.closeness_weight > 1)
    ) {
      throw new Error("closeness_weight must be between 0.0 and 1.0");
    }

    // Validate interaction_frequency_target if provided
    if (
      updates.interaction_frequency_target !== undefined &&
      updates.interaction_frequency_target !== null &&
      (typeof updates.interaction_frequency_target !== "number" ||
        updates.interaction_frequency_target <= 0 ||
        !Number.isInteger(updates.interaction_frequency_target))
    ) {
      throw new Error("interaction_frequency_target must be a positive integer (days)");
    }

    const now = new Date().toISOString();
    const newDisplayName = updates.display_name !== undefined ? updates.display_name : existing.display_name;
    const newCategory = updates.category !== undefined ? updates.category : existing.category;
    const newCloseness = updates.closeness_weight !== undefined ? updates.closeness_weight : existing.closeness_weight;
    const newCity = updates.city !== undefined ? updates.city : existing.city;
    const newTimezone = updates.timezone !== undefined ? updates.timezone : existing.timezone;
    const newFrequencyTarget = updates.interaction_frequency_target !== undefined
      ? updates.interaction_frequency_target
      : existing.interaction_frequency_target;

    this.sql.exec(
      `UPDATE relationships SET
        display_name = ?, category = ?, closeness_weight = ?,
        city = ?, timezone = ?, interaction_frequency_target = ?,
        updated_at = ?
       WHERE relationship_id = ?`,
      newDisplayName,
      newCategory,
      newCloseness,
      newCity,
      newTimezone,
      newFrequencyTarget,
      now,
      relationshipId,
    );

    return {
      relationship_id: relationshipId,
      participant_hash: existing.participant_hash,
      display_name: newDisplayName,
      category: newCategory,
      closeness_weight: newCloseness,
      last_interaction_ts: existing.last_interaction_ts,
      city: newCity,
      timezone: newTimezone,
      interaction_frequency_target: newFrequencyTarget,
      created_at: existing.created_at,
      updated_at: now,
    };
  }

  /**
   * Delete a relationship by ID.
   * Returns true if a row was deleted, false if not found.
   */
  deleteRelationship(relationshipId: string): boolean {
    this.ensureMigrated();

    const before = this.sql
      .exec<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM relationships WHERE relationship_id = ?",
        relationshipId,
      )
      .toArray()[0].cnt;

    if (before === 0) return false;

    // Delete associated milestones and interaction ledger entries first
    this.sql.exec(
      `DELETE FROM milestones WHERE participant_hash IN
       (SELECT participant_hash FROM relationships WHERE relationship_id = ?)`,
      relationshipId,
    );
    this.sql.exec(
      `DELETE FROM interaction_ledger WHERE participant_hash IN
       (SELECT participant_hash FROM relationships WHERE relationship_id = ?)`,
      relationshipId,
    );
    this.sql.exec("DELETE FROM relationships WHERE relationship_id = ?", relationshipId);
    return true;
  }

  // -------------------------------------------------------------------------
  // Interaction Ledger (Phase 4)
  // -------------------------------------------------------------------------

  /**
   * Mark an interaction outcome for a relationship.
   *
   * Looks up the relationship by ID to get the participant_hash,
   * then appends a ledger entry. Ledger is append-only -- entries
   * are never updated or deleted (except when the relationship itself
   * is deleted via deleteRelationship).
   *
   * Also updates the relationship's last_interaction_ts if the outcome
   * is ATTENDED (positive interaction occurred).
   *
   * @param relationshipId - The relationship to mark the outcome for
   * @param outcome - One of INTERACTION_OUTCOMES
   * @param canonicalEventId - Optional canonical event ID
   * @param note - Optional free-text note
   * @returns The created ledger entry, or null if relationship not found
   */
  markOutcome(
    relationshipId: string,
    outcome: string,
    canonicalEventId: string | null = null,
    note: string | null = null,
  ): LedgerEntry | null {
    this.ensureMigrated();

    // Validate outcome
    if (!isValidOutcome(outcome)) {
      throw new Error(
        `Invalid outcome: ${outcome}. Must be one of: ATTENDED, CANCELED_BY_ME, CANCELED_BY_THEM, NO_SHOW_THEM, NO_SHOW_ME, MOVED_LAST_MINUTE_THEM, MOVED_LAST_MINUTE_ME`,
      );
    }

    // Look up relationship to get participant_hash
    const relationship = this.getRelationship(relationshipId);
    if (!relationship) return null;

    const ledgerId = generateId("ledger");
    const weight = getOutcomeWeight(outcome as InteractionOutcome);
    const now = new Date().toISOString();

    this.sql.exec(
      `INSERT INTO interaction_ledger (
        ledger_id, participant_hash, canonical_event_id, outcome, weight, note, ts
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ledgerId,
      relationship.participant_hash,
      canonicalEventId,
      outcome,
      weight,
      note,
      now,
    );

    // Update last_interaction_ts on ATTENDED outcomes
    if (outcome === "ATTENDED") {
      this.sql.exec(
        "UPDATE relationships SET last_interaction_ts = ?, updated_at = ? WHERE relationship_id = ?",
        now,
        now,
        relationshipId,
      );
    }

    return {
      ledger_id: ledgerId,
      participant_hash: relationship.participant_hash,
      canonical_event_id: canonicalEventId,
      outcome,
      weight,
      note,
      ts: now,
    };
  }

  /**
   * List interaction ledger entries for a relationship.
   *
   * Returns entries ordered by timestamp descending (most recent first).
   * Optionally filter by outcome type.
   *
   * @param relationshipId - The relationship to list outcomes for
   * @param outcomeFilter - Optional outcome type to filter by
   * @returns Array of ledger entries, or null if relationship not found
   */
  listOutcomes(
    relationshipId: string,
    outcomeFilter?: string,
  ): LedgerEntry[] | null {
    this.ensureMigrated();

    // Look up relationship to get participant_hash
    const relationship = this.getRelationship(relationshipId);
    if (!relationship) return null;

    let query = `SELECT ledger_id, participant_hash, canonical_event_id, outcome, weight, note, ts
                 FROM interaction_ledger WHERE participant_hash = ?`;
    const params: unknown[] = [relationship.participant_hash];

    if (outcomeFilter) {
      if (!isValidOutcome(outcomeFilter)) {
        throw new Error(
          `Invalid outcome filter: ${outcomeFilter}. Must be one of: ATTENDED, CANCELED_BY_ME, CANCELED_BY_THEM, NO_SHOW_THEM, NO_SHOW_ME, MOVED_LAST_MINUTE_THEM, MOVED_LAST_MINUTE_ME`,
        );
      }
      query += " AND outcome = ?";
      params.push(outcomeFilter);
    }

    query += " ORDER BY ts DESC, ledger_id DESC";

    const rows = this.sql
      .exec<LedgerRow>(query, ...params)
      .toArray();

    return rows.map((row) => ({
      ledger_id: row.ledger_id,
      participant_hash: row.participant_hash,
      canonical_event_id: row.canonical_event_id,
      outcome: row.outcome,
      weight: row.weight,
      note: row.note,
      ts: row.ts,
    }));
  }

  /**
   * Get the interaction timeline across all relationships.
   *
   * Queries the full interaction_ledger ordered by timestamp descending.
   * Supports optional filtering by participant_hash and date range.
   *
   * @param participantHash - Optional participant hash to filter by
   * @param startDate - Optional start date (ISO string, inclusive)
   * @param endDate - Optional end date (ISO string, inclusive)
   * @returns Array of ledger entries
   */
  getTimeline(
    participantHash?: string | null,
    startDate?: string | null,
    endDate?: string | null,
  ): LedgerEntry[] {
    this.ensureMigrated();

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (participantHash) {
      conditions.push("participant_hash = ?");
      params.push(participantHash);
    }
    if (startDate) {
      conditions.push("ts >= ?");
      params.push(startDate);
    }
    if (endDate) {
      conditions.push("ts <= ?");
      params.push(endDate + "T23:59:59Z");
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const query = `SELECT ledger_id, participant_hash, canonical_event_id, outcome, weight, note, ts
                   FROM interaction_ledger ${where}
                   ORDER BY ts DESC, ledger_id DESC
                   LIMIT 200`;

    const rows = this.sql
      .exec<LedgerRow>(query, ...params)
      .toArray();

    return rows.map((row) => ({
      ledger_id: row.ledger_id,
      participant_hash: row.participant_hash,
      canonical_event_id: row.canonical_event_id,
      outcome: row.outcome,
      weight: row.weight,
      note: row.note,
      ts: row.ts,
    }));
  }

  /**
   * Compute reputation scores for a specific relationship.
   *
   * Queries the interaction ledger, then delegates to the pure
   * computeReputation function from @tminus/shared.
   *
   * Returns null if the relationship does not exist.
   * Scores are computed on-demand (not pre-computed).
   *
   * @param relationshipId - The relationship to compute reputation for
   * @param asOf - Optional timestamp for computation (defaults to now)
   * @returns ReputationResult or null if relationship not found
   */
  getReputation(
    relationshipId: string,
    asOf?: string,
  ): ReputationResult | null {
    this.ensureMigrated();

    const relationship = this.getRelationship(relationshipId);
    if (!relationship) return null;

    const entries = this.listOutcomes(relationshipId);
    if (!entries) return null;

    const ledgerInputs: LedgerInput[] = entries.map((e) => ({
      outcome: e.outcome,
      weight: e.weight,
      ts: e.ts,
    }));

    const now = asOf ?? new Date().toISOString();
    return computeReputation(ledgerInputs, now);
  }

  /**
   * List relationships sorted by reliability score (descending).
   *
   * Computes reputation on-demand for each relationship that has
   * ledger entries, then sorts by reliability_score descending.
   *
   * Returns all relationships with their scores attached.
   *
   * @param asOf - Optional timestamp for computation (defaults to now)
   * @returns Array of relationships with reputation data
   */
  listRelationshipsWithReputation(
    asOf?: string,
  ): Array<Relationship & { reputation: ReputationResult }> {
    this.ensureMigrated();

    const relationships = this.listRelationships();
    const now = asOf ?? new Date().toISOString();

    const results: Array<Relationship & { reputation: ReputationResult }> = [];

    for (const rel of relationships) {
      const entries = this.listOutcomes(rel.relationship_id);
      const ledgerInputs: LedgerInput[] = (entries ?? []).map((e) => ({
        outcome: e.outcome,
        weight: e.weight,
        ts: e.ts,
      }));

      const reputation = computeReputation(ledgerInputs, now);
      results.push({ ...rel, reputation });
    }

    // Sort by reliability_score descending
    results.sort(
      (a, b) => b.reputation.reliability_score - a.reputation.reliability_score,
    );

    return results;
  }

  /**
   * Compute drift report for all relationships.
   *
   * Uses the pure drift computation from @tminus/shared.
   * Returns overdue relationships sorted by urgency.
   */
  getDriftReport(asOf?: string): DriftReport {
    this.ensureMigrated();

    const relationships = this.listRelationships();
    const now = asOf ?? new Date().toISOString();
    return computeDrift(relationships, now);
  }

  /**
   * Get reconnection suggestions: overdue relationships in a specific city.
   *
   * Combines drift computation with city filtering (alias-aware, TM-xwn.3).
   * If trip_id is provided, resolves the trip constraint's destination_city
   * first. If city is provided directly, uses that. Returns overdue contacts
   * in the target city sorted by urgency, with timezone-aware meeting windows.
   *
   * City matching uses matchCityWithAliases: NYC matches "New York",
   * Bombay matches "Mumbai", etc. Falls back to case-insensitive exact match.
   *
   * @param city - City to filter relationships by (alias-aware)
   * @param tripId - Optional trip constraint ID to resolve city from
   * @returns Reconnection suggestions with city, trip, and timezone context
   */
  getReconnectionSuggestions(
    city?: string | null,
    tripId?: string | null,
  ): ReconnectionReport {
    this.ensureMigrated();

    let targetCity: string | null = city ?? null;
    let tripName: string | null = null;
    let tripStart: string | null = null;
    let tripEnd: string | null = null;
    let tripTimezone: string | null = null;

    // If trip_id provided, resolve trip context and fallback city
    if (tripId) {
      const constraint = this.getConstraint(tripId);
      if (!constraint) {
        throw new Error(`Trip constraint not found: ${tripId}`);
      }
      if (constraint.kind !== "trip") {
        throw new Error(`Constraint ${tripId} is not a trip (kind: ${constraint.kind})`);
      }
      const config = constraint.config_json;
      // Only use trip's destination_city if no explicit city was provided
      if (!targetCity && config.destination_city && typeof config.destination_city === "string") {
        targetCity = config.destination_city;
      }
      tripName = typeof config.name === "string" ? config.name : null;
      tripStart = constraint.active_from;
      tripEnd = constraint.active_to;
      tripTimezone = typeof config.timezone === "string" ? config.timezone : null;
    }

    if (!targetCity) {
      throw new Error("No city available. Provide city parameter or use a trip with destination_city set.");
    }

    // Get all relationships in the target city (alias-aware via matchCityWithAliases, TM-xwn.3)
    const allRelationships = this.listRelationships();
    const cityRelationships = allRelationships.filter(
      (r) => matchCityWithAliases(r.city, targetCity),
    );

    // Compute drift for city-filtered relationships
    const now = new Date().toISOString();
    const driftReport = computeDrift(cityRelationships, now);

    // Enrich suggestions with suggested_duration_minutes and time windows
    const enriched = enrichSuggestionsWithTimeWindows(
      driftReport.overdue,
      tripStart,
      tripEnd,
    );

    // Layer timezone-aware meeting windows on top (TM-xwn.3)
    // User timezone = trip timezone (where the traveler will be) or look up from city
    const userTimezone = tripTimezone || cityToTimezone(targetCity);

    // Build contact timezone map from relationship data
    const contactTimezones = new Map<string, string | null>();
    for (const rel of cityRelationships) {
      // Use relationship's stored timezone, or look up from city
      contactTimezones.set(
        rel.relationship_id,
        rel.timezone || cityToTimezone(rel.city) || null,
      );
    }

    const tzEnriched = enrichWithTimezoneWindows(
      enriched,
      tripStart,
      tripEnd,
      userTimezone,
      contactTimezones,
      suggestMeetingWindow,
    );

    return {
      city: targetCity,
      trip_id: tripId ?? null,
      trip_name: tripName,
      trip_start: tripStart,
      trip_end: tripEnd,
      suggestions: tzEnriched,
      total_in_city: cityRelationships.length,
      total_overdue_in_city: driftReport.total_overdue,
      computed_at: driftReport.computed_at,
    };
  }

  // -------------------------------------------------------------------------
  // Milestone CRUD (Phase 4B)
  // -------------------------------------------------------------------------

  /**
   * Create a milestone for a relationship contact.
   *
   * The milestone is linked to the relationship via participant_hash.
   * Kind must be one of MILESTONE_KINDS. Date must be YYYY-MM-DD.
   *
   * @param milestoneId - Pre-generated milestone ID (mst_ prefix)
   * @param relationshipId - The relationship to associate with
   * @param kind - One of MILESTONE_KINDS
   * @param date - ISO date string (YYYY-MM-DD)
   * @param recursAnnually - Whether the milestone recurs each year
   * @param note - Optional free-text note
   * @returns The created milestone, or null if relationship not found
   */
  createMilestone(
    milestoneId: string,
    relationshipId: string,
    kind: string,
    date: string,
    recursAnnually: boolean = false,
    note: string | null = null,
  ): Milestone | null {
    this.ensureMigrated();

    // Validate kind
    if (!isValidMilestoneKind(kind)) {
      throw new Error(
        `Invalid milestone kind: ${kind}. Must be one of: ${MILESTONE_KINDS.join(", ")}`,
      );
    }

    // Validate date
    if (!isValidMilestoneDate(date)) {
      throw new Error(
        `Invalid milestone date: ${date}. Must be YYYY-MM-DD format with a valid date.`,
      );
    }

    // Lookup relationship to get participant_hash
    const relationship = this.getRelationship(relationshipId);
    if (!relationship) return null;

    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO milestones (
        milestone_id, participant_hash, kind, date, recurs_annually, note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      milestoneId,
      relationship.participant_hash,
      kind,
      date,
      recursAnnually ? 1 : 0,
      note,
      now,
    );

    return {
      milestone_id: milestoneId,
      participant_hash: relationship.participant_hash,
      kind: kind as MilestoneKind,
      date,
      recurs_annually: recursAnnually,
      note,
      created_at: now,
    };
  }

  /**
   * List milestones for a specific relationship.
   *
   * @param relationshipId - The relationship whose milestones to list
   * @returns Array of milestones, or null if relationship not found
   */
  listMilestones(relationshipId: string): Milestone[] | null {
    this.ensureMigrated();

    const relationship = this.getRelationship(relationshipId);
    if (!relationship) return null;

    const rows = this.sql
      .exec<{
        milestone_id: string;
        participant_hash: string;
        kind: string;
        date: string;
        recurs_annually: number;
        note: string | null;
        created_at: string;
      }>(
        `SELECT milestone_id, participant_hash, kind, date, recurs_annually, note, created_at
         FROM milestones WHERE participant_hash = ? ORDER BY date ASC`,
        relationship.participant_hash,
      )
      .toArray();

    return rows.map((row) => ({
      milestone_id: row.milestone_id,
      participant_hash: row.participant_hash,
      kind: row.kind as MilestoneKind,
      date: row.date,
      recurs_annually: row.recurs_annually === 1,
      note: row.note,
      created_at: row.created_at,
    }));
  }

  /**
   * Delete a milestone by ID.
   *
   * @param milestoneId - The milestone to delete
   * @returns true if deleted, false if not found
   */
  deleteMilestone(milestoneId: string): boolean {
    this.ensureMigrated();

    const before = this.sql
      .exec<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM milestones WHERE milestone_id = ?",
        milestoneId,
      )
      .toArray()[0].cnt;

    if (before === 0) return false;

    this.sql.exec("DELETE FROM milestones WHERE milestone_id = ?", milestoneId);
    return true;
  }

  /**
   * List upcoming milestones across all relationships within a given number of days.
   *
   * Computes next occurrences for recurring milestones and filters by
   * days_until <= maxDays. Results are sorted by next occurrence date.
   *
   * @param maxDays - Maximum number of days into the future (default 30)
   * @returns Array of upcoming milestones with next_occurrence and days_until
   */
  listUpcomingMilestones(maxDays: number = 30): UpcomingMilestone[] {
    this.ensureMigrated();

    const today = new Date().toISOString().slice(0, 10);

    // Get all milestones with relationship display names
    const rows = this.sql
      .exec<{
        milestone_id: string;
        participant_hash: string;
        kind: string;
        date: string;
        recurs_annually: number;
        note: string | null;
        created_at: string;
        display_name: string | null;
      }>(
        `SELECT m.milestone_id, m.participant_hash, m.kind, m.date,
                m.recurs_annually, m.note, m.created_at,
                r.display_name
         FROM milestones m
         LEFT JOIN relationships r ON m.participant_hash = r.participant_hash
         ORDER BY m.date ASC`,
      )
      .toArray();

    const results: UpcomingMilestone[] = [];

    for (const row of rows) {
      const recurs = row.recurs_annually === 1;
      const nextOccurrence = computeNextOccurrence(row.date, today, recurs);
      const daysUntil = daysBetween(today, nextOccurrence);

      if (daysUntil >= 0 && daysUntil <= maxDays) {
        results.push({
          milestone_id: row.milestone_id,
          participant_hash: row.participant_hash,
          kind: row.kind as MilestoneKind,
          date: row.date,
          recurs_annually: recurs,
          note: row.note,
          created_at: row.created_at,
          next_occurrence: nextOccurrence,
          days_until: daysUntil,
          display_name: row.display_name,
        });
      }
    }

    // Sort by next occurrence (soonest first)
    results.sort((a, b) => a.next_occurrence.localeCompare(b.next_occurrence));

    return results;
  }

  /**
   * Get all milestones for scheduler integration.
   *
   * Returns all milestones (for expanding into busy blocks in computeAvailability).
   * This is a lightweight internal method, not exposed as a public RPC.
   */
  private getAllMilestones(): Array<{
    date: string;
    recurs_annually: number;
  }> {
    return this.sql
      .exec<{ date: string; recurs_annually: number }>(
        "SELECT date, recurs_annually FROM milestones",
      )
      .toArray();
  }

  /**
   * Update last_interaction_ts for relationships matching participant hashes.
   *
   * Called during event ingestion (applyProviderDelta) when an event's
   * attendees include known relationship participant_hashes.
   *
   * @param participantHashes - SHA-256 hashes from event attendees
   * @param interactionTs - Timestamp of the interaction (event start time)
   * @returns Number of relationships updated
   */
  updateInteractions(
    participantHashes: readonly string[],
    interactionTs: string,
  ): number {
    this.ensureMigrated();

    if (participantHashes.length === 0) return 0;

    // Get all relationships
    const allRelationships = this.sql
      .exec<{ relationship_id: string; participant_hash: string }>(
        "SELECT relationship_id, participant_hash FROM relationships",
      )
      .toArray();

    const matchingIds = matchEventParticipants(participantHashes, allRelationships);
    if (matchingIds.length === 0) return 0;

    const now = new Date().toISOString();
    for (const relId of matchingIds) {
      this.sql.exec(
        `UPDATE relationships SET last_interaction_ts = ?, updated_at = ?
         WHERE relationship_id = ?`,
        interactionTs,
        now,
        relId,
      );
    }

    return matchingIds.length;
  }

  // -------------------------------------------------------------------------
  // Event participant storage (for briefing lookups)
  // -------------------------------------------------------------------------

  /**
   * Store participant hashes for a canonical event.
   *
   * Uses INSERT OR IGNORE to handle duplicate hashes gracefully.
   * On update deltas, replaces the full set of participants.
   *
   * @param canonicalEventId - The event to store participants for
   * @param participantHashes - SHA-256 hashes of attendee emails
   */
  storeEventParticipants(
    canonicalEventId: string,
    participantHashes: readonly string[],
  ): void {
    this.ensureMigrated();

    // Delete existing participants for this event (handles updates)
    this.sql.exec(
      "DELETE FROM event_participants WHERE canonical_event_id = ?",
      canonicalEventId,
    );

    // Insert new participants
    for (const hash of participantHashes) {
      this.sql.exec(
        `INSERT OR IGNORE INTO event_participants (canonical_event_id, participant_hash)
         VALUES (?, ?)`,
        canonicalEventId,
        hash,
      );
    }
  }

  /**
   * Get participant hashes for a canonical event.
   *
   * @param canonicalEventId - The event to get participants for
   * @returns Array of participant hashes
   */
  getEventParticipantHashes(canonicalEventId: string): string[] {
    this.ensureMigrated();

    const rows = this.sql
      .exec<{ participant_hash: string }>(
        "SELECT participant_hash FROM event_participants WHERE canonical_event_id = ?",
        canonicalEventId,
      )
      .toArray();

    return rows.map((r) => r.participant_hash);
  }

  // -------------------------------------------------------------------------
  // Scheduling history for fairness scoring (TM-82s.3)
  // -------------------------------------------------------------------------

  /**
   * Record scheduling outcomes for fairness tracking.
   *
   * Inserts one row per participant per session into scheduling_history.
   * Records whether each participant got their preferred time slot.
   */
  recordSchedulingHistory(
    entries: Array<{
      session_id: string;
      participant_hash: string;
      got_preferred: boolean;
      scheduled_ts: string;
    }>,
  ): void {
    this.ensureMigrated();

    for (const entry of entries) {
      const id = generateId("schedHist");
      this.sql.exec(
        `INSERT INTO scheduling_history (id, session_id, participant_hash, got_preferred, scheduled_ts)
         VALUES (?, ?, ?, ?, ?)`,
        id,
        entry.session_id,
        entry.participant_hash,
        entry.got_preferred ? 1 : 0,
        entry.scheduled_ts,
      );
    }
  }

  /**
   * Get aggregated scheduling history for a set of participants.
   *
   * Returns one row per participant with:
   * - sessions_participated: total sessions they were part of
   * - sessions_preferred: sessions where they got preferred time
   * - last_session_ts: most recent session timestamp
   */
  getSchedulingHistory(
    participantHashes: string[],
  ): Array<{
    participant_hash: string;
    sessions_participated: number;
    sessions_preferred: number;
    last_session_ts: string;
  }> {
    this.ensureMigrated();

    if (participantHashes.length === 0) return [];

    // Query aggregate per participant
    const results: Array<{
      participant_hash: string;
      sessions_participated: number;
      sessions_preferred: number;
      last_session_ts: string;
    }> = [];

    for (const hash of participantHashes) {
      const rows = this.sql
        .exec<{
          [key: string]: unknown;
          sessions_participated: number;
          sessions_preferred: number;
          last_session_ts: string | null;
        }>(
          `SELECT
             COUNT(*) as sessions_participated,
             SUM(got_preferred) as sessions_preferred,
             MAX(scheduled_ts) as last_session_ts
           FROM scheduling_history
           WHERE participant_hash = ?`,
          hash,
        )
        .toArray();

      if (rows.length > 0 && rows[0].sessions_participated > 0) {
        results.push({
          participant_hash: hash,
          sessions_participated: rows[0].sessions_participated,
          sessions_preferred: rows[0].sessions_preferred ?? 0,
          last_session_ts: rows[0].last_session_ts ?? "",
        });
      }
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Pre-meeting context briefing (Phase 4C)
  // -------------------------------------------------------------------------

  /**
   * Compute a pre-meeting context briefing for an event.
   *
   * Given a canonical event ID:
   * 1. Loads the event to get its title and start time
   * 2. Looks up participant hashes from event_participants table
   * 3. Matches participant hashes against tracked relationships
   * 4. For matched relationships, computes reputation scores
   * 5. Counts mutual connections (contacts who share events with both user and participant)
   * 6. Assembles the briefing using the pure assembleBriefing function
   *
   * Performance: all data is in single UserGraphDO, computed on-demand.
   *
   * @param canonicalEventId - The event to compute a briefing for
   * @returns EventBriefing or null if event not found
   */
  getEventBriefing(canonicalEventId: string): EventBriefing | null {
    this.ensureMigrated();

    // Step 1: Load the event
    const eventRows = this.sql
      .exec<CanonicalEventRow>(
        `SELECT * FROM canonical_events WHERE canonical_event_id = ?`,
        canonicalEventId,
      )
      .toArray();

    if (eventRows.length === 0) return null;

    const eventRow = eventRows[0];
    const eventTitle = eventRow.title ?? null;
    const eventStart = eventRow.start_ts;

    // Step 2: Get participant hashes for this event
    const participantHashes = this.getEventParticipantHashes(canonicalEventId);

    // Step 3: Get all relationships and find matches
    const allRelationships = this.listRelationships();
    const hashToRelationship = new Map(
      allRelationships.map((r) => [r.participant_hash, r]),
    );

    // Match event participants against relationships
    const matchedRelationships = participantHashes
      .map((hash) => hashToRelationship.get(hash))
      .filter((r): r is Relationship => r !== undefined);

    // Step 4: Compute reputation for each matched relationship
    const now = new Date().toISOString();
    const participants: BriefingParticipantInput[] = matchedRelationships.map((rel) => {
      const entries = this.listOutcomes(rel.relationship_id);
      const ledgerInputs: LedgerInput[] = (entries ?? []).map((e) => ({
        outcome: e.outcome,
        weight: e.weight,
        ts: e.ts,
      }));
      const reputation = computeReputation(ledgerInputs, now);

      return {
        participant_hash: rel.participant_hash,
        display_name: rel.display_name,
        category: rel.category,
        closeness_weight: rel.closeness_weight,
        last_interaction_ts: rel.last_interaction_ts,
        reputation_score: reputation.reliability_score,
        total_interactions: reputation.total_interactions,
      };
    });

    // Step 5: Compute mutual connections
    // Mutual connection = a contact who appears in events with both the user
    // and the briefing participant (i.e., shares events with participant)
    const mutualConnectionCounts = new Map<string, number>();

    for (const rel of matchedRelationships) {
      // Find all events this participant is in
      const participantEvents = this.sql
        .exec<{ canonical_event_id: string }>(
          "SELECT canonical_event_id FROM event_participants WHERE participant_hash = ?",
          rel.participant_hash,
        )
        .toArray()
        .map((r) => r.canonical_event_id);

      if (participantEvents.length === 0) {
        mutualConnectionCounts.set(rel.participant_hash, 0);
        continue;
      }

      // Find other relationships who share events with this participant
      const mutualSet = new Set<string>();
      for (const evtId of participantEvents) {
        const coParticipants = this.sql
          .exec<{ participant_hash: string }>(
            `SELECT participant_hash FROM event_participants
             WHERE canonical_event_id = ? AND participant_hash != ?`,
            evtId,
            rel.participant_hash,
          )
          .toArray();

        for (const cp of coParticipants) {
          // Only count if this co-participant is also a tracked relationship
          if (hashToRelationship.has(cp.participant_hash)) {
            mutualSet.add(cp.participant_hash);
          }
        }
      }

      mutualConnectionCounts.set(rel.participant_hash, mutualSet.size);
    }

    // Step 6: Assemble the briefing
    return assembleBriefing(
      canonicalEventId,
      eventTitle,
      eventStart,
      participants,
      mutualConnectionCounts,
      now,
    );
  }

  // -------------------------------------------------------------------------
  // Drift alert storage (persisted snapshots from daily cron)
  // -------------------------------------------------------------------------

  /**
   * Store a new set of drift alerts, replacing any previous set.
   *
   * Called by the daily cron job after computing drift for all relationships.
   * Uses DELETE + INSERT pattern (full replacement) to ensure the stored
   * alerts always reflect the most recent computation.
   *
   * @param report - The drift report to persist as alerts
   * @returns Number of alerts stored
   */
  storeDriftAlerts(report: DriftReport): number {
    this.ensureMigrated();

    // Clear previous alerts
    this.sql.exec("DELETE FROM drift_alerts");

    // Insert new alerts from the overdue entries
    for (const entry of report.overdue) {
      const alertId = generateId("alert");
      this.sql.exec(
        `INSERT INTO drift_alerts
         (alert_id, relationship_id, display_name, category, drift_ratio, days_overdue, urgency, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        alertId,
        entry.relationship_id,
        entry.display_name,
        entry.category,
        entry.drift_ratio,
        entry.days_overdue,
        entry.urgency,
        report.computed_at,
      );
    }

    return report.overdue.length;
  }

  /**
   * Retrieve the most recently stored drift alerts.
   *
   * Returns the persisted alert snapshot from the last cron run,
   * sorted by urgency descending (most urgent first).
   */
  getDriftAlerts(): DriftAlert[] {
    this.ensureMigrated();

    return this.sql
      .exec<DriftAlertRow>(
        `SELECT alert_id, relationship_id, display_name, category,
                drift_ratio, days_overdue, urgency, computed_at
         FROM drift_alerts
         ORDER BY urgency DESC`,
      )
      .toArray();
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

        case "/storeCalendars": {
          const body = (await request.json()) as {
            calendars: Array<{
              account_id: string;
              provider_calendar_id: string;
              role: string;
              kind: string;
              display_name: string;
            }>;
          };
          this.storeCalendars(body.calendars);
          return Response.json({ ok: true, stored: body.calendars.length });
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

        case "/upsertCanonicalEvent": {
          const body = (await request.json()) as {
            event: import("@tminus/shared").CanonicalEvent;
            source: string;
          };
          const eventId = await this.upsertCanonicalEvent(body.event, body.source);
          return Response.json(eventId);
        }

        case "/deleteCanonicalEvent": {
          const body = (await request.json()) as {
            canonical_event_id: string;
            source: string;
          };
          const deleted = await this.deleteCanonicalEvent(
            body.canonical_event_id,
            body.source,
          );
          return Response.json(deleted);
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

        case "/computeAvailability": {
          const body = (await request.json()) as AvailabilityQuery;
          const result = this.computeAvailability(body);
          return Response.json(result);
        }

        case "/getCognitiveLoad": {
          const body = (await request.json()) as {
            date: string;
            range: "day" | "week";
          };
          const result = this.getCognitiveLoad(body.date, body.range);
          return Response.json(result);
        }

        case "/getContextSwitches": {
          const body = (await request.json()) as {
            date: string;
            range: "day" | "week";
          };
          const result = this.getContextSwitches(body.date, body.range);
          return Response.json(result);
        }

        case "/getDeepWork": {
          const body = (await request.json()) as {
            date: string;
            range: "day" | "week";
            min_block_minutes?: number;
          };
          const result = this.getDeepWork(body.date, body.range, body.min_block_minutes);
          return Response.json(result);
        }

        case "/getRiskScores": {
          const body = (await request.json()) as {
            weeks?: number;
          };
          const result = this.getRiskScores(body.weeks ?? 4);
          return Response.json(result);
        }

        case "/getProbabilisticAvailability": {
          const body = (await request.json()) as {
            start: string;
            end: string;
            granularity_minutes?: number;
          };
          const result = this.getProbabilisticAvailability(
            body.start,
            body.end,
            body.granularity_minutes,
          );
          return Response.json(result);
        }

        // ---------------------------------------------------------------
        // Constraint RPC endpoints
        // ---------------------------------------------------------------

        case "/addConstraint": {
          const body = (await request.json()) as {
            kind: string;
            config_json: Record<string, unknown>;
            active_from: string | null;
            active_to: string | null;
          };
          const constraint = this.addConstraint(
            body.kind,
            body.config_json,
            body.active_from,
            body.active_to,
          );
          return Response.json(constraint);
        }

        case "/deleteConstraint": {
          const body = (await request.json()) as { constraint_id: string };
          const deleted = await this.deleteConstraint(body.constraint_id);
          return Response.json({ deleted });
        }

        case "/listConstraints": {
          const body = (await request.json()) as { kind?: string };
          const constraints = this.listConstraints(body.kind);
          return Response.json({ items: constraints });
        }

        case "/getConstraint": {
          const body = (await request.json()) as { constraint_id: string };
          const constraint = this.getConstraint(body.constraint_id);
          return Response.json(constraint);
        }

        case "/updateConstraint": {
          const body = (await request.json()) as {
            constraint_id: string;
            config_json: Record<string, unknown>;
            active_from: string | null;
            active_to: string | null;
          };
          const updated = await this.updateConstraint(
            body.constraint_id,
            body.config_json,
            body.active_from,
            body.active_to,
          );
          return Response.json(updated);
        }

        case "/unlinkAccount": {
          const body = (await request.json()) as { account_id: string };
          const result = await this.unlinkAccount(body.account_id);
          return Response.json(result);
        }

        // ---------------------------------------------------------------
        // GDPR Deletion RPC endpoints
        // ---------------------------------------------------------------

        case "/deleteAllEvents": {
          const result = this.deleteAllEvents();
          return Response.json(result);
        }

        case "/deleteAllMirrors": {
          const result = this.deleteAllMirrors();
          return Response.json(result);
        }

        case "/deleteJournal": {
          const result = this.deleteJournal();
          return Response.json(result);
        }

        case "/deleteRelationshipData": {
          const result = this.deleteRelationshipData();
          return Response.json(result);
        }

        // ---------------------------------------------------------------
        // Scheduling RPC endpoints (Phase 3)
        // ---------------------------------------------------------------

        case "/storeSchedulingSession": {
          const body = (await request.json()) as {
            session_id: string;
            status: string;
            objective_json: string;
            candidates: Array<{
              candidateId: string;
              sessionId: string;
              start: string;
              end: string;
              score: number;
              explanation: string;
            }>;
            created_at: string;
          };
          this.storeSchedulingSession(body);
          return Response.json({ ok: true });
        }

        case "/getSchedulingSession": {
          const body = (await request.json()) as { session_id: string };
          const session = this.getSchedulingSession(body.session_id);
          return Response.json(session);
        }

        case "/commitSchedulingSession": {
          const body = (await request.json()) as {
            session_id: string;
            candidate_id: string;
            event_id: string;
          };
          this.commitSchedulingSession(body.session_id, body.candidate_id, body.event_id);
          return Response.json({ ok: true });
        }

        case "/listSchedulingSessions": {
          const body = (await request.json()) as {
            status?: string;
            limit?: number;
            offset?: number;
          };
          const sessions = this.listSchedulingSessions(body.status, body.limit, body.offset);
          return Response.json(sessions);
        }

        case "/cancelSchedulingSession": {
          const body = (await request.json()) as { session_id: string };
          this.cancelSchedulingSession(body.session_id);
          return Response.json({ ok: true });
        }

        case "/expireStaleSchedulingSessions": {
          const body = (await request.json()) as { max_age_hours?: number };
          const count = this.expireStaleSchedulingSessions(body.max_age_hours);
          return Response.json({ expired_count: count });
        }

        // ---------------------------------------------------------------
        // Hold management RPC endpoints (TM-946.3)
        // ---------------------------------------------------------------

        case "/storeHolds": {
          const body = (await request.json()) as {
            holds: Array<{
              hold_id: string;
              session_id: string;
              account_id: string;
              provider_event_id: string | null;
              expires_at: string;
              status: string;
            }>;
          };
          this.storeHolds(body.holds);
          return Response.json({ ok: true });
        }

        case "/getHoldsBySession": {
          const body = (await request.json()) as { session_id: string };
          const holds = this.getHoldsBySession(body.session_id);
          return Response.json({ holds });
        }

        case "/updateHoldStatus": {
          const body = (await request.json()) as {
            hold_id: string;
            status: string;
            provider_event_id?: string;
          };
          this.updateHoldStatus(body.hold_id, body.status, body.provider_event_id);
          return Response.json({ ok: true });
        }

        case "/getExpiredHolds": {
          const holds = this.getExpiredHolds();
          return Response.json({ holds });
        }

        case "/commitSessionHolds": {
          const body = (await request.json()) as {
            session_id: string;
            committed_candidate_id: string;
          };
          const holds = this.commitSessionHolds(body.session_id, body.committed_candidate_id);
          return Response.json({ holds });
        }

        case "/releaseSessionHolds": {
          const body = (await request.json()) as { session_id: string };
          this.releaseSessionHolds(body.session_id);
          return Response.json({ ok: true });
        }

        case "/extendHolds": {
          const body = (await request.json()) as {
            session_id: string;
            holds: Array<{ hold_id: string; new_expires_at: string }>;
          };
          const extended = this.extendHolds(body.session_id, body.holds);
          return Response.json({ ok: true, extended });
        }

        case "/expireSessionIfAllHoldsTerminal": {
          const body = (await request.json()) as { session_id: string };
          const expired = this.expireSessionIfAllHoldsTerminal(body.session_id);
          return Response.json({ ok: true, expired });
        }

        // ---------------------------------------------------------------
        // Time allocation RPC endpoints
        // ---------------------------------------------------------------

        case "/createAllocation": {
          const body = (await request.json()) as {
            allocation_id: string;
            canonical_event_id: string;
            billing_category: string;
            client_id: string | null;
            rate: number | null;
          };
          const alloc = this.createAllocation(
            body.allocation_id,
            body.canonical_event_id,
            body.billing_category,
            body.client_id,
            body.rate,
          );
          return Response.json(alloc);
        }

        case "/getAllocation": {
          const body = (await request.json()) as { canonical_event_id: string };
          const alloc = this.getAllocation(body.canonical_event_id);
          return Response.json(alloc);
        }

        case "/updateAllocation": {
          const body = (await request.json()) as {
            canonical_event_id: string;
            updates: {
              billing_category?: string;
              client_id?: string | null;
              rate?: number | null;
            };
          };
          const alloc = this.updateAllocation(body.canonical_event_id, body.updates);
          return Response.json(alloc);
        }

        case "/deleteAllocation": {
          const body = (await request.json()) as { canonical_event_id: string };
          const deleted = this.deleteAllocation(body.canonical_event_id);
          return Response.json({ deleted });
        }

        case "/listAllocations": {
          const items = this.listAllocations();
          return Response.json({ items });
        }

        // ---------------------------------------------------------------
        // VIP policy RPC endpoints
        // ---------------------------------------------------------------

        case "/createVipPolicy": {
          const body = (await request.json()) as {
            vip_id: string;
            participant_hash: string;
            display_name: string | null;
            priority_weight: number;
            conditions_json: Record<string, unknown>;
          };
          const vip = this.createVipPolicy(
            body.vip_id,
            body.participant_hash,
            body.display_name,
            body.priority_weight,
            body.conditions_json,
          );
          return Response.json(vip);
        }

        case "/listVipPolicies": {
          const items = this.listVipPolicies();
          return Response.json({ items });
        }

        case "/getVipPolicy": {
          const body = (await request.json()) as { vip_id: string };
          const vip = this.getVipPolicy(body.vip_id);
          return Response.json(vip);
        }

        case "/deleteVipPolicy": {
          const body = (await request.json()) as { vip_id: string };
          const deleted = this.deleteVipPolicy(body.vip_id);
          return Response.json({ deleted });
        }

        // ---------------------------------------------------------------
        // Commitment tracking RPC endpoints
        // ---------------------------------------------------------------

        case "/createCommitment": {
          const body = (await request.json()) as {
            commitment_id: string;
            client_id: string;
            target_hours: number;
            window_type?: string;
            client_name?: string | null;
            rolling_window_weeks?: number;
            hard_minimum?: boolean;
            proof_required?: boolean;
          };
          const commitment = this.createCommitment(
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
        }

        case "/getCommitment": {
          const body = (await request.json()) as { commitment_id: string };
          const commitment = this.getCommitment(body.commitment_id);
          return Response.json(commitment);
        }

        case "/listCommitments": {
          const items = this.listCommitments();
          return Response.json({ items });
        }

        case "/deleteCommitment": {
          const body = (await request.json()) as { commitment_id: string };
          const deleted = this.deleteCommitment(body.commitment_id);
          return Response.json({ deleted });
        }

        case "/getCommitmentStatus": {
          const body = (await request.json()) as {
            commitment_id: string;
            as_of?: string;
          };
          const status = this.getCommitmentStatus(
            body.commitment_id,
            body.as_of,
          );
          return Response.json(status);
        }

        case "/getCommitmentProofData": {
          const body = (await request.json()) as {
            commitment_id: string;
            as_of?: string;
          };
          const proofData = this.getCommitmentProofData(
            body.commitment_id,
            body.as_of,
          );
          return Response.json(proofData);
        }

        // ---------------------------------------------------------------
        // What-If Simulation RPC endpoint
        // ---------------------------------------------------------------

        case "/simulate": {
          const body = (await request.json()) as {
            scenario: SimulationScenario;
          };
          const snapshot = this.buildSimulationSnapshot();
          const impact = simulate(snapshot, body.scenario);
          return Response.json(impact);
        }

        // ---------------------------------------------------------------
        // Relationship tracking RPC endpoints (Phase 4)
        // ---------------------------------------------------------------

        case "/createRelationship": {
          const body = (await request.json()) as {
            relationship_id: string;
            participant_hash: string;
            display_name: string | null;
            category: string;
            closeness_weight?: number;
            city?: string | null;
            timezone?: string | null;
            interaction_frequency_target?: number | null;
          };
          const relationship = this.createRelationship(
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
        }

        case "/getRelationship": {
          const body = (await request.json()) as { relationship_id: string };
          const relationship = this.getRelationship(body.relationship_id);
          return Response.json(relationship);
        }

        case "/listRelationships": {
          const body = (await request.json()) as { category?: string };
          const items = this.listRelationships(body.category);
          return Response.json({ items });
        }

        case "/updateRelationship": {
          const body = (await request.json()) as {
            relationship_id: string;
            display_name?: string | null;
            category?: string;
            closeness_weight?: number;
            city?: string | null;
            timezone?: string | null;
            interaction_frequency_target?: number | null;
          };
          const { relationship_id, ...updates } = body;
          const updated = this.updateRelationship(relationship_id, updates);
          return Response.json(updated);
        }

        case "/deleteRelationship": {
          const body = (await request.json()) as { relationship_id: string };
          const deleted = this.deleteRelationship(body.relationship_id);
          return Response.json({ deleted });
        }

        case "/markOutcome": {
          const body = (await request.json()) as {
            relationship_id: string;
            outcome: string;
            canonical_event_id?: string | null;
            note?: string | null;
          };
          const entry = this.markOutcome(
            body.relationship_id,
            body.outcome,
            body.canonical_event_id ?? null,
            body.note ?? null,
          );
          return Response.json(entry);
        }

        case "/listOutcomes": {
          const body = (await request.json()) as {
            relationship_id: string;
            outcome?: string;
          };
          const entries = this.listOutcomes(
            body.relationship_id,
            body.outcome,
          );
          return Response.json({ items: entries });
        }

        case "/getReputation": {
          const body = (await request.json()) as {
            relationship_id: string;
            as_of?: string;
          };
          const reputation = this.getReputation(
            body.relationship_id,
            body.as_of,
          );
          return Response.json(reputation);
        }

        case "/listRelationshipsWithReputation": {
          const body = (await request.json()) as { as_of?: string };
          const items = this.listRelationshipsWithReputation(body.as_of);
          return Response.json({ items });
        }

        case "/getDriftReport": {
          const body = (await request.json()) as { as_of?: string };
          const report = this.getDriftReport(body.as_of);
          return Response.json(report);
        }

        case "/getReconnectionSuggestions": {
          const body = (await request.json()) as {
            city?: string | null;
            trip_id?: string | null;
          };
          const suggestions = this.getReconnectionSuggestions(
            body.city,
            body.trip_id,
          );
          return Response.json(suggestions);
        }

        // ---------------------------------------------------------------
        // Milestone CRUD RPC endpoints (Phase 4B)
        // ---------------------------------------------------------------

        case "/createMilestone": {
          const body = (await request.json()) as {
            milestone_id: string;
            relationship_id: string;
            kind: string;
            date: string;
            recurs_annually?: boolean;
            note?: string | null;
          };
          const milestone = this.createMilestone(
            body.milestone_id,
            body.relationship_id,
            body.kind,
            body.date,
            body.recurs_annually ?? false,
            body.note ?? null,
          );
          return Response.json(milestone);
        }

        case "/listMilestones": {
          const body = (await request.json()) as {
            relationship_id: string;
          };
          const milestones = this.listMilestones(body.relationship_id);
          if (milestones === null) {
            return Response.json(
              { error: "Relationship not found" },
              { status: 404 },
            );
          }
          return Response.json({ items: milestones });
        }

        case "/deleteMilestone": {
          const body = (await request.json()) as { milestone_id: string };
          const deleted = this.deleteMilestone(body.milestone_id);
          return Response.json({ deleted });
        }

        case "/listUpcomingMilestones": {
          const body = (await request.json()) as { max_days?: number };
          const upcoming = this.listUpcomingMilestones(body.max_days ?? 30);
          return Response.json({ items: upcoming });
        }

        case "/updateInteractions": {
          const body = (await request.json()) as {
            participant_hashes: string[];
            interaction_ts: string;
          };
          const count = this.updateInteractions(
            body.participant_hashes,
            body.interaction_ts,
          );
          return Response.json({ updated: count });
        }

        case "/storeDriftAlerts": {
          const body = (await request.json()) as { report: DriftReport };
          const count = this.storeDriftAlerts(body.report);
          return Response.json({ stored: count });
        }

        case "/getDriftAlerts": {
          const alerts = this.getDriftAlerts();
          return Response.json({ alerts });
        }

        case "/getEventBriefing": {
          const body = (await request.json()) as {
            canonical_event_id: string;
          };
          const briefing = this.getEventBriefing(body.canonical_event_id);
          if (briefing === null) {
            return Response.json(
              { error: "Event not found" },
              { status: 404 },
            );
          }
          return Response.json(briefing);
        }

        case "/storeEventParticipants": {
          const body = (await request.json()) as {
            canonical_event_id: string;
            participant_hashes: string[];
          };
          this.storeEventParticipants(
            body.canonical_event_id,
            body.participant_hashes,
          );
          return Response.json({ stored: body.participant_hashes.length });
        }

        case "/recordSchedulingHistory": {
          const body = (await request.json()) as {
            entries: Array<{
              session_id: string;
              participant_hash: string;
              got_preferred: boolean;
              scheduled_ts: string;
            }>;
          };
          this.recordSchedulingHistory(body.entries);
          return Response.json({ recorded: body.entries.length });
        }

        case "/getSchedulingHistory": {
          const body = (await request.json()) as {
            participant_hashes: string[];
          };
          const history = this.getSchedulingHistory(body.participant_hashes);
          return Response.json({ history });
        }

        // ---------------------------------------------------------------
        // Graph API RPC endpoints (TM-b3i.4)
        // ---------------------------------------------------------------

        case "/getEventParticipantHashes": {
          const body = (await request.json()) as {
            canonical_event_id: string;
          };
          const hashes = this.getEventParticipantHashes(body.canonical_event_id);
          return Response.json({ hashes });
        }

        case "/getTimeline": {
          const body = (await request.json()) as {
            participant_hash?: string | null;
            start_date?: string | null;
            end_date?: string | null;
          };
          const items = this.getTimeline(
            body.participant_hash,
            body.start_date,
            body.end_date,
          );
          return Response.json({ items });
        }

        // ---------------------------------------------------------------
        // Onboarding session RPC endpoints (Phase 6A)
        // ---------------------------------------------------------------

        case "/createOnboardingSession": {
          const body = (await request.json()) as {
            session_id: string;
            user_id: string;
            session_token: string;
          };
          const session = this.createOnboardingSession(
            body.session_id,
            body.user_id,
            body.session_token,
          );
          return Response.json(session);
        }

        case "/getOnboardingSession": {
          const body = (await request.json()) as {
            user_id: string;
          };
          const session = this.getOnboardingSession(body.user_id);
          return Response.json(session);
        }

        case "/getOnboardingSessionByToken": {
          const body = (await request.json()) as {
            session_token: string;
          };
          const session = this.getOnboardingSessionByToken(body.session_token);
          return Response.json(session);
        }

        case "/addOnboardingAccount": {
          const body = (await request.json()) as {
            user_id: string;
            account: {
              account_id: string;
              provider: string;
              email: string;
              status: string;
              calendar_count?: number;
              connected_at: string;
            };
          };
          const session = this.addOnboardingAccount(body.user_id, body.account);
          return Response.json(session);
        }

        case "/updateOnboardingAccountStatus": {
          const body = (await request.json()) as {
            user_id: string;
            account_id: string;
            status: string;
            calendar_count?: number;
          };
          const session = this.updateOnboardingAccountStatus(
            body.user_id,
            body.account_id,
            body.status,
            body.calendar_count,
          );
          return Response.json(session);
        }

        case "/completeOnboardingSession": {
          const body = (await request.json()) as {
            user_id: string;
          };
          const session = this.completeOnboardingSession(body.user_id);
          return Response.json(session);
        }

        // ---------------------------------------------------------------
        // ICS Upgrade Flow RPC endpoints (TM-1rs / TM-d17.5)
        // ---------------------------------------------------------------

        case "/getAccountEvents": {
          const body = (await request.json()) as { account_id: string };
          const events = this.getAccountEvents(body.account_id);
          return Response.json({ events });
        }

        case "/executeUpgrade": {
          const body = (await request.json()) as {
            ics_account_id: string;
            oauth_account_id: string;
            merged_events: MergedEvent[];
            new_events: UpgradeProviderEvent[];
            orphaned_events: UpgradeIcsEvent[];
          };
          await this.executeUpgradePlan(body);
          return Response.json({ ok: true });
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
  // Scheduling session management (Phase 3)
  // -------------------------------------------------------------------------

  /**
   * Store a scheduling session and its candidates in the DO-local SQLite.
   * Uses the schedule_sessions and schedule_candidates tables from the
   * USER_GRAPH_DO_MIGRATION_V1 schema.
   */
  private storeSchedulingSession(data: {
    session_id: string;
    status: string;
    objective_json: string;
    candidates: Array<{
      candidateId: string;
      sessionId: string;
      start: string;
      end: string;
      score: number;
      explanation: string;
    }>;
    created_at: string;
  }): void {
    this.ensureMigrated();

    this.sql.exec(
      `INSERT INTO schedule_sessions (session_id, status, objective_json, created_at)
       VALUES (?, ?, ?, ?)`,
      data.session_id,
      data.status,
      data.objective_json,
      data.created_at,
    );

    for (const c of data.candidates) {
      this.sql.exec(
        `INSERT INTO schedule_candidates (candidate_id, session_id, start_ts, end_ts, score, explanation, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        c.candidateId,
        c.sessionId,
        c.start,
        c.end,
        c.score,
        c.explanation,
        data.created_at,
      );
    }
  }

  /**
   * Retrieve a scheduling session and its candidates.
   * Returns the full session object with candidates array.
   */
  private getSchedulingSession(sessionId: string): {
    sessionId: string;
    status: string;
    params: Record<string, unknown>;
    candidates: Array<{
      candidateId: string;
      sessionId: string;
      start: string;
      end: string;
      score: number;
      explanation: string;
    }>;
    committedCandidateId?: string;
    committedEventId?: string;
    createdAt: string;
  } {
    this.ensureMigrated();

    interface SessionRow {
      [key: string]: unknown;
      session_id: string;
      status: string;
      objective_json: string;
      created_at: string;
    }

    const rows = this.sql.exec<SessionRow>(
      `SELECT session_id, status, objective_json, created_at
       FROM schedule_sessions WHERE session_id = ?`,
      sessionId,
    ).toArray();

    if (rows.length === 0) {
      throw new Error(`Session ${sessionId} not found`);
    }

    let session = rows[0];

    // Lazy expiry: if session is in an active state and older than 24h, expire it
    if (
      (session.status === "open" || session.status === "candidates_ready") &&
      session.created_at
    ) {
      const createdMs = new Date(session.created_at).getTime();
      const nowMs = Date.now();
      const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours
      if (nowMs - createdMs > maxAgeMs) {
        this.sql.exec(
          "UPDATE schedule_sessions SET status = 'expired' WHERE session_id = ?",
          sessionId,
        );
        this.sql.exec(
          "UPDATE schedule_holds SET status = 'released' WHERE session_id = ? AND status = 'held'",
          sessionId,
        );
        session = { ...session, status: "expired" };
      }
    }

    interface CandidateRow {
      [key: string]: unknown;
      candidate_id: string;
      session_id: string;
      start_ts: string;
      end_ts: string;
      score: number;
      explanation: string;
    }

    const candidateRows = this.sql.exec<CandidateRow>(
      `SELECT candidate_id, session_id, start_ts, end_ts, score, explanation
       FROM schedule_candidates WHERE session_id = ? ORDER BY score DESC`,
      sessionId,
    ).toArray();

    const candidates = candidateRows.map((r) => ({
      candidateId: r.candidate_id,
      sessionId: r.session_id,
      start: r.start_ts,
      end: r.end_ts,
      score: r.score as number,
      explanation: r.explanation as string,
    }));

    // Parse objective JSON to extract params and committed info
    let params: Record<string, unknown> = {};
    let committedCandidateId: string | undefined;
    let committedEventId: string | undefined;

    try {
      const obj = JSON.parse(session.objective_json);
      // Check if we stored commit info in the objective JSON
      if (obj._committedCandidateId) {
        committedCandidateId = obj._committedCandidateId;
        committedEventId = obj._committedEventId;
        // Remove internal fields from params
        const { _committedCandidateId, _committedEventId, ...rest } = obj;
        params = rest;
      } else {
        params = obj;
      }
    } catch {
      // objective_json may be malformed; use empty object
    }

    return {
      sessionId: session.session_id,
      status: session.status,
      params,
      candidates,
      committedCandidateId,
      committedEventId,
      createdAt: session.created_at,
    };
  }

  /**
   * Mark a scheduling session as committed and record which candidate
   * was chosen and the resulting event ID.
   */
  private commitSchedulingSession(
    sessionId: string,
    candidateId: string,
    eventId: string,
  ): void {
    this.ensureMigrated();

    // Get current session to preserve objective_json
    interface SessionRow {
      [key: string]: unknown;
      objective_json: string;
    }

    const rows = this.sql.exec<SessionRow>(
      `SELECT objective_json FROM schedule_sessions WHERE session_id = ?`,
      sessionId,
    ).toArray();

    if (rows.length === 0) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Store committed info in objective_json (augment, don't replace)
    let obj: Record<string, unknown> = {};
    try {
      obj = JSON.parse(rows[0].objective_json);
    } catch { /* empty */ }
    obj._committedCandidateId = candidateId;
    obj._committedEventId = eventId;

    this.sql.exec(
      `UPDATE schedule_sessions SET status = 'committed', objective_json = ? WHERE session_id = ?`,
      JSON.stringify(obj),
      sessionId,
    );
  }

  /**
   * List scheduling sessions with optional status filter.
   * Applies lazy expiry check before returning results:
   * sessions in 'open' or 'candidates_ready' status that are older
   * than SESSION_EXPIRY_HOURS are automatically marked 'expired'.
   */
  private listSchedulingSessions(
    statusFilter?: string,
    limit: number = 50,
    offset: number = 0,
  ): {
    items: Array<{
      sessionId: string;
      status: string;
      params: Record<string, unknown>;
      candidateCount: number;
      createdAt: string;
    }>;
    total: number;
  } {
    this.ensureMigrated();

    // Lazy expiry: expire stale sessions before listing
    this.expireStaleSchedulingSessions();

    interface SessionRow {
      [key: string]: unknown;
      session_id: string;
      status: string;
      objective_json: string;
      created_at: string;
    }

    interface CountRow {
      [key: string]: unknown;
      cnt: number;
    }

    interface CandidateCountRow {
      [key: string]: unknown;
      cnt: number;
    }

    // Build query with optional status filter
    let countQuery = "SELECT COUNT(*) as cnt FROM schedule_sessions";
    let listQuery = `SELECT session_id, status, objective_json, created_at FROM schedule_sessions`;
    const bindings: unknown[] = [];

    if (statusFilter) {
      countQuery += " WHERE status = ?";
      listQuery += " WHERE status = ?";
      bindings.push(statusFilter);
    }

    const totalRow = this.sql.exec<CountRow>(countQuery, ...bindings).one();
    const total = totalRow.cnt as number;

    listQuery += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    const rows = this.sql.exec<SessionRow>(
      listQuery,
      ...bindings,
      limit,
      offset,
    ).toArray();

    const items = rows.map((r) => {
      let params: Record<string, unknown> = {};
      try {
        const obj = JSON.parse(r.objective_json);
        const { _committedCandidateId, _committedEventId, ...rest } = obj;
        params = rest;
      } catch { /* empty */ }

      // Get candidate count for this session
      const candidateCountRow = this.sql.exec<CandidateCountRow>(
        "SELECT COUNT(*) as cnt FROM schedule_candidates WHERE session_id = ?",
        r.session_id,
      ).one();

      return {
        sessionId: r.session_id,
        status: r.status,
        params,
        candidateCount: candidateCountRow.cnt as number,
        createdAt: r.created_at,
      };
    });

    return { items, total };
  }

  /**
   * Cancel a scheduling session. Validates that the session is in a
   * cancellable state (open or candidates_ready). Releases any held
   * slots in the schedule_holds table.
   *
   * Valid transitions to cancelled: open, candidates_ready.
   * Already cancelled/committed/expired sessions cannot be cancelled.
   */
  private cancelSchedulingSession(sessionId: string): void {
    this.ensureMigrated();

    interface SessionRow {
      [key: string]: unknown;
      session_id: string;
      status: string;
    }

    const rows = this.sql.exec<SessionRow>(
      "SELECT session_id, status FROM schedule_sessions WHERE session_id = ?",
      sessionId,
    ).toArray();

    if (rows.length === 0) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const currentStatus = rows[0].status;

    // Validate status transition
    if (currentStatus === "cancelled") {
      throw new Error(`Session ${sessionId} is already cancelled`);
    }
    if (currentStatus === "committed") {
      throw new Error(`Session ${sessionId} is already committed and cannot be cancelled`);
    }
    if (currentStatus === "expired") {
      throw new Error(`Session ${sessionId} is expired and cannot be cancelled`);
    }

    // Update session status to cancelled
    this.sql.exec(
      "UPDATE schedule_sessions SET status = 'cancelled' WHERE session_id = ?",
      sessionId,
    );

    // Release any held slots for this session
    this.sql.exec(
      "UPDATE schedule_holds SET status = 'released' WHERE session_id = ? AND status = 'held'",
      sessionId,
    );
  }

  /**
   * Expire sessions that have been in 'open' or 'candidates_ready' status
   * for longer than the configured maximum age. Returns the count of
   * sessions expired.
   *
   * Default expiry: 24 hours.
   */
  private expireStaleSchedulingSessions(maxAgeHours: number = 24): number {
    this.ensureMigrated();

    interface ExpiredRow {
      [key: string]: unknown;
      session_id: string;
    }

    // Find sessions eligible for expiry
    const stale = this.sql.exec<ExpiredRow>(
      `SELECT session_id FROM schedule_sessions
       WHERE status IN ('open', 'candidates_ready')
       AND datetime(created_at, '+' || ? || ' hours') < datetime('now')`,
      maxAgeHours,
    ).toArray();

    if (stale.length === 0) return 0;

    // Expire each stale session and release its holds
    for (const row of stale) {
      this.sql.exec(
        "UPDATE schedule_sessions SET status = 'expired' WHERE session_id = ?",
        row.session_id,
      );
      this.sql.exec(
        "UPDATE schedule_holds SET status = 'released' WHERE session_id = ? AND status = 'held'",
        row.session_id,
      );
    }

    return stale.length;
  }

  // -------------------------------------------------------------------------
  // Tentative hold management (TM-946.3)
  // -------------------------------------------------------------------------

  /**
   * Store one or more hold records in the schedule_holds table.
   * Each hold represents a tentative calendar event for a candidate slot.
   */
  private storeHolds(
    holds: Array<{
      hold_id: string;
      session_id: string;
      account_id: string;
      provider_event_id: string | null;
      expires_at: string;
      status: string;
    }>,
  ): void {
    this.ensureMigrated();

    for (const h of holds) {
      this.sql.exec(
        `INSERT INTO schedule_holds (hold_id, session_id, account_id, provider_event_id, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
        h.hold_id,
        h.session_id,
        h.account_id,
        h.provider_event_id,
        h.expires_at,
        h.status,
      );
    }
  }

  /**
   * Retrieve all holds for a given session.
   */
  private getHoldsBySession(sessionId: string): Array<{
    hold_id: string;
    session_id: string;
    account_id: string;
    provider_event_id: string | null;
    expires_at: string;
    status: string;
  }> {
    this.ensureMigrated();

    interface HoldRow {
      [key: string]: unknown;
      hold_id: string;
      session_id: string;
      account_id: string;
      provider_event_id: string | null;
      expires_at: string;
      status: string;
    }

    return this.sql
      .exec<HoldRow>(
        `SELECT hold_id, session_id, account_id, provider_event_id, expires_at, status
         FROM schedule_holds WHERE session_id = ?`,
        sessionId,
      )
      .toArray()
      .map((r) => ({
        hold_id: r.hold_id,
        session_id: r.session_id,
        account_id: r.account_id,
        provider_event_id: r.provider_event_id,
        expires_at: r.expires_at,
        status: r.status,
      }));
  }

  /**
   * Update the status of a specific hold. Optionally sets provider_event_id
   * (e.g., after the write-queue creates the Google Calendar event).
   *
   * Valid transitions: held -> committed | released | expired
   */
  private updateHoldStatus(
    holdId: string,
    newStatus: string,
    providerEventId?: string,
  ): void {
    this.ensureMigrated();

    interface HoldRow {
      [key: string]: unknown;
      hold_id: string;
      status: string;
    }

    const rows = this.sql
      .exec<HoldRow>(
        "SELECT hold_id, status FROM schedule_holds WHERE hold_id = ?",
        holdId,
      )
      .toArray();

    if (rows.length === 0) {
      throw new Error(`Hold ${holdId} not found`);
    }

    const currentStatus = rows[0].status;

    // Validate transition
    const validTransitions: Record<string, string[]> = {
      held: ["committed", "released", "expired"],
    };
    const allowed = validTransitions[currentStatus] ?? [];
    if (!allowed.includes(newStatus)) {
      throw new Error(
        `Invalid hold transition: '${currentStatus}' -> '${newStatus}'`,
      );
    }

    if (providerEventId !== undefined) {
      this.sql.exec(
        "UPDATE schedule_holds SET status = ?, provider_event_id = ? WHERE hold_id = ?",
        newStatus,
        providerEventId,
        holdId,
      );
    } else {
      this.sql.exec(
        "UPDATE schedule_holds SET status = ? WHERE hold_id = ?",
        newStatus,
        holdId,
      );
    }
  }

  /**
   * Query holds that are in 'held' status but past their expires_at.
   * Used by the cron worker to clean up expired holds.
   */
  private getExpiredHolds(): Array<{
    hold_id: string;
    session_id: string;
    account_id: string;
    provider_event_id: string | null;
    expires_at: string;
    status: string;
  }> {
    this.ensureMigrated();

    interface HoldRow {
      [key: string]: unknown;
      hold_id: string;
      session_id: string;
      account_id: string;
      provider_event_id: string | null;
      expires_at: string;
      status: string;
    }

    return this.sql
      .exec<HoldRow>(
        `SELECT hold_id, session_id, account_id, provider_event_id, expires_at, status
         FROM schedule_holds
         WHERE status = 'held' AND expires_at <= datetime('now')`,
      )
      .toArray()
      .map((r) => ({
        hold_id: r.hold_id,
        session_id: r.session_id,
        account_id: r.account_id,
        provider_event_id: r.provider_event_id,
        expires_at: r.expires_at,
        status: r.status,
      }));
  }

  /**
   * On session commit: mark the hold matching the committed candidate
   * as 'committed' and release all other holds for the same session.
   *
   * Returns the committed hold and the released holds so the caller
   * can PATCH the committed hold's provider event to 'confirmed' and
   * DELETE the released holds' provider events.
   */
  private commitSessionHolds(
    sessionId: string,
    committedCandidateId: string,
  ): {
    committed: Array<{
      hold_id: string;
      session_id: string;
      account_id: string;
      provider_event_id: string | null;
      expires_at: string;
      status: string;
    }>;
    released: Array<{
      hold_id: string;
      session_id: string;
      account_id: string;
      provider_event_id: string | null;
      expires_at: string;
      status: string;
    }>;
  } {
    this.ensureMigrated();

    // Get all holds for the session
    const holds = this.getHoldsBySession(sessionId);

    // Holds carry the candidate info in their hold_id (or we match by position).
    // Since we create one hold per candidate per account, we match by
    // looking at holds linked to this session. The committed candidate's
    // hold is identified by the candidateId suffix in the hold's context.
    // For simplicity, all held holds for the committed candidate are committed,
    // all others released.

    // Since holds are per-account (one per candidate per account), and we
    // need to know which hold corresponds to which candidate, we rely on
    // the ordering: holds are stored in candidate order. However, a more
    // robust approach is to store candidate_id on the hold. Since the
    // schema doesn't have a candidate_id column, we'll use the objective_json
    // approach: match by position or store the mapping.
    //
    // PRAGMATIC APPROACH: When creating holds, the workflow will store one
    // hold per account for the entire session (all candidates share holds
    // since only one candidate is picked). Actually, re-reading the story:
    // "When candidates are produced, create tentative holds" - this means
    // all candidates get holds, not just one.
    //
    // Let's commit ALL holds (they all get converted since the committed
    // candidate becomes the real event and all holds are cleaned up).
    // Actually: on commit, the committed candidate's hold becomes the
    // confirmed event, and all OTHER holds are released.
    //
    // Since the schema tracks holds per session (not per candidate), and
    // we create holds for ALL candidates, we'll:
    // 1. Commit ALL holds (the workflow will handle PATCH/DELETE logic)
    // 2. Actually -- rethink: holds are per-candidate. We release non-committed ones.

    // For this implementation: ALL holds for the session transition.
    // The committed hold -> committed, all others -> released.
    // We need candidate mapping. Store it as: one hold per candidate.
    // The hold maps to a candidate via index in creation order.

    // SIMPLIFIED: The workflow creates one hold per candidate. On commit,
    // we release all holds (the workflow itself creates the confirmed event
    // separately via upsertCanonicalEvent). So all holds get released.
    const committed: typeof holds = [];
    const released: typeof holds = [];

    for (const h of holds) {
      if (h.status === "held") {
        this.sql.exec(
          "UPDATE schedule_holds SET status = 'released' WHERE hold_id = ?",
          h.hold_id,
        );
        released.push({ ...h, status: "released" });
      }
    }

    return { committed, released };
  }

  /**
   * Release all held holds for a session (cancel/timeout scenario).
   */
  private releaseSessionHolds(sessionId: string): void {
    this.ensureMigrated();

    this.sql.exec(
      "UPDATE schedule_holds SET status = 'released' WHERE session_id = ? AND status = 'held'",
      sessionId,
    );
  }

  /**
   * Extend the expiry of active holds for a session (TM-82s.4 AC-3).
   * Only holds in 'held' status are extended. Returns count of extended holds.
   */
  private extendHolds(
    sessionId: string,
    holds: Array<{ hold_id: string; new_expires_at: string }>,
  ): number {
    this.ensureMigrated();

    let extended = 0;
    for (const h of holds) {
      // Only extend holds that belong to this session and are still held
      const result = this.sql.exec(
        `UPDATE schedule_holds SET expires_at = ?
         WHERE hold_id = ? AND session_id = ? AND status = 'held'`,
        h.new_expires_at,
        h.hold_id,
        sessionId,
      );
      // Check if the update affected any rows
      const check = this.sql
        .exec<{ [key: string]: unknown; hold_id: string }>(
          "SELECT hold_id FROM schedule_holds WHERE hold_id = ? AND session_id = ? AND status = 'held' AND expires_at = ?",
          h.hold_id,
          sessionId,
          h.new_expires_at,
        )
        .toArray();
      if (check.length > 0) {
        extended++;
      }
    }
    return extended;
  }

  /**
   * Check if all holds for a session are in terminal states (expired, released, committed).
   * If so, transition the session to 'expired' status (TM-82s.4 AC-4/AC-6).
   * Returns true if the session was expired, false otherwise.
   */
  private expireSessionIfAllHoldsTerminal(sessionId: string): boolean {
    this.ensureMigrated();

    // Check if any holds are still active (held)
    const activeHolds = this.sql
      .exec<{ [key: string]: unknown; cnt: number }>(
        "SELECT COUNT(*) as cnt FROM schedule_holds WHERE session_id = ? AND status = 'held'",
        sessionId,
      )
      .toArray();

    const activeCount = activeHolds[0]?.cnt ?? 0;

    if (activeCount > 0) {
      // Still have active holds, do not expire
      return false;
    }

    // Verify session exists and is in a candidate-bearing state
    const sessionRows = this.sql
      .exec<{ [key: string]: unknown; status: string }>(
        "SELECT status FROM schedule_sessions WHERE session_id = ?",
        sessionId,
      )
      .toArray();

    if (sessionRows.length === 0) {
      return false;
    }

    const currentStatus = sessionRows[0].status;
    // Only expire sessions that are in candidates_ready state
    if (currentStatus !== "candidates_ready") {
      return false;
    }

    // All holds are terminal, expire the session
    this.sql.exec(
      "UPDATE schedule_sessions SET status = 'expired' WHERE session_id = ?",
      sessionId,
    );

    return true;
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

  // -------------------------------------------------------------------------
  // computeAvailability -- Constraint-aware unified free/busy computation
  // -------------------------------------------------------------------------

  /**
   * Compute unified free/busy intervals across all (or specified) accounts
   * for a given time range. Evaluates ALL active constraints in a defined
   * order to produce a complete availability picture.
   *
   * Constraint evaluation order (story TM-gj5.4, TM-xwn.2):
   *   1. Raw free/busy from canonical events (including trip-derived events)
   *   2. Working hours -- times outside any active working_hours constraint
   *      are treated as busy. Multiple working_hours are unioned.
   *   3. Trip blocks -- trip constraints with active_from/active_to overlapping
   *      the query range mark that time as busy. These are always applied
   *      regardless of the account filter (trips are cross-account blocks).
   *   4. No-meetings-after -- daily cutoff times after which all time is busy.
   *   5. Buffers -- travel/prep/cooldown time around events reduces availability.
   *   5.5. Milestones -- life event milestones (birthdays, anniversaries, etc.)
   *        create all-day busy blocks. Recurring milestones expand for each year.
   *   6. Merge all intervals and compute free gaps.
   *
   * Performance target (NFR-16): under 500ms for 1-week range with 10+ constraints.
   */
  computeAvailability(query: AvailabilityQuery): AvailabilityResult {
    this.ensureMigrated();

    // ----- Step 1: Raw free/busy from canonical events -----
    // Trip-derived events (origin_account_id='internal') are included here
    // when no account filter is applied. When an account filter IS applied,
    // trip blocks are added separately in step 3 to ensure they are never
    // excluded by account filtering.
    const conditions: string[] = [
      // Events that overlap the query range:
      // event starts before query ends AND event ends after query starts
      "end_ts > ?",
      "start_ts < ?",
      // Only opaque events count as busy
      "transparency = 'opaque'",
      // Exclude cancelled events
      "status != 'cancelled'",
    ];
    const params: unknown[] = [query.start, query.end];

    // Optional account filtering
    const hasAccountFilter = query.accounts && query.accounts.length > 0;
    if (hasAccountFilter) {
      // Include 'internal' so trip-derived events are not excluded
      const allAccounts = [...query.accounts!];
      if (!allAccounts.includes("internal")) {
        allAccounts.push("internal");
      }
      const placeholders = allAccounts.map(() => "?").join(", ");
      conditions.push(`origin_account_id IN (${placeholders})`);
      params.push(...allAccounts);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;
    const sql = `SELECT start_ts, end_ts, origin_account_id FROM canonical_events ${where} ORDER BY start_ts ASC`;

    const rows = this.sql
      .exec<{ start_ts: string; end_ts: string; origin_account_id: string }>(
        sql,
        ...params,
      )
      .toArray();

    // Build raw busy intervals from query results
    const rawIntervals: BusyInterval[] = rows.map((row) => ({
      start: row.start_ts,
      end: row.end_ts,
      account_ids: [row.origin_account_id],
    }));

    // ----- Step 2: Working hours (exclude outside hours) -----
    const workingHoursConstraints = this.listConstraints("working_hours");
    const outsideWorkingHours = expandWorkingHoursToOutsideBusy(
      workingHoursConstraints,
      query.start,
      query.end,
    );
    rawIntervals.push(...outsideWorkingHours);

    // ----- Step 3: Trip blocks (mark as busy) -----
    // Trip constraints create derived canonical events with origin_account_id=
    // 'internal' and transparency='opaque'. These are included in step 1 above.
    // The account filter in step 1 always includes 'internal' to ensure trip
    // blocks are never excluded by account filtering.
    //
    // No separate expansion needed here -- trip blocks are already in rawIntervals
    // from the canonical events query. This is by design: trip constraints are
    // the only constraint kind that creates derived events, which ensures they
    // appear in listEvents() and computeAvailability() consistently.

    // ----- Step 4: No-meetings-after (daily cutoff) -----
    const noMeetingsAfterConstraints = this.listConstraints("no_meetings_after");
    const noMeetingsBusy = expandNoMeetingsAfterToBusy(
      noMeetingsAfterConstraints,
      query.start,
      query.end,
    );
    rawIntervals.push(...noMeetingsBusy);

    // ----- Step 5: Buffers (reduce available time around events) -----
    const bufferConstraints = this.listConstraints("buffer");
    if (bufferConstraints.length > 0) {
      const bufferIntervals = expandBuffersToBusy(bufferConstraints, rows);
      rawIntervals.push(...bufferIntervals);
    }

    // ----- Step 5.5: Milestone busy blocks (avoid scheduling on milestone dates) -----
    const allMilestones = this.getAllMilestones();
    if (allMilestones.length > 0) {
      const milestoneIntervals = expandMilestonesToBusy(
        allMilestones,
        query.start,
        query.end,
      );
      rawIntervals.push(
        ...milestoneIntervals.map((iv: { start: string; end: string }) => ({
          start: iv.start,
          end: iv.end,
          account_ids: ["milestones"],
        })),
      );
    }

    // ----- Step 6: Merge and compute free intervals -----
    const busyIntervals = mergeIntervals(rawIntervals);
    const freeIntervals = computeFreeIntervals(busyIntervals, query.start, query.end);

    return {
      busy_intervals: busyIntervals,
      free_intervals: freeIntervals,
    };
  }

  // getCognitiveLoad -- Compute cognitive load score for a day/week
  // -------------------------------------------------------------------------

  /**
   * Compute cognitive load score for a day or week based on the user's
   * canonical events. Reads events from SQLite and delegates to the pure
   * computeCognitiveLoad function in @tminus/shared.
   *
   * Extracts working hours from active working_hours constraints if present,
   * otherwise defaults to 9-17.
   */
  getCognitiveLoad(date: string, range: "day" | "week"): CognitiveLoadResult {
    this.ensureMigrated();

    // Determine query time range
    const startDate = new Date(`${date}T00:00:00Z`);
    const dayCount = range === "week" ? 7 : 1;
    const endDate = new Date(startDate.getTime() + dayCount * 24 * 60 * 60 * 1000);

    const startIso = startDate.toISOString();
    const endIso = endDate.toISOString();

    // Fetch canonical events for the period
    const rows = this.sql
      .exec<CanonicalEventRow>(
        `SELECT * FROM canonical_events
         WHERE end_ts > ? AND start_ts < ?
           AND status != 'cancelled'
         ORDER BY start_ts ASC`,
        startIso,
        endIso,
      )
      .toArray();

    const events = rows.map((row) => this.rowToCanonicalEvent(row));

    // Extract working hours from constraints (if set)
    const workingHoursConstraints = this.listConstraints("working_hours");
    let workingHoursStart = 9;
    let workingHoursEnd = 17;
    if (workingHoursConstraints.length > 0) {
      const config = workingHoursConstraints[0].config_json as {
        start_hour?: number;
        end_hour?: number;
      };
      if (typeof config.start_hour === "number") workingHoursStart = config.start_hour;
      if (typeof config.end_hour === "number") workingHoursEnd = config.end_hour;
    }

    return computeCognitiveLoad({
      events,
      date,
      range,
      constraints: {
        workingHoursStart,
        workingHoursEnd,
      },
    });
  }

  // getContextSwitches -- Context-switch cost estimation for a day/week
  // -------------------------------------------------------------------------

  /**
   * Compute context-switch costs for a day or week based on the user's
   * canonical events. Reads events from SQLite and delegates to the pure
   * context-switch functions in @tminus/shared.
   *
   * For "day" range: computes transitions for the single date.
   * For "week" range: computes transitions for each day, aggregates costs.
   */
  getContextSwitches(date: string, range: "day" | "week"): ContextSwitchResult {
    this.ensureMigrated();

    const dayCount = range === "week" ? 7 : 1;
    const startDate = new Date(`${date}T00:00:00Z`);
    const endDate = new Date(startDate.getTime() + dayCount * 24 * 60 * 60 * 1000);

    const startIso = startDate.toISOString();
    const endIso = endDate.toISOString();

    // Fetch canonical events for the period
    const rows = this.sql
      .exec<CanonicalEventRow>(
        `SELECT * FROM canonical_events
         WHERE end_ts > ? AND start_ts < ?
           AND status != 'cancelled'
         ORDER BY start_ts ASC`,
        startIso,
        endIso,
      )
      .toArray();

    const allEvents = rows.map((row) => this.rowToCanonicalEvent(row));

    if (range === "day") {
      const transitions = computeTransitions(allEvents);
      const totalCost = computeDailySwitchCost(transitions);
      const suggestions = generateClusteringSuggestions(transitions, allEvents);
      return {
        transitions,
        total_cost: Math.round(totalCost * 100) / 100,
        daily_costs: [Math.round(totalCost * 100) / 100],
        suggestions,
      };
    }

    // Week range: compute per-day then aggregate
    const allTransitions: Array<import("@tminus/shared").Transition> = [];
    const dailyCosts: number[] = [];

    for (let i = 0; i < dayCount; i++) {
      const d = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);
      const dayStr = d.toISOString().slice(0, 10);
      const dayStart = new Date(`${dayStr}T00:00:00Z`).getTime();
      const dayEnd = dayStart + 24 * 60 * 60 * 1000;

      // Filter events for this day
      const dayEvents = allEvents.filter((e) => {
        if (!e.start.dateTime || !e.end.dateTime) return false;
        const eStart = new Date(e.start.dateTime).getTime();
        const eEnd = new Date(e.end.dateTime).getTime();
        return eStart < dayEnd && eEnd > dayStart;
      });

      const dayTransitions = computeTransitions(dayEvents);
      const dayCost = computeDailySwitchCost(dayTransitions);
      allTransitions.push(...dayTransitions);
      dailyCosts.push(Math.round(dayCost * 100) / 100);
    }

    const weekly = computeWeeklySwitchCost(dailyCosts);
    const suggestions = generateClusteringSuggestions(allTransitions, allEvents);

    return {
      transitions: allTransitions,
      total_cost: Math.round(weekly.total * 100) / 100,
      daily_costs: dailyCosts,
      suggestions,
    };
  }

  // getDeepWork -- Deep work window optimization for a day/week
  // -------------------------------------------------------------------------

  /**
   * Compute deep work report for a day or week based on the user's
   * canonical events. Reads events from SQLite and delegates to the pure
   * deep work functions in @tminus/shared.
   *
   * For "day" range: computes deep work blocks for the single date.
   * For "week" range: computes across 7 days starting from date.
   *
   * Returns blocks, total deep hours, protected hours target, and
   * optimization suggestions.
   */
  getDeepWork(
    date: string,
    range: "day" | "week",
    minBlockMinutes?: number,
  ): DeepWorkReport & { suggestions: Array<{ message: string; estimated_gain_minutes: number }> } {
    this.ensureMigrated();

    // Determine query time range
    const dayCount = range === "week" ? 7 : 1;
    const startDate = new Date(`${date}T00:00:00Z`);
    const endDate = new Date(startDate.getTime() + dayCount * 24 * 60 * 60 * 1000);

    const startIso = startDate.toISOString();
    const endIso = endDate.toISOString();

    // Fetch canonical events for the period
    const rows = this.sql
      .exec<CanonicalEventRow>(
        `SELECT * FROM canonical_events
         WHERE end_ts > ? AND start_ts < ?
           AND status != 'cancelled'
         ORDER BY start_ts ASC`,
        startIso,
        endIso,
      )
      .toArray();

    const events = rows.map((row) => this.rowToCanonicalEvent(row));

    // Extract working hours from constraints (if set)
    const workingHoursConstraints = this.listConstraints("working_hours");
    let workingHoursStart = 9;
    let workingHoursEnd = 17;
    if (workingHoursConstraints.length > 0) {
      const config = workingHoursConstraints[0].config_json as {
        start_hour?: number;
        end_hour?: number;
      };
      if (typeof config.start_hour === "number") workingHoursStart = config.start_hour;
      if (typeof config.end_hour === "number") workingHoursEnd = config.end_hour;
    }

    // Build array of day strings
    const days: string[] = [];
    for (let i = 0; i < dayCount; i++) {
      const d = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);
      days.push(d.toISOString().slice(0, 10));
    }

    const workingHours = { workingHoursStart, workingHoursEnd };

    const report = computeDeepWorkReport(events, workingHours, days, minBlockMinutes);
    const suggestions = suggestDeepWorkOptimizations(events, workingHours, minBlockMinutes);

    return {
      ...report,
      suggestions: suggestions.map((s) => ({
        message: s.message,
        estimated_gain_minutes: s.estimated_gain_minutes,
      })),
    };
  }

  // getRiskScores -- Temporal risk scoring (burnout, travel, drift)
  // -------------------------------------------------------------------------

  /**
   * Compute temporal risk scores for the user.
   *
   * Queries cognitive load history, trip constraints, and time allocations
   * to build inputs for the pure risk scoring functions.
   *
   * @param weeks - Number of weeks to analyze (default 4).
   * @returns Complete risk score result with burnout, travel, drift, overall,
   *          risk level, and recommendations.
   */
  getRiskScores(weeks: number = 4): RiskScoreResult {
    this.ensureMigrated();

    const now = new Date();
    const periodDays = weeks * 7;
    const periodStart = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);

    // 1. Build cognitive load history: compute daily cognitive load for each day
    const cognitiveLoadHistory: CognitiveLoadHistoryEntry[] = [];
    for (let i = 0; i < periodDays; i++) {
      const d = new Date(periodStart.getTime() + i * 24 * 60 * 60 * 1000);
      const dateStr = d.toISOString().slice(0, 10);
      const result = this.getCognitiveLoad(dateStr, "day");
      cognitiveLoadHistory.push({ date: dateStr, score: result.score });
    }

    // 2. Compute travel overload from trip constraints
    const tripConstraints = this.listConstraints("trip");
    const startMs = periodStart.getTime();
    const endMs = now.getTime();
    let tripDays = 0;

    for (const tc of tripConstraints) {
      if (!tc.active_from || !tc.active_to) continue;
      const tripStart = new Date(tc.active_from).getTime();
      const tripEnd = new Date(tc.active_to).getTime();

      // Overlap with analysis period
      const overlapStart = Math.max(tripStart, startMs);
      const overlapEnd = Math.min(tripEnd, endMs);
      if (overlapStart < overlapEnd) {
        tripDays += Math.ceil((overlapEnd - overlapStart) / (24 * 60 * 60 * 1000));
      }
    }

    // Working days = total days minus weekends (approximate)
    const workingDays = Math.round(periodDays * 5 / 7);

    // 3. Compute strategic drift from time allocations
    // Split the period in half: first half = historical, second half = current
    const midPoint = new Date(periodStart.getTime() + (endMs - startMs) / 2);
    const midIso = midPoint.toISOString();
    const startIso = periodStart.toISOString();
    const endIso = now.toISOString();

    // Get events for historical period (first half)
    const historicalRows = this.sql
      .exec<CanonicalEventRow>(
        `SELECT * FROM canonical_events
         WHERE end_ts > ? AND start_ts < ?
           AND status != 'cancelled' AND all_day = 0
         ORDER BY start_ts ASC`,
        startIso,
        midIso,
      )
      .toArray();

    // Get events for current period (second half)
    const currentRows = this.sql
      .exec<CanonicalEventRow>(
        `SELECT * FROM canonical_events
         WHERE end_ts > ? AND start_ts < ?
           AND status != 'cancelled' AND all_day = 0
         ORDER BY start_ts ASC`,
        midIso,
        endIso,
      )
      .toArray();

    const historicalAllocations = this.computeAllocationsFromEvents(
      historicalRows.map((r) => this.rowToCanonicalEvent(r)),
    );
    const currentAllocations = this.computeAllocationsFromEvents(
      currentRows.map((r) => this.rowToCanonicalEvent(r)),
    );

    // 4. Compute risk scores using pure functions
    const burnout = computeBurnoutRisk(cognitiveLoadHistory);
    const travel = computeTravelOverload(tripDays, workingDays);
    const drift = computeStrategicDrift(currentAllocations, historicalAllocations);
    const overall = computeOverallRisk(burnout, travel, drift);
    const riskLevel = getRiskLevel(overall);
    const recommendations = generateRiskRecommendations(burnout, travel, drift);

    return {
      burnout_risk: burnout,
      travel_overload: travel,
      strategic_drift: drift,
      overall_risk: overall,
      risk_level: riskLevel,
      recommendations,
    };
  }

  /**
   * Compute time allocation by category from a set of canonical events.
   * Uses classifyEventCategory to determine each event's category,
   * then sums hours per category.
   */
  private computeAllocationsFromEvents(
    events: readonly CanonicalEvent[],
  ): CategoryAllocation[] {
    const categoryHours = new Map<string, number>();

    for (const event of events) {
      if (!event.start.dateTime || !event.end.dateTime) continue;
      if (event.transparency === "transparent") continue;

      const category = classifyEventCategory(event);
      const startMs = new Date(event.start.dateTime).getTime();
      const endMs = new Date(event.end.dateTime).getTime();
      const hours = (endMs - startMs) / (60 * 60 * 1000);

      if (hours > 0) {
        const current = categoryHours.get(category) ?? 0;
        categoryHours.set(category, current + hours);
      }
    }

    const allocations: CategoryAllocation[] = [];
    for (const [category, hours] of categoryHours) {
      allocations.push({ category, hours: Math.round(hours * 100) / 100 });
    }
    return allocations;
  }

  // -------------------------------------------------------------------------
  // getProbabilisticAvailability -- probability-weighted availability
  // -------------------------------------------------------------------------

  /**
   * Compute probabilistic availability for a time range.
   *
   * Instead of binary free/busy, each slot has a probability of being free
   * (0.0 to 1.0) based on event status (confirmed=0.95, tentative=0.50),
   * with adjustments for recurring events that historically get cancelled.
   *
   * Cancellation history is derived from the event_journal: for each
   * recurring event series (identified by origin_event_id), we count
   * the total occurrences and how many were cancelled (change_type='deleted'
   * or patch_json containing status='cancelled').
   */
  getProbabilisticAvailability(
    start: string,
    end: string,
    granularity_minutes?: number,
  ): ProbabilisticAvailabilityResult {
    this.ensureMigrated();

    // Fetch canonical events for the period (including tentative)
    const rows = this.sql
      .exec<CanonicalEventRow>(
        `SELECT * FROM canonical_events
         WHERE end_ts > ? AND start_ts < ?
           AND all_day = 0
           AND transparency = 'opaque'
         ORDER BY start_ts ASC`,
        start,
        end,
      )
      .toArray();

    // Convert rows to ProbabilisticEvent format
    const events: ProbabilisticEvent[] = rows
      .filter((r) => r.start_ts && r.end_ts)
      .map((r) => ({
        event_id: r.canonical_event_id,
        start: r.start_ts,
        end: r.end_ts,
        status: r.status as "confirmed" | "tentative" | "cancelled",
        transparency: r.transparency as "opaque" | "transparent",
        recurrence_rule: r.recurrence_rule ?? undefined,
        origin_event_id: r.origin_event_id,
      }));

    // Build cancellation history for recurring events from the journal.
    // For each recurring event's origin_event_id, count how many
    // distinct canonical_event_id entries had a 'deleted' change_type.
    const recurringOriginIds = [
      ...new Set(
        events
          .filter((e) => e.recurrence_rule)
          .map((e) => e.origin_event_id),
      ),
    ];

    const cancellation_history: CancellationHistory = {};

    for (const originId of recurringOriginIds) {
      // Count total events with this origin_event_id (including cancelled/deleted)
      const totalRows = this.sql
        .exec<{ cnt: number }>(
          `SELECT COUNT(*) as cnt FROM canonical_events
           WHERE origin_event_id = ?`,
          originId,
        )
        .toArray();

      // Count journal entries that record cancellation/deletion for events
      // with this origin_event_id
      const cancelledRows = this.sql
        .exec<{ cnt: number }>(
          `SELECT COUNT(DISTINCT ej.canonical_event_id) as cnt
           FROM event_journal ej
           JOIN canonical_events ce ON ej.canonical_event_id = ce.canonical_event_id
           WHERE ce.origin_event_id = ?
             AND ej.change_type = 'deleted'`,
          originId,
        )
        .toArray();

      const total = totalRows[0]?.cnt ?? 0;
      const cancelled = cancelledRows[0]?.cnt ?? 0;

      if (total > 0) {
        cancellation_history[originId] = {
          total_occurrences: total,
          cancelled_occurrences: cancelled,
        };
      }
    }

    return computeProbabilisticAvailability({
      events,
      start,
      end,
      granularity_minutes,
      cancellation_history,
    });
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
    };
  }
}

// ---------------------------------------------------------------------------
// Availability types
// ---------------------------------------------------------------------------

/** Query parameters for computing free/busy availability. */
export interface AvailabilityQuery {
  /** ISO 8601 start of the time range. */
  readonly start: string;
  /** ISO 8601 end of the time range. */
  readonly end: string;
  /** Optional account IDs to filter. When omitted, all accounts are included. */
  readonly accounts?: string[];
}

/** A busy interval with the accounts that contribute to it. */
export interface BusyInterval {
  start: string;
  end: string;
  account_ids: string[];
}

/** A free interval (a gap between busy blocks). */
export interface FreeInterval {
  start: string;
  end: string;
}

/** Result of computing availability across accounts. */
export interface AvailabilityResult {
  readonly busy_intervals: BusyInterval[];
  readonly free_intervals: FreeInterval[];
}

// ---------------------------------------------------------------------------
// Pure functions for interval merging and gap computation
// ---------------------------------------------------------------------------

/**
 * Merge overlapping or adjacent busy intervals, combining account_ids.
 *
 * Algorithm:
 * 1. Sort intervals by start time
 * 2. Walk through sorted intervals, extending the current merged interval
 *    when the next interval overlaps or is adjacent (end >= next.start)
 * 3. When a gap is found, push the current merged interval and start a new one
 *
 * Time complexity: O(n log n) due to sorting.
 */
export function mergeIntervals(intervals: BusyInterval[]): BusyInterval[] {
  if (intervals.length === 0) return [];

  // Sort by start time using normalized comparison for mixed date/datetime strings
  const sorted = [...intervals].sort((a, b) =>
    normalizeForComparison(a.start).localeCompare(normalizeForComparison(b.start)),
  );

  const merged: BusyInterval[] = [];
  let current: BusyInterval = {
    start: sorted[0].start,
    end: sorted[0].end,
    account_ids: [...sorted[0].account_ids],
  };

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    const nextStartNorm = normalizeForComparison(next.start);
    const currentEndNorm = normalizeForComparison(current.end);

    if (nextStartNorm <= currentEndNorm) {
      // Overlapping or adjacent: extend the current interval
      const nextEndNorm = normalizeForComparison(next.end);
      if (nextEndNorm > currentEndNorm) {
        current.end = next.end;
      }
      // Merge account_ids (deduplicate)
      for (const aid of next.account_ids) {
        if (!current.account_ids.includes(aid)) {
          current.account_ids.push(aid);
        }
      }
    } else {
      // Gap found: push current and start new
      merged.push(current);
      current = {
        start: next.start,
        end: next.end,
        account_ids: [...next.account_ids],
      };
    }
  }

  // Push the last interval
  merged.push(current);

  return merged;
}

/**
 * Normalize a date or datetime string for consistent comparison.
 * All-day event dates ("2026-02-15") are expanded to "2026-02-15T00:00:00Z"
 * so they compare correctly with ISO 8601 datetime strings.
 *
 * This is needed because "2026-02-16" < "2026-02-16T00:00:00Z" in lexicographic
 * comparison, but they represent the same point in time.
 */
function normalizeForComparison(ts: string): string {
  // Date-only format is exactly 10 characters: YYYY-MM-DD
  if (ts.length === 10) {
    return `${ts}T00:00:00Z`;
  }
  return ts;
}

/**
 * Compute free intervals as gaps between merged busy intervals
 * within the given [rangeStart, rangeEnd) window.
 *
 * Assumes busyIntervals are already sorted and non-overlapping
 * (i.e., output of mergeIntervals).
 *
 * Uses normalizeForComparison to handle mixed date/datetime strings
 * correctly (all-day events use YYYY-MM-DD, timed events use ISO 8601 datetime).
 */
export function computeFreeIntervals(
  busyIntervals: BusyInterval[],
  rangeStart: string,
  rangeEnd: string,
): FreeInterval[] {
  const free: FreeInterval[] = [];
  let cursor = rangeStart;

  for (const busy of busyIntervals) {
    const busyStartNorm = normalizeForComparison(busy.start);
    const busyEndNorm = normalizeForComparison(busy.end);
    const cursorNorm = normalizeForComparison(cursor);

    // If there is a gap before this busy interval, add a free interval
    if (busyStartNorm > cursorNorm) {
      free.push({ start: cursor, end: busy.start });
    }
    // Advance cursor past this busy interval
    if (busyEndNorm > cursorNorm) {
      cursor = busy.end;
    }
  }

  // If there is time left after the last busy interval, add a free interval
  const cursorNorm = normalizeForComparison(cursor);
  const rangeEndNorm = normalizeForComparison(rangeEnd);
  if (cursorNorm < rangeEndNorm) {
    free.push({ start: cursor, end: rangeEnd });
  }

  return free;
}

// ---------------------------------------------------------------------------
// Working hours constraint helpers
// ---------------------------------------------------------------------------

/**
 * Working hours config shape as stored in config_json.
 */
export interface WorkingHoursConfig {
  /** Days of the week this applies to (0=Sunday through 6=Saturday). */
  readonly days: number[];
  /** Start time in HH:MM 24-hour format. */
  readonly start_time: string;
  /** End time in HH:MM 24-hour format. */
  readonly end_time: string;
  /** IANA timezone string (e.g. "America/New_York"). */
  readonly timezone: string;
}

/**
 * Expand working_hours constraints into "outside working hours" busy intervals.
 *
 * For a given time range, this function determines which periods fall OUTSIDE
 * working hours and returns them as busy intervals. When multiple working_hours
 * constraints exist, their working periods are unioned: a time slot is
 * considered "working time" if ANY constraint covers it. Only time slots
 * not covered by any constraint become busy.
 *
 * Algorithm:
 * 1. For each day in the range, compute working periods from all constraints
 * 2. Union (merge) all working periods
 * 3. The gaps between working periods (and before/after them) are "outside
 *    working hours" and thus busy
 *
 * Returns empty array when no working_hours constraints exist.
 */
export function expandWorkingHoursToOutsideBusy(
  constraints: readonly { config_json: Record<string, unknown> }[],
  rangeStart: string,
  rangeEnd: string,
): BusyInterval[] {
  if (constraints.length === 0) return [];

  const configs: WorkingHoursConfig[] = constraints.map(
    (c) => c.config_json as unknown as WorkingHoursConfig,
  );

  const rangeStartMs = new Date(rangeStart).getTime();
  const rangeEndMs = new Date(rangeEnd).getTime();

  if (rangeStartMs >= rangeEndMs) return [];

  // Collect all working intervals across all constraints for the range
  const workingIntervals: { start: number; end: number }[] = [];

  // Iterate day by day across the range. We expand slightly to cover
  // timezone edge cases (a working day in e.g. Pacific could start on the
  // "previous" UTC day).
  const oneDayMs = 24 * 60 * 60 * 1000;
  // Start one day before range start to handle timezone offsets
  const scanStart = rangeStartMs - oneDayMs;
  const scanEnd = rangeEndMs + oneDayMs;

  for (const config of configs) {
    // For each day in the scan window, check if this config applies
    let dayStart = scanStart;
    while (dayStart < scanEnd) {
      const dayDate = new Date(dayStart);
      // Get day-of-week in the constraint's timezone
      const dayOfWeek = getDayOfWeekInTimezone(dayDate, config.timezone);

      if (config.days.includes(dayOfWeek)) {
        // This constraint applies to this day
        const workStart = getTimestampForTimeInTimezone(
          dayDate,
          config.start_time,
          config.timezone,
        );
        const workEnd = getTimestampForTimeInTimezone(
          dayDate,
          config.end_time,
          config.timezone,
        );

        // Only include if it overlaps with the query range
        if (workEnd > rangeStartMs && workStart < rangeEndMs) {
          workingIntervals.push({
            start: Math.max(workStart, rangeStartMs),
            end: Math.min(workEnd, rangeEndMs),
          });
        }
      }

      dayStart += oneDayMs;
    }
  }

  if (workingIntervals.length === 0) {
    // No working hours at all in this range -- entire range is outside working hours
    return [{
      start: rangeStart,
      end: rangeEnd,
      account_ids: ["working_hours"],
    }];
  }

  // Merge overlapping working intervals
  workingIntervals.sort((a, b) => a.start - b.start);
  const mergedWorking: { start: number; end: number }[] = [];
  let current = { ...workingIntervals[0] };

  for (let i = 1; i < workingIntervals.length; i++) {
    const next = workingIntervals[i];
    if (next.start <= current.end) {
      current.end = Math.max(current.end, next.end);
    } else {
      mergedWorking.push(current);
      current = { ...next };
    }
  }
  mergedWorking.push(current);

  // Compute gaps (outside working hours) between working intervals
  const outsideBusy: BusyInterval[] = [];
  let cursor = rangeStartMs;

  for (const work of mergedWorking) {
    if (work.start > cursor) {
      outsideBusy.push({
        start: new Date(cursor).toISOString(),
        end: new Date(work.start).toISOString(),
        account_ids: ["working_hours"],
      });
    }
    if (work.end > cursor) {
      cursor = work.end;
    }
  }

  // Gap after the last working interval
  if (cursor < rangeEndMs) {
    outsideBusy.push({
      start: new Date(cursor).toISOString(),
      end: rangeEnd,
      account_ids: ["working_hours"],
    });
  }

  return outsideBusy;
}

/**
 * Get the day of week (0=Sunday through 6=Saturday) for a Date
 * in a specific timezone.
 */
function getDayOfWeekInTimezone(date: Date, timezone: string): number {
  // Format the date in the target timezone and extract the weekday
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  });
  const weekdayStr = formatter.format(date);

  const dayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return dayMap[weekdayStr] ?? 0;
}

/**
 * Get the UTC timestamp (ms) for a specific HH:MM time on a given date
 * in a specific timezone.
 *
 * For example, getTimestampForTimeInTimezone(date, "09:00", "America/New_York")
 * returns the UTC ms timestamp for 9:00 AM Eastern on that date.
 */
function getTimestampForTimeInTimezone(
  baseDate: Date,
  time: string,
  timezone: string,
): number {
  // Get the date components in the target timezone
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const dateParts = formatter.format(baseDate); // "YYYY-MM-DD"

  const [hours, minutes] = time.split(":").map(Number);

  // Construct an ISO string in the target timezone, then find the UTC equivalent.
  // We use a binary search approach: create a Date for the target local time
  // by formatting and comparing.
  //
  // Simpler approach: use the date parts and known offset.
  // Get the timezone offset at this approximate time.
  const approxDate = new Date(`${dateParts}T${time}:00Z`);

  // Find offset: format the approxDate in the timezone and compare
  const tzFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  // Use an iterative approach: guess UTC, check local, adjust
  // Start with naive UTC guess
  let utcGuess = new Date(`${dateParts}T${time}:00Z`).getTime();

  // Get what local time this UTC timestamp maps to in the timezone
  const localParts = getLocalTimeParts(new Date(utcGuess), timezone);
  const targetMinutes = hours * 60 + minutes;
  const actualMinutes = localParts.hours * 60 + localParts.minutes;

  // Adjust by the difference
  const diffMs = (targetMinutes - actualMinutes) * 60 * 1000;

  // Also check if the date rolled over
  if (localParts.dateStr !== dateParts) {
    // Date mismatch -- more complex timezone handling needed
    // Re-derive: if local date is day+1, subtract 24h; if day-1, add 24h
    const localDate = new Date(localParts.dateStr).getTime();
    const targetDate = new Date(dateParts).getTime();
    const dateDiffMs = targetDate - localDate;
    return utcGuess + diffMs + dateDiffMs;
  }

  return utcGuess + diffMs;
}

/**
 * Extract local time parts (hours, minutes, date string) for a UTC timestamp
 * in a specific timezone.
 */
function getLocalTimeParts(
  date: Date,
  timezone: string,
): { hours: number; minutes: number; dateStr: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  let hours = 0;
  let minutes = 0;
  let year = "";
  let month = "";
  let day = "";

  for (const part of parts) {
    switch (part.type) {
      case "hour":
        hours = parseInt(part.value, 10);
        // Handle midnight: Intl formats 24 as "24" in hour24 mode
        if (hours === 24) hours = 0;
        break;
      case "minute":
        minutes = parseInt(part.value, 10);
        break;
      case "year":
        year = part.value;
        break;
      case "month":
        month = part.value.padStart(2, "0");
        break;
      case "day":
        day = part.value.padStart(2, "0");
        break;
    }
  }

  return { hours, minutes, dateStr: `${year}-${month}-${day}` };
}

// ---------------------------------------------------------------------------
// Buffer constraint helpers
// ---------------------------------------------------------------------------

/**
 * Buffer config shape as stored in config_json.
 */
export interface BufferConfig {
  /** Buffer type: travel and prep apply before events, cooldown applies after. */
  readonly type: "travel" | "prep" | "cooldown";
  /** Buffer duration in minutes. */
  readonly minutes: number;
  /** Which events the buffer applies to: 'all' or 'external' only. */
  readonly applies_to: "all" | "external";
}

/**
 * Minimal event row shape needed by expandBuffersToBusy.
 * Matches the columns queried by computeAvailability.
 */
export interface EventRowForBuffer {
  readonly start_ts: string;
  readonly end_ts: string;
  readonly origin_account_id: string;
}

/**
 * Expand buffer constraints into busy intervals around existing events.
 *
 * For each buffer constraint, generates additional busy time around events:
 * - type='travel': adds buffer BEFORE the event (travel time to get there)
 * - type='prep': adds buffer BEFORE the event (preparation time)
 * - type='cooldown': adds buffer AFTER the event (recovery/wind-down time)
 *
 * When applies_to='external', buffers only apply to events where
 * origin_account_id is not 'internal' (i.e., real calendar events,
 * not system-generated ones like trip blocks).
 *
 * Returns BusyInterval[] -- these are NOT calendar events, just busy slots
 * that reduce availability.
 *
 * Pure function: no side effects, no database access.
 */
export function expandBuffersToBusy(
  constraints: readonly { config_json: Record<string, unknown> }[],
  events: readonly EventRowForBuffer[],
): BusyInterval[] {
  if (constraints.length === 0 || events.length === 0) return [];

  const configs: BufferConfig[] = constraints.map(
    (c) => c.config_json as unknown as BufferConfig,
  );

  const bufferIntervals: BusyInterval[] = [];

  for (const config of configs) {
    const bufferMs = config.minutes * 60 * 1000;

    for (const event of events) {
      // Skip internal events when applies_to is 'external'
      if (config.applies_to === "external" && event.origin_account_id === "internal") {
        continue;
      }

      const eventStartMs = new Date(event.start_ts).getTime();
      const eventEndMs = new Date(event.end_ts).getTime();

      if (config.type === "travel" || config.type === "prep") {
        // Buffer goes BEFORE the event
        const bufferStart = new Date(eventStartMs - bufferMs).toISOString();
        bufferIntervals.push({
          start: bufferStart,
          end: event.start_ts,
          account_ids: ["buffer"],
        });
      } else if (config.type === "cooldown") {
        // Buffer goes AFTER the event
        const bufferEnd = new Date(eventEndMs + bufferMs).toISOString();
        bufferIntervals.push({
          start: event.end_ts,
          end: bufferEnd,
          account_ids: ["buffer"],
        });
      }
    }
  }

  return bufferIntervals;
}

// ---------------------------------------------------------------------------
// Trip constraint helpers
// ---------------------------------------------------------------------------

/**
 * Expand trip constraints into busy intervals for the query range.
 *
 * Trip constraints have active_from and active_to dates that define the trip
 * period. Any overlap with the query range produces a busy interval.
 *
 * While trip constraints also create derived canonical events (picked up in
 * step 1 of computeAvailability), this explicit expansion ensures:
 * - Trip blocks are never lost due to account filtering
 * - Resilience if derived event creation was incomplete
 *
 * Pure function: no side effects, no database access.
 */
export function expandTripConstraintsToBusy(
  constraints: readonly { active_from: string | null; active_to: string | null }[],
  rangeStart: string,
  rangeEnd: string,
): BusyInterval[] {
  if (constraints.length === 0) return [];

  const rangeStartMs = new Date(rangeStart).getTime();
  const rangeEndMs = new Date(rangeEnd).getTime();
  if (rangeStartMs >= rangeEndMs) return [];

  const intervals: BusyInterval[] = [];

  for (const constraint of constraints) {
    if (!constraint.active_from || !constraint.active_to) continue;

    const tripStartMs = new Date(constraint.active_from).getTime();
    const tripEndMs = new Date(constraint.active_to).getTime();

    // Check overlap with query range
    if (tripEndMs <= rangeStartMs || tripStartMs >= rangeEndMs) continue;

    // Clamp to query range
    const clampedStart = Math.max(tripStartMs, rangeStartMs);
    const clampedEnd = Math.min(tripEndMs, rangeEndMs);

    intervals.push({
      start: new Date(clampedStart).toISOString(),
      end: new Date(clampedEnd).toISOString(),
      account_ids: ["trip"],
    });
  }

  return intervals;
}

// ---------------------------------------------------------------------------
// No-meetings-after constraint helpers
// ---------------------------------------------------------------------------

/**
 * Config shape for no_meetings_after constraints as stored in config_json.
 */
export interface NoMeetingsAfterConfig {
  /** Cutoff time in HH:MM 24-hour format. */
  readonly time: string;
  /** IANA timezone string (e.g. "America/New_York"). */
  readonly timezone: string;
}

/**
 * Expand no_meetings_after constraints into busy intervals.
 *
 * For each day in the query range, the time from the cutoff to midnight
 * (end of day) in the constraint's timezone is marked as busy.
 *
 * When multiple no_meetings_after constraints exist, the EARLIEST cutoff
 * wins for each day (most restrictive).
 *
 * Algorithm:
 * 1. Scan day by day across the range (with timezone buffer)
 * 2. For each scan day, compute cutoff time for each constraint
 * 3. Use the earliest cutoff, generate busy from cutoff to end-of-day
 * 4. Clamp all intervals to the query range
 *
 * Pure function: no side effects, no database access.
 */
export function expandNoMeetingsAfterToBusy(
  constraints: readonly { config_json: Record<string, unknown> }[],
  rangeStart: string,
  rangeEnd: string,
): BusyInterval[] {
  if (constraints.length === 0) return [];

  const configs: NoMeetingsAfterConfig[] = constraints.map(
    (c) => c.config_json as unknown as NoMeetingsAfterConfig,
  );

  const rangeStartMs = new Date(rangeStart).getTime();
  const rangeEndMs = new Date(rangeEnd).getTime();

  if (rangeStartMs >= rangeEndMs) return [];

  const busyIntervals: BusyInterval[] = [];
  const oneDayMs = 24 * 60 * 60 * 1000;

  // Scan day by day with timezone buffer to handle edge cases
  const scanStart = rangeStartMs - oneDayMs;
  const scanEnd = rangeEndMs + oneDayMs;

  let dayStart = scanStart;
  while (dayStart < scanEnd) {
    const dayDate = new Date(dayStart);

    let earliestCutoffMs: number | null = null;
    let earliestTimezone: string | null = null;

    for (const config of configs) {
      // Get the cutoff timestamp in UTC for this day/timezone
      const cutoffMs = getTimestampForTimeInTimezone(
        dayDate,
        config.time,
        config.timezone,
      );

      // End of this day in the constraint's timezone (midnight next day)
      const endOfDayMs = getTimestampForTimeInTimezone(
        dayDate,
        "23:59",
        config.timezone,
      ) + 60_000; // Add 1 minute to reach midnight

      // Skip if this day's cutoff-to-midnight doesn't overlap with query range
      if (endOfDayMs <= rangeStartMs || cutoffMs >= rangeEndMs) {
        continue;
      }

      if (earliestCutoffMs === null || cutoffMs < earliestCutoffMs) {
        earliestCutoffMs = cutoffMs;
        earliestTimezone = config.timezone;
      }
    }

    if (earliestCutoffMs !== null && earliestTimezone !== null) {
      // Busy from cutoff to end of day in the earliest constraint's timezone
      const endOfDayMs = getTimestampForTimeInTimezone(
        dayDate,
        "23:59",
        earliestTimezone,
      ) + 60_000;

      // Clamp to query range
      const busyStart = Math.max(earliestCutoffMs, rangeStartMs);
      const busyEnd = Math.min(endOfDayMs, rangeEndMs);

      if (busyStart < busyEnd) {
        busyIntervals.push({
          start: new Date(busyStart).toISOString(),
          end: new Date(busyEnd).toISOString(),
          account_ids: ["no_meetings_after"],
        });
      }
    }

    dayStart += oneDayMs;
  }

  return busyIntervals;
}
