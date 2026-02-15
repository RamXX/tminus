/**
 * Temporal Risk Scoring Engine -- pure computation functions for measuring
 * burnout risk, travel overload, and strategic drift.
 *
 * Produces a composite risk score (0-100) with actionable recommendations.
 *
 * All functions are pure (no I/O, no side effects).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Risk level classification. */
export type RiskLevel = "LOW" | "MODERATE" | "HIGH" | "CRITICAL";

/** A single day's cognitive load measurement. */
export interface CognitiveLoadHistoryEntry {
  /** Date in YYYY-MM-DD format. */
  readonly date: string;
  /** Cognitive load score 0-100 for that date. */
  readonly score: number;
}

/** Hours allocated to a work category. */
export interface CategoryAllocation {
  /** Work category (e.g. "engineering", "sales", "admin", "misc"). */
  readonly category: string;
  /** Hours spent in this category. */
  readonly hours: number;
}

/** Complete risk score result returned by the API. */
export interface RiskScoreResult {
  readonly burnout_risk: number;
  readonly travel_overload: number;
  readonly strategic_drift: number;
  readonly overall_risk: number;
  readonly risk_level: RiskLevel;
  readonly recommendations: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Risk level thresholds. */
export const RISK_LEVELS = {
  LOW: { min: 0, max: 30 },
  MODERATE: { min: 31, max: 60 },
  HIGH: { min: 61, max: 80 },
  CRITICAL: { min: 81, max: 100 },
} as const;

/**
 * Strategic work categories -- these represent high-value, goal-aligned work.
 * Non-strategic categories (admin, misc, personal) represent overhead.
 */
const STRATEGIC_CATEGORIES = new Set(["engineering", "sales", "client"]);

/**
 * Weights for composite risk score.
 * Burnout is weighted highest because it has the most immediate health impact.
 */
const WEIGHT_BURNOUT = 0.50;
const WEIGHT_TRAVEL = 0.25;
const WEIGHT_DRIFT = 0.25;

/** Cognitive load threshold above which a day counts as "high load". */
const HIGH_LOAD_THRESHOLD = 80;

/**
 * Number of consecutive high-load days that indicate burnout risk levels.
 * 7 days (1 week) = HIGH, 14 days (2 weeks) = CRITICAL.
 */
const BURNOUT_CRITICAL_DAYS = 14;
const BURNOUT_HIGH_DAYS = 7;

/**
 * Travel percentage thresholds for risk scaling.
 * 40% travel -> HIGH starts, 80% travel -> CRITICAL.
 */
const TRAVEL_HIGH_THRESHOLD = 0.40;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a numerical risk score into a risk level.
 *
 * @param score - Risk score 0-100 (clamped if outside range).
 * @returns One of LOW, MODERATE, HIGH, CRITICAL.
 */
export function getRiskLevel(score: number): RiskLevel {
  const clamped = Math.max(0, Math.min(100, score));
  if (clamped <= RISK_LEVELS.LOW.max) return "LOW";
  if (clamped <= RISK_LEVELS.MODERATE.max) return "MODERATE";
  if (clamped <= RISK_LEVELS.HIGH.max) return "HIGH";
  return "CRITICAL";
}

/**
 * Compute burnout risk from cognitive load history.
 *
 * Algorithm:
 * 1. Sort history by date (most recent last).
 * 2. Count the longest recent streak of high-load days (score > 80).
 * 3. Also compute a weighted average of recent scores (recency bias).
 * 4. Combine streak severity with average load.
 *
 * Sustained load >80 for 2+ weeks = CRITICAL (81-100).
 * Sustained load >80 for 1 week = HIGH (61-80).
 *
 * @param cognitiveLoadHistory - Array of daily cognitive load entries.
 * @returns Risk score 0-100.
 */
export function computeBurnoutRisk(
  cognitiveLoadHistory: readonly CognitiveLoadHistoryEntry[],
): number {
  if (cognitiveLoadHistory.length === 0) return 0;

  // Sort by date ascending
  const sorted = [...cognitiveLoadHistory].sort(
    (a, b) => a.date.localeCompare(b.date),
  );

  // Find the longest streak of consecutive high-load days from the most
  // recent end of the history. We scan from the end backwards.
  let recentStreak = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].score > HIGH_LOAD_THRESHOLD) {
      recentStreak++;
    } else {
      break;
    }
  }

  // Also compute the overall high-load day count in the recent window
  // (last 28 days maximum) and average score
  const recentWindow = sorted.slice(-28);
  const highLoadDays = recentWindow.filter(
    (e) => e.score > HIGH_LOAD_THRESHOLD,
  ).length;
  const avgScore =
    recentWindow.reduce((sum, e) => sum + e.score, 0) / recentWindow.length;

  // Streak-based component (dominant factor for sustained burnout detection)
  let streakComponent: number;
  if (recentStreak >= BURNOUT_CRITICAL_DAYS) {
    // 14+ consecutive days -> CRITICAL range (81-100)
    streakComponent = 85 + Math.min(15, (recentStreak - BURNOUT_CRITICAL_DAYS) * 2);
  } else if (recentStreak >= BURNOUT_HIGH_DAYS) {
    // 7-13 consecutive days -> HIGH range (61-80)
    const progress = (recentStreak - BURNOUT_HIGH_DAYS) / (BURNOUT_CRITICAL_DAYS - BURNOUT_HIGH_DAYS);
    streakComponent = 61 + progress * 19;
  } else if (recentStreak >= 3) {
    // 3-6 days -> MODERATE range (31-60)
    const progress = (recentStreak - 3) / 4;
    streakComponent = 31 + progress * 29;
  } else {
    // 0-2 days -> scale with high-load day density
    streakComponent = 0;
  }

  // Average-based component: general load level contributes to risk
  // even without sustained streaks (scattered high days still matter)
  const avgComponent = (avgScore / 100) * 40; // max 40 from averages

  // Density component: high-load days as fraction of window
  const densityComponent = (highLoadDays / Math.max(recentWindow.length, 1)) * 30;

  // Combine: streak dominates when present, otherwise average/density matter
  let risk: number;
  if (recentStreak >= BURNOUT_HIGH_DAYS) {
    // Sustained streak: streak component IS the score, with minor boost from
    // avg/density. The streak thresholds already map to the correct ranges.
    risk = streakComponent;
  } else if (streakComponent > 0) {
    // Short streak (3-6 days): blend streak with background load
    risk = streakComponent * 0.7 + avgComponent * 0.15 + densityComponent * 0.15;
  } else {
    // No meaningful streak: rely on average and density
    risk = avgComponent * 0.6 + densityComponent * 0.4;
  }

  return Math.round(Math.max(0, Math.min(100, risk)));
}

/**
 * Compute travel overload risk from trip days relative to working days.
 *
 * Travel percentage thresholds:
 * - 0-15%: LOW (0-30)
 * - 15-30%: MODERATE (31-60)
 * - 30-40%: HIGH (61-80)
 * - >40%: scales toward CRITICAL
 *
 * The formula uses a piecewise linear mapping that accelerates risk
 * as travel percentage increases, since travel fatigue compounds.
 *
 * @param tripDays - Number of days spent traveling.
 * @param workingDays - Total working days in the period.
 * @returns Risk score 0-100.
 */
export function computeTravelOverload(
  tripDays: number,
  workingDays: number,
): number {
  if (workingDays <= 0 || tripDays <= 0) return 0;

  const travelPct = Math.min(1, tripDays / workingDays);

  // Piecewise linear scaling with compounding effect:
  // 0-15%  -> 0-25    (low)
  // 15-30% -> 25-55   (moderate)
  // 30-50% -> 55-80   (high)
  // 50-80% -> 80-95   (critical)
  // 80-100%-> 95-100  (max critical)
  let risk: number;
  if (travelPct <= 0.15) {
    risk = (travelPct / 0.15) * 25;
  } else if (travelPct <= 0.30) {
    risk = 25 + ((travelPct - 0.15) / 0.15) * 30;
  } else if (travelPct <= 0.50) {
    risk = 55 + ((travelPct - 0.30) / 0.20) * 25;
  } else if (travelPct <= 0.80) {
    risk = 80 + ((travelPct - 0.50) / 0.30) * 15;
  } else {
    risk = 95 + ((travelPct - 0.80) / 0.20) * 5;
  }

  return Math.round(Math.max(0, Math.min(100, risk)));
}

/**
 * Compute strategic drift risk from allocation trends.
 *
 * Compares current time allocations against historical allocations to detect
 * when non-strategic categories (admin, misc, personal) are growing at the
 * expense of strategic categories (engineering, sales, client).
 *
 * @param currentAllocations - Current period's category allocations.
 * @param historicalAllocations - Historical (baseline) category allocations.
 * @returns Risk score 0-100.
 */
export function computeStrategicDrift(
  currentAllocations: readonly CategoryAllocation[],
  historicalAllocations: readonly CategoryAllocation[],
): number {
  if (currentAllocations.length === 0 && historicalAllocations.length === 0) {
    return 0;
  }

  // Build maps of category -> hours
  const currentMap = buildAllocationMap(currentAllocations);
  const historicalMap = buildAllocationMap(historicalAllocations);

  // Compute total hours for normalization
  const currentTotal = sumValues(currentMap);
  const historicalTotal = sumValues(historicalMap);

  if (currentTotal === 0 && historicalTotal === 0) return 0;

  // Compute strategic percentage in each period
  const currentStrategicPct = computeStrategicPct(currentMap, currentTotal);
  const historicalStrategicPct = computeStrategicPct(historicalMap, historicalTotal);

  // Compute non-strategic percentage in each period
  const currentNonStrategicPct = 1 - currentStrategicPct;
  const historicalNonStrategicPct = 1 - historicalStrategicPct;

  // Drift is measured by the increase in non-strategic percentage relative
  // to the historical baseline. If no change, there is no drift.
  const nonStrategicIncrease = Math.max(0, currentNonStrategicPct - historicalNonStrategicPct);

  // If there's no drift at all, return 0. Drift measures CHANGE, not absolute level.
  if (nonStrategicIncrease === 0) return 0;

  // Relative drift risk: how much did non-strategic grow?
  // A 30%+ shift from strategic to non-strategic would be extreme drift.
  // Scale: 10% shift -> ~27, 20% shift -> ~53, 30% shift -> 80
  const relativeDriftRisk = Math.min(80, (nonStrategicIncrease / 0.30) * 80);

  // Absolute non-strategic component: amplifies risk when current non-strategic
  // is already very high (drift into a bad state is worse than drift in a good state)
  const absoluteAmplifier = currentNonStrategicPct; // 0 to 1

  // Combine: relative drift scaled by absolute severity
  const risk = relativeDriftRisk * (0.7 + 0.3 * absoluteAmplifier);

  return Math.round(Math.max(0, Math.min(100, risk)));
}

/**
 * Compute overall risk as a weighted average of the three components.
 *
 * Weights: burnout 50%, travel 25%, drift 25%.
 * Burnout is weighted highest due to immediate health impact.
 *
 * @param burnout - Burnout risk score 0-100.
 * @param travel - Travel overload risk score 0-100.
 * @param drift - Strategic drift risk score 0-100.
 * @returns Composite risk score 0-100.
 */
export function computeOverallRisk(
  burnout: number,
  travel: number,
  drift: number,
): number {
  const raw =
    WEIGHT_BURNOUT * burnout +
    WEIGHT_TRAVEL * travel +
    WEIGHT_DRIFT * drift;
  return Math.round(Math.max(0, Math.min(100, raw)));
}

/**
 * Generate actionable recommendations based on risk levels.
 *
 * Only generates recommendations for components at MODERATE or above.
 * Higher risk levels produce more urgent recommendations.
 *
 * @param burnout - Burnout risk score 0-100.
 * @param travel - Travel overload risk score 0-100.
 * @param drift - Strategic drift risk score 0-100.
 * @returns Array of recommendation strings.
 */
export function generateRiskRecommendations(
  burnout: number,
  travel: number,
  drift: number,
): string[] {
  const recommendations: string[] = [];

  const burnoutLevel = getRiskLevel(burnout);
  const travelLevel = getRiskLevel(travel);
  const driftLevel = getRiskLevel(drift);

  // Burnout recommendations
  if (burnoutLevel === "CRITICAL") {
    recommendations.push(
      "Immediate action required: sustained high cognitive load detected for 2+ weeks. Cancel or delegate non-essential meetings this week.",
    );
    recommendations.push(
      "Schedule recovery time: block at least 2 half-days this week as protected deep work or rest periods to prevent burnout.",
    );
  } else if (burnoutLevel === "HIGH") {
    recommendations.push(
      "Burnout warning: cognitive load has been elevated for over a week. Consider reducing meeting density by 20% next week.",
    );
  } else if (burnoutLevel === "MODERATE") {
    recommendations.push(
      "Cognitive load is trending upward. Monitor your schedule and protect deep work blocks to prevent burnout escalation.",
    );
  }

  // Travel recommendations
  if (travelLevel === "CRITICAL") {
    recommendations.push(
      "Travel overload is critical: you are traveling more than 50% of working days. Consider converting some trips to virtual meetings.",
    );
  } else if (travelLevel === "HIGH") {
    recommendations.push(
      "Travel is consuming over 40% of your working days. Schedule buffer days between trips for recovery and focused work.",
    );
  } else if (travelLevel === "MODERATE") {
    recommendations.push(
      "Travel frequency is moderate. Consider batching nearby trips to reduce context-switching and travel fatigue.",
    );
  }

  // Strategic drift recommendations
  if (driftLevel === "CRITICAL") {
    recommendations.push(
      "Strategic drift is critical: admin and non-strategic work has overtaken your calendar. Audit recurring meetings and delegate administrative tasks.",
    );
    recommendations.push(
      "Reallocate at least 5 hours per week from admin/misc back to strategic categories (engineering, sales, client work).",
    );
  } else if (driftLevel === "HIGH") {
    recommendations.push(
      "Strategic drift detected: non-strategic categories (admin, misc) are growing. Review your time allocation and set weekly strategic work targets.",
    );
  } else if (driftLevel === "MODERATE") {
    recommendations.push(
      "Slight drift toward non-strategic work detected. Set a weekly time budget for admin tasks to keep strategic priorities on track.",
    );
  }

  return recommendations;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build a map from category name to total hours. */
function buildAllocationMap(
  allocations: readonly CategoryAllocation[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const alloc of allocations) {
    const current = map.get(alloc.category) ?? 0;
    map.set(alloc.category, current + alloc.hours);
  }
  return map;
}

/** Sum all values in a map. */
function sumValues(map: Map<string, number>): number {
  let total = 0;
  for (const v of map.values()) total += v;
  return total;
}

/** Compute the percentage of hours in strategic categories. */
function computeStrategicPct(
  map: Map<string, number>,
  total: number,
): number {
  if (total === 0) return 0.5; // Default to balanced when no data
  let strategicHours = 0;
  for (const [cat, hours] of map) {
    if (STRATEGIC_CATEGORIES.has(cat)) {
      strategicHours += hours;
    }
  }
  return strategicHours / total;
}
