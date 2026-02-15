#!/usr/bin/env node

/**
 * deploy-production.mjs -- Deploy tminus-api to production at api.tminus.ink.
 *
 * This script handles the production deployment pipeline:
 *   1. Verify prerequisites (wrangler auth, .env loaded)
 *   2. Ensure DNS records exist for api.tminus.ink
 *   3. Ensure KV namespace for sessions exists
 *   4. Deploy the api worker with --env production
 *   5. Push secrets (JWT_SECRET, MASTER_KEY)
 *   6. Run smoke tests against api.tminus.ink
 *
 * Usage:
 *   node scripts/deploy-production.mjs [options]
 *
 * Options:
 *   --dry-run          Print what would be done without executing
 *   --skip-dns         Skip DNS record setup
 *   --skip-smoke       Skip smoke tests after deploy
 *   --skip-secrets     Skip secret deployment
 *   --verbose, -v      Verbose output
 *   --env <name>       Environment: "production" (default) or "staging"
 *
 * Environment:
 *   CLOUDFLARE_API_TOKEN   -- Wrangler auth token
 *   CLOUDFLARE_ACCOUNT_ID  -- Cloudflare account ID
 *   TMINUS_ZONE_ID         -- Zone ID for tminus.ink
 *   JWT_SECRET             -- JWT signing secret
 *   MASTER_KEY             -- Envelope encryption master key
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Configuration (pure, testable)
// ---------------------------------------------------------------------------

/**
 * Deployment configuration per environment.
 */
export const DEPLOY_CONFIG = {
  production: {
    workerEnv: "production",
    apiUrl: "https://api.tminus.ink",
    label: "Production",
  },
  staging: {
    workerEnv: "staging",
    apiUrl: "https://api-staging.tminus.ink",
    label: "Staging",
  },
};

/**
 * Secrets that must be set on the api worker for auth to function.
 * Maps env var name -> wrangler secret name.
 */
export const REQUIRED_SECRETS = ["JWT_SECRET", "MASTER_KEY"];

// ---------------------------------------------------------------------------
// CLI argument parsing (pure, testable)
// ---------------------------------------------------------------------------

export function parseDeployArgs(argv) {
  const args = {
    dryRun: false,
    skipDns: false,
    skipSmoke: false,
    skipSecrets: false,
    verbose: false,
    environment: "production",
  };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--skip-dns") args.skipDns = true;
    else if (argv[i] === "--skip-smoke") args.skipSmoke = true;
    else if (argv[i] === "--skip-secrets") args.skipSecrets = true;
    else if (argv[i] === "--verbose" || argv[i] === "-v") args.verbose = true;
    else if (argv[i] === "--env" && i + 1 < argv.length) {
      args.environment = argv[++i];
    }
  }

  return args;
}

/**
 * Build a human-readable deploy plan.
 * Pure function, no side effects -- used for --dry-run output and testing.
 */
export function buildProductionDeployPlan(args) {
  const config = DEPLOY_CONFIG[args.environment];
  if (!config) {
    throw new Error(
      `Unknown environment: ${args.environment}. Expected: ${Object.keys(DEPLOY_CONFIG).join(", ")}`
    );
  }

  const steps = [];

  steps.push(`Verify wrangler authentication`);

  if (!args.skipDns) {
    steps.push(`Ensure DNS records for ${config.apiUrl}`);
  }

  steps.push(
    `Deploy tminus-api with --env ${config.workerEnv} (route: ${config.apiUrl})`
  );

  if (!args.skipSecrets) {
    for (const secret of REQUIRED_SECRETS) {
      steps.push(`Set secret ${secret} on tminus-api --env ${config.workerEnv}`);
    }
  }

  if (!args.skipSmoke) {
    steps.push(`Run smoke tests against ${config.apiUrl}`);
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Execution helpers
// ---------------------------------------------------------------------------

function log(msg) {
  process.stdout.write(`[deploy-prod] ${msg}\n`);
}

function logVerbose(msg, verbose) {
  if (verbose) log(msg);
}

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

function putSecret(workerName, secretName, value, envFlag, { verbose = false } = {}) {
  if (verbose) log(`Setting secret ${secretName} on ${workerName} (${envFlag})`);
  try {
    execSync(
      `npx wrangler secret put ${secretName} --name ${workerName} --env ${envFlag}`,
      {
        cwd: ROOT,
        encoding: "utf-8",
        input: value,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      }
    );
  } catch (err) {
    const stderr = err.stderr?.trim() || "";
    if (stderr.includes("already exists") || stderr.includes("Success")) {
      logVerbose(`Secret ${secretName} already set`, verbose);
    } else {
      throw new Error(
        `Failed to set secret ${secretName} on ${workerName}: ${stderr}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Deployment steps
// ---------------------------------------------------------------------------

function verifyAuth(verbose) {
  log("Verifying wrangler authentication...");
  try {
    const output = run("npx wrangler whoami", { verbose });
    logVerbose(output, verbose);
    log("Authentication OK");
  } catch {
    throw new Error(
      "wrangler authentication failed. Ensure CLOUDFLARE_API_TOKEN is set in .env and sourced."
    );
  }
}

function deployWorker(envFlag, verbose) {
  const workerDir = join(ROOT, "workers", "api");
  log(`Deploying tminus-api --env ${envFlag}...`);
  try {
    const output = execSync(`npx wrangler deploy --env ${envFlag}`, {
      cwd: workerDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    if (verbose) log(output.trim());
    log("Worker deployed");
  } catch (err) {
    const stderr = err.stderr?.trim() || err.message;
    throw new Error(`Failed to deploy tminus-api --env ${envFlag}:\n${stderr}`);
  }
}

function deploySecrets(envFlag, verbose) {
  log("Deploying secrets...");
  for (const secretName of REQUIRED_SECRETS) {
    const value = process.env[secretName];
    if (!value) {
      throw new Error(
        `Missing required secret: ${secretName}. Set in .env and source before deploying.`
      );
    }
    log(`Setting ${secretName}...`);
    putSecret("tminus-api", secretName, value, envFlag, { verbose });
  }
  log("Secrets deployed");
}

async function runSmoke(apiUrl, verbose) {
  log(`Running smoke tests against ${apiUrl}...`);

  // Health check
  log("  Smoke: GET /health");
  const healthRes = await fetch(`${apiUrl}/health`, { method: "GET" });
  if (!healthRes.ok) {
    throw new Error(`Health check failed: ${healthRes.status}`);
  }
  const healthBody = await healthRes.json();
  if (!healthBody.ok || healthBody.data?.status !== "healthy") {
    throw new Error(
      `Health check response invalid: ${JSON.stringify(healthBody)}`
    );
  }
  log("  Health check PASS");

  // Auth check: GET /v1/events without JWT should return 401
  log("  Smoke: GET /v1/events (no auth -> 401)");
  const noAuthRes = await fetch(`${apiUrl}/v1/events`, { method: "GET" });
  if (noAuthRes.status !== 401) {
    throw new Error(`Expected 401 without auth, got ${noAuthRes.status}`);
  }
  log("  Auth enforcement PASS");

  log("Smoke tests PASS");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseDeployArgs(process.argv.slice(2));
  const config = DEPLOY_CONFIG[args.environment];

  if (!config) {
    throw new Error(
      `Unknown environment: ${args.environment}. Expected: ${Object.keys(DEPLOY_CONFIG).join(", ")}`
    );
  }

  log(`T-Minus ${config.label} Deployment`);
  log("=".repeat(40));
  log("");

  if (args.dryRun) {
    log("DRY RUN -- no changes will be made\n");
    const steps = buildProductionDeployPlan(args);
    for (const step of steps) {
      log(`  [dry-run] ${step}`);
    }
    log("\nDry run complete.");
    return;
  }

  // Step 1: Verify auth
  verifyAuth(args.verbose);

  // Step 2: DNS setup
  if (!args.skipDns) {
    log("Setting up DNS records...");
    try {
      run(
        `node scripts/dns-setup.mjs --env ${args.environment}`,
        { verbose: args.verbose }
      );
    } catch (err) {
      log(`DNS setup warning: ${err.message}`);
      log("Continuing -- DNS may already be configured manually.");
    }
  } else {
    log("Skipping DNS setup (--skip-dns)");
  }

  // Step 3: Deploy worker
  deployWorker(config.workerEnv, args.verbose);

  // Step 4: Secrets
  if (!args.skipSecrets) {
    deploySecrets(config.workerEnv, args.verbose);
  } else {
    log("Skipping secrets (--skip-secrets)");
  }

  // Step 5: Smoke tests
  if (!args.skipSmoke) {
    // Wait a few seconds for the deploy to propagate
    log("Waiting 5s for deployment propagation...");
    await new Promise((r) => setTimeout(r, 5000));
    await runSmoke(config.apiUrl, args.verbose);
  } else {
    log("Skipping smoke tests (--skip-smoke)");
  }

  log("");
  log(`${config.label} deployment complete.`);
  log(`API available at: ${config.apiUrl}`);
}

// Only run main when executed directly
const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("deploy-production.mjs") ||
    process.argv[1].endsWith("deploy-production"));

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`\n[deploy-prod] ERROR: ${err.message}\n`);
    process.exit(1);
  });
}
