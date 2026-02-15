/**
 * @tminus/shared -- Signed deletion certificate generation for GDPR compliance.
 *
 * Generates cryptographically signed certificates proving complete data erasure.
 * Certificates contain NO PII -- only entity type, entity ID (opaque), counts,
 * and cryptographic proof (SHA-256 hash + HMAC-SHA-256 signature).
 *
 * Crypto approach (mirrors packages/shared/src/auth/jwt.ts):
 * - proof_hash = SHA-256(JSON.stringify({entity_type, entity_id, deleted_at, deletion_summary}))
 * - signature  = HMAC-SHA-256(proof_hash, MASTER_KEY)
 *
 * Uses Web Crypto API (crypto.subtle) for all cryptographic operations.
 * No external dependencies. Compatible with Cloudflare Workers runtime.
 */

import { generateId } from "../id";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Summary of what was deleted. Contains only counts -- no PII. */
export interface DeletionSummary {
  readonly events_deleted: number;
  readonly mirrors_deleted: number;
  readonly journal_entries_deleted: number;
  readonly relationship_records_deleted: number;
  readonly d1_rows_deleted: number;
  readonly r2_objects_deleted: number;
  readonly provider_deletions_enqueued: number;
}

/** A signed deletion certificate proving data erasure. */
export interface DeletionCertificate {
  readonly certificate_id: string;
  readonly entity_type: "user";
  readonly entity_id: string;
  readonly deleted_at: string;
  readonly proof_hash: string;
  readonly signature: string;
  readonly deletion_summary: DeletionSummary;
}

/**
 * Input for certificate generation: the deleted entities summary.
 * Maps from DeletionWorkflow step results to certificate counts.
 */
export interface DeletedEntities {
  readonly events_deleted: number;
  readonly mirrors_deleted: number;
  readonly journal_entries_deleted: number;
  readonly relationship_records_deleted: number;
  readonly d1_rows_deleted: number;
  readonly r2_objects_deleted: number;
  readonly provider_deletions_enqueued: number;
}

// ---------------------------------------------------------------------------
// Internal helpers (Web Crypto API)
// ---------------------------------------------------------------------------

/** Encode a Uint8Array to hex string. */
function bytesToHex(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (const byte of bytes) {
    parts.push(byte.toString(16).padStart(2, "0"));
  }
  return parts.join("");
}

/**
 * Compute SHA-256 hash of a string using Web Crypto API.
 * Returns the hash as a lowercase hex string.
 */
export async function computeSha256(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return bytesToHex(new Uint8Array(hashBuffer));
}

/**
 * Import an HMAC key for signing or verification.
 * Same pattern as packages/shared/src/auth/jwt.ts:importHmacKey.
 */
async function importHmacKey(
  secret: string,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/**
 * Compute HMAC-SHA-256 signature of data using the given key.
 * Returns the signature as a lowercase hex string.
 */
export async function computeHmacSha256(
  data: string,
  secret: string,
): Promise<string> {
  const key = await importHmacKey(secret, "sign");
  const encoded = new TextEncoder().encode(data);
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoded);
  return bytesToHex(new Uint8Array(signatureBuffer));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a signed deletion certificate.
 *
 * The certificate proves that data was deleted at a specific time.
 * It contains NO PII -- only the entity type, opaque entity ID,
 * deletion timestamp, counts of deleted items, and cryptographic proof.
 *
 * @param userId - The user ID whose data was deleted.
 * @param deletedEntities - Summary of what was deleted (counts only).
 * @param systemKey - MASTER_KEY used for HMAC signing.
 * @param deletedAt - Optional ISO8601 timestamp (defaults to now).
 * @returns A signed DeletionCertificate.
 */
export async function generateDeletionCertificate(
  userId: string,
  deletedEntities: DeletedEntities,
  systemKey: string,
  deletedAt?: string,
): Promise<DeletionCertificate> {
  const certificateId = generateId("cert");
  const deletionTimestamp = deletedAt ?? new Date().toISOString();

  const deletionSummary: DeletionSummary = {
    events_deleted: deletedEntities.events_deleted,
    mirrors_deleted: deletedEntities.mirrors_deleted,
    journal_entries_deleted: deletedEntities.journal_entries_deleted,
    relationship_records_deleted: deletedEntities.relationship_records_deleted,
    d1_rows_deleted: deletedEntities.d1_rows_deleted,
    r2_objects_deleted: deletedEntities.r2_objects_deleted,
    provider_deletions_enqueued: deletedEntities.provider_deletions_enqueued,
  };

  // Build the data to hash: deterministic JSON of the certificate fields.
  // proof_hash = SHA-256(JSON.stringify({entity_type, entity_id, deleted_at, deletion_summary}))
  const hashInput = JSON.stringify({
    entity_type: "user" as const,
    entity_id: userId,
    deleted_at: deletionTimestamp,
    deletion_summary: deletionSummary,
  });

  const proofHash = await computeSha256(hashInput);

  // signature = HMAC-SHA-256(proof_hash, MASTER_KEY)
  const signature = await computeHmacSha256(proofHash, systemKey);

  return {
    certificate_id: certificateId,
    entity_type: "user",
    entity_id: userId,
    deleted_at: deletionTimestamp,
    proof_hash: proofHash,
    signature,
    deletion_summary: deletionSummary,
  };
}

/**
 * Verify a deletion certificate's signature.
 *
 * Re-computes the proof hash from the certificate data, then verifies
 * the HMAC-SHA-256 signature matches. This proves the certificate was
 * created by a system with access to the MASTER_KEY and has not been
 * tampered with.
 *
 * @param certificate - The certificate to verify.
 * @param systemKey - The MASTER_KEY used for HMAC verification.
 * @returns true if the signature is valid, false otherwise.
 */
export async function verifyDeletionCertificate(
  certificate: DeletionCertificate,
  systemKey: string,
): Promise<boolean> {
  try {
    // Recompute the proof hash from certificate data
    const hashInput = JSON.stringify({
      entity_type: certificate.entity_type,
      entity_id: certificate.entity_id,
      deleted_at: certificate.deleted_at,
      deletion_summary: certificate.deletion_summary,
    });

    const expectedProofHash = await computeSha256(hashInput);

    // Check proof hash matches
    if (expectedProofHash !== certificate.proof_hash) {
      return false;
    }

    // Verify HMAC signature using Web Crypto verify (constant-time comparison)
    const key = await importHmacKey(systemKey, "verify");
    const signatureBytes = hexToBytes(certificate.signature);
    const proofHashBytes = new TextEncoder().encode(certificate.proof_hash);

    return crypto.subtle.verify("HMAC", key, signatureBytes, proofHashBytes);
  } catch {
    return false;
  }
}

/** Convert a hex string to Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
