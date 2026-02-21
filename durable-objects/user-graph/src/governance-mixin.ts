/**
 * Governance mixin for UserGraphDO.
 *
 * Extracted from UserGraphDO to reduce class size. Contains all methods
 * related to the governance/compliance domain:
 * - Time allocation CRUD: create / get / update / delete / list
 * - VIP policy management: create / list / get / delete
 * - Commitment tracking: create / get / list / delete / getStatus / getProofData
 *
 * Uses composition: the mixin receives the sql handle and a migration
 * callback from the host DO, so it can operate on the same SQLite store.
 */

import {
  isValidBillingCategory,
  generateId,
} from "@tminus/shared";
import type { SqlStorageLike } from "@tminus/shared";

// ---------------------------------------------------------------------------
// Internal row types (local to this mixin)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public types used by callers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Mixin class
// ---------------------------------------------------------------------------

/**
 * Encapsulates governance persistence logic: time allocations, VIP policies,
 * and commitment tracking.
 *
 * Constructed with a reference to the DO's SqlStorageLike handle and a
 * callback that ensures migrations have been applied. This avoids
 * duplicating migration logic while keeping the governance code isolated.
 */
export class GovernanceMixin {
  private readonly sql: SqlStorageLike;
  private readonly ensureMigrated: () => void;

  constructor(sql: SqlStorageLike, ensureMigrated: () => void) {
    this.sql = sql;
    this.ensureMigrated = ensureMigrated;
  }

  // -----------------------------------------------------------------------
  // Time allocation management (billable time tagging)
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // VIP policy management
  // -----------------------------------------------------------------------

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
  ): {
    vip_id: string;
    participant_hash: string;
    display_name: string | null;
    priority_weight: number;
    conditions_json: string;
    created_at: string;
  } {
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

  // -----------------------------------------------------------------------
  // Commitment tracking (Phase 3)
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Helper: event client_id lookup from allocations
  // -----------------------------------------------------------------------

  /**
   * Get the client_id for an event from its time_allocation, if any.
   * Returns null if no allocation exists.
   */
  getEventClientId(canonicalEventId: string): string | null {
    const rows = this.sql
      .exec<{ client_id: string | null }>(
        `SELECT client_id FROM time_allocations WHERE canonical_event_id = ? LIMIT 1`,
        canonicalEventId,
      )
      .toArray();
    return rows.length > 0 ? rows[0].client_id : null;
  }
}
