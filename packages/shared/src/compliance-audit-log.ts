/**
 * Compliance-grade audit log with hash chain integrity (TM-9iu.5).
 *
 * Provides:
 * 1. Append-only audit log for all delegation operations
 * 2. Tamper-evident hash chain: each entry includes hash of previous entry
 * 3. Configurable retention per-org (default 90 days, compliance orgs 7 years)
 * 4. Export capability in JSON-lines format for compliance auditors
 *
 * Required fields per entry:
 * - timestamp, actor, action, target, result, ip_address, user_agent
 *
 * Actions tracked:
 * - delegation_created, delegation_rotated, user_discovered, user_suspended,
 *   user_removed, config_updated, token_issued, admin_action
 *
 * Hash chain design:
 * - Each entry's hash = SHA-256(previous_hash + entry_data)
 * - First entry uses a well-known genesis hash
 * - Verification walks the chain and recomputes hashes
 *
 * Business rules:
 * - BR-2: Audit log is append-only (no updates, no deletes)
 * - BR-3: Hash chain integrity verified on read
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All possible audit log actions. */
export type ComplianceAuditAction =
  | "delegation_created"
  | "delegation_rotated"
  | "user_discovered"
  | "user_suspended"
  | "user_removed"
  | "config_updated"
  | "token_issued"
  | "admin_action";

/** Result of an audited operation. */
export type AuditResult = "success" | "failure" | "error";

/** A single compliance audit log entry. */
export interface ComplianceAuditEntry {
  /** Unique entry identifier. */
  entryId: string;
  /** Organization ID this entry belongs to. */
  orgId: string;
  /** ISO 8601 timestamp of when the action occurred. */
  timestamp: string;
  /** Who performed the action (email or system identifier). */
  actor: string;
  /** What action was performed. */
  action: ComplianceAuditAction;
  /** What was the target of the action (user email, delegation ID, etc). */
  target: string;
  /** Outcome of the action. */
  result: AuditResult;
  /** Client IP address. */
  ipAddress: string;
  /** Client user-agent string. */
  userAgent: string;
  /** Additional details as JSON string. */
  details: string | null;
  /** SHA-256 hash of the previous entry (genesis hash for first entry). */
  previousHash: string;
  /** SHA-256 hash of this entry (computed from previous_hash + entry data). */
  entryHash: string;
}

/** Input for creating a new audit log entry (before hash computation). */
export interface ComplianceAuditInput {
  /** Unique entry identifier. */
  entryId: string;
  /** Organization ID. */
  orgId: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Who performed the action. */
  actor: string;
  /** What action was performed. */
  action: ComplianceAuditAction;
  /** Target of the action. */
  target: string;
  /** Result of the action. */
  result: AuditResult;
  /** Client IP address. */
  ipAddress: string;
  /** Client user-agent string. */
  userAgent: string;
  /** Additional details. */
  details: string | null;
}

/** Per-org audit log retention configuration. */
export interface AuditRetentionConfig {
  /** Retention period in days. Default 90, compliance orgs up to 2555 (7 years). */
  retentionDays: number;
}

/** Result of a hash chain verification. */
export interface ChainVerificationResult {
  /** Whether the entire chain is valid. */
  valid: boolean;
  /** Total entries checked. */
  entriesChecked: number;
  /** Index of first invalid entry (-1 if all valid). */
  firstInvalidIndex: number;
  /** Error message if verification failed. */
  error: string | null;
}

/** Interface for compliance audit log persistence. */
export interface ComplianceAuditStore {
  /** Get the hash of the most recent entry for an org. Returns genesis hash if no entries. */
  getLastEntryHash(orgId: string): Promise<string>;
  /** Append a new entry (must be append-only -- implementations must not allow updates). */
  appendEntry(entry: ComplianceAuditEntry): Promise<void>;
  /** Get entries for an org within a date range, ordered by timestamp ascending. */
  getEntries(
    orgId: string,
    startDate: string,
    endDate: string,
    limit?: number,
    offset?: number,
  ): Promise<ComplianceAuditEntry[]>;
  /** Get total entry count for an org within a date range. */
  getEntryCount(orgId: string, startDate: string, endDate: string): Promise<number>;
  /** Get entries for hash chain verification (ordered ascending). */
  getEntriesForVerification(orgId: string, limit?: number): Promise<ComplianceAuditEntry[]>;
  /** Get retention config for an org. Returns null if using defaults. */
  getRetentionConfig(orgId: string): Promise<AuditRetentionConfig | null>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Genesis hash for the first entry in a chain. Well-known constant. */
export const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

/** Default retention: 90 days. */
export const DEFAULT_RETENTION_DAYS = 90;

/** Compliance retention: 7 years (2555 days). */
export const COMPLIANCE_RETENTION_DAYS = 2555;

/** Valid audit actions for input validation. */
export const VALID_AUDIT_ACTIONS: readonly ComplianceAuditAction[] = [
  "delegation_created",
  "delegation_rotated",
  "user_discovered",
  "user_suspended",
  "user_removed",
  "config_updated",
  "token_issued",
  "admin_action",
] as const;

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hash of the given data string.
 * Returns lowercase hex string.
 *
 * Uses Web Crypto API (available in Cloudflare Workers and Node 20+).
 */
export async function sha256(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compute the canonical string representation of an audit entry for hashing.
 *
 * The canonical form is a deterministic JSON string of the entry's data fields
 * (excluding entryHash itself). This ensures that any change to entry data
 * invalidates the hash.
 */
export function canonicalizeEntry(entry: ComplianceAuditInput, previousHash: string): string {
  return JSON.stringify({
    entryId: entry.entryId,
    orgId: entry.orgId,
    timestamp: entry.timestamp,
    actor: entry.actor,
    action: entry.action,
    target: entry.target,
    result: entry.result,
    ipAddress: entry.ipAddress,
    userAgent: entry.userAgent,
    details: entry.details,
    previousHash,
  });
}

/**
 * Compute the hash for a new audit entry.
 *
 * hash = SHA-256(previous_hash + canonical_entry_data)
 */
export async function computeEntryHash(
  entry: ComplianceAuditInput,
  previousHash: string,
): Promise<string> {
  const canonical = canonicalizeEntry(entry, previousHash);
  return sha256(canonical);
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Create and append a new audit log entry with hash chain integrity.
 *
 * 1. Gets the hash of the last entry for this org
 * 2. Computes the hash of the new entry
 * 3. Appends the entry to the store
 *
 * @param store - Audit log persistence
 * @param input - Entry data (without hash fields)
 * @returns The complete audit entry with hashes
 */
export async function appendAuditEntry(
  store: ComplianceAuditStore,
  input: ComplianceAuditInput,
): Promise<ComplianceAuditEntry> {
  // Validate action
  if (!VALID_AUDIT_ACTIONS.includes(input.action)) {
    throw new Error(`Invalid audit action: ${input.action}`);
  }

  const previousHash = await store.getLastEntryHash(input.orgId);
  const entryHash = await computeEntryHash(input, previousHash);

  const entry: ComplianceAuditEntry = {
    ...input,
    previousHash,
    entryHash,
  };

  await store.appendEntry(entry);
  return entry;
}

/**
 * Verify the hash chain integrity for an org's audit log.
 *
 * Walks the chain from oldest to newest, recomputing each entry's hash
 * and comparing against the stored hash.
 *
 * @param store - Audit log persistence
 * @param orgId - Organization to verify
 * @param limit - Maximum entries to verify (for large logs)
 * @returns ChainVerificationResult
 */
export async function verifyHashChain(
  store: ComplianceAuditStore,
  orgId: string,
  limit?: number,
): Promise<ChainVerificationResult> {
  const entries = await store.getEntriesForVerification(orgId, limit);

  if (entries.length === 0) {
    return {
      valid: true,
      entriesChecked: 0,
      firstInvalidIndex: -1,
      error: null,
    };
  }

  // First entry must reference genesis hash
  if (entries[0].previousHash !== GENESIS_HASH) {
    return {
      valid: false,
      entriesChecked: 1,
      firstInvalidIndex: 0,
      error: `First entry does not reference genesis hash. Expected: ${GENESIS_HASH}, got: ${entries[0].previousHash}`,
    };
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    // Verify this entry's hash
    const expectedPreviousHash = i === 0 ? GENESIS_HASH : entries[i - 1].entryHash;

    if (entry.previousHash !== expectedPreviousHash) {
      return {
        valid: false,
        entriesChecked: i + 1,
        firstInvalidIndex: i,
        error: `Entry ${i} (${entry.entryId}): previousHash mismatch. Expected: ${expectedPreviousHash}, got: ${entry.previousHash}`,
      };
    }

    // Recompute the hash and verify
    const input: ComplianceAuditInput = {
      entryId: entry.entryId,
      orgId: entry.orgId,
      timestamp: entry.timestamp,
      actor: entry.actor,
      action: entry.action,
      target: entry.target,
      result: entry.result,
      ipAddress: entry.ipAddress,
      userAgent: entry.userAgent,
      details: entry.details,
    };

    const recomputedHash = await computeEntryHash(input, entry.previousHash);

    if (recomputedHash !== entry.entryHash) {
      return {
        valid: false,
        entriesChecked: i + 1,
        firstInvalidIndex: i,
        error: `Entry ${i} (${entry.entryId}): entryHash mismatch. Expected: ${recomputedHash}, got: ${entry.entryHash}`,
      };
    }
  }

  return {
    valid: true,
    entriesChecked: entries.length,
    firstInvalidIndex: -1,
    error: null,
  };
}

/**
 * Export audit log entries in JSON-lines format.
 *
 * Each line is a self-contained JSON object representing one audit entry.
 * This format is preferred by compliance auditors because:
 * - Each line is independently parseable
 * - Easy to stream/append
 * - Compatible with common log analysis tools (jq, Splunk, etc.)
 *
 * @param store - Audit log persistence
 * @param orgId - Organization to export
 * @param startDate - Start of date range (ISO 8601)
 * @param endDate - End of date range (ISO 8601)
 * @returns JSON-lines string (newline-separated JSON objects)
 */
export async function exportAuditLog(
  store: ComplianceAuditStore,
  orgId: string,
  startDate: string,
  endDate: string,
): Promise<string> {
  const entries = await store.getEntries(orgId, startDate, endDate);
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

// ---------------------------------------------------------------------------
// Compliance report
// ---------------------------------------------------------------------------

/** Summary for compliance reporting. */
export interface ComplianceReport {
  /** Organization ID. */
  orgId: string;
  /** Start of reporting period. */
  periodStart: string;
  /** End of reporting period. */
  periodEnd: string;
  /** Total audit log entries in the period. */
  totalEntries: number;
  /** Total API calls (token_issued actions). */
  totalApiCalls: number;
  /** Unique users who had tokens issued. */
  uniqueUsers: string[];
  /** Number of credential rotations. */
  credentialRotations: number;
  /** Number of policy/config changes. */
  policyChanges: number;
  /** Anomalies detected (unusual patterns). */
  anomalies: ComplianceAnomaly[];
  /** Hash chain integrity status. */
  chainIntegrity: ChainVerificationResult;
  /** Report generated at. */
  generatedAt: string;
}

/** An anomaly detected in audit data. */
export interface ComplianceAnomaly {
  /** Type of anomaly. */
  type: "high_token_rate" | "unusual_hours" | "multiple_failures" | "bulk_operations";
  /** Human-readable description. */
  description: string;
  /** Number of occurrences. */
  count: number;
}

/**
 * Generate a compliance report for an org within a date range.
 *
 * Analyzes audit entries to produce a summary including:
 * - Total API calls and unique users
 * - Credential rotations and policy changes
 * - Anomaly detection (high token rates, multiple failures)
 * - Hash chain integrity verification
 */
export async function generateComplianceReport(
  store: ComplianceAuditStore,
  orgId: string,
  startDate: string,
  endDate: string,
): Promise<ComplianceReport> {
  const entries = await store.getEntries(orgId, startDate, endDate);

  let totalApiCalls = 0;
  const uniqueUsersSet = new Set<string>();
  let credentialRotations = 0;
  let policyChanges = 0;
  let failureCount = 0;

  // Action counts for anomaly detection
  const tokenIssueTimestamps: number[] = [];

  for (const entry of entries) {
    switch (entry.action) {
      case "token_issued":
        totalApiCalls++;
        uniqueUsersSet.add(entry.target);
        tokenIssueTimestamps.push(new Date(entry.timestamp).getTime());
        break;
      case "delegation_rotated":
        credentialRotations++;
        break;
      case "config_updated":
        policyChanges++;
        break;
    }

    if (entry.result === "failure" || entry.result === "error") {
      failureCount++;
    }
  }

  // Anomaly detection
  const anomalies: ComplianceAnomaly[] = [];

  // Check for high token issuance rate (>100 per hour in any window)
  if (tokenIssueTimestamps.length > 100) {
    tokenIssueTimestamps.sort((a, b) => a - b);
    const HOUR_MS = 60 * 60 * 1000;
    for (let i = 0; i <= tokenIssueTimestamps.length - 100; i++) {
      if (tokenIssueTimestamps[i + 99] - tokenIssueTimestamps[i] < HOUR_MS) {
        anomalies.push({
          type: "high_token_rate",
          description: "More than 100 token issuances detected within a single hour window",
          count: 100,
        });
        break;
      }
    }
  }

  // Check for multiple failures (>10 in the period)
  if (failureCount > 10) {
    anomalies.push({
      type: "multiple_failures",
      description: `${failureCount} failed operations detected in the reporting period`,
      count: failureCount,
    });
  }

  // Verify hash chain integrity
  const chainIntegrity = await verifyHashChain(store, orgId);

  return {
    orgId,
    periodStart: startDate,
    periodEnd: endDate,
    totalEntries: entries.length,
    totalApiCalls,
    uniqueUsers: Array.from(uniqueUsersSet),
    credentialRotations,
    policyChanges,
    anomalies,
    chainIntegrity,
    generatedAt: new Date().toISOString(),
  };
}
