/**
 * Probabilistic Availability Modeling -- pure computation functions for
 * probability-weighted availability that accounts for event likelihood.
 *
 * Instead of binary free/busy, each time slot has a probability of being
 * free (0.0 to 1.0):
 *   - Confirmed events: 0.95 busy probability (not 1.0 because even confirmed
 *     events can get cancelled last minute)
 *   - Tentative events: 0.50 busy probability
 *   - Cancelled events: 0.0 busy probability
 *   - Transparent events: 0.0 busy probability (doesn't block time)
 *   - Recurring events with cancellation history: adjusted based on
 *     historical cancellation rate
 *
 * For overlapping events, busy probabilities are treated as independent.
 * P(slot free) = product of (1 - P(event busy)) for all overlapping events.
 *
 * All functions are pure (no I/O, no side effects).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A simplified event representation for probability computation. */
export interface ProbabilisticEvent {
  /** Unique event identifier. */
  readonly event_id: string;
  /** ISO 8601 start datetime. */
  readonly start: string;
  /** ISO 8601 end datetime. */
  readonly end: string;
  /** Event status: confirmed, tentative, or cancelled. */
  readonly status: "confirmed" | "tentative" | "cancelled";
  /** Whether the event blocks time. */
  readonly transparency: "opaque" | "transparent";
  /** Recurrence rule string (present for recurring events). */
  readonly recurrence_rule?: string;
  /** Provider-specific event ID used to look up cancellation history. */
  readonly origin_event_id: string;
}

/** Cancellation history for a recurring event series. */
export interface CancellationHistoryEntry {
  /** Total number of occurrences tracked for this series. */
  readonly total_occurrences: number;
  /** Number of those occurrences that were cancelled. */
  readonly cancelled_occurrences: number;
}

/**
 * Map from origin_event_id to cancellation history.
 * Only populated for recurring events.
 */
export type CancellationHistory = Record<string, CancellationHistoryEntry>;

/** A single time slot with its probability of being free. */
export interface ProbabilisticSlot {
  /** ISO 8601 start datetime. */
  readonly start: string;
  /** ISO 8601 end datetime. */
  readonly end: string;
  /** Probability that this slot is free (0.0 = certainly busy, 1.0 = certainly free). */
  readonly probability: number;
}

/** Result of probabilistic availability computation. */
export interface ProbabilisticAvailabilityResult {
  readonly slots: ProbabilisticSlot[];
}

/** Input for the main computeProbabilisticAvailability function. */
export interface ProbabilisticAvailabilityInput {
  /** Events to consider for availability. */
  readonly events: readonly ProbabilisticEvent[];
  /** ISO 8601 start of the query range. */
  readonly start: string;
  /** ISO 8601 end of the query range. */
  readonly end: string;
  /** Slot granularity in minutes. Defaults to 30. */
  readonly granularity_minutes?: number;
  /** Cancellation history for recurring event series. */
  readonly cancellation_history?: CancellationHistory;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default probability that a confirmed event blocks its time slot. */
export const DEFAULT_CONFIRMED_BUSY_PROBABILITY = 0.95;

/** Default probability that a tentative event blocks its time slot. */
export const DEFAULT_TENTATIVE_BUSY_PROBABILITY = 0.50;

/** Default granularity in minutes when not specified. */
const DEFAULT_GRANULARITY_MINUTES = 30;

// ---------------------------------------------------------------------------
// Core computation functions
// ---------------------------------------------------------------------------

/**
 * Compute the busy probability of a single event.
 *
 * Base probability depends on status and transparency:
 *   - cancelled or transparent: 0.0
 *   - tentative: 0.50
 *   - confirmed: 0.95
 *
 * For recurring events with cancellation history, the base probability is
 * further reduced by the cancellation rate:
 *   adjusted = base * (1 - cancellation_rate)
 *
 * @param event - The event to evaluate.
 * @param cancellationHistory - Optional history for recurring series.
 * @returns Probability of this event making its time slot busy (0.0 to 1.0).
 */
export function computeEventBusyProbability(
  event: ProbabilisticEvent,
  cancellationHistory?: CancellationHistory,
): number {
  // Transparent events never block time
  if (event.transparency === "transparent") return 0.0;

  // Cancelled events never block time
  if (event.status === "cancelled") return 0.0;

  // Determine base probability from status
  let baseProbability: number;
  if (event.status === "tentative") {
    baseProbability = DEFAULT_TENTATIVE_BUSY_PROBABILITY;
  } else {
    baseProbability = DEFAULT_CONFIRMED_BUSY_PROBABILITY;
  }

  // Adjust for recurring event cancellation history
  if (
    event.recurrence_rule &&
    cancellationHistory &&
    event.origin_event_id in cancellationHistory
  ) {
    const entry = cancellationHistory[event.origin_event_id];
    if (entry.total_occurrences > 0) {
      const cancellationRate =
        entry.cancelled_occurrences / entry.total_occurrences;
      baseProbability = baseProbability * (1 - cancellationRate);
    }
  }

  return baseProbability;
}

/**
 * Compute the probability that a time slot is free, given the busy
 * probabilities of all events overlapping that slot.
 *
 * Events are treated as independent. The probability of a slot being free
 * is the product of (1 - P(busy)) for each overlapping event:
 *   P(free) = product((1 - p_i) for each event i)
 *
 * @param busyProbabilities - Array of busy probabilities from overlapping events.
 * @returns Probability that the slot is free (0.0 to 1.0).
 */
export function computeSlotFreeProbability(
  busyProbabilities: readonly number[],
): number {
  if (busyProbabilities.length === 0) return 1.0;

  let freeProbability = 1.0;
  for (const p of busyProbabilities) {
    freeProbability *= 1 - p;
  }
  return freeProbability;
}

/**
 * Compute probabilistic availability for a time range.
 *
 * Divides the time range into slots of the given granularity and computes
 * the probability of each slot being free based on overlapping events.
 *
 * @param input - Events, time range, granularity, and optional cancellation history.
 * @returns Array of time slots with free probabilities.
 */
export function computeProbabilisticAvailability(
  input: ProbabilisticAvailabilityInput,
): ProbabilisticAvailabilityResult {
  const {
    events,
    start,
    end,
    granularity_minutes = DEFAULT_GRANULARITY_MINUTES,
    cancellation_history,
  } = input;

  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const granularityMs = granularity_minutes * 60 * 1000;

  // Pre-compute busy probabilities and parsed timestamps for each event
  const parsedEvents = events.map((event) => ({
    startMs: new Date(event.start).getTime(),
    endMs: new Date(event.end).getTime(),
    busyProbability: computeEventBusyProbability(event, cancellation_history),
  }));

  // Generate time slots and compute free probability for each
  const slots: ProbabilisticSlot[] = [];
  let cursor = startMs;

  while (cursor < endMs) {
    const slotEnd = Math.min(cursor + granularityMs, endMs);

    // Find all events that overlap this slot.
    // An event overlaps if: event.start < slot.end AND event.end > slot.start
    const overlappingProbabilities: number[] = [];
    for (const pe of parsedEvents) {
      if (pe.startMs < slotEnd && pe.endMs > cursor && pe.busyProbability > 0) {
        overlappingProbabilities.push(pe.busyProbability);
      }
    }

    const freeProbability = computeSlotFreeProbability(overlappingProbabilities);

    slots.push({
      start: new Date(cursor).toISOString(),
      end: new Date(slotEnd).toISOString(),
      probability: Math.round(freeProbability * 1000) / 1000, // 3 decimal places
    });

    cursor = slotEnd;
  }

  return { slots };
}

/**
 * Compute the probability that ALL participants are free for a given slot.
 *
 * This is used by the scheduler to find the best time for a meeting with
 * multiple participants. Each participant's free probability is independent:
 *   P(all free) = product(P_i(free) for each participant i)
 *
 * @param participantFreeProbabilities - Free probability for each participant.
 * @returns Probability that all participants are free (0.0 to 1.0).
 */
export function computeMultiParticipantProbability(
  participantFreeProbabilities: readonly number[],
): number {
  if (participantFreeProbabilities.length === 0) return 1.0;

  let combinedProbability = 1.0;
  for (const p of participantFreeProbabilities) {
    combinedProbability *= p;
  }
  return combinedProbability;
}
