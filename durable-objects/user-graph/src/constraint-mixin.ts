/**
 * Constraint management mixin for UserGraphDO.
 *
 * Extracted from UserGraphDO to reduce class size. Contains all methods
 * related to the constraint domain:
 * - addConstraint -- validates kind, stores in `constraints` table, creates
 *   derived events for trip constraints
 * - deleteConstraint -- cascade-deletes derived trip events and their mirrors
 * - updateConstraint -- updates constraint fields, re-derives trip events
 * - listConstraints -- list by kind or all
 * - getConstraint -- single constraint lookup
 * - createTripDerivedEvents (private) -- generates canonical events from trips
 * - rowToConstraint (private) -- DB row to domain object converter
 * - All validation statics (working_hours, buffer, no_meetings_after, override, trip)
 *
 * Uses composition: the mixin receives the sql handle, a migration callback,
 * and a `constraintDeps` delegate for cross-domain operations (journal writes
 * and mirror deletion queue messages).
 */

import { generateId } from "@tminus/shared";
import type { SqlStorageLike } from "@tminus/shared";

// ---------------------------------------------------------------------------
// Internal row types (local to this mixin)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A constraint as returned by addConstraint / listConstraints. */
export interface Constraint {
  readonly constraint_id: string;
  readonly kind: string;
  readonly config_json: Record<string, unknown>;
  readonly active_from: string | null;
  readonly active_to: string | null;
  readonly created_at: string;
}

/**
 * Cross-domain operations that the constraint mixin delegates back to
 * the host DO. These are the only two operations that cross domain
 * boundaries: journal writes (audit trail) and mirror deletion queue
 * messages (for cascade-deleting trip-derived event mirrors).
 */
export interface ConstraintDeps {
  writeJournal(
    canonicalEventId: string,
    changeType: string,
    actor: string,
    patch: Record<string, unknown>,
  ): void;
  enqueueDeleteMirror(message: unknown): void;
}

// ---------------------------------------------------------------------------
// Mixin class
// ---------------------------------------------------------------------------

/**
 * Encapsulates constraint CRUD and validation logic: trip, working hours,
 * buffer, no_meetings_after, and override constraints.
 *
 * Constructed with a reference to the DO's SqlStorageLike handle, a
 * callback that ensures migrations have been applied, and a delegate
 * for cross-domain operations (journal + mirror deletion).
 */
export class ConstraintMixin {
  private readonly sql: SqlStorageLike;
  private readonly ensureMigrated: () => void;
  private readonly deps: ConstraintDeps;

  constructor(
    sql: SqlStorageLike,
    ensureMigrated: () => void,
    deps: ConstraintDeps,
  ) {
    this.sql = sql;
    this.ensureMigrated = ensureMigrated;
    this.deps = deps;
  }

  // -----------------------------------------------------------------------
  // Valid constraint kinds
  // -----------------------------------------------------------------------

  /** Valid constraint kinds. */
  static readonly VALID_CONSTRAINT_KINDS: ReadonlySet<string> = new Set([
    "trip",
    "working_hours",
    "buffer",
    "no_meetings_after",
    "override",
  ]);

  // -----------------------------------------------------------------------
  // Constraint validation statics
  // -----------------------------------------------------------------------

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
        ConstraintMixin.validateWorkingHoursConfig(configJson);
        break;
      case "buffer":
        ConstraintMixin.validateBufferConfig(configJson);
        break;
      case "no_meetings_after":
        ConstraintMixin.validateNoMeetingsAfterConfig(configJson);
        break;
      case "override":
        ConstraintMixin.validateOverrideConfig(configJson);
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

  // -----------------------------------------------------------------------
  // Constraint CRUD
  // -----------------------------------------------------------------------

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
    if (!ConstraintMixin.VALID_CONSTRAINT_KINDS.has(kind)) {
      throw new Error(
        `Invalid constraint kind "${kind}". Must be one of: ${[...ConstraintMixin.VALID_CONSTRAINT_KINDS].join(", ")}`,
      );
    }

    // Kind-specific validation (centralized)
    ConstraintMixin.validateConstraintConfig(kind, configJson, activeFrom, activeTo);

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
        this.deps.enqueueDeleteMirror({
          type: "DELETE_MIRROR",
          canonical_event_id: evt.canonical_event_id,
          target_account_id: mirror.target_account_id,
          target_calendar_id: mirror.target_calendar_id,
          provider_event_id: mirror.provider_event_id ?? "",
        });
      }

      // Soft-delete mirrors: transition to DELETING
      this.sql.exec(
        `UPDATE event_mirrors SET state = 'DELETING'
         WHERE canonical_event_id = ? AND state NOT IN ('DELETED', 'TOMBSTONED')`,
        evt.canonical_event_id,
      );
      this.sql.exec(
        `DELETE FROM event_mirrors
         WHERE canonical_event_id = ? AND state IN ('DELETED', 'TOMBSTONED')`,
        evt.canonical_event_id,
      );

      // Hard delete derived event only if no DELETING mirrors remain
      this.sql.exec(
        `DELETE FROM canonical_events WHERE canonical_event_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM event_mirrors
           WHERE event_mirrors.canonical_event_id = canonical_events.canonical_event_id
         )`,
        evt.canonical_event_id,
      );

      // Journal entry for derived event deletion
      this.deps.writeJournal(evt.canonical_event_id, "deleted", "system", {
        reason: "constraint_deleted",
        constraint_id: constraintId,
      });
    }

    // Detach any retained canonical events from the constraint before deleting it.
    // Events with DELETING mirrors can't be hard-deleted yet, but the constraint
    // reference must be cleared to satisfy the FK constraint.
    this.sql.exec(
      `UPDATE canonical_events SET constraint_id = NULL WHERE constraint_id = ?`,
      constraintId,
    );

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
    ConstraintMixin.validateConstraintConfig(kind, configJson, activeFrom, activeTo);

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
          this.deps.enqueueDeleteMirror({
            type: "DELETE_MIRROR",
            canonical_event_id: evt.canonical_event_id,
            target_account_id: mirror.target_account_id,
            target_calendar_id: mirror.target_calendar_id,
            provider_event_id: mirror.provider_event_id ?? "",
          });
        }

        // Soft-delete mirrors: transition to DELETING
        this.sql.exec(
          `UPDATE event_mirrors SET state = 'DELETING'
           WHERE canonical_event_id = ? AND state NOT IN ('DELETED', 'TOMBSTONED')`,
          evt.canonical_event_id,
        );
        this.sql.exec(
          `DELETE FROM event_mirrors
           WHERE canonical_event_id = ? AND state IN ('DELETED', 'TOMBSTONED')`,
          evt.canonical_event_id,
        );
        this.sql.exec(
          `DELETE FROM canonical_events WHERE canonical_event_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM event_mirrors
             WHERE event_mirrors.canonical_event_id = canonical_events.canonical_event_id
           )`,
          evt.canonical_event_id,
        );

        this.deps.writeJournal(evt.canonical_event_id, "deleted", "system", {
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

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

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
    this.deps.writeJournal(eventId, "created", "system", {
      reason: "trip_constraint",
      constraint_id: constraintId,
    });
  }

  // -----------------------------------------------------------------------
  // Bulk deletion (used by deleteRelationshipData)
  // -----------------------------------------------------------------------

  /**
   * Delete ALL constraint-domain data from this user's DO SQLite.
   *
   * Covers: constraints table.
   *
   * Note: this is a simple DELETE without cascade-deleting derived events
   * or mirrors. The caller (deleteRelationshipData) is responsible for
   * full GDPR cleanup of events and mirrors separately.
   *
   * Returns the total number of rows deleted.
   */
  deleteAll(): number {
    this.ensureMigrated();

    const count = this.sql
      .exec<{ cnt: number }>("SELECT COUNT(*) as cnt FROM constraints")
      .toArray()[0].cnt;

    this.sql.exec("DELETE FROM constraints");

    return count;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

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
}
