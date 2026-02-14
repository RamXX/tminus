/**
 * deploy-config.mjs -- Pure configuration and planning functions for deployment.
 *
 * These functions are side-effect free and testable without any Cloudflare credentials.
 * The actual execution lives in deploy.mjs which imports these.
 */

import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Ordered list of workers to deploy. Order matters: tminus-api must be first
 *  because other workers reference its Durable Objects via script_name. */
export const WORKER_DEPLOY_ORDER = [
  "api",
  "oauth",
  "webhook",
  "sync-consumer",
  "write-consumer",
  "cron",
];

/** Queues that must exist before deploying workers that reference them. */
export const REQUIRED_QUEUES = [
  "tminus-sync-queue",
  "tminus-write-queue",
  "tminus-reconcile-queue",
  "tminus-sync-queue-dlq",
  "tminus-write-queue-dlq",
];

/** D1 database name used across all workers. */
export const D1_DATABASE_NAME = "tminus-registry";

/** Path to D1 migrations, relative to project root. */
export const D1_MIGRATIONS_PATH = "migrations/d1-registry";

/**
 * Secret mapping: which secrets go to which workers.
 * Key = env var name, Value = array of worker names (without tminus- prefix).
 */
export const SECRET_MAP = {
  GOOGLE_CLIENT_ID: ["oauth"],
  GOOGLE_CLIENT_SECRET: ["oauth"],
  MS_CLIENT_ID: ["oauth"],
  MS_CLIENT_SECRET: ["oauth"],
  MASTER_KEY: ["api", "oauth"],
  JWT_SECRET: ["api", "oauth"],
};

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Parse a .env file into a key-value object.
 * Handles:
 *  - export VAR=VALUE
 *  - VAR=VALUE
 *  - VAR="VALUE" (strips quotes)
 *  - VAR='VALUE' (strips quotes)
 *  - # comments
 *  - blank lines
 *
 * @param {string} content -- raw text content of a .env file
 * @returns {Record<string, string>}
 */
export function parseEnvFile(content) {
  const result = {};
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // Strip optional leading "export "
    const stripped = line.startsWith("export ") ? line.slice(7) : line;
    const eqIdx = stripped.indexOf("=");
    if (eqIdx === -1) continue;
    const key = stripped.slice(0, eqIdx).trim();
    let value = stripped.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Build the plan of secret deployments needed.
 * Returns an array of { secretName, workerName, value } objects.
 *
 * @param {Record<string, string>} envVars -- parsed env vars
 * @param {Record<string, string[]>} secretMap -- mapping of secret -> workers
 * @returns {{ secretName: string, workerName: string, value: string }[]}
 */
export function buildSecretPlan(envVars, secretMap = SECRET_MAP) {
  const plan = [];
  for (const [secretName, workers] of Object.entries(secretMap)) {
    const value = envVars[secretName];
    if (!value) continue;
    for (const worker of workers) {
      plan.push({
        secretName,
        workerName: `tminus-${worker}`,
        value,
      });
    }
  }
  return plan;
}

/**
 * Resolve the list of wrangler.toml files that contain a placeholder D1 ID.
 *
 * @param {string} projectRoot -- absolute path to project root
 * @returns {string[]} -- absolute paths to wrangler.toml files with placeholder
 */
export function findPlaceholderTomlFiles(projectRoot) {
  const files = [];
  for (const worker of WORKER_DEPLOY_ORDER) {
    const tomlPath = join(projectRoot, "workers", worker, "wrangler.toml");
    try {
      const content = readFileSync(tomlPath, "utf-8");
      if (content.includes("placeholder-d1-id")) {
        files.push(tomlPath);
      }
    } catch {
      // File might not exist; skip
    }
  }
  return files;
}

/**
 * Replace placeholder-d1-id with a real database ID in TOML content.
 *
 * @param {string} tomlContent -- raw TOML content
 * @param {string} realId -- the real D1 database ID
 * @returns {string} -- updated TOML content
 */
export function replacePlaceholderD1Id(tomlContent, realId) {
  return tomlContent.replace(/placeholder-d1-id/g, realId);
}

/**
 * Build the full deployment plan as a human-readable list of steps.
 * Useful for --dry-run output.
 *
 * @param {{ d1Exists: boolean, existingQueues: string[] }} state
 * @returns {string[]}
 */
export function buildDeployPlan(state = { d1Exists: false, existingQueues: [] }) {
  const steps = [];

  // D1
  if (!state.d1Exists) {
    steps.push(`Create D1 database: ${D1_DATABASE_NAME}`);
  }
  steps.push(`Run D1 migrations from ${D1_MIGRATIONS_PATH}`);

  // Queues
  const missingQueues = REQUIRED_QUEUES.filter(
    (q) => !state.existingQueues.includes(q)
  );
  for (const q of missingQueues) {
    steps.push(`Create queue: ${q}`);
  }

  // Workers
  for (const worker of WORKER_DEPLOY_ORDER) {
    steps.push(`Deploy worker: tminus-${worker}`);
  }

  return steps;
}

/**
 * Parse CLI arguments for the deploy script.
 *
 * @param {string[]} argv -- process.argv.slice(2)
 * @returns {{ dryRun: boolean, skipSecrets: boolean, skipMigrations: boolean, verbose: boolean }}
 */
export function parseArgs(argv) {
  return {
    dryRun: argv.includes("--dry-run"),
    skipSecrets: argv.includes("--skip-secrets"),
    skipMigrations: argv.includes("--skip-migrations"),
    verbose: argv.includes("--verbose") || argv.includes("-v"),
  };
}
