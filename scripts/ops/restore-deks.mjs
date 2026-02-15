#!/usr/bin/env node
/**
 * Encrypted DEK Restore Script
 *
 * Imports encrypted DEKs from an R2 backup back to AccountDO instances.
 * Used for disaster recovery when AccountDO storage is corrupted or lost.
 *
 * Usage:
 *   BACKUP_KEY=dek-backups/2026-02-14/... node scripts/ops/restore-deks.mjs
 *
 * Environment variables:
 *   CLOUDFLARE_ACCOUNT_ID - Cloudflare account ID
 *   CLOUDFLARE_API_TOKEN - Cloudflare API token
 *   R2_BUCKET_NAME - R2 bucket for DEK backups (default: tminus-dek-backups)
 *   BACKUP_KEY - R2 object key to restore from (required)
 *   DRY_RUN - Set to "true" for dry-run mode
 *
 * Process:
 *   1. Fetch backup manifest from R2
 *   2. Validate manifest structure
 *   3. For each entry, call AccountDO.restoreDekFromBackup()
 *   4. Print summary
 */

import { validateBackupManifest } from "./backup-deks.mjs";

// ---------------------------------------------------------------------------
// Restore orchestration
// ---------------------------------------------------------------------------

/**
 * Restore DEKs from a backup manifest to AccountDOs.
 *
 * @param {object} opts
 * @param {import("./backup-deks.mjs").DekBackupManifest} opts.manifest
 * @param {function} opts.restoreAccountDek - (accountId, entry) => Promise<void>
 * @param {boolean} [opts.dryRun=false]
 * @returns {Promise<{total: number, restored: number, failed: number, errors: Array<{accountId: string, error: string}>}>}
 */
export async function restoreAllDeks(opts) {
  const { manifest, restoreAccountDek, dryRun = false } = opts;

  const validation = validateBackupManifest(manifest);
  if (!validation.valid) {
    throw new Error(`Invalid backup manifest: ${validation.error}`);
  }

  const result = {
    total: manifest.entries.length,
    restored: 0,
    failed: 0,
    errors: [],
  };

  for (const entry of manifest.entries) {
    if (dryRun) {
      console.log(`[DRY RUN] Would restore DEK for account: ${entry.accountId}`);
      result.restored++;
      continue;
    }

    try {
      await restoreAccountDek(entry.accountId, entry);
      result.restored++;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      result.failed++;
      result.errors.push({ accountId: entry.accountId, error: errorMessage });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const dryRun = process.env.DRY_RUN === "true";
  const bucketName = process.env.R2_BUCKET_NAME || "tminus-dek-backups";
  const backupKey = process.env.BACKUP_KEY;

  if (!backupKey) {
    throw new Error("BACKUP_KEY environment variable is required");
  }

  console.log(`DEK restore starting. bucket=${bucketName}, key=${backupKey}, dryRun=${dryRun}`);
  console.log(
    "NOTE: This script requires Cloudflare API bindings for R2 and DO access. " +
    "Use with wrangler or the Cloudflare REST API."
  );
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));
if (isMain) {
  main().catch((err) => {
    console.error("Restore failed:", err.message);
    process.exit(1);
  });
}
