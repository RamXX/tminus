/**
 * SchedulingWorkflow -- orchestrates the meeting scheduling flow (AD-3).
 *
 * Flow:
 * 1. gatherConstraints: Read session parameters, validate inputs
 * 2. gatherAvailability: Call UserGraphDO.computeAvailability() for the window
 * 3. runSolver: Execute greedy solver to enumerate candidates
 * 4. produceCandidates: Store candidates in schedule_candidates table
 * 5. createHolds: (Phase 3+) Create tentative holds on calendars
 * 6. commitOnConfirmation: When user picks a candidate, create canonical event
 *    and project mirrors
 *
 * The workflow is triggered from the API worker and communicates with
 * UserGraphDO via DO stubs (not queues -- per story spec).
 *
 * For testability, this is implemented as a plain class with injectable
 * dependencies, following the same pattern as OnboardingWorkflow.
 */

import { generateId } from "@tminus/shared";
import type { CanonicalEvent, AccountId, CalendarId, EventId } from "@tminus/shared";
import { greedySolver } from "./solver";
import type { SolverInput, BusyInterval, ScoredCandidate, SolverConstraint, VipOverrideConstraint } from "./solver";
import {
  createHoldRecord,
  buildHoldUpsertMessage,
  buildHoldDeleteMessage,
  isHoldExpired,
  findExpiredHolds,
  isValidTransition,
  transitionHold,
  DEFAULT_HOLD_TIMEOUT_MS,
  MIN_HOLD_TIMEOUT_MS,
} from "./holds";
import type { Hold, HoldStatus, CreateHoldParams, HoldWriteMessage, HoldDeleteMessage } from "./holds";
import {
  GreedySolverAdapter,
  ExternalSolver,
  selectSolver,
  createSolverFromEnv,
} from "./external-solver";
import type { Solver, SolverResult } from "./external-solver";
import {
  computeFairnessScore,
  applyVipWeight,
  computeMultiFactorScore,
  buildExplanation,
  recordSchedulingOutcome,
} from "./fairness";
import type {
  SchedulingHistoryEntry,
  VipPolicy,
  MultiFactorInput,
  ScoreComponents,
  SchedulingOutcome,
  FairnessContext,
  MultiFactorResult,
} from "./fairness";

// Re-export solver types and constants for consumers
export { greedySolver, CONSTRAINT_SCORES } from "./solver";
export type {
  SolverInput, BusyInterval, ScoredCandidate, SolverConstraint,
  WorkingHoursConstraint, TripConstraint, BufferConstraint,
  NoMeetingsAfterConstraint, VipOverrideConstraint, OverrideConstraint,
} from "./solver";
export { scoreVipOverride } from "./solver";

// Re-export external solver types and functions for consumers (TM-82s.2)
export {
  GreedySolverAdapter,
  ExternalSolver,
  selectSolver,
  createSolverFromEnv,
  EXTERNAL_SOLVER_TIMEOUT_MS,
} from "./external-solver";
export type { Solver, SolverResult } from "./external-solver";

// Re-export holds types and helpers for consumers
export {
  createHoldRecord,
  buildHoldUpsertMessage,
  buildHoldDeleteMessage,
  isHoldExpired,
  findExpiredHolds,
  isValidTransition,
  transitionHold,
  DEFAULT_HOLD_TIMEOUT_MS,
  MIN_HOLD_TIMEOUT_MS,
  // TM-82s.4: Advanced hold lifecycle
  validateHoldDurationHours,
  holdDurationHoursToMs,
  isApproachingExpiry,
  computeExtendedExpiry,
  detectHoldConflicts,
  HOLD_DURATION_MIN_HOURS,
  HOLD_DURATION_MAX_HOURS,
  HOLD_DURATION_DEFAULT_HOURS,
  APPROACHING_EXPIRY_THRESHOLD_MS,
} from "./holds";
export type { Hold, HoldStatus, CreateHoldParams, HoldWriteMessage, HoldDeleteMessage, HoldConflict } from "./holds";

// Re-export fairness scoring types and functions for consumers (TM-82s.3)
export {
  computeFairnessScore,
  applyVipWeight,
  computeMultiFactorScore,
  buildExplanation,
  recordSchedulingOutcome,
} from "./fairness";
export type {
  SchedulingHistoryEntry,
  VipPolicy,
  MultiFactorInput,
  ScoreComponents,
  SchedulingOutcome,
  FairnessContext,
  MultiFactorResult,
} from "./fairness";

// ---------------------------------------------------------------------------
// Env bindings
// ---------------------------------------------------------------------------

export interface SchedulingEnv {
  USER_GRAPH: DurableObjectNamespace;
  ACCOUNT: DurableObjectNamespace;
  WRITE_QUEUE: Queue;
  /** Optional: URL of external constraint solver service (TM-82s.2). */
  SOLVER_ENDPOINT?: string;
}

// ---------------------------------------------------------------------------
// Workflow parameters
// ---------------------------------------------------------------------------

/** Input parameters for creating a scheduling session. */
export interface SchedulingParams {
  /** User ID (owns the UserGraphDO). */
  readonly userId: string;
  /** Human-readable meeting title. */
  readonly title: string;
  /** Meeting duration in minutes. */
  readonly durationMinutes: number;
  /** ISO 8601 start of the scheduling window. */
  readonly windowStart: string;
  /** ISO 8601 end of the scheduling window. */
  readonly windowEnd: string;
  /** Account IDs that must all be free. */
  readonly requiredAccountIds: string[];
  /** Maximum candidates to produce (default 5). */
  readonly maxCandidates?: number;
  /** Hold timeout in milliseconds. Default: 24 hours. Set to 0 to skip hold creation. */
  readonly holdTimeoutMs?: number;
  /** Target calendar ID for creating tentative hold events. */
  readonly targetCalendarId?: string;
  /** Participant email hashes for VIP matching. */
  readonly participantHashes?: string[];
}

// ---------------------------------------------------------------------------
// Session and candidate types
// ---------------------------------------------------------------------------

export type SessionStatus = "open" | "candidates_ready" | "committed" | "expired" | "cancelled";

export interface SchedulingSession {
  readonly sessionId: string;
  readonly status: SessionStatus;
  readonly params: SchedulingParams;
  readonly candidates: StoredCandidate[];
  readonly committedCandidateId?: string;
  readonly committedEventId?: string;
  readonly holds?: Hold[];
  readonly createdAt: string;
}

export interface StoredCandidate {
  readonly candidateId: string;
  readonly sessionId: string;
  readonly start: string;
  readonly end: string;
  readonly score: number;
  readonly explanation: string;
}

// ---------------------------------------------------------------------------
// SchedulingWorkflow class
// ---------------------------------------------------------------------------

export class SchedulingWorkflow {
  private readonly env: SchedulingEnv;
  private readonly solver: Solver;
  private readonly externalSolver: Solver | null;

  constructor(env: SchedulingEnv) {
    this.env = env;
    // Always have a greedy solver ready (default + fallback)
    this.solver = new GreedySolverAdapter();
    // Create external solver only if endpoint is configured
    this.externalSolver = env.SOLVER_ENDPOINT
      ? createSolverFromEnv(env.SOLVER_ENDPOINT)
      : null;
  }

  /**
   * Step 1 + 2 + 3 + 4: Create session, gather availability, run solver,
   * store candidates.
   *
   * This is the main entry point called when POST /v1/scheduling/sessions
   * is invoked. Returns the session with candidates.
   */
  async createSession(params: SchedulingParams): Promise<SchedulingSession> {
    // Step 1: Validate inputs
    this.validateParams(params);

    const sessionId = generateId("session");
    const now = new Date().toISOString();

    // Step 2: Gather availability, constraints, VIP policies, and scheduling history
    const [availability, constraints, vipConstraints, schedulingHistory] = await Promise.all([
      this.gatherAvailability(
        params.userId,
        params.windowStart,
        params.windowEnd,
        params.requiredAccountIds,
      ),
      this.getActiveConstraints(params.userId, params.windowStart, params.windowEnd),
      this.getVipOverrideConstraints(params.userId),
      this.getSchedulingHistory(params.userId, params.participantHashes ?? []),
    ]);

    // Merge VIP override constraints into the constraint list
    const allConstraints: SolverConstraint[] = [...constraints, ...vipConstraints];

    // Extract VIP policies for fairness scoring (from vip_override constraints)
    const vipPolicies: VipPolicy[] = vipConstraints.map((vc) => ({
      participant_hash: vc.config.participant_hash,
      display_name: vc.config.display_name,
      priority_weight: vc.config.priority_weight,
    }));

    // Step 3: Run solver with constraint-aware + VIP-aware scoring.
    // Uses pluggable solver: external for complex cases, greedy as default + fallback.
    const solverInput: SolverInput = {
      windowStart: params.windowStart,
      windowEnd: params.windowEnd,
      durationMinutes: params.durationMinutes,
      busyIntervals: availability.busy_intervals,
      requiredAccountIds: params.requiredAccountIds,
      constraints: allConstraints,
      participantHashes: params.participantHashes,
    };
    const maxCandidates = params.maxCandidates ?? 5;
    const solverResult = await this.runSolverWithFallback(solverInput, maxCandidates);
    const rawCandidates = solverResult.candidates;

    // Step 3b: Apply fairness and VIP multi-factor scoring (TM-82s.3)
    const hasFairnessData = schedulingHistory.length > 0 && (params.participantHashes?.length ?? 0) > 0;
    const hasVipData = vipPolicies.length > 0 && (params.participantHashes?.length ?? 0) > 0;

    const fairnessEnhancedCandidates = rawCandidates.map((c) => {
      if (!hasFairnessData && !hasVipData) {
        // No fairness or VIP data: use raw solver scores unchanged
        return c;
      }

      // Compute per-participant fairness (use first matching participant as representative)
      const targetHash = params.participantHashes?.[0];
      const fairness = hasFairnessData
        ? computeFairnessScore(schedulingHistory, targetHash)
        : { adjustment: 1.0, explanation: null as string | null };

      // Compute VIP weight
      const vipResult = hasVipData
        ? applyVipWeight(vipPolicies, params.participantHashes ?? [])
        : { weight: 1.0, explanation: null as string | null };

      // Multi-factor scoring
      const multiResult = computeMultiFactorScore({
        timePreferenceScore: c.score,
        constraintScore: 0, // Already included in solver base score
        fairnessAdjustment: fairness.adjustment,
        vipWeight: vipResult.weight,
      });

      // Build enhanced explanation
      const enhanced = buildExplanation({
        timePreferenceScore: c.score,
        constraintScore: 0,
        fairnessAdjustment: fairness.adjustment,
        vipWeight: vipResult.weight,
        baseExplanation: c.explanation,
        fairnessExplanation: fairness.explanation,
        vipExplanation: vipResult.explanation,
      });

      return {
        ...c,
        score: multiResult.finalScore,
        explanation: enhanced,
      };
    });

    // Re-sort by enhanced scores (descending, then by start time for stability)
    fairnessEnhancedCandidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.start.localeCompare(b.start);
    });

    // Step 4: Store session and candidates in UserGraphDO
    const candidates: StoredCandidate[] = fairnessEnhancedCandidates.map((c) => ({
      candidateId: generateId("candidate"),
      sessionId,
      start: c.start,
      end: c.end,
      score: c.score,
      explanation: c.explanation,
    }));

    await this.storeSession(params.userId, sessionId, params, candidates, now);

    // Step 5: Create tentative holds for candidates (if enabled)
    let holds: Hold[] = [];
    if (candidates.length > 0 && params.holdTimeoutMs !== 0) {
      holds = await this.createHolds(params, sessionId, candidates);
    }

    return {
      sessionId,
      status: candidates.length > 0 ? "candidates_ready" : "open",
      params,
      candidates,
      holds,
      createdAt: now,
    };
  }

  /**
   * Step 5a: Retrieve candidates for a session.
   */
  async getCandidates(userId: string, sessionId: string): Promise<SchedulingSession> {
    return this.getSession(userId, sessionId);
  }

  /**
   * Step 5b: Create tentative holds for candidates.
   *
   * For each candidate, creates a hold record and enqueues an UPSERT_MIRROR
   * message via the write-queue to create a tentative calendar event.
   * The tentative event appears as striped in Google Calendar UI.
   *
   * @param params - Session parameters (includes timeout, calendar, accounts)
   * @param sessionId - The scheduling session ID
   * @param candidates - The candidate time slots from the solver
   * @returns Array of created hold records
   */
  async createHolds(
    params: SchedulingParams,
    sessionId: string,
    candidates: StoredCandidate[],
  ): Promise<Hold[]> {
    const holds: Hold[] = [];
    const writeMessages: HoldWriteMessage[] = [];

    // Default calendar: use primary calendar convention
    const calendarId = params.targetCalendarId ?? `primary_${params.requiredAccountIds[0]}`;

    for (const candidate of candidates) {
      // Create one hold per candidate per required account
      for (const accountId of params.requiredAccountIds) {
        const holdParams: CreateHoldParams = {
          sessionId,
          accountId,
          candidateStart: candidate.start,
          candidateEnd: candidate.end,
          title: params.title,
          holdTimeoutMs: params.holdTimeoutMs ?? DEFAULT_HOLD_TIMEOUT_MS,
        };

        const hold = createHoldRecord(holdParams);
        holds.push(hold);

        // Build UPSERT_MIRROR message for tentative event creation
        const accountCalendarId = params.targetCalendarId ?? `primary_${accountId}`;
        const msg = buildHoldUpsertMessage(hold, holdParams, accountCalendarId);
        writeMessages.push(msg);
      }
    }

    // Store holds in UserGraphDO
    if (holds.length > 0) {
      await this.storeHolds(params.userId, holds);
    }

    // Enqueue write messages for tentative event creation
    if (writeMessages.length > 0) {
      await this.env.WRITE_QUEUE.sendBatch(
        writeMessages.map((msg) => ({ body: msg })),
      );
    }

    return holds;
  }

  /**
   * Step 6: Commit a candidate -- create canonical event + project mirrors.
   *
   * Creates a canonical event from the selected candidate, marks the session
   * as committed, releases all tentative holds (deleting their provider
   * events), and triggers mirror projection to all target accounts.
   */
  async commitCandidate(
    userId: string,
    sessionId: string,
    candidateId: string,
  ): Promise<{ eventId: string; session: SchedulingSession }> {
    // Get session and validate
    const session = await this.getSession(userId, sessionId);

    if (session.status === "committed") {
      throw new Error(`Session ${sessionId} is already committed`);
    }
    if (session.status === "cancelled" || session.status === "expired") {
      throw new Error(`Session ${sessionId} is ${session.status}`);
    }

    const candidate = session.candidates.find((c) => c.candidateId === candidateId);
    if (!candidate) {
      throw new Error(`Candidate ${candidateId} not found in session ${sessionId}`);
    }

    // Release all tentative holds for this session (delete provider events)
    await this.releaseSessionHolds(userId, sessionId);

    // Create canonical event from the candidate
    const eventId = generateId("event");
    const event: CanonicalEvent = {
      canonical_event_id: eventId as CanonicalEvent["canonical_event_id"],
      // Use the first required account as origin (the organizer)
      origin_account_id: (session.params.requiredAccountIds[0] ?? "internal") as CanonicalEvent["origin_account_id"],
      origin_event_id: `scheduled_${sessionId}`,
      title: session.params.title,
      start: { dateTime: candidate.start },
      end: { dateTime: candidate.end },
      all_day: false,
      status: "confirmed",
      visibility: "default",
      transparency: "opaque",
      source: "system",
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // Upsert via UserGraphDO (which also handles projection/mirroring)
    await this.upsertEvent(userId, event);

    // Mark session as committed
    await this.commitSession(userId, sessionId, candidateId, eventId);

    // Record scheduling outcome for fairness tracking (TM-82s.3)
    if (session.params.participantHashes && session.params.participantHashes.length > 0) {
      // The participant who got their preferred slot is determined by the
      // highest-scoring candidate being the one committed. For fairness,
      // we record the first participant as the one who "got preferred" since
      // the committed candidate presumably matched their preference best.
      // A more sophisticated approach would compare each participant's
      // individual preference, but for MVP this captures the outcome.
      const outcomes = recordSchedulingOutcome(
        sessionId,
        session.params.participantHashes,
        session.params.participantHashes[0], // organizer got their preferred time
        candidate.start,
      );
      await this.recordSchedulingHistory(userId, outcomes);
    }

    const updatedSession = await this.getSession(userId, sessionId);

    return { eventId, session: updatedSession };
  }

  /**
   * Cancel a session and release all tentative holds.
   *
   * Transitions session to 'cancelled' status and enqueues DELETE_MANAGED_MIRROR
   * messages for all held provider events.
   */
  async cancelSession(
    userId: string,
    sessionId: string,
  ): Promise<SchedulingSession> {
    // Release holds first (enqueue delete messages)
    await this.releaseSessionHolds(userId, sessionId);

    // Cancel the session via UserGraphDO
    const userGraphId = this.env.USER_GRAPH.idFromName(userId);
    const stub = this.env.USER_GRAPH.get(userGraphId);

    const response = await stub.fetch(
      new Request("https://user-graph.internal/cancelSchedulingSession", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`UserGraphDO.cancelSchedulingSession failed (${response.status}): ${body}`);
    }

    return this.getSession(userId, sessionId);
  }

  // -------------------------------------------------------------------------
  // VIP policy interactions
  // -------------------------------------------------------------------------

  /**
   * Fetch VIP policies from UserGraphDO and convert to VipOverrideConstraint
   * objects for the solver. Non-fatal: returns empty array on failure.
   */
  private async getVipOverrideConstraints(
    userId: string,
  ): Promise<VipOverrideConstraint[]> {
    try {
      const userGraphId = this.env.USER_GRAPH.idFromName(userId);
      const stub = this.env.USER_GRAPH.get(userGraphId);

      const response = await stub.fetch(
        new Request("https://user-graph.internal/listVipPolicies", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      );

      if (!response.ok) {
        // Non-fatal: VIP policies enhance scoring but are not required
        return [];
      }

      const { items } = (await response.json()) as {
        items: Array<{
          vip_id: string;
          participant_hash: string;
          display_name: string;
          priority_weight: number;
          conditions_json: {
            allow_after_hours?: boolean;
            min_notice_hours?: number;
            override_deep_work?: boolean;
          };
        }>;
      };

      return items.map((vip) => ({
        kind: "vip_override" as const,
        config: {
          participant_hash: vip.participant_hash,
          display_name: vip.display_name ?? "VIP",
          priority_weight: vip.priority_weight,
          allow_after_hours: vip.conditions_json.allow_after_hours ?? false,
          min_notice_hours: vip.conditions_json.min_notice_hours ?? 0,
          override_deep_work: vip.conditions_json.override_deep_work ?? false,
        },
      }));
    } catch {
      // Non-fatal: VIP policies enhance scoring but are not required
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Scheduling history for fairness scoring (TM-82s.3)
  // -------------------------------------------------------------------------

  /**
   * Fetch scheduling history for the given participants from UserGraphDO.
   * Non-fatal: returns empty array on failure.
   */
  private async getSchedulingHistory(
    userId: string,
    participantHashes: readonly string[],
  ): Promise<SchedulingHistoryEntry[]> {
    if (participantHashes.length === 0) return [];

    try {
      const userGraphId = this.env.USER_GRAPH.idFromName(userId);
      const stub = this.env.USER_GRAPH.get(userGraphId);

      const response = await stub.fetch(
        new Request("https://user-graph.internal/getSchedulingHistory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ participant_hashes: participantHashes }),
        }),
      );

      if (!response.ok) return [];

      const { history } = (await response.json()) as {
        history: SchedulingHistoryEntry[];
      };
      return history;
    } catch {
      // Non-fatal: scheduling history enhances fairness but is not required
      return [];
    }
  }

  /**
   * Record scheduling outcomes in UserGraphDO for fairness tracking.
   * Non-fatal: silently fails if the DO is unavailable.
   */
  private async recordSchedulingHistory(
    userId: string,
    outcomes: SchedulingOutcome[],
  ): Promise<void> {
    if (outcomes.length === 0) return;

    try {
      const userGraphId = this.env.USER_GRAPH.idFromName(userId);
      const stub = this.env.USER_GRAPH.get(userGraphId);

      await stub.fetch(
        new Request("https://user-graph.internal/recordSchedulingHistory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries: outcomes }),
        }),
      );
    } catch {
      // Non-fatal: recording history is best-effort
    }
  }

  // -------------------------------------------------------------------------
  // Solver execution with fallback (TM-82s.2)
  // -------------------------------------------------------------------------

  /**
   * Run the appropriate solver for the given input, with automatic fallback.
   *
   * Decision logic:
   * 1. If no external solver is configured, always use greedy solver.
   * 2. If external solver IS configured, use selectSolver() to decide.
   * 3. If external solver is selected but fails (timeout, error), fall back
   *    to greedy solver (log warning, do not throw).
   *
   * This ensures scheduling always produces results, even if the external
   * solver service is unavailable.
   */
  private async runSolverWithFallback(
    input: SolverInput,
    maxCandidates: number,
  ): Promise<SolverResult> {
    // If no external solver configured, always use greedy
    if (!this.externalSolver) {
      return this.solver.solve(input, maxCandidates);
    }

    // Determine which solver to use based on problem complexity
    const selection = selectSolver(input);

    if (selection === "greedy") {
      return this.solver.solve(input, maxCandidates);
    }

    // Try external solver with fallback to greedy
    try {
      return await this.externalSolver.solve(input, maxCandidates);
    } catch (err) {
      // External solver failed -- fall back to greedy solver
      // This is expected behavior when the external service is unavailable
      console.warn(
        `External solver failed, falling back to greedy: ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.solver.solve(input, maxCandidates);
    }
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  private validateParams(params: SchedulingParams): void {
    if (!params.userId) throw new Error("userId is required");
    if (!params.title || params.title.trim().length === 0) throw new Error("title is required");
    if (!params.durationMinutes || params.durationMinutes < 15 || params.durationMinutes > 480) {
      throw new Error("durationMinutes must be between 15 and 480");
    }
    if (!params.windowStart) throw new Error("windowStart is required");
    if (!params.windowEnd) throw new Error("windowEnd is required");
    if (new Date(params.windowStart) >= new Date(params.windowEnd)) {
      throw new Error("windowStart must be before windowEnd");
    }
    if (!params.requiredAccountIds || params.requiredAccountIds.length === 0) {
      throw new Error("At least one requiredAccountId is needed");
    }
  }

  // -------------------------------------------------------------------------
  // UserGraphDO interactions
  // -------------------------------------------------------------------------

  private async gatherAvailability(
    userId: string,
    start: string,
    end: string,
    accounts: string[],
  ): Promise<{ busy_intervals: BusyInterval[]; free_intervals: { start: string; end: string }[] }> {
    const userGraphId = this.env.USER_GRAPH.idFromName(userId);
    const stub = this.env.USER_GRAPH.get(userGraphId);

    const response = await stub.fetch(
      new Request("https://user-graph.internal/computeAvailability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start, end, accounts }),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`UserGraphDO.computeAvailability failed (${response.status}): ${body}`);
    }

    return response.json() as Promise<{
      busy_intervals: BusyInterval[];
      free_intervals: { start: string; end: string }[];
    }>;
  }

  /**
   * Fetch all active constraints from UserGraphDO and convert them to
   * SolverConstraint format. Uses the existing /listConstraints RPC and
   * filters to constraints relevant to the scheduling window.
   */
  private async getActiveConstraints(
    userId: string,
    windowStart: string,
    windowEnd: string,
  ): Promise<SolverConstraint[]> {
    const userGraphId = this.env.USER_GRAPH.idFromName(userId);
    const stub = this.env.USER_GRAPH.get(userGraphId);

    const response = await stub.fetch(
      new Request("https://user-graph.internal/listConstraints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    if (!response.ok) {
      // Non-fatal: constraints enhance scoring but are not required
      return [];
    }

    const { items } = (await response.json()) as {
      items: Array<{
        constraint_id: string;
        kind: string;
        config_json: Record<string, unknown>;
        active_from: string | null;
        active_to: string | null;
      }>;
    };

    return convertToSolverConstraints(items, windowStart, windowEnd);
  }

  private async storeSession(
    userId: string,
    sessionId: string,
    params: SchedulingParams,
    candidates: StoredCandidate[],
    createdAt: string,
  ): Promise<void> {
    const userGraphId = this.env.USER_GRAPH.idFromName(userId);
    const stub = this.env.USER_GRAPH.get(userGraphId);

    const response = await stub.fetch(
      new Request("https://user-graph.internal/storeSchedulingSession", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          status: candidates.length > 0 ? "candidates_ready" : "open",
          objective_json: JSON.stringify(params),
          candidates,
          created_at: createdAt,
        }),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`UserGraphDO.storeSchedulingSession failed (${response.status}): ${body}`);
    }
  }

  private async getSession(userId: string, sessionId: string): Promise<SchedulingSession> {
    const userGraphId = this.env.USER_GRAPH.idFromName(userId);
    const stub = this.env.USER_GRAPH.get(userGraphId);

    const response = await stub.fetch(
      new Request("https://user-graph.internal/getSchedulingSession", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`UserGraphDO.getSchedulingSession failed (${response.status}): ${body}`);
    }

    return response.json() as Promise<SchedulingSession>;
  }

  private async upsertEvent(userId: string, event: CanonicalEvent): Promise<void> {
    const userGraphId = this.env.USER_GRAPH.idFromName(userId);
    const stub = this.env.USER_GRAPH.get(userGraphId);

    const response = await stub.fetch(
      new Request("https://user-graph.internal/upsertCanonicalEvent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, source: "system" }),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`UserGraphDO.upsertCanonicalEvent failed (${response.status}): ${body}`);
    }
  }

  private async commitSession(
    userId: string,
    sessionId: string,
    candidateId: string,
    eventId: string,
  ): Promise<void> {
    const userGraphId = this.env.USER_GRAPH.idFromName(userId);
    const stub = this.env.USER_GRAPH.get(userGraphId);

    const response = await stub.fetch(
      new Request("https://user-graph.internal/commitSchedulingSession", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          candidate_id: candidateId,
          event_id: eventId,
        }),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`UserGraphDO.commitSchedulingSession failed (${response.status}): ${body}`);
    }
  }

  // -------------------------------------------------------------------------
  // Hold-related DO interactions
  // -------------------------------------------------------------------------

  /**
   * Store hold records in UserGraphDO's schedule_holds table.
   */
  private async storeHolds(userId: string, holds: Hold[]): Promise<void> {
    const userGraphId = this.env.USER_GRAPH.idFromName(userId);
    const stub = this.env.USER_GRAPH.get(userGraphId);

    const response = await stub.fetch(
      new Request("https://user-graph.internal/storeHolds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ holds }),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`UserGraphDO.storeHolds failed (${response.status}): ${body}`);
    }
  }

  /**
   * Get all holds for a session from UserGraphDO.
   */
  async getHoldsBySession(userId: string, sessionId: string): Promise<Hold[]> {
    const userGraphId = this.env.USER_GRAPH.idFromName(userId);
    const stub = this.env.USER_GRAPH.get(userGraphId);

    const response = await stub.fetch(
      new Request("https://user-graph.internal/getHoldsBySession", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`UserGraphDO.getHoldsBySession failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as { holds: Hold[] };
    return data.holds;
  }

  /**
   * Release all held holds for a session.
   * Enqueues DELETE_MANAGED_MIRROR messages for holds with provider events.
   */
  private async releaseSessionHolds(
    userId: string,
    sessionId: string,
  ): Promise<void> {
    // Get current holds to find provider events that need deletion
    const holds = await this.getHoldsBySession(userId, sessionId);
    const heldHolds = holds.filter((h) => h.status === "held");

    // Enqueue delete messages for holds that have provider events
    const deleteMessages = heldHolds
      .map((h) => buildHoldDeleteMessage(h))
      .filter((msg): msg is NonNullable<typeof msg> => msg !== null);

    if (deleteMessages.length > 0) {
      await this.env.WRITE_QUEUE.sendBatch(
        deleteMessages.map((msg) => ({ body: msg })),
      );
    }

    // Release holds in the DO
    const userGraphId = this.env.USER_GRAPH.idFromName(userId);
    const stub = this.env.USER_GRAPH.get(userGraphId);

    const response = await stub.fetch(
      new Request("https://user-graph.internal/releaseSessionHolds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`UserGraphDO.releaseSessionHolds failed (${response.status}): ${body}`);
    }
  }

  /**
   * Get expired holds from UserGraphDO (for cron cleanup).
   */
  async getExpiredHolds(userId: string): Promise<Hold[]> {
    const userGraphId = this.env.USER_GRAPH.idFromName(userId);
    const stub = this.env.USER_GRAPH.get(userGraphId);

    const response = await stub.fetch(
      new Request("https://user-graph.internal/getExpiredHolds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`UserGraphDO.getExpiredHolds failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as { holds: Hold[] };
    return data.holds;
  }
}

// ---------------------------------------------------------------------------
// Constraint conversion helpers
// ---------------------------------------------------------------------------

/** Raw constraint shape as returned by UserGraphDO.listConstraints. */
interface RawConstraint {
  readonly kind: string;
  readonly config_json: Record<string, unknown>;
  readonly active_from: string | null;
  readonly active_to: string | null;
}

/**
 * Convert raw UserGraphDO constraints to typed SolverConstraint objects.
 *
 * Filters trip constraints to those overlapping the scheduling window.
 * All other constraint kinds (working_hours, buffer, no_meetings_after)
 * are included unconditionally since they are time-of-day based.
 *
 * Exported for testing.
 */
export function convertToSolverConstraints(
  raw: readonly RawConstraint[],
  windowStart: string,
  windowEnd: string,
): SolverConstraint[] {
  const windowStartMs = new Date(windowStart).getTime();
  const windowEndMs = new Date(windowEnd).getTime();

  const results: SolverConstraint[] = [];

  for (const c of raw) {
    switch (c.kind) {
      case "working_hours": {
        const config = c.config_json as {
          days: number[];
          start_time: string;
          end_time: string;
          timezone: string;
        };
        results.push({
          kind: "working_hours",
          config: {
            days: config.days,
            start_time: config.start_time,
            end_time: config.end_time,
            timezone: config.timezone,
          },
        });
        break;
      }
      case "trip": {
        // Only include trips that overlap the scheduling window
        if (c.active_from && c.active_to) {
          const tripStart = new Date(c.active_from).getTime();
          const tripEnd = new Date(c.active_to).getTime();
          if (tripEnd > windowStartMs && tripStart < windowEndMs) {
            results.push({
              kind: "trip",
              activeFrom: c.active_from,
              activeTo: c.active_to,
            });
          }
        }
        break;
      }
      case "buffer": {
        const config = c.config_json as {
          type: "travel" | "prep" | "cooldown";
          minutes: number;
          applies_to: "all" | "external";
        };
        results.push({
          kind: "buffer",
          config: {
            type: config.type,
            minutes: config.minutes,
            applies_to: config.applies_to,
          },
        });
        break;
      }
      case "no_meetings_after": {
        const config = c.config_json as {
          time: string;
          timezone: string;
        };
        results.push({
          kind: "no_meetings_after",
          config: {
            time: config.time,
            timezone: config.timezone,
          },
        });
        break;
      }
      case "override": {
        // Override constraints exempt specific time windows from working hours enforcement.
        // They require slot_start/slot_end (or active_from/active_to) to define the window.
        const config = c.config_json as {
          reason: string;
          slot_start?: string;
          slot_end?: string;
          timezone?: string;
        };
        const slotStart = config.slot_start ?? c.active_from;
        const slotEnd = config.slot_end ?? c.active_to;
        if (slotStart && slotEnd) {
          results.push({
            kind: "override",
            config: {
              reason: config.reason ?? "manual override",
              slot_start: slotStart,
              slot_end: slotEnd,
              timezone: config.timezone ?? "UTC",
            },
          });
        }
        break;
      }
      // Skip unknown constraint kinds silently
    }
  }

  return results;
}
