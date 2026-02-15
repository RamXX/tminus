/**
 * Tentative holds state machine and lifecycle management (TM-946.3, TM-82s.4).
 *
 * When candidates are produced by the greedy solver, tentative holds are
 * created in target accounts as real Google Calendar events with status=
 * 'tentative'. These holds appear as striped in Google Calendar UI.
 *
 * Hold lifecycle:
 *   1. CREATE: Candidate -> tentative hold (status='held', provider event created)
 *   2. COMMIT: User picks candidate -> hold status='committed', event patched to confirmed
 *   3. CANCEL: User cancels -> hold status='released', provider event deleted
 *   4. EXPIRE: Hold timeout (default 24h) -> hold status='expired', provider event deleted
 *   5. EXTEND: Hold duration extended from current time (TM-82s.4)
 *
 * State transitions:
 *   held -> committed   (user confirms)
 *   held -> released    (user cancels)
 *   held -> expired     (timeout)
 *
 * Advanced lifecycle (TM-82s.4):
 *   - Configurable hold duration: 1h-72h (default 24h)
 *   - Expiry notification: isApproachingExpiry flag (1h before)
 *   - Hold extension: computeExtendedExpiry from current time
 *   - Conflict detection: detectHoldConflicts for new events
 *
 * Only 'held' status can transition. committed/released/expired are terminal states.
 */

import { generateId } from "@tminus/shared";
import type { AccountId, CalendarId, EventId, ProjectedEvent } from "@tminus/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Hold status in the schedule_holds table. */
export type HoldStatus = "held" | "committed" | "released" | "expired";

/** A tentative hold record as stored in the schedule_holds table. */
export interface Hold {
  readonly hold_id: string;
  readonly session_id: string;
  readonly account_id: string;
  readonly provider_event_id: string | null;
  readonly expires_at: string;
  readonly status: HoldStatus;
}

/** Parameters for creating a new hold. */
export interface CreateHoldParams {
  readonly sessionId: string;
  readonly accountId: string;
  readonly candidateStart: string;
  readonly candidateEnd: string;
  readonly title: string;
  /** Hold expiry in milliseconds from now. Default: 24 hours. */
  readonly holdTimeoutMs?: number;
}

/** Write-queue message for creating a tentative event. */
export interface HoldWriteMessage {
  readonly type: "UPSERT_MIRROR";
  readonly canonical_event_id: EventId;
  readonly target_account_id: AccountId;
  readonly target_calendar_id: CalendarId;
  readonly projected_payload: ProjectedEvent;
  readonly idempotency_key: string;
}

/** Write-queue message for deleting a hold event. */
export interface HoldDeleteMessage {
  readonly type: "DELETE_MIRROR";
  readonly canonical_event_id: EventId;
  readonly target_account_id: AccountId;
  readonly provider_event_id: string;
  readonly idempotency_key: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default hold timeout: 24 hours in milliseconds. */
export const DEFAULT_HOLD_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** Minimum hold timeout: 5 minutes (prevent accidental instant expiry). */
export const MIN_HOLD_TIMEOUT_MS = 5 * 60 * 1000;

// TM-82s.4: Configurable hold duration constants (in hours)
/** Minimum configurable hold duration: 1 hour. */
export const HOLD_DURATION_MIN_HOURS = 1;
/** Maximum configurable hold duration: 72 hours. */
export const HOLD_DURATION_MAX_HOURS = 72;
/** Default configurable hold duration: 24 hours. */
export const HOLD_DURATION_DEFAULT_HOURS = 24;
/** Threshold for "approaching expiry" notification: 1 hour in milliseconds. */
export const APPROACHING_EXPIRY_THRESHOLD_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// State machine: valid transitions
// ---------------------------------------------------------------------------

/**
 * Valid state transitions for holds.
 * Only 'held' status can transition; all others are terminal.
 */
const VALID_TRANSITIONS: Record<HoldStatus, readonly HoldStatus[]> = {
  held: ["committed", "released", "expired"],
  committed: [],
  released: [],
  expired: [],
};

/**
 * Check if a hold state transition is valid.
 *
 * @param from - Current hold status
 * @param to - Target hold status
 * @returns true if the transition is allowed
 */
export function isValidTransition(from: HoldStatus, to: HoldStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Attempt a hold state transition. Throws if invalid.
 *
 * @param from - Current hold status
 * @param to - Target hold status
 * @returns The new status
 * @throws Error if transition is not allowed
 */
export function transitionHold(from: HoldStatus, to: HoldStatus): HoldStatus {
  if (!isValidTransition(from, to)) {
    throw new Error(
      `Invalid hold transition: '${from}' -> '${to}'. Hold in '${from}' state cannot transition to '${to}'.`,
    );
  }
  return to;
}

// ---------------------------------------------------------------------------
// Hold creation helpers
// ---------------------------------------------------------------------------

/**
 * Create a Hold record for storage in schedule_holds.
 *
 * @param params - Hold creation parameters
 * @returns A Hold object ready for DB insertion
 */
export function createHoldRecord(params: CreateHoldParams): Hold {
  const timeoutMs = params.holdTimeoutMs ?? DEFAULT_HOLD_TIMEOUT_MS;

  if (timeoutMs < MIN_HOLD_TIMEOUT_MS) {
    throw new Error(
      `Hold timeout (${timeoutMs}ms) is below minimum (${MIN_HOLD_TIMEOUT_MS}ms)`,
    );
  }

  return {
    hold_id: generateId("hold"),
    session_id: params.sessionId,
    account_id: params.accountId,
    provider_event_id: null, // Set after write-queue creates the event
    expires_at: new Date(Date.now() + timeoutMs).toISOString(),
    status: "held",
  };
}

/**
 * Build a write-queue UPSERT_MIRROR message that creates a tentative event.
 *
 * The projected payload sets status='tentative' which Google Calendar
 * renders with a striped background.
 *
 * @param hold - The hold record
 * @param params - Candidate parameters (time, title)
 * @param calendarId - Target calendar ID for the hold
 * @returns Write-queue message ready to be sent
 */
export function buildHoldUpsertMessage(
  hold: Hold,
  params: CreateHoldParams,
  calendarId: string,
): HoldWriteMessage {
  // Use hold_id as the canonical_event_id for tentative events.
  // When committed, the real canonical event replaces this.
  const eventId = `hold_${hold.hold_id}` as EventId;

  const payload: ProjectedEvent = {
    summary: `[Hold] ${params.title}`,
    start: { dateTime: params.candidateStart },
    end: { dateTime: params.candidateEnd },
    transparency: "opaque",
    visibility: "default",
    extendedProperties: {
      private: {
        tminus: "true",
        managed: "true",
        canonical_event_id: eventId,
        origin_account_id: params.accountId,
      },
    },
  };

  return {
    type: "UPSERT_MIRROR",
    canonical_event_id: eventId,
    target_account_id: params.accountId as AccountId,
    target_calendar_id: calendarId as CalendarId,
    projected_payload: payload,
    idempotency_key: `hold_create_${hold.hold_id}`,
  };
}

/**
 * Build a write-queue DELETE_MIRROR message that removes a hold event.
 *
 * Used when a hold is cancelled, expired, or being replaced by a
 * committed event.
 *
 * @param hold - The hold record (must have provider_event_id set)
 * @returns Write-queue message, or null if no provider event to delete
 */
export function buildHoldDeleteMessage(
  hold: Hold,
): HoldDeleteMessage | null {
  if (!hold.provider_event_id) {
    return null;
  }

  return {
    type: "DELETE_MIRROR",
    canonical_event_id: `hold_${hold.hold_id}` as EventId,
    target_account_id: hold.account_id as AccountId,
    provider_event_id: hold.provider_event_id,
    idempotency_key: `hold_delete_${hold.hold_id}`,
  };
}

/**
 * Check if a hold has expired based on its expires_at timestamp.
 *
 * @param hold - The hold to check
 * @param now - Current time (ISO string or Date). Defaults to Date.now().
 * @returns true if the hold's expiry time has passed
 */
export function isHoldExpired(
  hold: Hold,
  now?: string | Date,
): boolean {
  const nowMs = now
    ? new Date(now).getTime()
    : Date.now();
  return new Date(hold.expires_at).getTime() <= nowMs;
}

/**
 * Filter holds to find those that are expired but still in 'held' status.
 * These need cleanup (delete provider event + update status to 'expired').
 *
 * @param holds - Array of holds to filter
 * @param now - Current time. Defaults to Date.now().
 * @returns Holds that need expiry cleanup
 */
export function findExpiredHolds(
  holds: readonly Hold[],
  now?: string | Date,
): Hold[] {
  return holds.filter(
    (h) => h.status === "held" && isHoldExpired(h, now),
  );
}

// ---------------------------------------------------------------------------
// TM-82s.4: Configurable hold duration
// ---------------------------------------------------------------------------

/**
 * Validate that a hold duration in hours is within the allowed range.
 *
 * @param hours - Desired hold duration in hours
 * @returns The validated duration (pass-through)
 * @throws Error if outside [HOLD_DURATION_MIN_HOURS, HOLD_DURATION_MAX_HOURS]
 */
export function validateHoldDurationHours(hours: number): number {
  if (hours < HOLD_DURATION_MIN_HOURS || hours > HOLD_DURATION_MAX_HOURS) {
    throw new Error(
      `Hold duration must be between ${HOLD_DURATION_MIN_HOURS} and ${HOLD_DURATION_MAX_HOURS} hours, got ${hours}`,
    );
  }
  return hours;
}

/**
 * Convert hold duration from hours to milliseconds.
 *
 * @param hours - Duration in hours
 * @returns Duration in milliseconds
 */
export function holdDurationHoursToMs(hours: number): number {
  return hours * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// TM-82s.4: Expiry notification (approaching expiry)
// ---------------------------------------------------------------------------

/**
 * Check if a hold is approaching its expiry time.
 *
 * Returns true when the hold is in 'held' status and the remaining time
 * before expiry is less than or equal to APPROACHING_EXPIRY_THRESHOLD_MS
 * (1 hour). This flag is surfaced in the session response for UI polling.
 *
 * @param hold - The hold to check
 * @param now - Current time (ISO string or Date). Defaults to Date.now().
 * @returns true if the hold is approaching expiry (within 1 hour)
 */
export function isApproachingExpiry(
  hold: Hold,
  now?: string | Date,
): boolean {
  // Only active (held) holds can approach expiry
  if (hold.status !== "held") return false;

  const nowMs = now ? new Date(now).getTime() : Date.now();
  const expiresMs = new Date(hold.expires_at).getTime();
  const remainingMs = expiresMs - nowMs;

  // Approaching if remaining time is at or below the threshold (including already expired)
  return remainingMs <= APPROACHING_EXPIRY_THRESHOLD_MS;
}

// ---------------------------------------------------------------------------
// TM-82s.4: Hold extension
// ---------------------------------------------------------------------------

/**
 * Compute the new expiry time when extending a hold.
 *
 * Extension adds the configured duration from the current time (not from
 * the existing expiry). This prevents accumulating tiny extensions.
 *
 * @param hold - The hold to extend (must be in 'held' status)
 * @param durationHours - Extension duration in hours (validated against range)
 * @param now - Current time (ISO string). Defaults to Date.now().
 * @returns New expires_at ISO string
 * @throws Error if hold is not in 'held' status or duration is out of range
 */
export function computeExtendedExpiry(
  hold: Hold,
  durationHours: number,
  now?: string,
): string {
  if (hold.status !== "held") {
    throw new Error(
      `Only holds in 'held' status can be extended. Current status: '${hold.status}'`,
    );
  }

  validateHoldDurationHours(durationHours);

  const nowMs = now ? new Date(now).getTime() : Date.now();
  const extensionMs = holdDurationHoursToMs(durationHours);

  return new Date(nowMs + extensionMs).toISOString();
}

// ---------------------------------------------------------------------------
// TM-82s.4: Conflict detection
// ---------------------------------------------------------------------------

/** Result of a hold conflict check. */
export interface HoldConflict {
  readonly hold_id: string;
  readonly session_id: string;
  readonly hold_start: string;
  readonly hold_end: string;
}

/**
 * Detect conflicts between a new event and active holds.
 *
 * A conflict exists when a new event's time range overlaps with the
 * candidate time range of an active (held) hold. Overlap is defined as
 * eventStart < holdEnd AND eventEnd > holdStart (exclusive boundaries
 * mean touching-but-not-overlapping is not a conflict).
 *
 * @param eventStart - Start of the new event (ISO string)
 * @param eventEnd - End of the new event (ISO string)
 * @param holds - Active holds to check against
 * @param candidateTimes - Maps hold_id -> {start, end} of the candidate time slot.
 *   The Hold record itself does not store candidate times (only session_id and
 *   expires_at), so the caller must provide the time mapping from schedule_candidates.
 * @returns Array of conflicting holds with their time ranges
 */
export function detectHoldConflicts(
  eventStart: string,
  eventEnd: string,
  holds: readonly Hold[],
  candidateTimes: Record<string, { start: string; end: string }>,
): HoldConflict[] {
  const eventStartMs = new Date(eventStart).getTime();
  const eventEndMs = new Date(eventEnd).getTime();

  const conflicts: HoldConflict[] = [];

  for (const hold of holds) {
    // Only check active holds
    if (hold.status !== "held") continue;

    // Look up the candidate time for this hold
    const times = candidateTimes[hold.hold_id];
    if (!times) continue;

    const holdStartMs = new Date(times.start).getTime();
    const holdEndMs = new Date(times.end).getTime();

    // Overlap check: eventStart < holdEnd AND eventEnd > holdStart
    if (eventStartMs < holdEndMs && eventEndMs > holdStartMs) {
      conflicts.push({
        hold_id: hold.hold_id,
        session_id: hold.session_id,
        hold_start: times.start,
        hold_end: times.end,
      });
    }
  }

  return conflicts;
}
