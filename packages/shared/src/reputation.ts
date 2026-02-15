/**
 * @tminus/shared -- Reputation scoring for relationship tracking.
 *
 * Pure functions for computing reliability and reciprocity scores from
 * interaction ledger data. All scores range 0.0-1.0 (1.0 = perfectly reliable).
 *
 * Decay formula: 0.95^(age_days / 30)
 *   - Recent interactions matter more than old ones.
 *   - ~50% weight at ~400 days old.
 *
 * Reliability: weighted average of outcome weights (with decay), then
 *   normalized from [-1, 1] to [0, 1].
 *
 * Reciprocity: compares "their" negative actions vs "my" negative actions.
 *   0.5 = balanced, > 0.5 = they cancel more, < 0.5 = I cancel more.
 *
 * Privacy: NFR-7 -- reputation data is private by default.
 * Never shared with other users.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal ledger entry shape needed for reputation computation. */
export interface LedgerInput {
  readonly outcome: string;
  readonly weight: number;
  readonly ts: string;
}

/** Full reputation result. */
export interface ReputationResult {
  /** Reliability score 0.0-1.0 (1.0 = perfectly reliable). */
  readonly reliability_score: number;
  /** Reciprocity score 0.0-1.0 (0.5 = balanced, >0.5 = they cancel more). */
  readonly reciprocity_score: number;
  /** Total number of interactions in the ledger. */
  readonly total_interactions: number;
  /** Number of interactions in the last 30 days. */
  readonly last_30_days: number;
  /** Timestamp used for computation (ISO 8601). */
  readonly computed_at: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Decay base per 30-day period. */
const DECAY_BASE = 0.95;

/** Decay period in days. */
const DECAY_PERIOD_DAYS = 30;

/** Default score when no data is available (neutral). */
const NEUTRAL_SCORE = 0.5;

/** Window for "recent" interactions. */
const RECENT_WINDOW_DAYS = 30;

/**
 * Outcomes where "they" did something negative (for reciprocity).
 * These count as "their" negative actions.
 */
const THEM_NEGATIVE_OUTCOMES = new Set([
  "CANCELED_BY_THEM",
  "NO_SHOW_THEM",
  "MOVED_LAST_MINUTE_THEM",
]);

/**
 * Outcomes where "I" did something negative (for reciprocity).
 * These count as "my" negative actions.
 */
const ME_NEGATIVE_OUTCOMES = new Set([
  "CANCELED_BY_ME",
  "NO_SHOW_ME",
  "MOVED_LAST_MINUTE_ME",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the decay factor for a given age in days.
 *
 * Formula: 0.95^(age_days / 30)
 *
 * @param ageDays - Age in days (0 = today)
 * @returns Decay factor in (0, 1], where 1.0 = no decay (today)
 */
export function computeDecayFactor(ageDays: number): number {
  return DECAY_BASE ** (ageDays / DECAY_PERIOD_DAYS);
}

/**
 * Compute reliability score from ledger entries.
 *
 * Algorithm:
 * 1. For each entry, compute: weight * decay_factor(age_days)
 * 2. Sum all weighted values, divide by sum of decay factors (weighted average)
 * 3. Normalize from [-1, 1] to [0, 1]: (avg + 1) / 2
 * 4. Clamp to [0, 1] and round to 2 decimal places
 *
 * Returns 0.5 (neutral) for empty ledger.
 *
 * @param entries - Ledger entries with outcome, weight, and timestamp
 * @param now - Current timestamp (ISO 8601 or Date). Defaults to Date.now().
 * @returns Reliability score 0.0-1.0
 */
export function computeReliabilityScore(
  entries: readonly LedgerInput[],
  now?: string | Date,
): number {
  if (entries.length === 0) return NEUTRAL_SCORE;

  const currentTime = resolveTimestamp(now);

  let weightedSum = 0;
  let decaySum = 0;

  for (const entry of entries) {
    const ageDays = computeAgeDays(entry.ts, currentTime);
    const decay = computeDecayFactor(ageDays);

    weightedSum += entry.weight * decay;
    decaySum += decay;
  }

  if (decaySum === 0) return NEUTRAL_SCORE;

  // Weighted average is in [-1, 1] range (matching weight range).
  // Normalize to [0, 1]: (avg + 1) / 2
  const weightedAvg = weightedSum / decaySum;
  const normalized = (weightedAvg + 1) / 2;

  return roundAndClamp(normalized);
}

/**
 * Compute reciprocity score from ledger entries.
 *
 * Compares "their" negative actions (cancel/no-show/move by them) against
 * "my" negative actions (cancel/no-show/move by me).
 *
 * Algorithm:
 * 1. Count negative actions by each party
 * 2. If neither has negative actions, return 0.5 (balanced)
 * 3. Reciprocity = their_count / (their_count + my_count)
 *    - 0.5 = balanced
 *    - > 0.5 = they cancel more (they are less reliable)
 *    - < 0.5 = I cancel more (I am less reliable)
 *
 * @param entries - Ledger entries
 * @returns Reciprocity score 0.0-1.0 (0.5 = balanced)
 */
export function computeReciprocityScore(
  entries: readonly LedgerInput[],
): number {
  if (entries.length === 0) return NEUTRAL_SCORE;

  let themCount = 0;
  let meCount = 0;

  for (const entry of entries) {
    if (THEM_NEGATIVE_OUTCOMES.has(entry.outcome)) {
      themCount++;
    } else if (ME_NEGATIVE_OUTCOMES.has(entry.outcome)) {
      meCount++;
    }
  }

  const total = themCount + meCount;
  if (total === 0) return NEUTRAL_SCORE;

  const score = themCount / total;
  return roundAndClamp(score);
}

/**
 * Compute full reputation for a relationship from ledger entries.
 *
 * Combines reliability score, reciprocity score, interaction count,
 * and recent interaction count into a single result.
 *
 * @param entries - All ledger entries for the relationship
 * @param now - Current timestamp (ISO 8601 or Date). Defaults to Date.now().
 * @returns Full reputation result
 */
export function computeReputation(
  entries: readonly LedgerInput[],
  now?: string | Date,
): ReputationResult {
  const currentTime = resolveTimestamp(now);
  const computedAt = new Date(currentTime).toISOString();

  const reliabilityScore = computeReliabilityScore(entries, now);
  const reciprocityScore = computeReciprocityScore(entries);

  const recentWindowMs = RECENT_WINDOW_DAYS * MS_PER_DAY;
  let last30Days = 0;
  for (const entry of entries) {
    const entryTime = new Date(entry.ts).getTime();
    if (currentTime - entryTime <= recentWindowMs) {
      last30Days++;
    }
  }

  return {
    reliability_score: reliabilityScore,
    reciprocity_score: reciprocityScore,
    total_interactions: entries.length,
    last_30_days: last30Days,
    computed_at: computedAt,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveTimestamp(now?: string | Date): number {
  if (!now) return Date.now();
  return typeof now === "string" ? new Date(now).getTime() : now.getTime();
}

function computeAgeDays(ts: string, currentTimeMs: number): number {
  const entryTime = new Date(ts).getTime();
  const diffMs = currentTimeMs - entryTime;
  return Math.max(0, diffMs / MS_PER_DAY);
}

function roundAndClamp(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return Math.round(clamped * 100) / 100;
}
