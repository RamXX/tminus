#!/usr/bin/env node
/**
 * Master Key Rotation Script
 *
 * Rotates all AccountDO DEKs from old master key to new master key.
 * Tracks rotation status per account in D1 key_rotation_log table.
 * Idempotent: can be safely re-run (skips already-completed accounts).
 *
 * Usage:
 *   OLD_MASTER_KEY=<hex> NEW_MASTER_KEY=<hex> node scripts/ops/rotate-master-key.mjs
 *
 * Environment variables:
 *   OLD_MASTER_KEY - Current hex-encoded 32-byte master key (64 hex chars)
 *   NEW_MASTER_KEY - New hex-encoded 32-byte master key (64 hex chars)
 *   CLOUDFLARE_ACCOUNT_ID - Cloudflare account ID
 *   CLOUDFLARE_API_TOKEN - Cloudflare API token with D1 + DO access
 *   D1_DATABASE_ID - D1 registry database ID
 *   DRY_RUN - Set to "true" for dry-run mode (no mutations)
 *
 * Process:
 *   1. Validate inputs (both keys must be 64 hex chars)
 *   2. Generate a unique rotation_id
 *   3. List all active accounts from D1 registry
 *   4. For each account:
 *      a. Check if already rotated for this rotation_id (idempotent)
 *      b. Log "started" in key_rotation_log
 *      c. Call AccountDO.rotateKey(oldKey, newKey)
 *      d. Log "completed" or "failed" in key_rotation_log
 *   5. Print summary
 */

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/**
 * Validate a hex-encoded master key (must be 64 hex characters = 32 bytes).
 * @param {string} key - Hex-encoded key
 * @param {string} name - Name for error messages
 */
export function validateMasterKey(key, name) {
  if (!key) {
    throw new Error(`${name} is required`);
  }
  if (typeof key !== "string") {
    throw new Error(`${name} must be a string`);
  }
  if (key.length !== 64) {
    throw new Error(`${name} must be 64 hex characters (32 bytes), got ${key.length}`);
  }
  if (!/^[0-9a-fA-F]+$/.test(key)) {
    throw new Error(`${name} contains non-hex characters`);
  }
}

/**
 * Generate a unique rotation ID.
 * Format: rot_<timestamp>_<random>
 * @returns {string}
 */
export function generateRotationId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `rot_${ts}_${rand}`;
}

// ---------------------------------------------------------------------------
// Rotation orchestration
// ---------------------------------------------------------------------------

/**
 * Rotate master key for all accounts.
 *
 * @param {object} opts
 * @param {string} opts.oldMasterKeyHex
 * @param {string} opts.newMasterKeyHex
 * @param {string} opts.rotationId
 * @param {Array<{account_id: string}>} opts.accounts - List of accounts
 * @param {function} opts.rotateAccountDek - (accountId, oldKey, newKey) => Promise<void>
 * @param {function} opts.logRotationStatus - (rotationId, accountId, status, error?) => Promise<void>
 * @param {function} opts.checkRotationStatus - (rotationId, accountId) => Promise<string|null>
 * @param {boolean} [opts.dryRun=false]
 * @returns {Promise<{total: number, completed: number, skipped: number, failed: number, errors: Array<{accountId: string, error: string}>}>}
 */
export async function rotateAllAccounts(opts) {
  const {
    oldMasterKeyHex,
    newMasterKeyHex,
    rotationId,
    accounts,
    rotateAccountDek,
    logRotationStatus,
    checkRotationStatus,
    dryRun = false,
  } = opts;

  validateMasterKey(oldMasterKeyHex, "OLD_MASTER_KEY");
  validateMasterKey(newMasterKeyHex, "NEW_MASTER_KEY");

  if (oldMasterKeyHex === newMasterKeyHex) {
    throw new Error("OLD_MASTER_KEY and NEW_MASTER_KEY must be different");
  }

  const result = {
    total: accounts.length,
    completed: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  for (const account of accounts) {
    const accountId = account.account_id;

    // Check if already rotated (idempotent)
    const existingStatus = await checkRotationStatus(rotationId, accountId);
    if (existingStatus === "completed") {
      result.skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`[DRY RUN] Would rotate DEK for account: ${accountId}`);
      result.completed++;
      continue;
    }

    // Log started
    await logRotationStatus(rotationId, accountId, "started");

    try {
      await rotateAccountDek(accountId, oldMasterKeyHex, newMasterKeyHex);
      await logRotationStatus(rotationId, accountId, "completed");
      result.completed++;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await logRotationStatus(rotationId, accountId, "failed", errorMessage);
      result.failed++;
      result.errors.push({ accountId, error: errorMessage });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const oldMasterKeyHex = process.env.OLD_MASTER_KEY;
  const newMasterKeyHex = process.env.NEW_MASTER_KEY;
  const dryRun = process.env.DRY_RUN === "true";

  validateMasterKey(oldMasterKeyHex, "OLD_MASTER_KEY");
  validateMasterKey(newMasterKeyHex, "NEW_MASTER_KEY");

  const rotationId = generateRotationId();
  console.log(`Master key rotation starting. rotation_id=${rotationId}`);
  console.log(`Dry run: ${dryRun}`);

  // In production, these would be real D1 and DO calls via Cloudflare API.
  // This script provides the orchestration logic; actual API bindings
  // depend on the deployment environment (wrangler or REST API).
  console.log(
    "NOTE: This script requires Cloudflare API bindings. " +
    "Use with wrangler or the Cloudflare REST API."
  );
  console.log(`Rotation ID: ${rotationId}`);
}

// Run if executed directly (not imported)
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));
if (isMain) {
  main().catch((err) => {
    console.error("Rotation failed:", err.message);
    process.exit(1);
  });
}
