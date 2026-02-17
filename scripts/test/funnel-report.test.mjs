/**
 * Tests for the funnel report generator script (TM-zf91.6, AC#2).
 *
 * Validates:
 * - Markdown report generation with sample data
 * - JSON report generation with sample data
 * - Report structure and content correctness
 * - CLI argument handling
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";

const SCRIPT_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "funnel-report.mjs",
);

describe("funnel-report script", () => {
  // -----------------------------------------------------------------------
  // Markdown output
  // -----------------------------------------------------------------------
  describe("markdown output (--sample)", () => {
    it("generates a valid markdown report", () => {
      const output = execSync(`node ${SCRIPT_PATH} --sample`, {
        encoding: "utf8",
      });

      // Must contain the report title
      expect(output).toContain("# T-Minus Weekly Funnel Conversion Report");

      // Must contain the generated timestamp
      expect(output).toContain("**Generated:**");

      // Must contain period info
      expect(output).toContain("**Period:** Last 4 weeks");

      // Must contain stage count table
      expect(output).toContain("| Week | CTA Click | Signup | Provider Connect | Sync Complete | Insight Viewed |");

      // Must contain conversion rate tables
      expect(output).toContain("## Stage-to-Stage Conversion Rates");
      expect(output).toContain("| From | To | Users In | Users Out | Conversion |");

      // Must contain overall funnel efficiency
      expect(output).toContain("**Overall funnel efficiency:**");

      // Must contain week-over-week trends
      expect(output).toContain("## Week-over-Week Trends");

      // Must contain decision rubric reference
      expect(output).toContain("## Decision Rubric");
      expect(output).toContain("docs/business/roadmap.md");

      // Must contain SQL reference
      expect(output).toContain("## SQL Queries (D1 Reference)");
      expect(output).toContain("SELECT");
      expect(output).toContain("funnel_events");

      // Must indicate sample data source
      expect(output).toContain("Sample data (dry-run)");
    });

    it("respects --weeks parameter", () => {
      const output2 = execSync(`node ${SCRIPT_PATH} --sample --weeks 2`, {
        encoding: "utf8",
      });
      expect(output2).toContain("**Period:** Last 2 weeks");

      // 2 weeks should have fewer lines than 4 weeks
      const output4 = execSync(`node ${SCRIPT_PATH} --sample --weeks 4`, {
        encoding: "utf8",
      });
      expect(output4.length).toBeGreaterThan(output2.length);
    });
  });

  // -----------------------------------------------------------------------
  // JSON output
  // -----------------------------------------------------------------------
  describe("JSON output (--sample --json)", () => {
    it("generates valid JSON with expected structure", () => {
      const output = execSync(`node ${SCRIPT_PATH} --sample --json`, {
        encoding: "utf8",
      });

      const report = JSON.parse(output);

      // Top-level fields
      expect(report).toHaveProperty("generated");
      expect(report).toHaveProperty("period_weeks", 4);
      expect(report).toHaveProperty("source", "sample");
      expect(report).toHaveProperty("weeks");
      expect(report.weeks).toHaveLength(4);

      // Each week should have the expected structure
      for (const week of report.weeks) {
        expect(week).toHaveProperty("week");
        expect(week).toHaveProperty("stages");
        expect(week).toHaveProperty("conversions");
        expect(week).toHaveProperty("overall_efficiency");

        // Stages should have all 5 funnel stages
        expect(week.stages).toHaveProperty("landing_cta_click");
        expect(week.stages).toHaveProperty("signup_start");
        expect(week.stages).toHaveProperty("first_provider_connect");
        expect(week.stages).toHaveProperty("first_sync_complete");
        expect(week.stages).toHaveProperty("first_insight_viewed");

        // All stage counts should be positive integers
        for (const count of Object.values(week.stages)) {
          expect(count).toBeGreaterThanOrEqual(1);
          expect(Number.isInteger(count)).toBe(true);
        }

        // Conversions should have 4 transitions (5 stages - 1)
        expect(week.conversions).toHaveLength(4);

        for (const conv of week.conversions) {
          expect(conv).toHaveProperty("from");
          expect(conv).toHaveProperty("to");
          expect(conv).toHaveProperty("rate");
          expect(conv.rate).toBeGreaterThanOrEqual(0);
          expect(conv.rate).toBeLessThanOrEqual(100);
        }

        // Overall efficiency should be between 0 and 100
        expect(week.overall_efficiency).toBeGreaterThanOrEqual(0);
        expect(week.overall_efficiency).toBeLessThanOrEqual(100);
      }
    });

    it("respects --weeks parameter in JSON mode", () => {
      const output = execSync(`node ${SCRIPT_PATH} --sample --json --weeks 2`, {
        encoding: "utf8",
      });
      const report = JSON.parse(output);

      expect(report.period_weeks).toBe(2);
      expect(report.weeks).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // CLI error handling
  // -----------------------------------------------------------------------
  describe("CLI error handling", () => {
    it("fails without --sample flag", () => {
      try {
        execSync(`node ${SCRIPT_PATH}`, {
          encoding: "utf8",
          stdio: "pipe",
        });
        // Should not reach here
        expect.unreachable("Expected script to exit with error");
      } catch (err) {
        expect(err.stderr).toContain("Only --sample mode is currently supported");
      }
    });

    it("shows help with --help flag", () => {
      const output = execSync(`node ${SCRIPT_PATH} --help`, {
        encoding: "utf8",
      });
      expect(output).toContain("T-Minus Funnel Report Generator");
      expect(output).toContain("--sample");
      expect(output).toContain("--json");
      expect(output).toContain("--weeks");
    });
  });
});
