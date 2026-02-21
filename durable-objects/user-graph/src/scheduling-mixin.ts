/**
 * Scheduling session and tentative hold management mixin for UserGraphDO.
 *
 * Extracted from UserGraphDO to reduce class size. Contains all methods
 * related to the scheduling domain:
 * - Scheduling sessions: store / get / commit / list / cancel / expire
 * - Tentative holds: store / getBySession / updateStatus / getExpired /
 *   commitSession / releaseSession / extend / expireIfAllTerminal
 *
 * Uses composition: the mixin receives the sql handle and a migration
 * callback from the host DO, so it can operate on the same SQLite store.
 */

import type { SqlStorageLike } from "@tminus/shared";

// ---------------------------------------------------------------------------
// Internal row types (local to this mixin)
// ---------------------------------------------------------------------------

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

interface CandidateRow {
  [key: string]: unknown;
  candidate_id: string;
  session_id: string;
  start_ts: string;
  end_ts: string;
  score: number;
  explanation: string;
}

interface HoldRow {
  [key: string]: unknown;
  hold_id: string;
  session_id: string;
  account_id: string;
  provider_event_id: string | null;
  expires_at: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Public types used by callers
// ---------------------------------------------------------------------------

export interface SchedulingCandidate {
  candidateId: string;
  sessionId: string;
  start: string;
  end: string;
  score: number;
  explanation: string;
}

export interface SchedulingSessionResult {
  sessionId: string;
  status: string;
  params: Record<string, unknown>;
  candidates: SchedulingCandidate[];
  committedCandidateId?: string;
  committedEventId?: string;
  createdAt: string;
}

export interface SchedulingSessionListItem {
  sessionId: string;
  status: string;
  params: Record<string, unknown>;
  candidateCount: number;
  createdAt: string;
}

export interface HoldRecord {
  hold_id: string;
  session_id: string;
  account_id: string;
  provider_event_id: string | null;
  expires_at: string;
  status: string;
}

export interface StoreSchedulingSessionInput {
  session_id: string;
  status: string;
  objective_json: string;
  candidates: SchedulingCandidate[];
  created_at: string;
}

export interface StoreHoldInput {
  hold_id: string;
  session_id: string;
  account_id: string;
  provider_event_id: string | null;
  expires_at: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Mixin class
// ---------------------------------------------------------------------------

/**
 * Encapsulates scheduling session and tentative hold persistence logic.
 *
 * Constructed with a reference to the DO's SqlStorageLike handle and a
 * callback that ensures migrations have been applied. This avoids
 * duplicating migration logic while keeping the scheduling code isolated.
 */
export class SchedulingMixin {
  private readonly sql: SqlStorageLike;
  private readonly ensureMigrated: () => void;

  constructor(sql: SqlStorageLike, ensureMigrated: () => void) {
    this.sql = sql;
    this.ensureMigrated = ensureMigrated;
  }

  // -----------------------------------------------------------------------
  // Scheduling session management (Phase 3)
  // -----------------------------------------------------------------------

  /**
   * Store a scheduling session and its candidates in the DO-local SQLite.
   * Uses the schedule_sessions and schedule_candidates tables from the
   * USER_GRAPH_DO_MIGRATION_V1 schema.
   */
  storeSchedulingSession(data: StoreSchedulingSessionInput): void {
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
  getSchedulingSession(sessionId: string): SchedulingSessionResult {
    this.ensureMigrated();

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
  commitSchedulingSession(
    sessionId: string,
    candidateId: string,
    eventId: string,
  ): void {
    this.ensureMigrated();

    // Get current session to preserve objective_json
    interface ObjRow {
      [key: string]: unknown;
      objective_json: string;
    }

    const rows = this.sql.exec<ObjRow>(
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
  listSchedulingSessions(
    statusFilter?: string,
    limit: number = 50,
    offset: number = 0,
  ): {
    items: SchedulingSessionListItem[];
    total: number;
  } {
    this.ensureMigrated();

    // Lazy expiry: expire stale sessions before listing
    this.expireStaleSchedulingSessions();

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
      const candidateCountRow = this.sql.exec<CountRow>(
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
  cancelSchedulingSession(sessionId: string): void {
    this.ensureMigrated();

    interface StatusRow {
      [key: string]: unknown;
      session_id: string;
      status: string;
    }

    const rows = this.sql.exec<StatusRow>(
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
  expireStaleSchedulingSessions(maxAgeHours: number = 24): number {
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

  // -----------------------------------------------------------------------
  // Tentative hold management (TM-946.3)
  // -----------------------------------------------------------------------

  /**
   * Store one or more hold records in the schedule_holds table.
   * Each hold represents a tentative calendar event for a candidate slot.
   */
  storeHolds(holds: StoreHoldInput[]): void {
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
  getHoldsBySession(sessionId: string): HoldRecord[] {
    this.ensureMigrated();

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
  updateHoldStatus(
    holdId: string,
    newStatus: string,
    providerEventId?: string,
  ): void {
    this.ensureMigrated();

    interface HoldStatusRow {
      [key: string]: unknown;
      hold_id: string;
      status: string;
    }

    const rows = this.sql
      .exec<HoldStatusRow>(
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
  getExpiredHolds(): HoldRecord[] {
    this.ensureMigrated();

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
  commitSessionHolds(
    sessionId: string,
    committedCandidateId: string,
  ): {
    committed: HoldRecord[];
    released: HoldRecord[];
  } {
    this.ensureMigrated();

    // Get all holds for the session
    const holds = this.getHoldsBySession(sessionId);

    // On commit, release all held holds (the workflow creates the confirmed
    // event separately via upsertCanonicalEvent).
    const committed: HoldRecord[] = [];
    const released: HoldRecord[] = [];

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
  releaseSessionHolds(sessionId: string): void {
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
  extendHolds(
    sessionId: string,
    holds: Array<{ hold_id: string; new_expires_at: string }>,
  ): number {
    this.ensureMigrated();

    let extended = 0;
    for (const h of holds) {
      // Only extend holds that belong to this session and are still held
      this.sql.exec(
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
  expireSessionIfAllHoldsTerminal(sessionId: string): boolean {
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
}
