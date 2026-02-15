#!/usr/bin/env node

/**
 * setup-secrets.mjs -- Dedicated secrets management for T-Minus workers.
 *
 * Sets all required secrets for all workers across staging and production
 * environments using `wrangler secret put` with values piped via stdin
 * (never exposed on the command line).
 *
 * Usage:
 *   node scripts/setup-secrets.mjs [options]
 *
 * Options:
 *   --env <name>       Target environment: "staging", "production", or omit for both
 *   --worker <name>    Target a single worker: "api" or "oauth"
 *   --dry-run          Print what would be done without executing
 *   --verbose, -v      Verbose output
 *
 * Environment variables (from .env):
 *   JWT_SECRET             -- JWT signing/verification secret
 *   MASTER_KEY             -- Envelope encryption master key (DEK wrapping)
 *   GOOGLE_CLIENT_ID       -- Google OAuth client ID
 *   GOOGLE_CLIENT_SECRET   -- Google OAuth client secret
 *   MS_CLIENT_ID           -- Microsoft Entra ID client ID
 *   MS_CLIENT_SECRET       -- Microsoft Entra ID client secret
 *
 * Secret-to-worker mapping:
 *   tminus-api:   JWT_SECRET, MASTER_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
 *                 MS_CLIENT_ID, MS_CLIENT_SECRET
 *                 (api hosts AccountDO which needs OAuth creds for token refresh
 *                  and MASTER_KEY for DEK encryption)
 *   tminus-oauth: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, MS_CLIENT_ID,
 *                 MS_CLIENT_SECRET, MASTER_KEY, JWT_SECRET
 *                 (oauth handles OAuth flows and shares encryption/auth with api)
 *
 * Idempotent: re-running overwrites secrets with current .env values.
 * Wrangler treats secret put as an upsert -- safe to run repeatedly.
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseEnvFile } from "./deploy-config.mjs";

const ROOT = resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Constants (pure, testable)
// ---------------------------------------------------------------------------

/**
 * Supported deployment environments.
 * Secrets must be set independently for each environment because
 * wrangler environments create separate worker instances.
 */
export const SUPPORTED_ENVIRONMENTS = ["staging", "production"];

/**
 * The authoritative registry of all secrets required by T-Minus workers.
 *
 * Each entry defines:
 *   envVar      -- the .env variable name that provides the value
 *   secretName  -- the name used in `wrangler secret put` and `env.SECRET_NAME` in worker code
 *   workers     -- which workers need this secret (short names without tminus- prefix)
 *   description -- human-readable purpose for documentation
 *
 * Why api needs OAuth secrets: AccountDO is hosted on tminus-api and performs
 * token refresh for connected calendar accounts, requiring OAuth credentials.
 */
export const SECRETS_REGISTRY = [
  {
    envVar: "JWT_SECRET",
    secretName: "JWT_SECRET",
    workers: ["api", "oauth"],
    description:
      "JWT signing and verification secret for API authentication. Must be identical across api and oauth workers.",
  },
  {
    envVar: "MASTER_KEY",
    secretName: "MASTER_KEY",
    workers: ["api", "oauth"],
    description:
      "Envelope encryption master key for DEK wrapping. Used by AccountDO (on api) for encrypting OAuth tokens at rest. Must be identical across api and oauth workers.",
  },
  {
    envVar: "GOOGLE_CLIENT_ID",
    secretName: "GOOGLE_CLIENT_ID",
    workers: ["api", "oauth"],
    description:
      "Google OAuth 2.0 client ID. Used by oauth for OAuth flows and by api (AccountDO) for token refresh.",
  },
  {
    envVar: "GOOGLE_CLIENT_SECRET",
    secretName: "GOOGLE_CLIENT_SECRET",
    workers: ["api", "oauth"],
    description:
      "Google OAuth 2.0 client secret. Used by oauth for OAuth flows and by api (AccountDO) for token refresh.",
  },
  {
    envVar: "MS_CLIENT_ID",
    secretName: "MS_CLIENT_ID",
    workers: ["api", "oauth"],
    description:
      "Microsoft Entra ID (Azure AD) client ID. Used by oauth for OAuth flows and by api (AccountDO) for token refresh.",
  },
  {
    envVar: "MS_CLIENT_SECRET",
    secretName: "MS_CLIENT_SECRET",
    workers: ["api", "oauth"],
    description:
      "Microsoft Entra ID (Azure AD) client secret. Used by oauth for OAuth flows and by api (AccountDO) for token refresh.",
  },
];

// ---------------------------------------------------------------------------
// Pure functions (no side effects, fully testable)
// ---------------------------------------------------------------------------

/**
 * Parse CLI arguments for the setup-secrets script.
 *
 * @param {string[]} argv -- process.argv.slice(2)
 * @returns {{ dryRun: boolean, verbose: boolean, environment: string|null, worker: string|null }}
 */
export function parseSecretsArgs(argv) {
  const args = {
    dryRun: false,
    verbose: false,
    environment: null,
    worker: null,
  };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--verbose" || argv[i] === "-v") args.verbose = true;
    else if (argv[i] === "--env" && i + 1 < argv.length) {
      args.environment = argv[++i];
    } else if (argv[i] === "--worker" && i + 1 < argv.length) {
      args.worker = argv[++i];
    }
  }

  return args;
}

/**
 * Get the full wrangler worker name for a given worker and environment.
 * Wrangler environments create workers named {name}-{env}.
 *
 * @param {string} worker -- short worker name (e.g., "api")
 * @param {string} env -- environment name (e.g., "production")
 * @returns {string} -- e.g., "tminus-api-production"
 */
export function getWorkerEnvName(worker, env) {
  return `tminus-${worker}-${env}`;
}

/**
 * Build the secret deployment plan for a single environment.
 *
 * @param {Record<string, string>} envVars -- parsed .env key-value pairs
 * @param {string} environment -- target environment ("staging" or "production")
 * @param {string|null} [workerFilter=null] -- optional: only include secrets for this worker
 * @returns {Array<{ secretName: string, workerName: string, environment: string, value: string }>}
 */
export function buildEnvironmentSecretPlan(
  envVars,
  environment,
  workerFilter = null
) {
  const plan = [];

  for (const entry of SECRETS_REGISTRY) {
    const value = envVars[entry.envVar];
    if (!value) continue;

    for (const worker of entry.workers) {
      if (workerFilter && worker !== workerFilter) continue;

      plan.push({
        secretName: entry.secretName,
        workerName: `tminus-${worker}`,
        environment,
        value,
      });
    }
  }

  return plan;
}

/**
 * Convert a secret plan into wrangler commands.
 * Commands use --name and --env flags. Values are NOT included in the
 * command string -- they must be piped via stdin to avoid shell exposure.
 *
 * @param {Array<{ secretName: string, workerName: string, environment: string, value: string }>} plan
 * @returns {Array<{ command: string, value: string, label: string }>}
 */
export function buildWranglerCommands(plan) {
  return plan.map((entry) => ({
    command: `npx wrangler secret put ${entry.secretName} --name ${entry.workerName} --env ${entry.environment}`,
    value: entry.value,
    label: `${entry.secretName} -> ${entry.workerName} (${entry.environment})`,
  }));
}

/**
 * Validate that all required secret values are present in env vars.
 *
 * @param {Record<string, string>} envVars -- parsed .env key-value pairs
 * @returns {{ valid: boolean, present: string[], missing: string[] }}
 */
export function validateSecretValues(envVars) {
  const allEnvVars = [...new Set(SECRETS_REGISTRY.map((s) => s.envVar))];
  const present = [];
  const missing = [];

  for (const envVar of allEnvVars) {
    if (envVars[envVar] && envVars[envVar].trim() !== "") {
      present.push(envVar);
    } else {
      missing.push(envVar);
    }
  }

  return {
    valid: missing.length === 0,
    present,
    missing,
  };
}

// ---------------------------------------------------------------------------
// Execution (side effects -- only runs when invoked directly)
// ---------------------------------------------------------------------------

function log(msg) {
  process.stdout.write(`[setup-secrets] ${msg}\n`);
}

function logVerbose(msg, verbose) {
  if (verbose) log(msg);
}

function executeSecretPut(command, value, label, { verbose = false } = {}) {
  log(`Setting ${label}...`);
  try {
    execSync(command, {
      cwd: ROOT,
      encoding: "utf-8",
      input: value,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    log(`  OK`);
    return true;
  } catch (err) {
    const stderr = err.stderr?.trim() || err.message;
    // Some versions of wrangler exit non-zero even on success
    if (stderr.includes("Success")) {
      log(`  OK (via stderr)`);
      return true;
    }
    log(`  FAILED: ${stderr}`);
    return false;
  }
}

function main() {
  const args = parseSecretsArgs(process.argv.slice(2));

  // Load .env
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) {
    process.stderr.write(
      "[setup-secrets] ERROR: .env file not found. Copy .env.example and fill in values.\n"
    );
    process.exit(1);
  }

  const envContent = readFileSync(envPath, "utf-8");
  const envVars = parseEnvFile(envContent);

  // Validate
  const validation = validateSecretValues(envVars);
  if (!validation.valid) {
    log(
      `WARNING: Missing secrets in .env: ${validation.missing.join(", ")}`
    );
    log("Only present secrets will be deployed.");
  }
  logVerbose(`Present secrets: ${validation.present.join(", ")}`, args.verbose);

  // Determine target environments
  const targetEnvs = args.environment
    ? [args.environment]
    : SUPPORTED_ENVIRONMENTS;

  // Validate environment names
  for (const env of targetEnvs) {
    if (!SUPPORTED_ENVIRONMENTS.includes(env)) {
      process.stderr.write(
        `[setup-secrets] ERROR: Unknown environment '${env}'. Expected: ${SUPPORTED_ENVIRONMENTS.join(", ")}\n`
      );
      process.exit(1);
    }
  }

  // Build combined plan
  const fullPlan = [];
  for (const env of targetEnvs) {
    const envPlan = buildEnvironmentSecretPlan(envVars, env, args.worker);
    fullPlan.push(...envPlan);
  }

  if (fullPlan.length === 0) {
    log("No secrets to deploy. Check .env values and filters.");
    process.exit(1);
  }

  const commands = buildWranglerCommands(fullPlan);

  log(`${commands.length} secret(s) to deploy across ${targetEnvs.join(", ")}:`);
  for (const cmd of commands) {
    log(`  ${cmd.label}`);
  }

  if (args.dryRun) {
    log("\nDRY RUN -- commands that would be executed:");
    for (const cmd of commands) {
      log(`  $ ${cmd.command}`);
      log(`    (value piped via stdin)`);
    }
    log("\nDry run complete. No changes made.");
    return;
  }

  log("");
  let errors = 0;
  for (const cmd of commands) {
    const ok = executeSecretPut(cmd.command, cmd.value, cmd.label, {
      verbose: args.verbose,
    });
    if (!ok) errors++;
  }

  if (errors > 0) {
    log(`\nCompleted with ${errors} error(s) out of ${commands.length} secrets.`);
    process.exit(1);
  }

  log(`\nAll ${commands.length} secrets deployed successfully.`);
}

// Only run main when executed directly
const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("setup-secrets.mjs") ||
    process.argv[1].endsWith("setup-secrets"));

if (isDirectRun) {
  main();
}
