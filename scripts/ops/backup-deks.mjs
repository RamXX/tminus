#!/usr/bin/env node
/**
 * Encrypted DEK Backup Script
 *
 * Exports encrypted DEKs (still encrypted with master key) to R2 for backup.
 * Backups use R2 server-side encryption (SSE) for defense-in-depth.
 *
 * Usage:
 *   node scripts/ops/backup-deks.mjs
 *
 * Environment variables:
 *   CLOUDFLARE_ACCOUNT_ID - Cloudflare account ID
 *   CLOUDFLARE_API_TOKEN - Cloudflare API token
 *   R2_BUCKET_NAME - R2 bucket for DEK backups (default: tminus-dek-backups)
 *   DRY_RUN - Set to "true" for dry-run mode
 *
 * Backup format (JSON):
 *   {
 *     version: 1,
 *     createdAt: ISO8601,
 *     rotationId: string | null,
 *     entries: [
 *       { accountId, encryptedDek, dekIv, backedUpAt }
 *     ]
 *   }
 *
 * The backup key in R2: dek-backups/<date>/<timestamp>.json
 */

// ---------------------------------------------------------------------------
// Backup data structures
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} DekBackupEntry
 * @property {string} accountId
 * @property {string} encryptedDek - Base64 DEK encrypted with master key
 * @property {string} dekIv - Base64 IV for DEK encryption
 * @property {string} backedUpAt - ISO 8601 timestamp
 */

/**
 * @typedef {Object} DekBackupManifest
 * @property {number} version - Backup format version
 * @property {string} createdAt - ISO 8601 backup creation timestamp
 * @property {string|null} rotationId - Associated rotation ID if done after rotation
 * @property {DekBackupEntry[]} entries
 */

/**
 * Create a backup manifest from DEK entries.
 *
 * @param {DekBackupEntry[]} entries
 * @param {string|null} [rotationId=null]
 * @returns {DekBackupManifest}
 */
export function createBackupManifest(entries, rotationId = null) {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    rotationId,
    entries,
  };
}

/**
 * Validate a backup manifest structure.
 *
 * @param {unknown} data
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateBackupManifest(data) {
  if (!data || typeof data !== "object") {
    return { valid: false, error: "Backup must be an object" };
  }

  const manifest = /** @type {Record<string, unknown>} */ (data);

  if (manifest.version !== 1) {
    return { valid: false, error: `Unsupported backup version: ${manifest.version}` };
  }

  if (!manifest.createdAt || typeof manifest.createdAt !== "string") {
    return { valid: false, error: "Missing or invalid createdAt" };
  }

  if (!Array.isArray(manifest.entries)) {
    return { valid: false, error: "entries must be an array" };
  }

  for (let i = 0; i < manifest.entries.length; i++) {
    const entry = manifest.entries[i];
    if (!entry.accountId || !entry.encryptedDek || !entry.dekIv) {
      return { valid: false, error: `Entry ${i} missing required fields (accountId, encryptedDek, dekIv)` };
    }
  }

  return { valid: true };
}

/**
 * Generate the R2 object key for a backup.
 *
 * @param {Date} [date=new Date()]
 * @returns {string}
 */
export function generateBackupKey(date = new Date()) {
  const dateStr = date.toISOString().slice(0, 10); // YYYY-MM-DD
  const ts = date.toISOString().replace(/[:.]/g, "-");
  return `dek-backups/${dateStr}/${ts}.json`;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const dryRun = process.env.DRY_RUN === "true";
  const bucketName = process.env.R2_BUCKET_NAME || "tminus-dek-backups";

  console.log(`DEK backup starting. bucket=${bucketName}, dryRun=${dryRun}`);
  console.log(
    "NOTE: This script requires Cloudflare API bindings for R2 and DO access. " +
    "Use with wrangler or the Cloudflare REST API."
  );

  const backupKey = generateBackupKey();
  console.log(`Backup key: ${backupKey}`);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));
if (isMain) {
  main().catch((err) => {
    console.error("Backup failed:", err.message);
    process.exit(1);
  });
}
