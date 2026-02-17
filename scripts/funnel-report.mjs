#!/usr/bin/env node

/**
 * Weekly Funnel Conversion Report Generator (TM-zf91.6, AC#2).
 *
 * Generates a markdown report showing weekly conversion between funnel stages.
 * Can run against:
 *   1. Sample data (--sample) for dry-run / CI validation
 *   2. D1 database (--d1) when connected to Cloudflare (future)
 *
 * Usage:
 *   node scripts/funnel-report.mjs --sample         # Dry-run with sample data
 *   node scripts/funnel-report.mjs --sample --json   # JSON output
 *   node scripts/funnel-report.mjs --sample --weeks 4  # Last 4 weeks
 *
 * The report computes:
 *   - Weekly unique users per funnel stage
 *   - Stage-to-stage conversion rates
 *   - Week-over-week trends
 *   - Overall funnel efficiency (top to bottom)
 *
 * SQL queries are included for future D1 integration.
 *
 * @module funnel-report
 */

// ---------------------------------------------------------------------------
// Funnel stage definitions (mirrors packages/shared/src/funnel-events.ts)
// ---------------------------------------------------------------------------

const FUNNEL_STAGES = [
  "landing_cta_click",
  "signup_start",
  "first_provider_connect",
  "first_sync_complete",
  "first_insight_viewed",
];

const STAGE_LABELS = {
  landing_cta_click: "Landing CTA Click",
  signup_start: "Signup Start",
  first_provider_connect: "First Provider Connect",
  first_sync_complete: "First Sync Complete",
  first_insight_viewed: "First Insight Viewed",
};

// ---------------------------------------------------------------------------
// SQL queries for D1 integration (reference, not executed in --sample mode)
// ---------------------------------------------------------------------------

/**
 * SQL to create the funnel_events table in D1.
 * This is a reference DDL -- actual migration would go in migrations/.
 */
const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS funnel_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  stage      TEXT NOT NULL CHECK(stage IN (
    'landing_cta_click', 'signup_start', 'first_provider_connect',
    'first_sync_complete', 'first_insight_viewed'
  )),
  user_id    TEXT NOT NULL,
  session_id TEXT,
  timestamp  TEXT NOT NULL DEFAULT (datetime('now')),
  metadata   TEXT -- JSON blob
);

CREATE INDEX IF NOT EXISTS idx_funnel_stage_ts ON funnel_events(stage, timestamp);
CREATE INDEX IF NOT EXISTS idx_funnel_user ON funnel_events(user_id, stage);
`;

/**
 * SQL query: Weekly unique users per funnel stage.
 * Groups by ISO week and stage, counting distinct users.
 */
const WEEKLY_COUNTS_SQL = `
SELECT
  strftime('%Y-W%W', timestamp) AS week,
  stage,
  COUNT(DISTINCT user_id) AS unique_users
FROM funnel_events
WHERE timestamp >= date('now', '-' || ? || ' days')
GROUP BY week, stage
ORDER BY week ASC, CASE stage
  WHEN 'landing_cta_click' THEN 1
  WHEN 'signup_start' THEN 2
  WHEN 'first_provider_connect' THEN 3
  WHEN 'first_sync_complete' THEN 4
  WHEN 'first_insight_viewed' THEN 5
END;
`;

/**
 * SQL query: Stage-to-stage conversion for a specific week.
 */
const CONVERSION_SQL = `
WITH stage_users AS (
  SELECT stage, COUNT(DISTINCT user_id) AS cnt
  FROM funnel_events
  WHERE strftime('%Y-W%W', timestamp) = ?
  GROUP BY stage
)
SELECT
  a.stage AS from_stage,
  b.stage AS to_stage,
  a.cnt AS from_count,
  b.cnt AS to_count,
  ROUND(CAST(b.cnt AS REAL) / NULLIF(a.cnt, 0) * 100, 1) AS conversion_pct
FROM stage_users a
JOIN stage_users b ON (
  CASE a.stage
    WHEN 'landing_cta_click' THEN 'signup_start'
    WHEN 'signup_start' THEN 'first_provider_connect'
    WHEN 'first_provider_connect' THEN 'first_sync_complete'
    WHEN 'first_sync_complete' THEN 'first_insight_viewed'
  END = b.stage
)
ORDER BY CASE a.stage
  WHEN 'landing_cta_click' THEN 1
  WHEN 'signup_start' THEN 2
  WHEN 'first_provider_connect' THEN 3
  WHEN 'first_sync_complete' THEN 4
END;
`;

// ---------------------------------------------------------------------------
// Sample data generator
// ---------------------------------------------------------------------------

function generateSampleData(weeks = 4) {
  const data = [];
  const now = new Date();

  for (let w = weeks - 1; w >= 0; w--) {
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - w * 7);

    // Simulate growing traffic with some variance
    const baseTraffic = 80 + (weeks - w) * 20 + Math.floor(Math.random() * 30);

    // Conversion rates with slight weekly variance
    const rates = {
      landing_cta_click: 1.0,
      signup_start: 0.55 + Math.random() * 0.15,
      first_provider_connect: 0.40 + Math.random() * 0.15,
      first_sync_complete: 0.70 + Math.random() * 0.15,
      first_insight_viewed: 0.50 + Math.random() * 0.20,
    };

    let currentCount = baseTraffic;
    for (const stage of FUNNEL_STAGES) {
      const stageCount = Math.max(
        1,
        Math.round(currentCount * rates[stage]),
      );

      data.push({
        week: formatWeek(weekStart),
        stage,
        unique_users: stageCount,
      });

      currentCount = stageCount;
    }
  }

  return data;
}

function formatWeek(date) {
  const year = date.getFullYear();
  const start = new Date(year, 0, 1);
  const diff = date - start;
  const oneWeek = 604800000;
  const weekNum = Math.floor(diff / oneWeek);
  return `${year}-W${String(weekNum).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function computeConversions(weekData) {
  const conversions = [];
  for (let i = 0; i < weekData.length - 1; i++) {
    const from = weekData[i];
    const to = weekData[i + 1];
    const rate =
      from.unique_users > 0
        ? ((to.unique_users / from.unique_users) * 100).toFixed(1)
        : "0.0";
    conversions.push({
      from_stage: from.stage,
      to_stage: to.stage,
      from_count: from.unique_users,
      to_count: to.unique_users,
      conversion_pct: parseFloat(rate),
    });
  }
  return conversions;
}

function generateMarkdownReport(data, weeks) {
  const lines = [];
  lines.push("# T-Minus Weekly Funnel Conversion Report");
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Period:** Last ${weeks} weeks`);
  lines.push(`**Source:** ${process.argv.includes("--sample") ? "Sample data (dry-run)" : "Production D1"}`);
  lines.push("");

  // Group by week
  const byWeek = new Map();
  for (const row of data) {
    if (!byWeek.has(row.week)) byWeek.set(row.week, []);
    byWeek.get(row.week).push(row);
  }

  // Overall summary table
  lines.push("## Weekly Stage Counts");
  lines.push("");
  lines.push("| Week | CTA Click | Signup | Provider Connect | Sync Complete | Insight Viewed |");
  lines.push("|------|-----------|--------|------------------|---------------|----------------|");

  for (const [week, weekData] of byWeek) {
    const counts = {};
    for (const row of weekData) {
      counts[row.stage] = row.unique_users;
    }
    lines.push(
      `| ${week} | ${counts.landing_cta_click ?? 0} | ${counts.signup_start ?? 0} | ${counts.first_provider_connect ?? 0} | ${counts.first_sync_complete ?? 0} | ${counts.first_insight_viewed ?? 0} |`,
    );
  }

  lines.push("");

  // Per-week conversion rates
  lines.push("## Stage-to-Stage Conversion Rates");
  lines.push("");

  for (const [week, weekData] of byWeek) {
    lines.push(`### ${week}`);
    lines.push("");
    lines.push("| From | To | Users In | Users Out | Conversion |");
    lines.push("|------|----|----------|-----------|------------|");

    const conversions = computeConversions(weekData);
    for (const c of conversions) {
      const label = (s) => STAGE_LABELS[s] || s;
      lines.push(
        `| ${label(c.from_stage)} | ${label(c.to_stage)} | ${c.from_count} | ${c.to_count} | ${c.conversion_pct}% |`,
      );
    }

    // Overall funnel efficiency
    const topOfFunnel = weekData[0]?.unique_users ?? 0;
    const bottomOfFunnel = weekData[weekData.length - 1]?.unique_users ?? 0;
    const overall =
      topOfFunnel > 0
        ? ((bottomOfFunnel / topOfFunnel) * 100).toFixed(1)
        : "0.0";
    lines.push("");
    lines.push(`**Overall funnel efficiency:** ${overall}% (${topOfFunnel} -> ${bottomOfFunnel})`);
    lines.push("");
  }

  // Week-over-week trends
  const weekKeys = [...byWeek.keys()];
  if (weekKeys.length >= 2) {
    lines.push("## Week-over-Week Trends");
    lines.push("");
    lines.push("| Stage | Previous Week | Current Week | Change |");
    lines.push("|-------|---------------|--------------|--------|");

    const prevWeek = byWeek.get(weekKeys[weekKeys.length - 2]);
    const currWeek = byWeek.get(weekKeys[weekKeys.length - 1]);

    for (const stage of FUNNEL_STAGES) {
      const prev = prevWeek?.find((r) => r.stage === stage)?.unique_users ?? 0;
      const curr = currWeek?.find((r) => r.stage === stage)?.unique_users ?? 0;
      const change = prev > 0 ? (((curr - prev) / prev) * 100).toFixed(1) : "N/A";
      const arrow = curr > prev ? "^" : curr < prev ? "v" : "=";
      lines.push(
        `| ${STAGE_LABELS[stage]} | ${prev} | ${curr} | ${arrow} ${change}% |`,
      );
    }

    lines.push("");
  }

  // Decision rubric reference
  lines.push("## Decision Rubric");
  lines.push("");
  lines.push("See [docs/business/roadmap.md](../docs/business/roadmap.md#weekly-review-cadence--decision-rubric) for the weekly review cadence and prioritization triggers.");
  lines.push("");

  // SQL reference
  lines.push("## SQL Queries (D1 Reference)");
  lines.push("");
  lines.push("```sql");
  lines.push("-- Weekly unique users per stage");
  lines.push(WEEKLY_COUNTS_SQL.trim());
  lines.push("```");
  lines.push("");
  lines.push("```sql");
  lines.push("-- Stage-to-stage conversion");
  lines.push(CONVERSION_SQL.trim());
  lines.push("```");

  return lines.join("\n");
}

function generateJsonReport(data, weeks) {
  const byWeek = new Map();
  for (const row of data) {
    if (!byWeek.has(row.week)) byWeek.set(row.week, []);
    byWeek.get(row.week).push(row);
  }

  const report = {
    generated: new Date().toISOString(),
    period_weeks: weeks,
    source: process.argv.includes("--sample") ? "sample" : "d1",
    weeks: [],
  };

  for (const [week, weekData] of byWeek) {
    const conversions = computeConversions(weekData);
    const topOfFunnel = weekData[0]?.unique_users ?? 0;
    const bottomOfFunnel = weekData[weekData.length - 1]?.unique_users ?? 0;

    report.weeks.push({
      week,
      stages: Object.fromEntries(weekData.map((r) => [r.stage, r.unique_users])),
      conversions: conversions.map((c) => ({
        from: c.from_stage,
        to: c.to_stage,
        rate: c.conversion_pct,
      })),
      overall_efficiency:
        topOfFunnel > 0
          ? parseFloat(((bottomOfFunnel / topOfFunnel) * 100).toFixed(1))
          : 0,
    });
  }

  return JSON.stringify(report, null, 2);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    sample: args.includes("--sample"),
    json: args.includes("--json"),
    weeks: (() => {
      const idx = args.indexOf("--weeks");
      if (idx >= 0 && args[idx + 1]) return parseInt(args[idx + 1], 10);
      return 4;
    })(),
    help: args.includes("--help") || args.includes("-h"),
  };
}

function main() {
  const opts = parseArgs();

  if (opts.help) {
    console.log(`
T-Minus Funnel Report Generator

Usage:
  node scripts/funnel-report.mjs --sample         Generate with sample data
  node scripts/funnel-report.mjs --sample --json   JSON output
  node scripts/funnel-report.mjs --sample --weeks 8  Last 8 weeks

Options:
  --sample   Use generated sample data (no database required)
  --json     Output as JSON instead of markdown
  --weeks N  Number of weeks to include (default: 4)
  --help     Show this help message
`);
    process.exit(0);
  }

  if (!opts.sample) {
    console.error(
      "ERROR: Only --sample mode is currently supported. D1 integration requires a live database connection.",
    );
    process.exit(1);
  }

  const data = generateSampleData(opts.weeks);

  if (opts.json) {
    console.log(generateJsonReport(data, opts.weeks));
  } else {
    console.log(generateMarkdownReport(data, opts.weeks));
  }
}

main();
