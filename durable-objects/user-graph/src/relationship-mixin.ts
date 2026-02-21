/**
 * Relationship tracking mixin for UserGraphDO.
 *
 * Extracted from UserGraphDO to reduce class size. Contains all methods
 * related to the relationship/social-graph domain:
 * - Relationship CRUD: create / get / list / update / delete
 * - Interaction ledger: markOutcome / listOutcomes / getTimeline
 * - Reputation: getReputation / listRelationshipsWithReputation
 * - Drift: getDriftReport / getReconnectionSuggestions
 * - Milestones: create / list / delete / listUpcoming / getAll
 * - Interaction detection: updateInteractions
 * - Event participants: store / get participant hashes
 * - Scheduling history: record / get (for fairness scoring)
 * - Event briefing: getEventBriefing
 * - Drift alerts: store / get (persisted snapshots from daily cron)
 *
 * Uses composition: the mixin receives the sql handle and a migration
 * callback from the host DO, so it can operate on the same SQLite store.
 */

import {
  generateId,
  isValidRelationshipCategory,
  isValidOutcome,
  getOutcomeWeight,
  computeDrift,
  matchEventParticipants,
  computeReputation,
  enrichSuggestionsWithTimeWindows,
  enrichWithTimezoneWindows,
  matchCityWithAliases,
  cityToTimezone,
  suggestMeetingWindow,
  assembleBriefing,
  isValidMilestoneKind,
  isValidMilestoneDate,
  MILESTONE_KINDS,
  computeNextOccurrence,
  daysBetween,
} from "@tminus/shared";
import type {
  SqlStorageLike,
  DriftReport,
  DriftAlert,
  InteractionOutcome,
  ReputationResult,
  LedgerInput,
  ReconnectionSuggestion,
  EventBriefing,
  BriefingParticipantInput,
  MilestoneKind,
  Milestone,
  UpcomingMilestone,
} from "@tminus/shared";

// ---------------------------------------------------------------------------
// Internal row types (local to this mixin)
// ---------------------------------------------------------------------------

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

interface CanonicalEventRow {
  [key: string]: unknown;
  canonical_event_id: string;
  title: string | null;
  start_ts: string;
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

// ---------------------------------------------------------------------------
// Public types (re-exported by index.ts)
// ---------------------------------------------------------------------------

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

/** A constraint as returned by constraint lookup (used internally by getReconnectionSuggestions). */
interface Constraint {
  readonly constraint_id: string;
  readonly kind: string;
  readonly config_json: Record<string, unknown>;
  readonly active_from: string | null;
  readonly active_to: string | null;
  readonly created_at: string;
}

// ---------------------------------------------------------------------------
// Mixin class
// ---------------------------------------------------------------------------

/**
 * Encapsulates relationship tracking, interaction ledger, milestone,
 * participant, drift-alert, scheduling-history, and briefing persistence logic.
 *
 * Constructed with a reference to the DO's SqlStorageLike handle and a
 * callback that ensures migrations have been applied. This avoids
 * duplicating migration logic while keeping the relationship code isolated.
 */
export class RelationshipMixin {
  private readonly sql: SqlStorageLike;
  private readonly ensureMigrated: () => void;

  constructor(sql: SqlStorageLike, ensureMigrated: () => void) {
    this.sql = sql;
    this.ensureMigrated = ensureMigrated;
  }

  // -----------------------------------------------------------------------
  // Relationship CRUD (Phase 4)
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Interaction Ledger (Phase 4)
  // -----------------------------------------------------------------------

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
      const constraint = this.getConstraintById(tripId);
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

  // -----------------------------------------------------------------------
  // Milestone CRUD (Phase 4B)
  // -----------------------------------------------------------------------

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
   * Used by the host DO's computeAvailability method.
   */
  getAllMilestones(): Array<{
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

  // -----------------------------------------------------------------------
  // Event participant storage (for briefing lookups)
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Scheduling history for fairness scoring (TM-82s.3)
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Pre-meeting context briefing (Phase 4C)
  // -----------------------------------------------------------------------

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
        `SELECT canonical_event_id, title, start_ts FROM canonical_events WHERE canonical_event_id = ?`,
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

  // -----------------------------------------------------------------------
  // Drift alert storage (persisted snapshots from daily cron)
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Look up a constraint by ID (used by getReconnectionSuggestions for trip resolution).
   * Queries the constraints table directly via the shared SQL handle.
   */
  private getConstraintById(constraintId: string): Constraint | null {
    this.ensureMigrated();

    const rows = this.sql
      .exec<ConstraintRow>(
        `SELECT constraint_id, kind, config_json, active_from, active_to, created_at
         FROM constraints WHERE constraint_id = ?`,
        constraintId,
      )
      .toArray();

    if (rows.length === 0) return null;

    const row = rows[0];
    let configJson: Record<string, unknown> = {};
    try {
      configJson = JSON.parse(row.config_json);
    } catch {
      // If config_json is malformed, use empty object
    }

    return {
      constraint_id: row.constraint_id,
      kind: row.kind,
      config_json: configJson,
      active_from: row.active_from,
      active_to: row.active_to,
      created_at: row.created_at,
    };
  }
}
