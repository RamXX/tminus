/**
 * Tests for deploy-config.mjs -- pure configuration and planning functions.
 *
 * These tests require NO Cloudflare credentials or network access.
 * They verify the correctness of env parsing, secret planning,
 * placeholder replacement, deploy planning, and CLI arg parsing.
 */

import { describe, it, expect } from "vitest";
import {
  parseEnvFile,
  buildSecretPlan,
  replacePlaceholderD1Id,
  buildDeployPlan,
  parseArgs,
  WORKER_DEPLOY_ORDER,
  REQUIRED_QUEUES,
  D1_DATABASE_NAME,
  SECRET_MAP,
} from "./deploy-config.mjs";

// ---------------------------------------------------------------------------
// parseEnvFile
// ---------------------------------------------------------------------------

describe("parseEnvFile", () => {
  it("parses simple KEY=VALUE lines", () => {
    const result = parseEnvFile("FOO=bar\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("parses export KEY=VALUE lines", () => {
    const result = parseEnvFile('export CLOUDFLARE_API_TOKEN="abc123"');
    expect(result).toEqual({ CLOUDFLARE_API_TOKEN: "abc123" });
  });

  it("strips double quotes around values", () => {
    const result = parseEnvFile('KEY="value with spaces"');
    expect(result).toEqual({ KEY: "value with spaces" });
  });

  it("strips single quotes around values", () => {
    const result = parseEnvFile("KEY='value'");
    expect(result).toEqual({ KEY: "value" });
  });

  it("skips blank lines and comments", () => {
    const content = [
      "# This is a comment",
      "",
      "KEY=value",
      "  # Another comment",
      "  ",
      "OTHER=val2",
    ].join("\n");
    expect(parseEnvFile(content)).toEqual({ KEY: "value", OTHER: "val2" });
  });

  it("handles values containing equals signs", () => {
    const result = parseEnvFile("KEY=abc=def=ghi");
    expect(result).toEqual({ KEY: "abc=def=ghi" });
  });

  it("returns empty object for empty string", () => {
    expect(parseEnvFile("")).toEqual({});
  });

  it("handles real .env format from tminus project", () => {
    const content = [
      'export CLOUDFLARE_API_TOKEN="LuEJ6pbRcx-M72GrvOBAqCz8BqHef6LgAGCMb9N8"',
      'export CLOUDFLARE_ACCOUNT_ID="fb309e69deee965ffee6a15fdc30ceb0"',
    ].join("\n");
    const result = parseEnvFile(content);
    expect(result.CLOUDFLARE_API_TOKEN).toBe(
      "LuEJ6pbRcx-M72GrvOBAqCz8BqHef6LgAGCMb9N8"
    );
    expect(result.CLOUDFLARE_ACCOUNT_ID).toBe(
      "fb309e69deee965ffee6a15fdc30ceb0"
    );
  });
});

// ---------------------------------------------------------------------------
// buildSecretPlan
// ---------------------------------------------------------------------------

describe("buildSecretPlan", () => {
  it("maps secrets to correct workers using default SECRET_MAP", () => {
    const envVars = {
      GOOGLE_CLIENT_ID: "gid",
      GOOGLE_CLIENT_SECRET: "gsecret",
      MASTER_KEY: "mk",
      JWT_SECRET: "jwts",
    };
    const plan = buildSecretPlan(envVars);

    // GOOGLE_CLIENT_ID -> api AND oauth (api hosts AccountDO for token refresh)
    const gcidEntries = plan.filter((p) => p.secretName === "GOOGLE_CLIENT_ID");
    expect(gcidEntries).toHaveLength(2);
    expect(gcidEntries.map((e) => e.workerName).sort()).toEqual([
      "tminus-api",
      "tminus-oauth",
    ]);

    // MASTER_KEY -> api AND oauth
    const mkEntries = plan.filter((p) => p.secretName === "MASTER_KEY");
    expect(mkEntries).toHaveLength(2);
    expect(mkEntries.map((e) => e.workerName).sort()).toEqual([
      "tminus-api",
      "tminus-oauth",
    ]);

    // JWT_SECRET -> api AND oauth
    const jwtEntries = plan.filter((p) => p.secretName === "JWT_SECRET");
    expect(jwtEntries).toHaveLength(2);
    expect(jwtEntries.map((e) => e.workerName).sort()).toEqual([
      "tminus-api",
      "tminus-oauth",
    ]);
  });

  it("skips secrets not present in env vars", () => {
    const plan = buildSecretPlan({ MASTER_KEY: "mk" });
    expect(plan).toEqual([
      { secretName: "MASTER_KEY", workerName: "tminus-api", value: "mk" },
      { secretName: "MASTER_KEY", workerName: "tminus-oauth", value: "mk" },
    ]);
  });

  it("returns empty plan when no matching env vars", () => {
    const plan = buildSecretPlan({ UNRELATED: "val" });
    expect(plan).toEqual([]);
  });

  it("uses same value for shared secrets across workers", () => {
    const envVars = { JWT_SECRET: "same-jwt-value" };
    const plan = buildSecretPlan(envVars);
    const values = plan.map((p) => p.value);
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toBe("same-jwt-value");
  });

  it("accepts a custom secret map", () => {
    const customMap = { MY_SECRET: ["api", "cron"] };
    const plan = buildSecretPlan({ MY_SECRET: "val" }, customMap);
    expect(plan).toEqual([
      { secretName: "MY_SECRET", workerName: "tminus-api", value: "val" },
      { secretName: "MY_SECRET", workerName: "tminus-cron", value: "val" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// replacePlaceholderD1Id
// ---------------------------------------------------------------------------

describe("replacePlaceholderD1Id", () => {
  it("replaces placeholder-d1-id with real ID", () => {
    const toml = 'database_id = "placeholder-d1-id"';
    const result = replacePlaceholderD1Id(toml, "real-abc-123");
    expect(result).toBe('database_id = "real-abc-123"');
  });

  it("replaces all occurrences", () => {
    const toml = [
      'database_id = "placeholder-d1-id"',
      "# other stuff",
      'database_id = "placeholder-d1-id"',
    ].join("\n");
    const result = replacePlaceholderD1Id(toml, "id-xyz");
    expect(result).not.toContain("placeholder-d1-id");
    expect(result.match(/id-xyz/g)).toHaveLength(2);
  });

  it("returns content unchanged if no placeholder present", () => {
    const toml = 'database_id = "already-set"';
    const result = replacePlaceholderD1Id(toml, "new-id");
    expect(result).toBe(toml);
  });
});

// ---------------------------------------------------------------------------
// buildDeployPlan
// ---------------------------------------------------------------------------

describe("buildDeployPlan", () => {
  it("includes D1 creation when d1Exists is false", () => {
    const steps = buildDeployPlan({ d1Exists: false, existingQueues: [] });
    expect(steps[0]).toContain("Create D1 database");
    expect(steps[0]).toContain(D1_DATABASE_NAME);
  });

  it("skips D1 creation when d1Exists is true", () => {
    const steps = buildDeployPlan({ d1Exists: true, existingQueues: [] });
    expect(steps.find((s) => s.startsWith("Create D1"))).toBeUndefined();
  });

  it("always includes migration step", () => {
    const steps = buildDeployPlan({ d1Exists: true, existingQueues: [] });
    expect(steps.some((s) => s.includes("migration"))).toBe(true);
  });

  it("creates only missing queues", () => {
    const existing = ["tminus-sync-queue", "tminus-write-queue"];
    const steps = buildDeployPlan({ d1Exists: true, existingQueues: existing });
    // Should create the 3 missing queues
    const queueSteps = steps.filter((s) => s.startsWith("Create queue"));
    expect(queueSteps).toHaveLength(3);
    expect(queueSteps.map((s) => s.replace("Create queue: ", "")).sort()).toEqual(
      ["tminus-reconcile-queue", "tminus-sync-queue-dlq", "tminus-write-queue-dlq"].sort()
    );
  });

  it("creates all 5 queues when none exist", () => {
    const steps = buildDeployPlan({ d1Exists: true, existingQueues: [] });
    const queueSteps = steps.filter((s) => s.startsWith("Create queue"));
    expect(queueSteps).toHaveLength(5);
  });

  it("deploys workers in correct order", () => {
    const steps = buildDeployPlan({ d1Exists: true, existingQueues: REQUIRED_QUEUES });
    const workerSteps = steps.filter((s) => s.startsWith("Deploy worker"));
    expect(workerSteps).toEqual([
      "Deploy worker: tminus-api",
      "Deploy worker: tminus-oauth",
      "Deploy worker: tminus-webhook",
      "Deploy worker: tminus-sync-consumer",
      "Deploy worker: tminus-write-consumer",
      "Deploy worker: tminus-cron",
    ]);
  });

  it("uses default state when called with no arguments", () => {
    const steps = buildDeployPlan();
    // Should include D1 creation + all queues + all workers
    expect(steps.length).toBeGreaterThanOrEqual(
      1 + 1 + REQUIRED_QUEUES.length + WORKER_DEPLOY_ORDER.length
    );
  });
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("returns defaults when no args", () => {
    expect(parseArgs([])).toEqual({
      dryRun: false,
      skipSecrets: false,
      skipMigrations: false,
      verbose: false,
    });
  });

  it("detects --dry-run", () => {
    expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
  });

  it("detects --skip-secrets", () => {
    expect(parseArgs(["--skip-secrets"]).skipSecrets).toBe(true);
  });

  it("detects --skip-migrations", () => {
    expect(parseArgs(["--skip-migrations"]).skipMigrations).toBe(true);
  });

  it("detects --verbose and -v", () => {
    expect(parseArgs(["--verbose"]).verbose).toBe(true);
    expect(parseArgs(["-v"]).verbose).toBe(true);
  });

  it("handles multiple flags", () => {
    const result = parseArgs(["--dry-run", "--verbose", "--skip-secrets"]);
    expect(result).toEqual({
      dryRun: true,
      skipSecrets: true,
      skipMigrations: false,
      verbose: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Constants validation
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("WORKER_DEPLOY_ORDER has 6 workers", () => {
    expect(WORKER_DEPLOY_ORDER).toHaveLength(6);
  });

  it("WORKER_DEPLOY_ORDER starts with api (hosts DOs)", () => {
    expect(WORKER_DEPLOY_ORDER[0]).toBe("api");
  });

  it("REQUIRED_QUEUES has 5 entries (3 main + 2 DLQ)", () => {
    expect(REQUIRED_QUEUES).toHaveLength(5);
  });

  it("REQUIRED_QUEUES DLQs match main queues", () => {
    const dlqs = REQUIRED_QUEUES.filter((q) => q.endsWith("-dlq"));
    expect(dlqs).toHaveLength(2);
    for (const dlq of dlqs) {
      const mainQueue = dlq.replace("-dlq", "");
      expect(REQUIRED_QUEUES).toContain(mainQueue);
    }
  });

  it("SECRET_MAP has JWT_SECRET and MASTER_KEY on both api and oauth", () => {
    expect(SECRET_MAP.JWT_SECRET).toContain("api");
    expect(SECRET_MAP.JWT_SECRET).toContain("oauth");
    expect(SECRET_MAP.MASTER_KEY).toContain("api");
    expect(SECRET_MAP.MASTER_KEY).toContain("oauth");
  });
});
