/**
 * Fairness and priority scoring for multi-party scheduling (TM-82s.3).
 *
 * Pure functions that compute fairness adjustments, VIP priority weights,
 * multi-factor candidate scores, and human-readable explanations.
 *
 * Scoring model:
 *   finalScore = (timePreferenceScore + constraintScore) * fairnessAdjustment * vipWeight
 *
 * Where:
 *   - timePreferenceScore: morning/afternoon/adjacency base score from solver
 *   - constraintScore: working hours, buffer, no-meetings-after bonuses/penalties
 *   - fairnessAdjustment: 0.5-1.5 multiplier from scheduling history
 *   - vipWeight: >= 1.0 from VIP policies (default 1.0)
 *
 * Fairness algorithm:
 *   For each participant, compute their "preference rate" = sessions_preferred / sessions_participated.
 *   The group average rate is calculated. A participant above average gets a penalty (adjustment < 1.0),
 *   one below average gets a boost (adjustment > 1.0). Bounded to [0.5, 1.5].
 *
 * No side effects. No database access. Designed for testability and Workers compatibility.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A row from the scheduling_history table. */
export interface SchedulingHistoryEntry {
  readonly participant_hash: string;
  /** Total sessions this participant was involved in. */
  readonly sessions_participated: number;
  /** Sessions where this participant got their preferred time. */
  readonly sessions_preferred: number;
  /** ISO 8601 timestamp of the most recent session. */
  readonly last_session_ts: string;
}

/** VIP policy data relevant to scoring. */
export interface VipPolicy {
  readonly participant_hash: string;
  readonly display_name: string;
  readonly priority_weight: number;
}

/** Input to the multi-factor scoring function. */
export interface MultiFactorInput {
  /** Base time-of-day preference score (from solver: morning/afternoon/adjacency). */
  readonly timePreferenceScore: number;
  /** Constraint-derived score delta (working hours, buffer, etc.). */
  readonly constraintScore: number;
  /** Fairness adjustment multiplier (0.5-1.5). */
  readonly fairnessAdjustment: number;
  /** VIP weight multiplier (>= 1.0). */
  readonly vipWeight: number;
}

/** Result of multi-factor scoring. */
export interface MultiFactorResult {
  readonly finalScore: number;
  readonly components: MultiFactorInput;
}

/** Context for fairness computation within a session. */
export interface FairnessContext {
  readonly history: readonly SchedulingHistoryEntry[];
  readonly participantHashes: readonly string[];
}

/** Components for building a human-readable explanation. */
export interface ScoreComponents {
  readonly timePreferenceScore: number;
  readonly constraintScore: number;
  readonly fairnessAdjustment: number;
  readonly vipWeight: number;
  readonly baseExplanation: string;
  readonly fairnessExplanation: string | null;
  readonly vipExplanation: string | null;
}

/** Result of recording a scheduling outcome. */
export interface SchedulingOutcome {
  readonly session_id: string;
  readonly participant_hash: string;
  readonly got_preferred: boolean;
  readonly scheduled_ts: string;
}

// ---------------------------------------------------------------------------
// Fairness bounds
// ---------------------------------------------------------------------------

/** Minimum fairness adjustment (50% of base score). */
const MIN_FAIRNESS_ADJUSTMENT = 0.5;

/** Maximum fairness adjustment (150% of base score). */
const MAX_FAIRNESS_ADJUSTMENT = 1.5;

// ---------------------------------------------------------------------------
// computeFairnessScore
// ---------------------------------------------------------------------------

/**
 * Compute a fairness adjustment multiplier for a specific participant
 * based on scheduling history.
 *
 * Algorithm:
 * 1. Compute each participant's "preference rate" = preferred / participated.
 * 2. Compute the group average preference rate.
 * 3. The target participant's deviation from average determines adjustment:
 *    - Above average (got preferred times too often): adjustment < 1.0
 *    - Below average (disadvantaged): adjustment > 1.0
 *    - At average: adjustment = 1.0
 * 4. Bounded to [MIN_FAIRNESS_ADJUSTMENT, MAX_FAIRNESS_ADJUSTMENT].
 *
 * @param history - Scheduling history entries for all participants in the group
 * @param targetParticipant - The participant hash to compute fairness for (optional)
 * @returns Adjustment multiplier and explanation
 */
export function computeFairnessScore(
  history: readonly SchedulingHistoryEntry[],
  targetParticipant?: string,
): { adjustment: number; explanation: string } {
  // No history -> no adjustment
  if (history.length === 0) {
    return { adjustment: 1.0, explanation: "no history: fairness neutral" };
  }

  // Single participant -> no fairness comparison needed
  if (history.length === 1) {
    return { adjustment: 1.0, explanation: "single participant: fairness neutral" };
  }

  // No target specified -> return neutral
  if (!targetParticipant) {
    return { adjustment: 1.0, explanation: "no target participant: fairness neutral" };
  }

  // Compute preference rates
  const rates: { hash: string; rate: number }[] = [];
  let totalRate = 0;
  let validCount = 0;

  for (const entry of history) {
    if (entry.sessions_participated === 0) {
      rates.push({ hash: entry.participant_hash, rate: 0 });
      continue;
    }
    const rate = entry.sessions_preferred / entry.sessions_participated;
    rates.push({ hash: entry.participant_hash, rate });
    totalRate += rate;
    validCount++;
  }

  // All participants have zero sessions -> no adjustment
  if (validCount === 0) {
    return { adjustment: 1.0, explanation: "no valid history: fairness neutral" };
  }

  const averageRate = totalRate / validCount;

  // Find the target participant's rate
  const targetRate = rates.find((r) => r.hash === targetParticipant);
  if (!targetRate) {
    return { adjustment: 1.0, explanation: "participant not in history: fairness neutral" };
  }

  // Compute deviation from average
  // Positive deviation (above average) -> penalty (adjustment < 1.0)
  // Negative deviation (below average) -> boost (adjustment > 1.0)
  const deviation = targetRate.rate - averageRate;

  // Scale deviation into adjustment: each 0.1 deviation changes adjustment by 0.1
  // deviation of +0.5 would give adjustment of 0.5 (max penalty)
  // deviation of -0.5 would give adjustment of 1.5 (max boost)
  const rawAdjustment = 1.0 - deviation;

  // Clamp to bounds
  const adjustment = Math.max(
    MIN_FAIRNESS_ADJUSTMENT,
    Math.min(MAX_FAIRNESS_ADJUSTMENT, rawAdjustment),
  );

  // Round to 2 decimal places for cleanliness
  const rounded = Math.round(adjustment * 100) / 100;

  if (rounded === 1.0) {
    return { adjustment: 1.0, explanation: "fairness: at group average" };
  }

  const direction = rounded < 1.0 ? "advantaged" : "disadvantaged";
  return {
    adjustment: rounded,
    explanation: `fairness: ${targetParticipant} ${direction} (${rounded}x)`,
  };
}

// ---------------------------------------------------------------------------
// applyVipWeight
// ---------------------------------------------------------------------------

/**
 * Determine the VIP weight multiplier for a set of participants.
 *
 * If any participant matches a VIP policy, the highest priority_weight
 * among matching policies is used. Non-matching participants get weight 1.0.
 *
 * @param policies - VIP policies configured by the user
 * @param participantHashes - Hashes of participants in the current meeting
 * @returns Weight multiplier and optional explanation
 */
export function applyVipWeight(
  policies: readonly VipPolicy[],
  participantHashes: readonly string[],
): { weight: number; explanation: string | null } {
  if (policies.length === 0 || participantHashes.length === 0) {
    return { weight: 1.0, explanation: null };
  }

  const participantSet = new Set(participantHashes);
  const matchingPolicies = policies.filter((p) =>
    participantSet.has(p.participant_hash),
  );

  if (matchingPolicies.length === 0) {
    return { weight: 1.0, explanation: null };
  }

  // Use highest priority weight
  const bestPolicy = matchingPolicies.reduce((best, current) =>
    current.priority_weight > best.priority_weight ? current : best,
  );

  return {
    weight: bestPolicy.priority_weight,
    explanation: `VIP priority: ${bestPolicy.display_name} (${bestPolicy.priority_weight}x)`,
  };
}

// ---------------------------------------------------------------------------
// computeMultiFactorScore
// ---------------------------------------------------------------------------

/**
 * Compute the final multi-factor score for a candidate time slot.
 *
 * Formula: (timePreferenceScore + constraintScore) * fairnessAdjustment * vipWeight
 *
 * This ensures:
 * - Base scoring (time preference + constraints) determines the slot quality
 * - Fairness adjusts for historical equity across participants
 * - VIP weight elevates priority for important participants
 *
 * @param input - All scoring factors
 * @returns Final score and component breakdown
 */
export function computeMultiFactorScore(input: MultiFactorInput): MultiFactorResult {
  const baseScore = input.timePreferenceScore + input.constraintScore;
  const finalScore = Math.round(baseScore * input.fairnessAdjustment * input.vipWeight);

  return {
    finalScore,
    components: { ...input },
  };
}

// ---------------------------------------------------------------------------
// buildExplanation
// ---------------------------------------------------------------------------

/**
 * Build a human-readable explanation string from score components.
 *
 * The explanation includes the base scoring reason (from the solver),
 * fairness adjustment info (if != 1.0), and VIP info (if weight > 1.0).
 *
 * @param components - All components contributing to the score
 * @returns Human-readable explanation string
 */
export function buildExplanation(components: ScoreComponents): string {
  const parts: string[] = [];

  // Base explanation always included
  if (components.baseExplanation) {
    parts.push(components.baseExplanation);
  }

  // Fairness explanation only when adjustment != 1.0
  if (components.fairnessAdjustment !== 1.0 && components.fairnessExplanation) {
    parts.push(components.fairnessExplanation);
  }

  // VIP explanation only when weight > 1.0
  if (components.vipWeight > 1.0 && components.vipExplanation) {
    parts.push(components.vipExplanation);
  }

  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// recordSchedulingOutcome
// ---------------------------------------------------------------------------

/**
 * Create scheduling outcome records for all participants after a session
 * is committed. These records are used to update the scheduling_history
 * table in UserGraphDO.
 *
 * @param sessionId - The committed scheduling session ID
 * @param participantHashes - All participant hashes in the meeting
 * @param preferredParticipant - Hash of participant who got their preferred time (or null)
 * @param scheduledTs - ISO 8601 timestamp of the scheduled meeting
 * @returns Array of outcome records to store
 */
export function recordSchedulingOutcome(
  sessionId: string,
  participantHashes: readonly string[],
  preferredParticipant: string | null,
  scheduledTs: string,
): SchedulingOutcome[] {
  return participantHashes.map((hash) => ({
    session_id: sessionId,
    participant_hash: hash,
    got_preferred: hash === preferredParticipant,
    scheduled_ts: scheduledTs,
  }));
}
