/**
 * Unit tests for deletion certificate generation and verification.
 *
 * Validates:
 * - Certificate generation produces all required fields
 * - proof_hash is SHA-256 of deterministic JSON input
 * - signature is HMAC-SHA-256 of proof_hash with system key
 * - Verification succeeds with correct key
 * - Verification fails with wrong key
 * - Verification fails with tampered data
 * - No PII in certificate (only counts and hashes)
 * - Certificate IDs use the "crt_" prefix
 */

import { describe, it, expect } from "vitest";
import {
  generateDeletionCertificate,
  verifyDeletionCertificate,
  computeSha256,
  computeHmacSha256,
} from "./deletion-certificate";
import type {
  DeletedEntities,
  DeletionCertificate,
} from "./deletion-certificate";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_SYSTEM_KEY = "test-master-key-for-hmac-signing-2026";
const TEST_USER_ID = "usr_01HXYZ1234567890ABCDEFGHJJ";
const TEST_DELETED_AT = "2026-02-14T12:00:00.000Z";

const TEST_DELETED_ENTITIES: DeletedEntities = {
  events_deleted: 42,
  mirrors_deleted: 15,
  journal_entries_deleted: 87,
  relationship_records_deleted: 23,
  d1_rows_deleted: 5,
  r2_objects_deleted: 3,
  provider_deletions_enqueued: 2,
};

// ---------------------------------------------------------------------------
// SHA-256 computation tests
// ---------------------------------------------------------------------------

describe("computeSha256", () => {
  it("produces a 64-character hex string", async () => {
    const hash = await computeSha256("hello world");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic (same input produces same hash)", async () => {
    const hash1 = await computeSha256("deterministic-test");
    const hash2 = await computeSha256("deterministic-test");
    expect(hash1).toBe(hash2);
  });

  it("different inputs produce different hashes", async () => {
    const hash1 = await computeSha256("input-a");
    const hash2 = await computeSha256("input-b");
    expect(hash1).not.toBe(hash2);
  });

  it("matches known SHA-256 value for empty string", async () => {
    // SHA-256 of empty string is a well-known constant
    const hash = await computeSha256("");
    expect(hash).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

// ---------------------------------------------------------------------------
// HMAC-SHA-256 computation tests
// ---------------------------------------------------------------------------

describe("computeHmacSha256", () => {
  it("produces a 64-character hex string", async () => {
    const sig = await computeHmacSha256("data", "key");
    expect(sig).toHaveLength(64);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", async () => {
    const sig1 = await computeHmacSha256("data", "key");
    const sig2 = await computeHmacSha256("data", "key");
    expect(sig1).toBe(sig2);
  });

  it("different keys produce different signatures", async () => {
    const sig1 = await computeHmacSha256("data", "key-a");
    const sig2 = await computeHmacSha256("data", "key-b");
    expect(sig1).not.toBe(sig2);
  });

  it("different data produce different signatures", async () => {
    const sig1 = await computeHmacSha256("data-a", "key");
    const sig2 = await computeHmacSha256("data-b", "key");
    expect(sig1).not.toBe(sig2);
  });
});

// ---------------------------------------------------------------------------
// Certificate generation tests
// ---------------------------------------------------------------------------

describe("generateDeletionCertificate", () => {
  it("produces a certificate with all required fields", async () => {
    const cert = await generateDeletionCertificate(
      TEST_USER_ID,
      TEST_DELETED_ENTITIES,
      TEST_SYSTEM_KEY,
      TEST_DELETED_AT,
    );

    expect(cert.certificate_id).toMatch(/^crt_/);
    expect(cert.entity_type).toBe("user");
    expect(cert.entity_id).toBe(TEST_USER_ID);
    expect(cert.deleted_at).toBe(TEST_DELETED_AT);
    expect(cert.proof_hash).toHaveLength(64);
    expect(cert.proof_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(cert.signature).toHaveLength(64);
    expect(cert.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(cert.deletion_summary).toEqual(TEST_DELETED_ENTITIES);
  });

  it("generates unique certificate IDs", async () => {
    const cert1 = await generateDeletionCertificate(
      TEST_USER_ID,
      TEST_DELETED_ENTITIES,
      TEST_SYSTEM_KEY,
      TEST_DELETED_AT,
    );
    const cert2 = await generateDeletionCertificate(
      TEST_USER_ID,
      TEST_DELETED_ENTITIES,
      TEST_SYSTEM_KEY,
      TEST_DELETED_AT,
    );
    expect(cert1.certificate_id).not.toBe(cert2.certificate_id);
  });

  it("proof_hash matches SHA-256 of deterministic JSON", async () => {
    const cert = await generateDeletionCertificate(
      TEST_USER_ID,
      TEST_DELETED_ENTITIES,
      TEST_SYSTEM_KEY,
      TEST_DELETED_AT,
    );

    // Manually compute the expected proof hash
    const hashInput = JSON.stringify({
      entity_type: "user",
      entity_id: TEST_USER_ID,
      deleted_at: TEST_DELETED_AT,
      deletion_summary: TEST_DELETED_ENTITIES,
    });
    const expectedHash = await computeSha256(hashInput);

    expect(cert.proof_hash).toBe(expectedHash);
  });

  it("signature matches HMAC-SHA-256 of proof_hash with system key", async () => {
    const cert = await generateDeletionCertificate(
      TEST_USER_ID,
      TEST_DELETED_ENTITIES,
      TEST_SYSTEM_KEY,
      TEST_DELETED_AT,
    );

    // Manually compute the expected signature
    const expectedSignature = await computeHmacSha256(
      cert.proof_hash,
      TEST_SYSTEM_KEY,
    );

    expect(cert.signature).toBe(expectedSignature);
  });

  it("uses current time when deletedAt is not provided", async () => {
    const before = new Date().toISOString();
    const cert = await generateDeletionCertificate(
      TEST_USER_ID,
      TEST_DELETED_ENTITIES,
      TEST_SYSTEM_KEY,
    );
    const after = new Date().toISOString();

    // deleted_at should be between before and after
    expect(cert.deleted_at >= before).toBe(true);
    expect(cert.deleted_at <= after).toBe(true);
  });

  it("contains no PII -- only counts and hashes", async () => {
    const cert = await generateDeletionCertificate(
      TEST_USER_ID,
      TEST_DELETED_ENTITIES,
      TEST_SYSTEM_KEY,
      TEST_DELETED_AT,
    );

    // Serialize the deletion_summary to check its contents
    const summaryStr = JSON.stringify(cert.deletion_summary);

    // Summary should only contain count fields (numbers)
    const summaryValues = Object.values(cert.deletion_summary);
    for (const val of summaryValues) {
      expect(typeof val).toBe("number");
    }

    // Summary should not contain email, name, or any PII
    expect(summaryStr).not.toContain("@");
    expect(summaryStr).not.toContain("email");
    expect(summaryStr).not.toContain("name");
    expect(summaryStr).not.toContain("password");

    // The certificate entity_id is an opaque ID (usr_ prefix), not PII per se,
    // but verify it doesn't expose anything else
    expect(cert.entity_type).toBe("user");
    expect(cert.entity_id).toBe(TEST_USER_ID);
  });

  it("different system keys produce different signatures", async () => {
    const cert1 = await generateDeletionCertificate(
      TEST_USER_ID,
      TEST_DELETED_ENTITIES,
      "key-alpha",
      TEST_DELETED_AT,
    );
    const cert2 = await generateDeletionCertificate(
      TEST_USER_ID,
      TEST_DELETED_ENTITIES,
      "key-beta",
      TEST_DELETED_AT,
    );

    // Same data => same proof hash
    expect(cert1.proof_hash).toBe(cert2.proof_hash);
    // Different keys => different signatures
    expect(cert1.signature).not.toBe(cert2.signature);
  });

  it("different user IDs produce different proof hashes", async () => {
    const cert1 = await generateDeletionCertificate(
      "usr_AAAA1234567890ABCDEFGHIJ01",
      TEST_DELETED_ENTITIES,
      TEST_SYSTEM_KEY,
      TEST_DELETED_AT,
    );
    const cert2 = await generateDeletionCertificate(
      "usr_BBBB1234567890ABCDEFGHIJ01",
      TEST_DELETED_ENTITIES,
      TEST_SYSTEM_KEY,
      TEST_DELETED_AT,
    );

    expect(cert1.proof_hash).not.toBe(cert2.proof_hash);
    expect(cert1.signature).not.toBe(cert2.signature);
  });
});

// ---------------------------------------------------------------------------
// Certificate verification tests
// ---------------------------------------------------------------------------

describe("verifyDeletionCertificate", () => {
  it("returns true for a valid certificate", async () => {
    const cert = await generateDeletionCertificate(
      TEST_USER_ID,
      TEST_DELETED_ENTITIES,
      TEST_SYSTEM_KEY,
      TEST_DELETED_AT,
    );

    const valid = await verifyDeletionCertificate(cert, TEST_SYSTEM_KEY);
    expect(valid).toBe(true);
  });

  it("returns false with wrong system key", async () => {
    const cert = await generateDeletionCertificate(
      TEST_USER_ID,
      TEST_DELETED_ENTITIES,
      TEST_SYSTEM_KEY,
      TEST_DELETED_AT,
    );

    const valid = await verifyDeletionCertificate(cert, "wrong-key");
    expect(valid).toBe(false);
  });

  it("returns false when proof_hash is tampered", async () => {
    const cert = await generateDeletionCertificate(
      TEST_USER_ID,
      TEST_DELETED_ENTITIES,
      TEST_SYSTEM_KEY,
      TEST_DELETED_AT,
    );

    const tampered: DeletionCertificate = {
      ...cert,
      proof_hash: "a".repeat(64),
    };

    const valid = await verifyDeletionCertificate(tampered, TEST_SYSTEM_KEY);
    expect(valid).toBe(false);
  });

  it("returns false when signature is tampered", async () => {
    const cert = await generateDeletionCertificate(
      TEST_USER_ID,
      TEST_DELETED_ENTITIES,
      TEST_SYSTEM_KEY,
      TEST_DELETED_AT,
    );

    const tampered: DeletionCertificate = {
      ...cert,
      signature: "b".repeat(64),
    };

    const valid = await verifyDeletionCertificate(tampered, TEST_SYSTEM_KEY);
    expect(valid).toBe(false);
  });

  it("returns false when deletion_summary is tampered", async () => {
    const cert = await generateDeletionCertificate(
      TEST_USER_ID,
      TEST_DELETED_ENTITIES,
      TEST_SYSTEM_KEY,
      TEST_DELETED_AT,
    );

    const tampered: DeletionCertificate = {
      ...cert,
      deletion_summary: {
        ...cert.deletion_summary,
        events_deleted: 999, // tampered count
      },
    };

    const valid = await verifyDeletionCertificate(tampered, TEST_SYSTEM_KEY);
    expect(valid).toBe(false);
  });

  it("returns false when entity_id is tampered", async () => {
    const cert = await generateDeletionCertificate(
      TEST_USER_ID,
      TEST_DELETED_ENTITIES,
      TEST_SYSTEM_KEY,
      TEST_DELETED_AT,
    );

    const tampered: DeletionCertificate = {
      ...cert,
      entity_id: "usr_TAMPERED1234567890ABCDEFGH",
    };

    const valid = await verifyDeletionCertificate(tampered, TEST_SYSTEM_KEY);
    expect(valid).toBe(false);
  });

  it("returns false when deleted_at is tampered", async () => {
    const cert = await generateDeletionCertificate(
      TEST_USER_ID,
      TEST_DELETED_ENTITIES,
      TEST_SYSTEM_KEY,
      TEST_DELETED_AT,
    );

    const tampered: DeletionCertificate = {
      ...cert,
      deleted_at: "2099-01-01T00:00:00.000Z",
    };

    const valid = await verifyDeletionCertificate(tampered, TEST_SYSTEM_KEY);
    expect(valid).toBe(false);
  });

  it("signature is independently verifiable (round-trip)", async () => {
    // Generate certificate, serialize to JSON, deserialize, verify
    const cert = await generateDeletionCertificate(
      TEST_USER_ID,
      TEST_DELETED_ENTITIES,
      TEST_SYSTEM_KEY,
      TEST_DELETED_AT,
    );

    // Simulate storing and retrieving from database
    const serialized = JSON.stringify(cert);
    const deserialized = JSON.parse(serialized) as DeletionCertificate;

    const valid = await verifyDeletionCertificate(deserialized, TEST_SYSTEM_KEY);
    expect(valid).toBe(true);
  });
});
