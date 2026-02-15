/**
 * Governance domain logic for the T-Minus SPA.
 *
 * Types and pure functions for commitment compliance tracking, VIP list
 * management, and time allocation aggregation. Used by the Governance
 * dashboard page and its tests.
 *
 * Compliance color coding:
 *   - compliant (within +/-10% of target): green
 *   - under target (>10% below): yellow
 *   - over target (>10% above): blue
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single commitment to a client with target and actual hours. */
export interface Commitment {
  commitment_id: string;
  client_name: string;
  target_hours: number;
  actual_hours: number;
  period_start: string;
  period_end: string;
}

/** A VIP contact entry. */
export interface VipContact {
  vip_id: string;
  name: string;
  email: string;
  notes: string;
  created_at: string;
}

/** Payload for adding a new VIP contact. */
export interface AddVipPayload {
  name: string;
  email: string;
  notes: string;
}

/** Response from export proof endpoint. */
export interface ExportProofResponse {
  download_url: string;
  filename: string;
  generated_at: string;
}

/** Time allocation entry for a given period. */
export interface TimeAllocation {
  client_name: string;
  hours: number;
}

/** Aggregated time allocation for a period (week or month). */
export interface TimeAllocationPeriod {
  period_label: string;
  period_start: string;
  period_end: string;
  allocations: TimeAllocation[];
  total_hours: number;
}

/** Chart data point for a single client's actual vs target. */
export interface ChartDataPoint {
  client_name: string;
  target_hours: number;
  actual_hours: number;
  compliance_status: ComplianceStatus;
}

/** Compliance status for color coding. */
export type ComplianceStatus = "compliant" | "under" | "over";

/** View mode for time allocation. */
export type AllocationViewMode = "weekly" | "monthly";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Color for compliant status (green). */
export const COLOR_COMPLIANT = "#22c55e";

/** Color for under-target status (yellow/amber). */
export const COLOR_UNDER = "#eab308";

/** Color for over-target status (blue). */
export const COLOR_OVER = "#3b82f6";

/** Background color for compliant status. */
export const BG_COMPLIANT = "#052e16";

/** Background color for under-target status. */
export const BG_UNDER = "#422006";

/** Background color for over-target status. */
export const BG_OVER = "#1e3a5f";

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Determine compliance status based on actual vs target hours.
 *
 * - compliant: actual is within +/-10% of target
 * - under: actual is more than 10% below target
 * - over: actual is more than 10% above target
 *
 * Edge case: if target is 0, any actual hours count as "over",
 * and 0 actual with 0 target is "compliant".
 */
export function complianceStatus(
  actual: number,
  target: number,
): ComplianceStatus {
  if (target === 0) {
    return actual === 0 ? "compliant" : "over";
  }
  const ratio = actual / target;
  if (ratio < 0.9) return "under";
  if (ratio > 1.1) return "over";
  return "compliant";
}

/**
 * Get the display color for a compliance status.
 */
export function complianceColor(status: ComplianceStatus): string {
  switch (status) {
    case "compliant":
      return COLOR_COMPLIANT;
    case "under":
      return COLOR_UNDER;
    case "over":
      return COLOR_OVER;
  }
}

/**
 * Get the background color for a compliance status.
 */
export function complianceBgColor(status: ComplianceStatus): string {
  switch (status) {
    case "compliant":
      return BG_COMPLIANT;
    case "under":
      return BG_UNDER;
    case "over":
      return BG_OVER;
  }
}

/**
 * Get human-readable label for compliance status.
 */
export function complianceLabel(status: ComplianceStatus): string {
  switch (status) {
    case "compliant":
      return "On Track";
    case "under":
      return "Under Target";
    case "over":
      return "Over Target";
  }
}

/**
 * Transform a list of commitments into chart data points.
 * Each commitment becomes a bar in the actual vs target chart.
 */
export function toChartData(commitments: Commitment[]): ChartDataPoint[] {
  return commitments.map((c) => ({
    client_name: c.client_name,
    target_hours: c.target_hours,
    actual_hours: c.actual_hours,
    compliance_status: complianceStatus(c.actual_hours, c.target_hours),
  }));
}

/**
 * Calculate the maximum hours value across all commitments,
 * used for scaling the chart bars. Returns at least 1 to avoid
 * division by zero.
 */
export function chartMaxHours(data: ChartDataPoint[]): number {
  let max = 0;
  for (const d of data) {
    if (d.target_hours > max) max = d.target_hours;
    if (d.actual_hours > max) max = d.actual_hours;
  }
  return Math.max(max, 1);
}

/**
 * Calculate the percentage width for a bar in the chart.
 * Returns a value between 0 and 100.
 */
export function barPercent(hours: number, maxHours: number): number {
  if (maxHours <= 0) return 0;
  return Math.min(100, Math.round((hours / maxHours) * 100));
}

/**
 * Aggregate time allocations into weekly or monthly periods.
 *
 * Takes a flat list of commitments and groups their hours by client.
 * For weekly view: groups by ISO week.
 * For monthly view: groups by calendar month.
 *
 * This is a simplified aggregation that assumes commitments
 * span a single reporting period. For the dashboard, we aggregate
 * all commitments into a single current-period summary.
 */
export function aggregateTimeAllocations(
  commitments: Commitment[],
  mode: AllocationViewMode,
): TimeAllocationPeriod[] {
  if (commitments.length === 0) return [];

  // Group commitments by period
  const periodMap = new Map<
    string,
    { label: string; start: string; end: string; allocations: Map<string, number> }
  >();

  for (const c of commitments) {
    const key = mode === "weekly"
      ? weekKey(c.period_start)
      : monthKey(c.period_start);
    const label = mode === "weekly"
      ? weekLabel(c.period_start)
      : monthLabel(c.period_start);

    if (!periodMap.has(key)) {
      periodMap.set(key, {
        label,
        start: c.period_start,
        end: c.period_end,
        allocations: new Map(),
      });
    }

    const period = periodMap.get(key)!;
    const existing = period.allocations.get(c.client_name) ?? 0;
    period.allocations.set(c.client_name, existing + c.actual_hours);
  }

  // Convert to output format
  const result: TimeAllocationPeriod[] = [];
  for (const [, period] of periodMap) {
    const allocations: TimeAllocation[] = [];
    let total = 0;
    for (const [client_name, hours] of period.allocations) {
      allocations.push({ client_name, hours });
      total += hours;
    }
    result.push({
      period_label: period.label,
      period_start: period.start,
      period_end: period.end,
      allocations,
      total_hours: total,
    });
  }

  return result;
}

/**
 * Format hours for display: "12.5h" or "0h".
 */
export function formatHours(hours: number): string {
  if (hours === 0) return "0h";
  // Show one decimal if not a whole number
  if (hours % 1 === 0) return `${hours}h`;
  return `${hours.toFixed(1)}h`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Get ISO week-based key for grouping: "2026-W07" */
function weekKey(isoDate: string): string {
  const d = new Date(isoDate);
  const year = d.getFullYear();
  const week = isoWeekNumber(d);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Human-readable week label: "Week 7, 2026" */
function weekLabel(isoDate: string): string {
  const d = new Date(isoDate);
  const year = d.getFullYear();
  const week = isoWeekNumber(d);
  return `Week ${week}, ${year}`;
}

/** Get month key: "2026-02" */
function monthKey(isoDate: string): string {
  const d = new Date(isoDate);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Human-readable month label: "Feb 2026" */
function monthLabel(isoDate: string): string {
  const d = new Date(isoDate);
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

/** Calculate ISO week number for a date. */
function isoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
