#!/usr/bin/env node

/**
 * deploy.mjs -- Orchestrate deployment of all T-Minus Cloudflare resources.
 *
 * Usage:
 *   node scripts/deploy.mjs [options]
 *
 * Options:
 *   --dry-run          Print what would be done without executing
 *   --skip-secrets     Skip secret provisioning
 *   --skip-migrations  Skip D1 migrations
 *   --verbose, -v      Verbose output
 *
 * Environment:
 *   CLOUDFLARE_API_TOKEN   -- Wrangler auth token (from .env)
 *   CLOUDFLARE_ACCOUNT_ID  -- Cloudflare account ID (from .env)
 *
 * This script is idempotent: running it multiple times is safe.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  parseArgs,
  parseEnvFile,
  buildDeployPlan,
  buildSecretPlan,
  replacePlaceholderD1Id,
  findPlaceholderTomlFiles,
  WORKER_DEPLOY_ORDER,
  REQUIRED_QUEUES,
  D1_DATABASE_NAME,
  D1_MIGRATIONS_PATH,
} from "./deploy-config.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname, "..");

function log(msg) {
  process.stdout.write(`[deploy] ${msg}\n`);
}

function logVerbose(msg, verbose) {
  if (verbose) log(msg);
}

/**
 * Run a shell command and return stdout. Inherits env from process.
 * On failure, throws with stderr info.
 */
function run(cmd, { verbose = false, allowFailure = false } = {}) {
  if (verbose) log(`$ ${cmd}`);
  try {
    const output = execSync(cmd, {
      cwd: ROOT,
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
 * Push a secret value to a worker via stdin (avoids command-line exposure).
 */
function putSecret(workerName, secretName, value, { verbose = false } = {}) {
  if (verbose) log(`Setting secret ${secretName} on ${workerName}`);
  try {
    execSync(`npx wrangler secret put ${secretName} --name ${workerName}`, {
      cwd: ROOT,
      encoding: "utf-8",
      input: value,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
  } catch (err) {
    // wrangler secret put may warn if secret already exists; not fatal
    const stderr = err.stderr?.trim() || "";
    if (stderr.includes("already exists") || stderr.includes("Success")) {
      logVerbose(`Secret ${secretName} already set on ${workerName}`, verbose);
    } else {
      throw new Error(
        `Failed to set secret ${secretName} on ${workerName}: ${stderr}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Step 1: Ensure D1 database exists, return database ID.
 * Idempotent: if database already exists, return its existing ID.
 */
function ensureD1Database(verbose) {
  log("Checking D1 database...");

  // List existing databases
  const listOutput = run("npx wrangler d1 list --json", { verbose });
  let databases;
  try {
    databases = JSON.parse(listOutput);
  } catch {
    databases = [];
  }

  const existing = databases.find((db) => db.name === D1_DATABASE_NAME);
  if (existing) {
    log(`D1 database '${D1_DATABASE_NAME}' already exists (ID: ${existing.uuid})`);
    return existing.uuid;
  }

  log(`Creating D1 database '${D1_DATABASE_NAME}'...`);
  // wrangler d1 create does not support --json; parse database_id from text output
  const createOutput = run(
    `npx wrangler d1 create ${D1_DATABASE_NAME}`,
    { verbose }
  );
  // Output contains a JSON snippet with "database_id": "<uuid>"
  const idMatch = createOutput.match(/"database_id"\s*:\s*"([^"]+)"/);
  if (idMatch) {
    log(`D1 database created (ID: ${idMatch[1]})`);
    return idMatch[1];
  }
  // Fallback: try to extract any UUID
  const uuidMatch = createOutput.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (uuidMatch) {
    log(`D1 database created (ID: ${uuidMatch[1]})`);
    return uuidMatch[1];
  }
  throw new Error(`Failed to parse D1 database ID from create output:\n${createOutput}`);
}

/**
 * Step 2: Patch placeholder D1 IDs in wrangler.toml files.
 * Patches both worker wrangler.toml files AND the root wrangler-d1.toml.
 * Idempotent: only patches files still containing 'placeholder-d1-id'.
 */
function patchD1Ids(databaseId, verbose) {
  const files = findPlaceholderTomlFiles(ROOT);

  // Also check the root wrangler-d1.toml used for migrations
  const d1TomlPath = join(ROOT, "wrangler-d1.toml");
  if (existsSync(d1TomlPath)) {
    const content = readFileSync(d1TomlPath, "utf-8");
    if (content.includes("placeholder-d1-id") && !files.includes(d1TomlPath)) {
      files.push(d1TomlPath);
    }
  }

  if (files.length === 0) {
    log("No placeholder D1 IDs to patch");
    return;
  }

  log(`Patching ${files.length} wrangler.toml files with D1 ID: ${databaseId}`);
  for (const filePath of files) {
    const content = readFileSync(filePath, "utf-8");
    const updated = replacePlaceholderD1Id(content, databaseId);
    writeFileSync(filePath, updated, "utf-8");
    logVerbose(`  Patched: ${filePath}`, verbose);
  }
}

/**
 * Step 3: Run D1 migrations using wrangler-d1.toml config at project root.
 * The config defines migrations_dir pointing to migrations/d1-registry/.
 */
function runD1Migrations(databaseId, verbose) {
  log("Running D1 migrations...");
  const migrationsDir = join(ROOT, D1_MIGRATIONS_PATH);
  if (!existsSync(migrationsDir)) {
    log(`Migrations directory not found: ${D1_MIGRATIONS_PATH} -- skipping`);
    return;
  }

  // Use wrangler-d1.toml which has migrations_dir set correctly
  const output = run(
    `npx wrangler d1 migrations apply ${D1_DATABASE_NAME} --remote --config wrangler-d1.toml`,
    { verbose }
  );
  log("D1 migrations applied");
  if (verbose) log(output);
}

/**
 * Step 4: Ensure all required queues exist.
 * Idempotent: only creates queues that do not already exist.
 */
function ensureQueues(verbose) {
  log("Checking queues...");

  let existingQueues = [];
  try {
    // wrangler queues list does not support --json; parse text output.
    // Output format: table rows with queue names, or empty if no queues.
    const listOutput = run("npx wrangler queues list", {
      verbose,
      allowFailure: true,
    });
    if (listOutput) {
      // Extract queue names from output. Each tminus-* name is a queue we care about.
      for (const q of REQUIRED_QUEUES) {
        if (listOutput.includes(q)) {
          existingQueues.push(q);
        }
      }
    }
  } catch {
    // If queues list fails (e.g., no queues exist yet), just create all
  }

  const missing = REQUIRED_QUEUES.filter((q) => !existingQueues.includes(q));

  if (missing.length === 0) {
    log("All queues already exist");
    return;
  }

  for (const queueName of missing) {
    log(`Creating queue: ${queueName}`);
    run(`npx wrangler queues create ${queueName}`, { verbose });
  }
  log(`Created ${missing.length} queue(s)`);
}

/**
 * Step 5: Deploy workers in order.
 */
function deployWorkers(verbose) {
  log("Deploying workers...");

  for (const worker of WORKER_DEPLOY_ORDER) {
    const workerDir = join(ROOT, "workers", worker);
    log(`Deploying tminus-${worker}...`);

    try {
      const output = execSync("npx wrangler deploy", {
        cwd: workerDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
      if (verbose) log(output.trim());
    } catch (err) {
      const stderr = err.stderr?.trim() || err.message;
      throw new Error(`Failed to deploy tminus-${worker}:\n${stderr}`);
    }
  }
  log(`All ${WORKER_DEPLOY_ORDER.length} workers deployed`);
}

/**
 * Step 6: Deploy secrets from .env file.
 */
function deploySecrets(verbose) {
  log("Deploying secrets...");

  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) {
    throw new Error(".env file not found at project root. Copy .env.example and fill in values.");
  }

  const envContent = readFileSync(envPath, "utf-8");
  const envVars = parseEnvFile(envContent);
  const plan = buildSecretPlan(envVars);

  if (plan.length === 0) {
    log("No secrets to deploy (none found in .env matching SECRET_MAP)");
    return;
  }

  for (const { secretName, workerName, value } of plan) {
    log(`Setting ${secretName} on ${workerName}...`);
    putSecret(workerName, secretName, value, { verbose });
  }
  log(`Deployed ${plan.length} secret(s)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  log("T-Minus Deployment");
  log("==================");
  log("");

  // Verify wrangler authentication
  try {
    const whoami = run("npx wrangler whoami", { verbose: args.verbose });
    logVerbose(whoami, args.verbose);
  } catch {
    throw new Error(
      "wrangler authentication failed. Ensure CLOUDFLARE_API_TOKEN is set in .env and sourced."
    );
  }

  if (args.dryRun) {
    log("DRY RUN -- no changes will be made\n");
    const steps = buildDeployPlan();
    for (const step of steps) {
      log(`  [dry-run] ${step}`);
    }
    log("\nDry run complete.");
    return;
  }

  // Step 1: D1 database
  const databaseId = ensureD1Database(args.verbose);

  // Step 2: Patch placeholder IDs
  patchD1Ids(databaseId, args.verbose);

  // Step 3: D1 migrations
  if (!args.skipMigrations) {
    runD1Migrations(databaseId, args.verbose);
  } else {
    log("Skipping D1 migrations (--skip-migrations)");
  }

  // Step 4: Queues
  ensureQueues(args.verbose);

  // Step 5: Deploy workers
  deployWorkers(args.verbose);

  // Step 6: Secrets
  if (!args.skipSecrets) {
    deploySecrets(args.verbose);
  } else {
    log("Skipping secrets (--skip-secrets)");
  }

  log("");
  log("Deployment complete.");
}

main().catch((err) => {
  process.stderr.write(`\n[deploy] ERROR: ${err.message}\n`);
  process.exit(1);
});
