/**
 * Unit tests for collect-operational-metrics.mjs (TM-kzvn).
 *
 * Tests the pure logic functions used to collect, merge, and format
 * operational metrics for the public site proof section.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  collectTestCount,
  collectProviderCount,
  parseOverrides,
  mergeMetrics,
  buildMetricsPayload,
  formatTestCount,
  parseArgs,
  collectAll,
} from "../collect-operational-metrics.mjs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../..");

// ---------------------------------------------------------------------------
// collectTestCount
// ---------------------------------------------------------------------------

describe("collectTestCount", () => {
  it("counts non-empty lines from vitest list output", () => {
    const mockExec = vi.fn().mockReturnValue(
      "packages/shared/src/types.test.ts > validates AccountId\n" +
        "packages/shared/src/types.test.ts > validates EventId\n" +
        "packages/shared/src/schema.test.ts > creates table\n" +
        "\n"
    );
    const count = collectTestCount(mockExec, "/fake/root");
    expect(count).toBe(3);
    expect(mockExec).toHaveBeenCalledWith("npx vitest list 2>/dev/null", {
      cwd: "/fake/root",
      encoding: "utf-8",
    });
  });

  it("returns 0 when vitest list output is empty", () => {
    const mockExec = vi.fn().mockReturnValue("\n\n");
    expect(collectTestCount(mockExec, "/fake")).toBe(0);
  });

  it("falls back to file count when vitest list fails", () => {
    const mockExec = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("vitest not found");
      })
      .mockReturnValueOnce("  42\n");

    const count = collectTestCount(mockExec, "/fake");
    expect(count).toBe(42);
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it("returns 0 when both methods fail", () => {
    const mockExec = vi.fn().mockImplementation(() => {
      throw new Error("fail");
    });
    expect(collectTestCount(mockExec, "/fake")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// collectProviderCount
// ---------------------------------------------------------------------------

describe("collectProviderCount", () => {
  it("parses SUPPORTED_PROVIDERS from the real provider.ts file", () => {
    const result = collectProviderCount(PROJECT_ROOT);
    expect(result.count).toBeGreaterThanOrEqual(3);
    expect(result.providers).toContain("google");
    expect(result.providers).toContain("microsoft");
    expect(result.providers).toContain("caldav");
  });

  it("returns 0 for non-existent root", () => {
    const result = collectProviderCount("/nonexistent/path");
    expect(result.count).toBe(0);
    expect(result.providers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseOverrides
// ---------------------------------------------------------------------------

describe("parseOverrides", () => {
  const tmpDir = join(tmpdir(), "tminus-metrics-test-" + Date.now());

  // Create and clean up temp dir
  beforeAll(() => mkdirSync(tmpDir, { recursive: true }));
  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("returns empty object when path is null", () => {
    expect(parseOverrides(null)).toEqual({});
  });

  it("returns empty object when path is undefined", () => {
    expect(parseOverrides(undefined)).toEqual({});
  });

  it("returns empty object when file does not exist", () => {
    expect(parseOverrides("/nonexistent/file.json")).toEqual({});
  });

  it("parses valid JSON override file", () => {
    const path = join(tmpDir, "override.json");
    writeFileSync(
      path,
      JSON.stringify({ sync_reliability_pct: 99.9, test_count: 5000 })
    );
    const result = parseOverrides(path);
    expect(result.sync_reliability_pct).toBe(99.9);
    expect(result.test_count).toBe(5000);
  });

  it("returns empty object for invalid JSON", () => {
    const path = join(tmpDir, "bad.json");
    writeFileSync(path, "not valid json {{{}");
    expect(parseOverrides(path)).toEqual({});
  });

  it("returns empty object for JSON array", () => {
    const path = join(tmpDir, "array.json");
    writeFileSync(path, "[1, 2, 3]");
    expect(parseOverrides(path)).toEqual({});
  });

  it("returns empty object for JSON string", () => {
    const path = join(tmpDir, "string.json");
    writeFileSync(path, '"hello"');
    expect(parseOverrides(path)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// mergeMetrics
// ---------------------------------------------------------------------------

describe("mergeMetrics", () => {
  it("returns collected values when no overrides", () => {
    const collected = { test_count: 100, provider_count: 3 };
    expect(mergeMetrics(collected, {})).toEqual(collected);
  });

  it("overrides specific fields", () => {
    const collected = { test_count: 100, provider_count: 3 };
    const overrides = { test_count: 200 };
    expect(mergeMetrics(collected, overrides)).toEqual({
      test_count: 200,
      provider_count: 3,
    });
  });

  it("ignores null override values", () => {
    const collected = { test_count: 100 };
    expect(mergeMetrics(collected, { test_count: null })).toEqual({
      test_count: 100,
    });
  });

  it("ignores undefined override values", () => {
    const collected = { test_count: 100 };
    expect(mergeMetrics(collected, { test_count: undefined })).toEqual({
      test_count: 100,
    });
  });

  it("adds new fields from overrides", () => {
    const collected = { test_count: 100 };
    const overrides = { extra_metric: 42 };
    expect(mergeMetrics(collected, overrides)).toEqual({
      test_count: 100,
      extra_metric: 42,
    });
  });

  it("does not mutate the original collected object", () => {
    const collected = { test_count: 100 };
    const overrides = { test_count: 200 };
    mergeMetrics(collected, overrides);
    expect(collected.test_count).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// buildMetricsPayload
// ---------------------------------------------------------------------------

describe("buildMetricsPayload", () => {
  it("builds a complete payload with all required fields", () => {
    const payload = buildMetricsPayload({
      testCount: 4732,
      providerCount: 3,
      providers: ["google", "microsoft", "caldav"],
      syncLatencyP50Ms: 1200,
      syncLatencyP95Ms: 3800,
      syncReliabilityPct: 99.7,
    });

    expect(payload.test_count).toBe(4732);
    expect(payload.provider_count).toBe(3);
    expect(payload.providers).toEqual(["google", "microsoft", "caldav"]);
    expect(payload.sync_latency_p50_ms).toBe(1200);
    expect(payload.sync_latency_p95_ms).toBe(3800);
    expect(payload.sync_reliability_pct).toBe(99.7);
    expect(payload.collected_at).toBeTruthy();
    // Validate ISO 8601 format
    expect(new Date(payload.collected_at).toISOString()).toBe(
      payload.collected_at
    );
  });

  it("generates human-readable display values", () => {
    const payload = buildMetricsPayload({
      testCount: 4732,
      providerCount: 3,
      providers: ["google", "microsoft", "caldav"],
      syncLatencyP50Ms: 1200,
      syncLatencyP95Ms: 3800,
      syncReliabilityPct: 99.7,
    });

    expect(payload.display.sync_latency).toBe("<4s");
    expect(payload.display.sync_reliability).toBe("99.7%");
    expect(payload.display.provider_coverage).toBe("3");
    expect(payload.display.test_coverage).toBe("4,700+");
  });

  it("handles sub-1000 test counts in display", () => {
    const payload = buildMetricsPayload({
      testCount: 42,
      providerCount: 1,
      providers: ["google"],
      syncLatencyP50Ms: 500,
      syncLatencyP95Ms: 1500,
      syncReliabilityPct: 98.5,
    });

    expect(payload.display.test_coverage).toBe("42");
    expect(payload.display.sync_latency).toBe("<2s");
  });

  it("rounds latency display up to next whole second", () => {
    const payload = buildMetricsPayload({
      testCount: 100,
      providerCount: 1,
      providers: ["google"],
      syncLatencyP50Ms: 100,
      syncLatencyP95Ms: 4001, // 4.001s -> should display <5s
      syncReliabilityPct: 99.0,
    });

    expect(payload.display.sync_latency).toBe("<5s");
  });
});

// ---------------------------------------------------------------------------
// formatTestCount
// ---------------------------------------------------------------------------

describe("formatTestCount", () => {
  it("formats large numbers with comma and +", () => {
    expect(formatTestCount(4732)).toBe("4,700+");
  });

  it("formats exact thousands", () => {
    expect(formatTestCount(5000)).toBe("5,000+");
  });

  it("formats numbers under 1000 as-is", () => {
    expect(formatTestCount(42)).toBe("42");
    expect(formatTestCount(999)).toBe("999");
  });

  it("formats 1000 exactly", () => {
    expect(formatTestCount(1000)).toBe("1,000+");
  });

  it("handles zero", () => {
    expect(formatTestCount(0)).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("defaults to non-dry-run with standard output path", () => {
    const result = parseArgs(["node", "script.mjs"]);
    expect(result.dryRun).toBe(false);
    expect(result.overridePath).toBe(null);
    expect(result.outPath).toContain("site/metrics.json");
  });

  it("parses --dry-run flag", () => {
    const result = parseArgs(["node", "script.mjs", "--dry-run"]);
    expect(result.dryRun).toBe(true);
  });

  it("parses --override with path", () => {
    const result = parseArgs([
      "node",
      "script.mjs",
      "--override",
      "/tmp/o.json",
    ]);
    expect(result.overridePath).toBe("/tmp/o.json");
  });

  it("parses --out with path", () => {
    const result = parseArgs(["node", "script.mjs", "--out", "/tmp/out.json"]);
    expect(result.outPath).toBe("/tmp/out.json");
  });

  it("handles all flags combined", () => {
    const result = parseArgs([
      "node",
      "script.mjs",
      "--dry-run",
      "--override",
      "/tmp/o.json",
      "--out",
      "/tmp/out.json",
    ]);
    expect(result.dryRun).toBe(true);
    expect(result.overridePath).toBe("/tmp/o.json");
    expect(result.outPath).toBe("/tmp/out.json");
  });
});

// ---------------------------------------------------------------------------
// collectAll (integration of pure functions)
// ---------------------------------------------------------------------------

describe("collectAll", () => {
  it("collects metrics from mock sources and produces valid payload", () => {
    const mockExec = vi.fn().mockReturnValue(
      "test 1\ntest 2\ntest 3\n"
    );

    const payload = collectAll({
      execFn: mockExec,
      root: PROJECT_ROOT,
      overridePath: null,
    });

    // Should have all required fields
    expect(payload).toHaveProperty("test_count");
    expect(payload).toHaveProperty("provider_count");
    expect(payload).toHaveProperty("providers");
    expect(payload).toHaveProperty("sync_latency_p50_ms");
    expect(payload).toHaveProperty("sync_latency_p95_ms");
    expect(payload).toHaveProperty("sync_reliability_pct");
    expect(payload).toHaveProperty("collected_at");
    expect(payload).toHaveProperty("display");

    // Provider count should come from the real file
    expect(payload.provider_count).toBeGreaterThanOrEqual(3);
    expect(payload.providers).toContain("google");

    // Test count should come from mock (3 lines)
    expect(payload.test_count).toBe(3);

    // Display should be well-formed
    expect(payload.display.sync_latency).toMatch(/^<\d+s$/);
    expect(payload.display.sync_reliability).toMatch(/^\d+\.?\d*%$/);
    expect(payload.display.provider_coverage).toMatch(/^\d+$/);
  });

  it("applies overrides from file", () => {
    const tmpDir = join(tmpdir(), "tminus-collect-test-" + Date.now());
    mkdirSync(tmpDir, { recursive: true });
    const overridePath = join(tmpDir, "override.json");
    writeFileSync(
      overridePath,
      JSON.stringify({
        test_count: 9999,
        sync_reliability_pct: 99.99,
      })
    );

    const mockExec = vi.fn().mockReturnValue("t1\nt2\n");

    const payload = collectAll({
      execFn: mockExec,
      root: PROJECT_ROOT,
      overridePath,
    });

    expect(payload.test_count).toBe(9999);
    expect(payload.sync_reliability_pct).toBe(99.99);
    expect(payload.display.test_coverage).toBe("9,900+");
    expect(payload.display.sync_reliability).toBe("99.99%");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses default latency/reliability when no overrides provided", () => {
    const mockExec = vi.fn().mockReturnValue("");
    const payload = collectAll({
      execFn: mockExec,
      root: PROJECT_ROOT,
      overridePath: null,
    });

    expect(payload.sync_latency_p50_ms).toBe(1200);
    expect(payload.sync_latency_p95_ms).toBe(3800);
    expect(payload.sync_reliability_pct).toBe(99.7);
  });
});
