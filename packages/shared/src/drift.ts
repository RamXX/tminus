/**
 * @tminus/shared -- Drift computation for relationship tracking.
 *
 * Pure functions for determining which relationships are overdue for
 * interaction based on their frequency targets and last interaction
 * timestamps.
 *
 * Drift = now - last_interaction_ts > interaction_frequency_target (in days).
 * Urgency is weighted by closeness_weight: higher weight = more urgent.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal relationship shape needed for drift computation. */
export interface DriftInput {
  readonly relationship_id: string;
  readonly participant_hash: string;
  readonly display_name: string | null;
  readonly category: string;
  readonly closeness_weight: number;
  /** ISO 8601 timestamp of last interaction, or null if never interacted. */
  readonly last_interaction_ts: string | null;
  /** Target interaction frequency in days. Null means no target set. */
  readonly interaction_frequency_target: number | null;
}

/** A relationship that is overdue for interaction. */
export interface DriftEntry {
  readonly relationship_id: string;
  readonly participant_hash: string;
  readonly display_name: string | null;
  readonly category: string;
  readonly closeness_weight: number;
  readonly last_interaction_ts: string | null;
  readonly interaction_frequency_target: number;
  /** Days since last interaction (or since epoch if never interacted). */
  readonly days_since_interaction: number;
  /** How many days overdue (days_since_interaction - target). */
  readonly days_overdue: number;
  /** Urgency score: days_overdue * closeness_weight. Higher = more urgent. */
  readonly urgency: number;
}

/** Full drift report for a user. */
export interface DriftReport {
  /** Relationships that are overdue, sorted by urgency descending. */
  readonly overdue: DriftEntry[];
  /** Total number of relationships with frequency targets. */
  readonly total_tracked: number;
  /** Number of relationships that are overdue. */
  readonly total_overdue: number;
  /** Timestamp used for computation. */
  readonly computed_at: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute drift for a set of relationships at a given point in time.
 *
 * Only relationships with a non-null interaction_frequency_target are
 * considered. Those without a target are excluded from drift tracking.
 *
 * @param relationships - All relationships for the user
 * @param now - Current timestamp (ISO 8601 or Date). Defaults to Date.now().
 * @returns A DriftReport with overdue relationships sorted by urgency.
 */
export function computeDrift(
  relationships: readonly DriftInput[],
  now?: string | Date,
): DriftReport {
  const currentTime = now
    ? typeof now === "string"
      ? new Date(now).getTime()
      : now.getTime()
    : Date.now();

  const computedAt = new Date(currentTime).toISOString();

  // Only track relationships that have a frequency target
  const tracked = relationships.filter(
    (r): r is DriftInput & { interaction_frequency_target: number } =>
      r.interaction_frequency_target !== null &&
      r.interaction_frequency_target > 0,
  );

  const overdue: DriftEntry[] = [];

  for (const rel of tracked) {
    const lastInteraction = rel.last_interaction_ts
      ? new Date(rel.last_interaction_ts).getTime()
      : 0; // epoch if never interacted

    const daysSince = Math.floor(
      (currentTime - lastInteraction) / MS_PER_DAY,
    );
    const daysOverdue = daysSince - rel.interaction_frequency_target;

    if (daysOverdue > 0) {
      overdue.push({
        relationship_id: rel.relationship_id,
        participant_hash: rel.participant_hash,
        display_name: rel.display_name,
        category: rel.category,
        closeness_weight: rel.closeness_weight,
        last_interaction_ts: rel.last_interaction_ts,
        interaction_frequency_target: rel.interaction_frequency_target,
        days_since_interaction: daysSince,
        days_overdue: daysOverdue,
        urgency: daysOverdue * rel.closeness_weight,
      });
    }
  }

  // Sort by urgency descending (most urgent first)
  overdue.sort((a, b) => b.urgency - a.urgency);

  return {
    overdue,
    total_tracked: tracked.length,
    total_overdue: overdue.length,
    computed_at: computedAt,
  };
}

/**
 * Detect which participant hashes from an event match known relationships.
 *
 * Given a set of participant_hashes from a calendar event and a list
 * of relationships, returns the matching relationship IDs.
 *
 * @param eventParticipantHashes - SHA-256 hashes of event attendee emails
 * @param relationships - All relationships with their participant_hashes
 * @returns Array of relationship_ids that match
 */
export function matchEventParticipants(
  eventParticipantHashes: readonly string[],
  relationships: ReadonlyArray<{
    readonly relationship_id: string;
    readonly participant_hash: string;
  }>,
): string[] {
  const hashSet = new Set(eventParticipantHashes);
  return relationships
    .filter((r) => hashSet.has(r.participant_hash))
    .map((r) => r.relationship_id);
}
