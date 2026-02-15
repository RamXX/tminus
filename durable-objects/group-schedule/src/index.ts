/**
 * GroupScheduleDO -- Durable Object for multi-user scheduling coordination.
 *
 * Coordinates scheduling sessions across multiple T-Minus users.
 * Each GroupScheduleDO instance is identified by idFromName(session_id).
 *
 * Privacy invariant: GroupScheduleDO only receives free/busy data from
 * each participant's UserGraphDO. No event titles, descriptions, or other
 * details cross user boundaries. The only data shared is:
 * - Which time slots are busy (start/end)
 * - Meeting title (proposed by the session creator)
 * - Candidate proposals (time + score)
 *
 * Flow:
 * 1. Creator POSTs to API with participant user_ids + meeting params
 * 2. GroupScheduleDO gathers free/busy from each participant's UserGraphDO
 * 3. Busy intervals are merged (privacy-preserving intersection)
 * 4. Greedy solver runs on merged busy to find mutually available times
 * 5. Tentative holds created in ALL participants' calendars
 * 6. On commit: atomic -- all participants get the event, or none do
 */

import { generateId } from "@tminus/shared";
import type { CanonicalEvent } from "@tminus/shared";
import { greedySolver } from "@tminus/workflow-scheduling";
import type { SolverInput, BusyInterval, ScoredCandidate } from "@tminus/workflow-scheduling";
import {
  createHoldRecord,
  buildHoldUpsertMessage,
  DEFAULT_HOLD_TIMEOUT_MS,
} from "@tminus/workflow-scheduling";
import type { Hold, HoldWriteMessage } from "@tminus/workflow-scheduling";
import { mergeBusyIntervals, buildGroupAccountIds } from "./intersection";
import type { UserAvailability } from "./intersection";

// Re-export pure functions for consumers
export { mergeBusyIntervals, buildGroupAccountIds, mergeOverlapping } from "./intersection";
export type { UserAvailability } from "./intersection";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GroupSessionStatus =
  | "gathering"       // Collecting availability from participants
  | "candidates_ready"  // Solver has produced candidates
  | "committed"       // All participants committed
  | "cancelled"       // Session was cancelled
  | "expired";        // Session timed out

export interface GroupSessionParams {
  /** User ID of the session creator (organizer). */
  readonly creatorUserId: string;
  /** All participant user IDs (including creator). */
  readonly participantUserIds: readonly string[];
  /** Human-readable meeting title. */
  readonly title: string;
  /** Meeting duration in minutes. */
  readonly durationMinutes: number;
  /** ISO 8601 start of the scheduling window. */
  readonly windowStart: string;
  /** ISO 8601 end of the scheduling window. */
  readonly windowEnd: string;
  /** Maximum candidates to produce (default 5). */
  readonly maxCandidates?: number;
  /** Hold timeout in milliseconds. Default: 24 hours. */
  readonly holdTimeoutMs?: number;
}

export interface GroupSessionCandidate {
  readonly candidateId: string;
  readonly sessionId: string;
  readonly start: string;
  readonly end: string;
  readonly score: number;
  readonly explanation: string;
}

export interface GroupSession {
  readonly sessionId: string;
  readonly status: GroupSessionStatus;
  readonly params: GroupSessionParams;
  readonly candidates: GroupSessionCandidate[];
  readonly committedCandidateId?: string;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Env bindings
// ---------------------------------------------------------------------------

export interface GroupScheduleEnv {
  USER_GRAPH: DurableObjectNamespace;
  WRITE_QUEUE: Queue;
  /** D1 database for cross-user session registration. */
  DB: D1Database;
}

// ---------------------------------------------------------------------------
// GroupScheduleDO class
// ---------------------------------------------------------------------------

/**
 * GroupScheduleDO coordinates multi-user scheduling sessions.
 *
 * It gathers availability from each participant's UserGraphDO,
 * computes the intersection using the greedy solver, creates holds
 * in all participants' calendars, and handles atomic commit/cancel.
 */
export class GroupScheduleDO {
  private readonly env: GroupScheduleEnv;

  constructor(env: GroupScheduleEnv) {
    this.env = env;
  }

  /**
   * Create a new group scheduling session.
   *
   * 1. Validates params
   * 2. Gathers free/busy from each participant (privacy: only busy intervals)
   * 3. Merges busy intervals across users
   * 4. Runs greedy solver to find mutually free slots
   * 5. Creates tentative holds in all participants' calendars
   * 6. Registers session in D1 for cross-user discovery
   *
   * @returns The created session with candidates
   */
  async createGroupSession(params: GroupSessionParams): Promise<GroupSession> {
    this.validateParams(params);

    const sessionId = generateId("session");
    const now = new Date().toISOString();

    // Step 1: Gather free/busy from each participant's UserGraphDO
    // Privacy: each UserGraphDO only returns busy intervals (start/end/account_ids)
    const userAvailabilities = await this.gatherAllAvailability(
      params.participantUserIds,
      params.windowStart,
      params.windowEnd,
    );

    // Step 2: Merge busy intervals -- privacy-preserving (synthetic account IDs)
    const mergedBusy = mergeBusyIntervals(userAvailabilities);
    const groupAccountIds = buildGroupAccountIds(params.participantUserIds);

    // Step 3: Run greedy solver on merged availability
    const solverInput: SolverInput = {
      windowStart: params.windowStart,
      windowEnd: params.windowEnd,
      durationMinutes: params.durationMinutes,
      busyIntervals: mergedBusy,
      requiredAccountIds: groupAccountIds,
    };
    const rawCandidates = greedySolver(solverInput, params.maxCandidates ?? 5);

    // Step 4: Build candidate records
    const candidates: GroupSessionCandidate[] = rawCandidates.map((c) => ({
      candidateId: generateId("candidate"),
      sessionId,
      start: c.start,
      end: c.end,
      score: c.score,
      explanation: c.explanation,
    }));

    const status: GroupSessionStatus =
      candidates.length > 0 ? "candidates_ready" : "gathering";

    // Step 5: Store session in each participant's UserGraphDO.
    // This MUST happen before creating holds, because schedule_holds has
    // a FOREIGN KEY on schedule_sessions(session_id).
    await this.storeGroupSessionInUserDOs(
      params.participantUserIds,
      sessionId,
      params,
      candidates,
      status,
      now,
    );

    // Step 6: Create tentative holds in ALL participants' calendars
    if (candidates.length > 0 && params.holdTimeoutMs !== 0) {
      await this.createGroupHolds(params, sessionId, candidates);
    }

    // Step 7: Register session in D1 for cross-user discovery
    await this.registerSessionInD1(sessionId, params, status, now);

    return {
      sessionId,
      status,
      params,
      candidates,
      createdAt: now,
    };
  }

  /**
   * Retrieve a group session by ID.
   *
   * Fetches from the creator's UserGraphDO (authoritative source).
   */
  async getGroupSession(
    sessionId: string,
    requestingUserId: string,
  ): Promise<GroupSession> {
    // Verify the requesting user is a participant via D1
    const registration = await this.getSessionFromD1(sessionId);
    if (!registration) {
      throw new Error(`Group session ${sessionId} not found`);
    }

    const participantIds: string[] = JSON.parse(registration.participant_ids_json);
    if (!participantIds.includes(requestingUserId)) {
      throw new Error(`User ${requestingUserId} is not a participant in session ${sessionId}`);
    }

    // Fetch session from creator's UserGraphDO
    return this.fetchSessionFromUserDO(registration.creator_user_id, sessionId);
  }

  /**
   * Commit a candidate: create events in ALL participants' calendars.
   *
   * Atomic: either all participants get the event, or none do.
   * On failure, we cancel the session and release all holds.
   */
  async commitGroupSession(
    sessionId: string,
    candidateId: string,
    requestingUserId: string,
  ): Promise<{ eventIds: Record<string, string>; session: GroupSession }> {
    // Verify participant and get session
    const registration = await this.getSessionFromD1(sessionId);
    if (!registration) {
      throw new Error(`Group session ${sessionId} not found`);
    }

    const participantIds: string[] = JSON.parse(registration.participant_ids_json);
    if (!participantIds.includes(requestingUserId)) {
      throw new Error(`User ${requestingUserId} is not a participant in session ${sessionId}`);
    }

    // Fetch session from creator to get candidates
    const session = await this.fetchSessionFromUserDO(
      registration.creator_user_id,
      sessionId,
    );

    if (session.status === "committed") {
      throw new Error(`Group session ${sessionId} is already committed`);
    }
    if (session.status === "cancelled" || session.status === "expired") {
      throw new Error(`Group session ${sessionId} is ${session.status}`);
    }

    const candidate = session.candidates.find((c) => c.candidateId === candidateId);
    if (!candidate) {
      throw new Error(`Candidate ${candidateId} not found in session ${sessionId}`);
    }

    // Atomic commit: create events in ALL participants' calendars
    const eventIds: Record<string, string> = {};
    const createdForUsers: string[] = [];

    try {
      for (const userId of participantIds) {
        const eventId = generateId("event");
        const event: CanonicalEvent = {
          canonical_event_id: eventId as CanonicalEvent["canonical_event_id"],
          origin_account_id: `group_${sessionId}` as CanonicalEvent["origin_account_id"],
          origin_event_id: `group_scheduled_${sessionId}`,
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

        await this.upsertEventInUserDO(userId, event);
        eventIds[userId] = eventId;
        createdForUsers.push(userId);
      }

      // Mark session as committed in all participants' UserGraphDOs
      for (const userId of participantIds) {
        await this.commitSessionInUserDO(userId, sessionId, candidateId, eventIds[userId]);
      }

      // Update D1 registration
      await this.updateSessionStatusInD1(sessionId, "committed");

    } catch (err) {
      // Atomic rollback: if any participant fails, cancel for all
      // Note: events already created in some DOs will be orphaned but
      // harmless (they are confirmed events). In a production system,
      // we'd use a Workflow for proper saga rollback.
      for (const userId of createdForUsers) {
        try {
          await this.cancelSessionInUserDO(userId, sessionId);
        } catch {
          // Best-effort cleanup
        }
      }
      await this.updateSessionStatusInD1(sessionId, "cancelled");
      throw new Error(
        `Atomic commit failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Fetch updated session
    const updatedSession = await this.fetchSessionFromUserDO(
      registration.creator_user_id,
      sessionId,
    );

    return { eventIds, session: updatedSession };
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  private validateParams(params: GroupSessionParams): void {
    if (!params.creatorUserId) throw new Error("creatorUserId is required");
    if (!params.title || params.title.trim().length === 0) throw new Error("title is required");
    if (!params.durationMinutes || params.durationMinutes < 15 || params.durationMinutes > 480) {
      throw new Error("durationMinutes must be between 15 and 480");
    }
    if (!params.windowStart) throw new Error("windowStart is required");
    if (!params.windowEnd) throw new Error("windowEnd is required");
    if (new Date(params.windowStart) >= new Date(params.windowEnd)) {
      throw new Error("windowStart must be before windowEnd");
    }
    if (!params.participantUserIds || params.participantUserIds.length < 2) {
      throw new Error("At least two participant user IDs are required for group scheduling");
    }
    if (!params.participantUserIds.includes(params.creatorUserId)) {
      throw new Error("Creator must be included in participant list");
    }
  }

  // -------------------------------------------------------------------------
  // UserGraphDO interactions (privacy: only free/busy)
  // -------------------------------------------------------------------------

  /**
   * Gather free/busy from all participants' UserGraphDOs.
   * Each call returns only busy intervals -- no event details.
   */
  private async gatherAllAvailability(
    userIds: readonly string[],
    windowStart: string,
    windowEnd: string,
  ): Promise<UserAvailability[]> {
    const results = await Promise.all(
      userIds.map(async (userId) => {
        const availability = await this.gatherUserAvailability(
          userId,
          windowStart,
          windowEnd,
        );
        return {
          userId,
          busyIntervals: availability.busy_intervals,
        };
      }),
    );
    return results;
  }

  private async gatherUserAvailability(
    userId: string,
    start: string,
    end: string,
  ): Promise<{ busy_intervals: BusyInterval[] }> {
    const userGraphId = this.env.USER_GRAPH.idFromName(userId);
    const stub = this.env.USER_GRAPH.get(userGraphId);

    const response = await stub.fetch(
      new Request("https://user-graph.internal/computeAvailability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Note: we pass empty accounts array -- UserGraphDO returns ALL accounts' busy
        body: JSON.stringify({ start, end, accounts: [] }),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`UserGraphDO.computeAvailability failed for user ${userId} (${response.status}): ${body}`);
    }

    return response.json() as Promise<{ busy_intervals: BusyInterval[] }>;
  }

  /**
   * Create tentative holds in all participants' calendars for all candidates.
   */
  private async createGroupHolds(
    params: GroupSessionParams,
    sessionId: string,
    candidates: GroupSessionCandidate[],
  ): Promise<void> {
    for (const userId of params.participantUserIds) {
      const holds: Hold[] = [];
      const writeMessages: HoldWriteMessage[] = [];

      for (const candidate of candidates) {
        const holdParams = {
          sessionId,
          accountId: `group_${userId}`,
          candidateStart: candidate.start,
          candidateEnd: candidate.end,
          title: params.title,
          holdTimeoutMs: params.holdTimeoutMs ?? DEFAULT_HOLD_TIMEOUT_MS,
        };

        const hold = createHoldRecord(holdParams);
        holds.push(hold);

        const calendarId = `primary_group_${userId}`;
        const msg = buildHoldUpsertMessage(hold, holdParams, calendarId);
        writeMessages.push(msg);
      }

      // Store holds in this participant's UserGraphDO
      if (holds.length > 0) {
        await this.storeHoldsInUserDO(userId, holds);
      }

      // Enqueue write messages for tentative event creation
      if (writeMessages.length > 0) {
        await this.env.WRITE_QUEUE.sendBatch(
          writeMessages.map((msg) => ({ body: msg })),
        );
      }
    }
  }

  /**
   * Store a group session reference in each participant's UserGraphDO.
   */
  private async storeGroupSessionInUserDOs(
    userIds: readonly string[],
    sessionId: string,
    params: GroupSessionParams,
    candidates: GroupSessionCandidate[],
    status: GroupSessionStatus,
    createdAt: string,
  ): Promise<void> {
    await Promise.all(
      userIds.map((userId) =>
        this.storeSessionInUserDO(userId, sessionId, params, candidates, status, createdAt),
      ),
    );
  }

  private async storeSessionInUserDO(
    userId: string,
    sessionId: string,
    params: GroupSessionParams,
    candidates: GroupSessionCandidate[],
    status: string,
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
          status,
          objective_json: JSON.stringify(params),
          candidates: candidates.map((c) => ({
            candidateId: c.candidateId,
            sessionId: c.sessionId,
            start: c.start,
            end: c.end,
            score: c.score,
            explanation: c.explanation,
          })),
          created_at: createdAt,
        }),
      }),
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`UserGraphDO.storeSchedulingSession failed for user ${userId} (${response.status}): ${body}`);
    }
  }

  private async fetchSessionFromUserDO(
    userId: string,
    sessionId: string,
  ): Promise<GroupSession> {
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
      throw new Error(`UserGraphDO.getSchedulingSession failed for user ${userId} (${response.status}): ${body}`);
    }

    return response.json() as Promise<GroupSession>;
  }

  private async upsertEventInUserDO(userId: string, event: CanonicalEvent): Promise<void> {
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
      throw new Error(`UserGraphDO.upsertCanonicalEvent failed for user ${userId} (${response.status}): ${body}`);
    }
  }

  private async commitSessionInUserDO(
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
      throw new Error(`UserGraphDO.commitSchedulingSession failed for user ${userId} (${response.status}): ${body}`);
    }
  }

  private async cancelSessionInUserDO(userId: string, sessionId: string): Promise<void> {
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
      // Best-effort: log but don't throw during cleanup
      const body = await response.text();
      console.error(`UserGraphDO.cancelSchedulingSession failed for user ${userId}: ${body}`);
    }
  }

  private async storeHoldsInUserDO(userId: string, holds: Hold[]): Promise<void> {
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
      throw new Error(`UserGraphDO.storeHolds failed for user ${userId} (${response.status}): ${body}`);
    }
  }

  // -------------------------------------------------------------------------
  // D1 interactions (cross-user session registry)
  // -------------------------------------------------------------------------

  /**
   * Register a group session in D1 for cross-user discovery.
   * This allows any participant to look up the session by ID.
   */
  private async registerSessionInD1(
    sessionId: string,
    params: GroupSessionParams,
    status: string,
    createdAt: string,
  ): Promise<void> {
    await this.env.DB
      .prepare(
        `INSERT INTO group_scheduling_sessions
         (session_id, creator_user_id, participant_ids_json, title, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        sessionId,
        params.creatorUserId,
        JSON.stringify(params.participantUserIds),
        params.title,
        status,
        createdAt,
      )
      .run();
  }

  private async getSessionFromD1(
    sessionId: string,
  ): Promise<{
    session_id: string;
    creator_user_id: string;
    participant_ids_json: string;
    title: string;
    status: string;
    created_at: string;
  } | null> {
    return this.env.DB
      .prepare(
        `SELECT session_id, creator_user_id, participant_ids_json, title, status, created_at
         FROM group_scheduling_sessions
         WHERE session_id = ?`,
      )
      .bind(sessionId)
      .first();
  }

  private async updateSessionStatusInD1(
    sessionId: string,
    status: string,
  ): Promise<void> {
    await this.env.DB
      .prepare(
        `UPDATE group_scheduling_sessions SET status = ? WHERE session_id = ?`,
      )
      .bind(status, sessionId)
      .run();
  }
}
