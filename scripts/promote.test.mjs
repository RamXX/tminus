/**
 * Tests for promote.mjs -- Stage-to-prod deployment pipeline.
 *
 * These tests verify pure planning functions with NO Cloudflare credentials
 * or network access required. The pipeline execution is tested via dry-run mode.
 */

import { describe, it, expect } from "vitest";
import {
  parsePromoteArgs,
  buildPromotePlan,
  getHealthCheckTargets,
  getWorkerDeployOrder,
  getWorkerUrl,
  PIPELINE_STAGES,
  ENV_CONFIG,
} from "./promote.mjs";

// ---------------------------------------------------------------------------
// parsePromoteArgs
// ---------------------------------------------------------------------------

describe("parsePromoteArgs", () => {
  it("returns defaults when no args", () => {
    expect(parsePromoteArgs([])).toEqual({
      dryRun: false,
      stageOnly: false,
      prodOnly: false,
      skipSmoke: false,
      skipSecrets: false,
      skipMigrations: false,
      skipBuild: false,
      verbose: false,
    });
  });

  it("detects --dry-run", () => {
    expect(parsePromoteArgs(["--dry-run"]).dryRun).toBe(true);
  });

  it("detects --stage-only", () => {
    expect(parsePromoteArgs(["--stage-only"]).stageOnly).toBe(true);
  });

  it("detects --prod-only", () => {
    expect(parsePromoteArgs(["--prod-only"]).prodOnly).toBe(true);
  });

  it("detects --skip-smoke", () => {
    expect(parsePromoteArgs(["--skip-smoke"]).skipSmoke).toBe(true);
  });

  it("detects --skip-secrets", () => {
    expect(parsePromoteArgs(["--skip-secrets"]).skipSecrets).toBe(true);
  });

  it("detects --skip-migrations", () => {
    expect(parsePromoteArgs(["--skip-migrations"]).skipMigrations).toBe(true);
  });

  it("detects --skip-build", () => {
    expect(parsePromoteArgs(["--skip-build"]).skipBuild).toBe(true);
  });

  it("detects --verbose and -v", () => {
    expect(parsePromoteArgs(["--verbose"]).verbose).toBe(true);
    expect(parsePromoteArgs(["-v"]).verbose).toBe(true);
  });

  it("handles multiple flags simultaneously", () => {
    const result = parsePromoteArgs([
      "--dry-run",
      "--verbose",
      "--skip-smoke",
      "--stage-only",
    ]);
    expect(result).toEqual({
      dryRun: true,
      stageOnly: true,
      prodOnly: false,
      skipSmoke: true,
      skipSecrets: false,
      skipMigrations: false,
      skipBuild: false,
      verbose: true,
    });
  });
});

// ---------------------------------------------------------------------------
// ENV_CONFIG
// ---------------------------------------------------------------------------

describe("ENV_CONFIG", () => {
  it("has staging and production environments", () => {
    expect(ENV_CONFIG).toHaveProperty("staging");
    expect(ENV_CONFIG).toHaveProperty("production");
  });

  it("staging uses staging wrangler env flag", () => {
    expect(ENV_CONFIG.staging.wranglerEnv).toBe("staging");
  });

  it("production uses production wrangler env flag", () => {
    expect(ENV_CONFIG.production.wranglerEnv).toBe("production");
  });

  it("staging API URL is api-staging.tminus.ink", () => {
    expect(ENV_CONFIG.staging.apiUrl).toBe("https://api-staging.tminus.ink");
  });

  it("production API URL is api.tminus.ink", () => {
    expect(ENV_CONFIG.production.apiUrl).toBe("https://api.tminus.ink");
  });

  it("staging D1 database name has -staging suffix", () => {
    expect(ENV_CONFIG.staging.d1DatabaseName).toBe("tminus-registry-staging");
  });

  it("production D1 database name is tminus-registry", () => {
    expect(ENV_CONFIG.production.d1DatabaseName).toBe("tminus-registry");
  });
});

// ---------------------------------------------------------------------------
// PIPELINE_STAGES
// ---------------------------------------------------------------------------

describe("PIPELINE_STAGES", () => {
  it("defines the correct pipeline stages in order", () => {
    expect(PIPELINE_STAGES).toEqual([
      "build",
      "migrate-staging",
      "deploy-staging",
      "health-staging",
      "smoke-staging",
      "migrate-production",
      "deploy-production",
      "health-production",
      "smoke-production",
    ]);
  });

  it("staging stages come before production stages", () => {
    const stageIdx = PIPELINE_STAGES.indexOf("deploy-staging");
    const prodIdx = PIPELINE_STAGES.indexOf("deploy-production");
    expect(stageIdx).toBeLessThan(prodIdx);
  });

  it("health checks come after deploy for each environment", () => {
    const deployStage = PIPELINE_STAGES.indexOf("deploy-staging");
    const healthStage = PIPELINE_STAGES.indexOf("health-staging");
    expect(healthStage).toBeGreaterThan(deployStage);

    const deployProd = PIPELINE_STAGES.indexOf("deploy-production");
    const healthProd = PIPELINE_STAGES.indexOf("health-production");
    expect(healthProd).toBeGreaterThan(deployProd);
  });

  it("smoke tests come after health checks for each environment", () => {
    const healthStage = PIPELINE_STAGES.indexOf("health-staging");
    const smokeStage = PIPELINE_STAGES.indexOf("smoke-staging");
    expect(smokeStage).toBeGreaterThan(healthStage);
  });
});

// ---------------------------------------------------------------------------
// getWorkerDeployOrder
// ---------------------------------------------------------------------------

describe("getWorkerDeployOrder", () => {
  it("returns 9 workers", () => {
    expect(getWorkerDeployOrder()).toHaveLength(9);
  });

  it("deploys api first (hosts DOs)", () => {
    expect(getWorkerDeployOrder()[0]).toBe("api");
  });

  it("deploys consumers before support workers", () => {
    const order = getWorkerDeployOrder();
    const syncIdx = order.indexOf("sync-consumer");
    const writeIdx = order.indexOf("write-consumer");
    const oauthIdx = order.indexOf("oauth");
    const webhookIdx = order.indexOf("webhook");
    const cronIdx = order.indexOf("cron");

    // Consumers before oauth, webhook, cron
    expect(syncIdx).toBeLessThan(oauthIdx);
    expect(syncIdx).toBeLessThan(webhookIdx);
    expect(writeIdx).toBeLessThan(cronIdx);
  });

  it("deploys app-gateway and mcp after core workers", () => {
    const order = getWorkerDeployOrder();
    const cronIdx = order.indexOf("cron");
    const gatewayIdx = order.indexOf("app-gateway");
    const mcpIdx = order.indexOf("mcp");

    expect(gatewayIdx).toBeGreaterThan(cronIdx);
    expect(mcpIdx).toBeGreaterThan(cronIdx);
  });

  it("deploys push last", () => {
    const order = getWorkerDeployOrder();
    expect(order[order.length - 1]).toBe("push");
  });

  it("includes all expected workers", () => {
    const order = getWorkerDeployOrder();
    expect(order).toContain("api");
    expect(order).toContain("sync-consumer");
    expect(order).toContain("write-consumer");
    expect(order).toContain("oauth");
    expect(order).toContain("webhook");
    expect(order).toContain("cron");
    expect(order).toContain("app-gateway");
    expect(order).toContain("mcp");
    expect(order).toContain("push");
  });
});

// ---------------------------------------------------------------------------
// getHealthCheckTargets
// ---------------------------------------------------------------------------

describe("getHealthCheckTargets", () => {
  it("returns only workers with HTTP routes for staging", () => {
    const targets = getHealthCheckTargets("staging");
    // api, oauth, webhook, app-gateway, mcp have routes
    expect(targets.length).toBe(5);
    expect(targets.map((t) => t.worker)).toContain("api");
    expect(targets.map((t) => t.worker)).toContain("oauth");
    expect(targets.map((t) => t.worker)).toContain("webhook");
    expect(targets.map((t) => t.worker)).toContain("app-gateway");
    expect(targets.map((t) => t.worker)).toContain("mcp");
  });

  it("returns only workers with HTTP routes for production", () => {
    const targets = getHealthCheckTargets("production");
    expect(targets.length).toBe(5);
    expect(targets.map((t) => t.worker)).toContain("api");
    expect(targets.map((t) => t.worker)).toContain("oauth");
    expect(targets.map((t) => t.worker)).toContain("webhook");
    expect(targets.map((t) => t.worker)).toContain("app-gateway");
    expect(targets.map((t) => t.worker)).toContain("mcp");
  });

  it("does NOT include queue consumers (no HTTP routes)", () => {
    const targets = getHealthCheckTargets("staging");
    expect(targets.map((t) => t.worker)).not.toContain("sync-consumer");
    expect(targets.map((t) => t.worker)).not.toContain("write-consumer");
  });

  it("does NOT include cron or push workers (no HTTP routes)", () => {
    const targets = getHealthCheckTargets("staging");
    expect(targets.map((t) => t.worker)).not.toContain("cron");
    expect(targets.map((t) => t.worker)).not.toContain("push");
  });

  it("staging URLs use -staging subdomain pattern", () => {
    const targets = getHealthCheckTargets("staging");
    for (const target of targets) {
      expect(target.healthUrl).toContain("-staging.tminus.ink");
      expect(target.healthUrl).toMatch(/\/health$/);
    }
  });

  it("production URLs use direct subdomain pattern", () => {
    const targets = getHealthCheckTargets("production");
    for (const target of targets) {
      expect(target.healthUrl).not.toContain("-staging");
      expect(target.healthUrl).toMatch(/\/health$/);
    }
  });

  it("staging API health URL is correct", () => {
    const targets = getHealthCheckTargets("staging");
    const api = targets.find((t) => t.worker === "api");
    expect(api.healthUrl).toBe("https://api-staging.tminus.ink/health");
  });

  it("production API health URL is correct", () => {
    const targets = getHealthCheckTargets("production");
    const api = targets.find((t) => t.worker === "api");
    expect(api.healthUrl).toBe("https://api.tminus.ink/health");
  });
});

// ---------------------------------------------------------------------------
// getWorkerUrl
// ---------------------------------------------------------------------------

describe("getWorkerUrl", () => {
  it("returns staging URL for api worker", () => {
    expect(getWorkerUrl("api", "staging")).toBe(
      "https://api-staging.tminus.ink"
    );
  });

  it("returns production URL for api worker", () => {
    expect(getWorkerUrl("api", "production")).toBe("https://api.tminus.ink");
  });

  it("returns staging URL for oauth worker", () => {
    expect(getWorkerUrl("oauth", "staging")).toBe(
      "https://oauth-staging.tminus.ink"
    );
  });

  it("returns production URL for webhook worker", () => {
    expect(getWorkerUrl("webhook", "production")).toBe(
      "https://webhooks.tminus.ink"
    );
  });

  it("returns staging URL for app-gateway worker", () => {
    expect(getWorkerUrl("app-gateway", "staging")).toBe(
      "https://app-staging.tminus.ink"
    );
  });

  it("returns production URL for mcp worker", () => {
    expect(getWorkerUrl("mcp", "production")).toBe("https://mcp.tminus.ink");
  });

  it("returns null for workers without HTTP routes", () => {
    expect(getWorkerUrl("sync-consumer", "staging")).toBeNull();
    expect(getWorkerUrl("write-consumer", "production")).toBeNull();
    expect(getWorkerUrl("cron", "staging")).toBeNull();
    expect(getWorkerUrl("push", "production")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildPromotePlan
// ---------------------------------------------------------------------------

describe("buildPromotePlan", () => {
  it("full pipeline includes all stages in order", () => {
    const plan = buildPromotePlan({});
    const stageNames = plan.map((s) => s.stage);

    // Must include build, staging deploy, staging health, staging smoke,
    // prod deploy, prod health, prod smoke
    expect(stageNames).toContain("build");
    expect(stageNames).toContain("migrate-staging");
    expect(stageNames).toContain("deploy-staging");
    expect(stageNames).toContain("health-staging");
    expect(stageNames).toContain("smoke-staging");
    expect(stageNames).toContain("migrate-production");
    expect(stageNames).toContain("deploy-production");
    expect(stageNames).toContain("health-production");
    expect(stageNames).toContain("smoke-production");
  });

  it("deploy-staging includes all 9 workers in correct order", () => {
    const plan = buildPromotePlan({});
    const deployStage = plan.find((s) => s.stage === "deploy-staging");
    expect(deployStage).toBeDefined();
    expect(deployStage.steps.length).toBe(9);
    expect(deployStage.steps[0]).toContain("api");
  });

  it("health-staging includes 5 health check targets", () => {
    const plan = buildPromotePlan({});
    const healthStage = plan.find((s) => s.stage === "health-staging");
    expect(healthStage).toBeDefined();
    expect(healthStage.steps.length).toBe(5);
  });

  it("smoke-staging includes smoke test step", () => {
    const plan = buildPromotePlan({});
    const smokeStage = plan.find((s) => s.stage === "smoke-staging");
    expect(smokeStage).toBeDefined();
    expect(smokeStage.steps.length).toBeGreaterThan(0);
    expect(smokeStage.steps[0]).toContain("api-staging");
  });

  it("--stage-only omits production stages", () => {
    const plan = buildPromotePlan({ stageOnly: true });
    const stageNames = plan.map((s) => s.stage);

    expect(stageNames).toContain("deploy-staging");
    expect(stageNames).not.toContain("deploy-production");
    expect(stageNames).not.toContain("health-production");
    expect(stageNames).not.toContain("smoke-production");
  });

  it("--prod-only omits staging stages", () => {
    const plan = buildPromotePlan({ prodOnly: true });
    const stageNames = plan.map((s) => s.stage);

    expect(stageNames).not.toContain("deploy-staging");
    expect(stageNames).not.toContain("health-staging");
    expect(stageNames).not.toContain("smoke-staging");
    expect(stageNames).toContain("deploy-production");
    expect(stageNames).toContain("health-production");
  });

  it("--skip-smoke omits all smoke stages", () => {
    const plan = buildPromotePlan({ skipSmoke: true });
    const stageNames = plan.map((s) => s.stage);

    expect(stageNames).not.toContain("smoke-staging");
    expect(stageNames).not.toContain("smoke-production");
    // Health checks still present
    expect(stageNames).toContain("health-staging");
    expect(stageNames).toContain("health-production");
  });

  it("--skip-migrations omits all migration stages", () => {
    const plan = buildPromotePlan({ skipMigrations: true });
    const stageNames = plan.map((s) => s.stage);

    expect(stageNames).not.toContain("migrate-staging");
    expect(stageNames).not.toContain("migrate-production");
  });

  it("--skip-build omits build stage", () => {
    const plan = buildPromotePlan({ skipBuild: true });
    const stageNames = plan.map((s) => s.stage);

    expect(stageNames).not.toContain("build");
  });

  it("deploy stage steps use wrangler deploy with correct env flag", () => {
    const plan = buildPromotePlan({});
    const deployStage = plan.find((s) => s.stage === "deploy-staging");
    for (const step of deployStage.steps) {
      expect(step).toContain("--env staging");
    }

    const deployProd = plan.find((s) => s.stage === "deploy-production");
    for (const step of deployProd.steps) {
      expect(step).toContain("--env production");
    }
  });

  it("production stages always come after staging stages", () => {
    const plan = buildPromotePlan({});
    const stageNames = plan.map((s) => s.stage);

    const lastStaging = Math.max(
      stageNames.indexOf("deploy-staging"),
      stageNames.indexOf("health-staging"),
      stageNames.indexOf("smoke-staging")
    );
    const firstProd = Math.min(
      stageNames.indexOf("deploy-production"),
      stageNames.indexOf("health-production"),
      stageNames.indexOf("smoke-production")
    );

    expect(lastStaging).toBeLessThan(firstProd);
  });

  it("each step has stage name and human-readable steps array", () => {
    const plan = buildPromotePlan({});
    for (const entry of plan) {
      expect(entry).toHaveProperty("stage");
      expect(entry).toHaveProperty("steps");
      expect(Array.isArray(entry.steps)).toBe(true);
      expect(entry.steps.length).toBeGreaterThan(0);
    }
  });

  it("migrate-staging step references staging D1 database name", () => {
    const plan = buildPromotePlan({});
    const migrateStage = plan.find((s) => s.stage === "migrate-staging");
    expect(migrateStage.steps[0]).toContain("tminus-registry-staging");
  });

  it("migrate-production step references production D1 database name", () => {
    const plan = buildPromotePlan({});
    const migrateProd = plan.find((s) => s.stage === "migrate-production");
    expect(migrateProd.steps[0]).toContain("tminus-registry");
    // Ensure it is NOT the staging name
    expect(migrateProd.steps[0]).not.toContain("tminus-registry-staging");
  });
});

// ---------------------------------------------------------------------------
// Pipeline ordering validation (critical correctness)
// ---------------------------------------------------------------------------

describe("pipeline ordering", () => {
  it("D1 migrations run before worker deploys for each env", () => {
    const plan = buildPromotePlan({});
    const stageNames = plan.map((s) => s.stage);

    const migrateStage = stageNames.indexOf("migrate-staging");
    const deployStage = stageNames.indexOf("deploy-staging");
    expect(migrateStage).toBeLessThan(deployStage);

    const migrateProd = stageNames.indexOf("migrate-production");
    const deployProd = stageNames.indexOf("deploy-production");
    expect(migrateProd).toBeLessThan(deployProd);
  });

  it("staging smoke must pass before production starts", () => {
    const plan = buildPromotePlan({});
    const stageNames = plan.map((s) => s.stage);

    const smokeStage = stageNames.indexOf("smoke-staging");
    const migrateProd = stageNames.indexOf("migrate-production");
    expect(smokeStage).toBeLessThan(migrateProd);
  });

  it("build is always first when included", () => {
    const plan = buildPromotePlan({});
    expect(plan[0].stage).toBe("build");
  });
});

// ---------------------------------------------------------------------------
// Dry-run plan is comprehensive
// ---------------------------------------------------------------------------

describe("dry-run plan completeness", () => {
  it("full pipeline plan has expected number of stages", () => {
    const plan = buildPromotePlan({});
    // build(1) + staging(migrate+deploy+health+smoke=4) + prod(migrate+deploy+health+smoke=4) = 9
    expect(plan.length).toBe(9);
  });

  it("stage-only plan has 5 stages", () => {
    const plan = buildPromotePlan({ stageOnly: true });
    // build(1) + staging(migrate+deploy+health+smoke=4) = 5
    expect(plan.length).toBe(5);
  });

  it("prod-only plan has 5 stages", () => {
    const plan = buildPromotePlan({ prodOnly: true });
    // build(1) + prod(migrate+deploy+health+smoke=4) = 5
    expect(plan.length).toBe(5);
  });

  it("combined skip flags reduce plan correctly", () => {
    const plan = buildPromotePlan({
      skipBuild: true,
      skipSmoke: true,
      skipMigrations: true,
    });
    // No build, no migrations, no smoke = deploy+health for both envs = 4
    expect(plan.length).toBe(4);
  });
});
