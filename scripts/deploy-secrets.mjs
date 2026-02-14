#!/usr/bin/env node

/**
 * deploy-secrets.mjs -- Push secrets from .env to Cloudflare workers.
 *
 * Usage:
 *   node scripts/deploy-secrets.mjs [options]
 *
 * Options:
 *   --dry-run       Print what would be done without executing
 *   --verbose, -v   Verbose output
 *
 * Reads .env from project root, maps secrets to workers per SECRET_MAP,
 * and pushes each via `wrangler secret put` with value piped via stdin
 * (never exposed on the command line).
 *
 * JWT_SECRET and MASTER_KEY are set to the SAME value on both tminus-api
 * and tminus-oauth to ensure cross-worker encryption compatibility.
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseEnvFile, buildSecretPlan, SECRET_MAP } from "./deploy-config.mjs";

const ROOT = resolve(import.meta.dirname, "..");

function log(msg) {
  process.stdout.write(`[deploy-secrets] ${msg}\n`);
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const verbose = args.includes("--verbose") || args.includes("-v");

  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) {
    process.stderr.write(
      "[deploy-secrets] ERROR: .env file not found. Copy .env.example and fill in values.\n"
    );
    process.exit(1);
  }

  const envContent = readFileSync(envPath, "utf-8");
  const envVars = parseEnvFile(envContent);
  const plan = buildSecretPlan(envVars);

  if (plan.length === 0) {
    log("No secrets found in .env matching SECRET_MAP.");
    log("Expected keys: " + Object.keys(SECRET_MAP).join(", "));
    process.exit(1);
  }

  log(`${plan.length} secret(s) to deploy:`);
  for (const { secretName, workerName } of plan) {
    log(`  ${secretName} -> ${workerName}`);
  }

  if (dryRun) {
    log("DRY RUN -- no changes made.");
    return;
  }

  log("");
  let errors = 0;
  for (const { secretName, workerName, value } of plan) {
    log(`Setting ${secretName} on ${workerName}...`);
    try {
      execSync(`npx wrangler secret put ${secretName} --name ${workerName}`, {
        cwd: ROOT,
        encoding: "utf-8",
        input: value,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
      log(`  OK`);
    } catch (err) {
      const stderr = err.stderr?.trim() || err.message;
      // Some versions of wrangler exit non-zero even on success
      if (stderr.includes("Success")) {
        log(`  OK (via stderr)`);
      } else {
        log(`  FAILED: ${stderr}`);
        errors++;
      }
    }
  }

  if (errors > 0) {
    log(`\nCompleted with ${errors} error(s).`);
    process.exit(1);
  }

  log("\nAll secrets deployed successfully.");
}

main();
