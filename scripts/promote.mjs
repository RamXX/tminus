#!/usr/bin/env node

/**
 * promote.mjs -- Stage-to-production deployment pipeline for T-Minus.
 *
 * Orchestrates the full promotion flow:
 *   1. Build all packages (pnpm run build)
 *   2. Run D1 migrations for staging
 *   3. Deploy all workers to staging (wrangler deploy --env staging) in correct order
 *   4. Run health checks on all staging workers with HTTP routes
 *   5. Run smoke tests on staging (register + login flow)
 *   6. If staging passes: run D1 migrations for production
 *   7. Deploy all workers to production
 *   8. Run health checks on production
 *   9. Run smoke tests on production
 *
 * Worker deploy order: api (hosts DOs), sync-consumer, write-consumer,
 * oauth, webhook, cron, app-gateway, mcp, push. API must be first because
 * other workers reference its Durable Objects via script_name. app-gateway
 * and mcp depend on API via service bindings so deploy after core workers.
 *
 * Usage:
 *   node scripts/promote.mjs [options]
 *
 * Options:
 *   --dry-run           Print plan without executing
 *   --stage-only        Deploy to staging only (skip production)
 *   --prod-only         Deploy to production only (skip staging)
 *   --skip-smoke        Skip smoke tests (health checks still run)
 *   --skip-secrets      Skip secret deployment
 *   --skip-migrations   Skip D1 migrations
 *   --skip-build        Skip build step (use when already built)
 *   --verbose, -v       Verbose output
 *
 * Environment:
 *   CLOUDFLARE_API_TOKEN   -- Wrangler auth token
 *   CLOUDFLARE_ACCOUNT_ID  -- Cloudflare account ID
 */

import { execSync } from "node:child_process";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Pipeline stages in execution order. Each stage is a gate: if it fails,
 * subsequent stages do not run.
 */
export const PIPELINE_STAGES = [
  "build",
  "migrate-staging",
  "deploy-staging",
  "health-staging",
  "smoke-staging",
  "migrate-production",
  "deploy-production",
  "health-production",
  "smoke-production",
];

/**
 * Worker deploy order. API must be first because other workers reference
 * its Durable Objects via script_name. Consumers next (they depend on DOs
 * for processing), then support workers.
 */
const PROMOTE_WORKER_ORDER = [
  "api",
  "sync-consumer",
  "write-consumer",
  "oauth",
  "webhook",
  "cron",
  "app-gateway",
  "mcp",
  "push",
];

/**
 * Workers that have HTTP routes and therefore health endpoints.
 * Queue consumers and cron are triggered by queues/cron, not HTTP requests.
 */
const HTTP_WORKERS = ["api", "oauth", "webhook", "app-gateway", "mcp"];

/**
 * URL patterns per environment. Workers with HTTP routes get subdomain-based URLs.
 * The webhook worker uses "webhooks" as its subdomain (plural).
 */
const WORKER_URL_MAP = {
  api: { staging: "https://api-staging.tminus.ink", production: "https://api.tminus.ink" },
  oauth: { staging: "https://oauth-staging.tminus.ink", production: "https://oauth.tminus.ink" },
  webhook: { staging: "https://webhooks-staging.tminus.ink", production: "https://webhooks.tminus.ink" },
  "app-gateway": { staging: "https://app-staging.tminus.ink", production: "https://app.tminus.ink" },
  mcp: { staging: "https://mcp-staging.tminus.ink", production: "https://mcp.tminus.ink" },
};

/**
 * Per-environment configuration for deployment.
 */
export const ENV_CONFIG = {
  staging: {
    wranglerEnv: "staging",
    apiUrl: "https://api-staging.tminus.ink",
    d1DatabaseName: "tminus-registry-staging",
    label: "Staging",
  },
  production: {
    wranglerEnv: "production",
    apiUrl: "https://api.tminus.ink",
    d1DatabaseName: "tminus-registry",
    label: "Production",
  },
};

// ---------------------------------------------------------------------------
// Pure functions (testable, no side effects)
// ---------------------------------------------------------------------------

/**
 * Parse CLI arguments for the promote pipeline.
 *
 * @param {string[]} argv -- process.argv.slice(2)
 */
export function parsePromoteArgs(argv) {
  return {
    dryRun: argv.includes("--dry-run"),
    stageOnly: argv.includes("--stage-only"),
    prodOnly: argv.includes("--prod-only"),
    skipSmoke: argv.includes("--skip-smoke"),
    skipSecrets: argv.includes("--skip-secrets"),
    skipMigrations: argv.includes("--skip-migrations"),
    skipBuild: argv.includes("--skip-build"),
    verbose: argv.includes("--verbose") || argv.includes("-v"),
  };
}

/**
 * Return the ordered list of workers to deploy.
 * API first (hosts DOs), then consumers, then support workers.
 */
export function getWorkerDeployOrder() {
  return [...PROMOTE_WORKER_ORDER];
}

/**
 * Get the base URL for a worker in a given environment.
 * Returns null for workers without HTTP routes (consumers, cron).
 *
 * @param {string} worker -- worker short name (e.g., "api", "oauth")
 * @param {string} env -- "staging" or "production"
 * @returns {string | null}
 */
export function getWorkerUrl(worker, env) {
  return WORKER_URL_MAP[worker]?.[env] ?? null;
}

/**
 * Get the health check targets for a given environment.
 * Only workers with HTTP routes are health-checkable.
 *
 * @param {string} env -- "staging" or "production"
 * @returns {{ worker: string, healthUrl: string }[]}
 */
export function getHealthCheckTargets(env) {
  return HTTP_WORKERS.map((worker) => ({
    worker,
    healthUrl: `${WORKER_URL_MAP[worker][env]}/health`,
  }));
}

/**
 * Build the full promote pipeline plan as a structured array of stages.
 * Each stage has a name and an array of human-readable steps.
 * Pure function -- used for --dry-run output and testing.
 *
 * @param {object} args -- parsed CLI args (or subset)
 * @returns {{ stage: string, steps: string[] }[]}
 */
export function buildPromotePlan(args = {}) {
  const {
    stageOnly = false,
    prodOnly = false,
    skipSmoke = false,
    skipMigrations = false,
    skipBuild = false,
  } = args;

  const plan = [];

  // Build
  if (!skipBuild) {
    plan.push({
      stage: "build",
      steps: ["pnpm run build"],
    });
  }

  const includeStaging = !prodOnly;
  const includeProduction = !stageOnly;

  // --- Staging stages ---
  if (includeStaging) {
    if (!skipMigrations) {
      const stagingConfig = ENV_CONFIG.staging;
      plan.push({
        stage: "migrate-staging",
        steps: [
          `wrangler d1 migrations apply ${stagingConfig.d1DatabaseName} --remote --env staging`,
        ],
      });
    }

    plan.push({
      stage: "deploy-staging",
      steps: PROMOTE_WORKER_ORDER.map(
        (w) => `wrangler deploy workers/${w} --env staging`
      ),
    });

    plan.push({
      stage: "health-staging",
      steps: getHealthCheckTargets("staging").map(
        (t) => `GET ${t.healthUrl} -> 200`
      ),
    });

    if (!skipSmoke) {
      plan.push({
        stage: "smoke-staging",
        steps: [
          `smoke-test against ${ENV_CONFIG.staging.apiUrl} (health + register + login)`,
        ],
      });
    }
  }

  // --- Production stages ---
  if (includeProduction) {
    if (!skipMigrations) {
      const prodConfig = ENV_CONFIG.production;
      plan.push({
        stage: "migrate-production",
        steps: [
          `wrangler d1 migrations apply ${prodConfig.d1DatabaseName} --remote --env production`,
        ],
      });
    }

    plan.push({
      stage: "deploy-production",
      steps: PROMOTE_WORKER_ORDER.map(
        (w) => `wrangler deploy workers/${w} --env production`
      ),
    });

    plan.push({
      stage: "health-production",
      steps: getHealthCheckTargets("production").map(
        (t) => `GET ${t.healthUrl} -> 200`
      ),
    });

    if (!skipSmoke) {
      plan.push({
        stage: "smoke-production",
        steps: [
          `smoke-test against ${ENV_CONFIG.production.apiUrl} (health + register + login)`,
        ],
      });
    }
  }

  return plan;
}

// ---------------------------------------------------------------------------
// Execution helpers (side effects)
// ---------------------------------------------------------------------------

function log(msg) {
  process.stdout.write(`[promote] ${msg}\n`);
}

function logVerbose(msg, verbose) {
  if (verbose) log(msg);
}

/**
 * Run a shell command synchronously. Returns stdout on success.
 * Throws with stderr on failure unless allowFailure is true.
 */
function run(cmd, { verbose = false, allowFailure = false, cwd = ROOT } = {}) {
  if (verbose) log(`$ ${cmd}`);
  try {
    const output = execSync(cmd, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    return output.trim();
  } catch (err) {
    if (allowFailure) return "";
    const stderr = err.stderr?.trim() || err.message;
    throw new Error(`Command failed: ${cmd}\n${stderr}`);
  }
}

/**
 * Fetch with timeout. Used for health checks and smoke tests.
 */
async function fetchWithTimeout(url, init = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Wait for an HTTP endpoint to return an acceptable status.
 * Retries with exponential backoff.
 *
 * @param {string} url -- URL to check
 * @param {number[]} acceptStatuses -- acceptable HTTP status codes
 * @param {string} label -- human-readable label for error messages
 * @param {number} maxAttempts -- max retry attempts (default 20)
 * @param {number} baseDelayMs -- initial delay between retries (default 3000)
 */
async function waitForHealth(url, { acceptStatuses = [200], label = "", maxAttempts = 20, baseDelayMs = 3000 } = {}) {
  let lastStatus = null;
  let lastBody = null;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetchWithTimeout(url, { method: "GET" }, 15000);
      lastStatus = res.status;
      lastBody = await res.text().catch(() => null);
      if (acceptStatuses.includes(res.status)) {
        return { status: res.status, body: lastBody };
      }
    } catch (err) {
      lastBody = String(err?.message ?? err);
    }

    // Exponential backoff capped at 15s
    const delay = Math.min(baseDelayMs * Math.pow(1.5, i), 15000);
    await new Promise((r) => setTimeout(r, delay));
  }

  const prefix = label ? `${label}: ` : "";
  throw new Error(
    `${prefix}Health check timed out for ${url} (last status=${lastStatus}). Last body: ${lastBody}`
  );
}

// ---------------------------------------------------------------------------
// Pipeline stages (execution)
// ---------------------------------------------------------------------------

function stageBuild(verbose) {
  log("Stage: BUILD");
  log("Building all packages...");
  run("pnpm run build", { verbose });
  log("Build complete");
}

function stageMigrate(env, verbose) {
  const config = ENV_CONFIG[env];
  log(`Stage: MIGRATE (${config.label})`);
  log(`Running D1 migrations for ${config.d1DatabaseName}...`);

  // Use wrangler-d1.toml which has migrations_dir configured
  run(
    `npx wrangler d1 migrations apply ${config.d1DatabaseName} --remote --config wrangler-d1.toml`,
    { verbose }
  );
  log(`D1 migrations applied for ${config.label}`);
}

function stageDeploy(env, verbose) {
  const config = ENV_CONFIG[env];
  log(`Stage: DEPLOY (${config.label})`);
  log(`Deploying ${PROMOTE_WORKER_ORDER.length} workers to ${config.label}...`);

  for (const worker of PROMOTE_WORKER_ORDER) {
    const workerDir = join(ROOT, "workers", worker);
    log(`  Deploying tminus-${worker} --env ${config.wranglerEnv}...`);
    try {
      const output = execSync(
        `npx wrangler deploy --env ${config.wranglerEnv}`,
        {
          cwd: workerDir,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          env: process.env,
        }
      );
      if (verbose) log(`  ${output.trim()}`);
    } catch (err) {
      const stderr = err.stderr?.trim() || err.message;
      throw new Error(
        `Failed to deploy tminus-${worker} --env ${config.wranglerEnv}:\n${stderr}`
      );
    }
  }
  log(`All ${PROMOTE_WORKER_ORDER.length} workers deployed to ${config.label}`);
}

async function stageHealthCheck(env, verbose) {
  const config = ENV_CONFIG[env];
  log(`Stage: HEALTH CHECK (${config.label})`);

  // Brief pause after deploy for route propagation
  log("  Waiting 5s for deployment propagation...");
  await new Promise((r) => setTimeout(r, 5000));

  const targets = getHealthCheckTargets(env);
  for (const { worker, healthUrl } of targets) {
    log(`  Checking ${worker}: ${healthUrl}`);
    const result = await waitForHealth(healthUrl, {
      acceptStatuses: [200],
      label: `${config.label} ${worker}`,
      maxAttempts: 20,
      baseDelayMs: 3000,
    });
    logVerbose(`    Status: ${result.status}`, verbose);
    log(`  ${worker} health: OK`);
  }
  log(`All ${config.label} health checks passed`);
}

async function stageSmoke(env, verbose) {
  const config = ENV_CONFIG[env];
  log(`Stage: SMOKE TEST (${config.label})`);
  log(`Running smoke tests against ${config.apiUrl}...`);

  // Use the existing smoke-test.mjs runner
  run(`node scripts/smoke-test.mjs --env ${env}`, { verbose });
  log(`${config.label} smoke tests passed`);
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function main() {
  const args = parsePromoteArgs(process.argv.slice(2));

  log("T-Minus Stage-to-Production Pipeline");
  log("=".repeat(44));
  log("");

  // Verify wrangler auth
  try {
    const whoami = run("npx wrangler whoami", { verbose: args.verbose });
    logVerbose(whoami, args.verbose);
    log("Authentication: OK");
  } catch {
    throw new Error(
      "wrangler authentication failed. Ensure CLOUDFLARE_API_TOKEN is set in .env and sourced."
    );
  }

  // Dry run: print plan and exit
  if (args.dryRun) {
    log("DRY RUN -- no changes will be made\n");
    const plan = buildPromotePlan(args);
    for (const { stage, steps } of plan) {
      log(`  [${stage}]`);
      for (const step of steps) {
        log(`    ${step}`);
      }
    }
    log("\nDry run complete.");
    return;
  }

  const startTime = Date.now();

  // 1. Build
  if (!args.skipBuild) {
    stageBuild(args.verbose);
  } else {
    log("Skipping build (--skip-build)");
  }

  const includeStaging = !args.prodOnly;
  const includeProduction = !args.stageOnly;

  // --- Staging pipeline ---
  if (includeStaging) {
    log("");
    log("--- STAGING PIPELINE ---");

    if (!args.skipMigrations) {
      stageMigrate("staging", args.verbose);
    } else {
      log("Skipping staging migrations (--skip-migrations)");
    }

    stageDeploy("staging", args.verbose);
    await stageHealthCheck("staging", args.verbose);

    if (!args.skipSmoke) {
      await stageSmoke("staging", args.verbose);
    } else {
      log("Skipping staging smoke tests (--skip-smoke)");
    }

    log("--- STAGING: ALL CHECKS PASSED ---");
  }

  // --- Production pipeline ---
  if (includeProduction) {
    log("");
    log("--- PRODUCTION PIPELINE ---");

    if (!args.skipMigrations) {
      stageMigrate("production", args.verbose);
    } else {
      log("Skipping production migrations (--skip-migrations)");
    }

    stageDeploy("production", args.verbose);
    await stageHealthCheck("production", args.verbose);

    if (!args.skipSmoke) {
      await stageSmoke("production", args.verbose);
    } else {
      log("Skipping production smoke tests (--skip-smoke)");
    }

    log("--- PRODUCTION: ALL CHECKS PASSED ---");
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log("");
  log(`Pipeline complete in ${elapsed}s`);
  if (includeStaging) log(`  Staging:    ${ENV_CONFIG.staging.apiUrl}`);
  if (includeProduction) log(`  Production: ${ENV_CONFIG.production.apiUrl}`);
}

// Only run main when executed directly
const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("promote.mjs") ||
    process.argv[1].endsWith("promote"));

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`\n[promote] PIPELINE FAILED: ${err.message}\n`);
    process.exit(1);
  });
}
