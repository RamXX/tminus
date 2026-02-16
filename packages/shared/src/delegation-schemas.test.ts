/**
 * Unit tests for delegation Zod schemas (TM-9iu.2).
 *
 * Tests:
 * - ServiceAccountKeySchema validates correct and incorrect structures
 * - EncryptedEnvelopeSchema validates envelope shape
 * - KeyMetadataSchema validates rotation tracking data
 * - Round-trip serialization: parse -> stringify -> parse preserves data
 * - Rotation due date computation (90-day reminder)
 * - isKeyRotationDue checks
 * - parseServiceAccountKey throws on invalid data
 * - safeParseServiceAccountKey returns success/error without throwing
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  ServiceAccountKeySchema,
  EncryptedEnvelopeSchema,
  KeyMetadataSchema,
  HealthCheckResultSchema,
  CachedImpersonationTokenSchema,
  OrgDelegationConfigSchema,
  parseServiceAccountKey,
  safeParseServiceAccountKey,
  parseEncryptedEnvelope,
  computeRotationDueDate,
  isKeyRotationDue,
  ROTATION_REMINDER_DAYS,
} from "./delegation-schemas";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const VALID_SA_KEY = {
  type: "service_account" as const,
  project_id: "test-project-123",
  private_key_id: "key-id-abc123",
  private_key: TEST_PRIVATE_KEY,
  client_email: "sa@test-project.iam.gserviceaccount.com",
  client_id: "123456789",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
};

// ---------------------------------------------------------------------------
// ServiceAccountKeySchema
// ---------------------------------------------------------------------------

describe("ServiceAccountKeySchema", () => {
  it("accepts a valid service account key", () => {
    const result = ServiceAccountKeySchema.safeParse(VALID_SA_KEY);
    expect(result.success).toBe(true);
  });

  it("rejects wrong type field", () => {
    const result = ServiceAccountKeySchema.safeParse({
      ...VALID_SA_KEY,
      type: "user",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty project_id", () => {
    const result = ServiceAccountKeySchema.safeParse({
      ...VALID_SA_KEY,
      project_id: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing private_key", () => {
    const { private_key, ...rest } = VALID_SA_KEY;
    const result = ServiceAccountKeySchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects non-PEM private_key", () => {
    const result = ServiceAccountKeySchema.safeParse({
      ...VALID_SA_KEY,
      private_key: "not-a-pem-key",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid client_email (not a service account email)", () => {
    const result = ServiceAccountKeySchema.safeParse({
      ...VALID_SA_KEY,
      client_email: "user@example.com",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid token_uri (not a URL)", () => {
    const result = ServiceAccountKeySchema.safeParse({
      ...VALID_SA_KEY,
      token_uri: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  it("allows auth_uri to be omitted (optional)", () => {
    const { auth_uri, ...rest } = VALID_SA_KEY;
    const result = ServiceAccountKeySchema.safeParse(rest);
    expect(result.success).toBe(true);
  });

  it("round-trip: JSON stringify -> parse preserves structure", () => {
    const json = JSON.stringify(VALID_SA_KEY);
    const parsed = JSON.parse(json);
    const result = ServiceAccountKeySchema.safeParse(parsed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.project_id).toBe("test-project-123");
      expect(result.data.client_email).toBe("sa@test-project.iam.gserviceaccount.com");
    }
  });
});

// ---------------------------------------------------------------------------
// EncryptedEnvelopeSchema
// ---------------------------------------------------------------------------

describe("EncryptedEnvelopeSchema", () => {
  it("accepts valid envelope", () => {
    const result = EncryptedEnvelopeSchema.safeParse({
      iv: "base64iv==",
      ciphertext: "base64ciphertext==",
      encryptedDek: "base64dek==",
      dekIv: "base64dekiv==",
    });
    expect(result.success).toBe(true);
  });

  it("rejects envelope with empty iv", () => {
    const result = EncryptedEnvelopeSchema.safeParse({
      iv: "",
      ciphertext: "base64ciphertext==",
      encryptedDek: "base64dek==",
      dekIv: "base64dekiv==",
    });
    expect(result.success).toBe(false);
  });

  it("rejects envelope missing ciphertext", () => {
    const result = EncryptedEnvelopeSchema.safeParse({
      iv: "base64iv==",
      encryptedDek: "base64dek==",
      dekIv: "base64dekiv==",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-string fields", () => {
    const result = EncryptedEnvelopeSchema.safeParse({
      iv: 123,
      ciphertext: "text",
      encryptedDek: "dek",
      dekIv: "dekiv",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// KeyMetadataSchema
// ---------------------------------------------------------------------------

describe("KeyMetadataSchema", () => {
  it("accepts valid key metadata", () => {
    const result = KeyMetadataSchema.safeParse({
      keyId: "key-id-123",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-02-01T00:00:00.000Z",
      rotationDueAt: "2026-04-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("accepts null lastUsedAt (never used)", () => {
    const result = KeyMetadataSchema.safeParse({
      keyId: "key-id-123",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: null,
      rotationDueAt: "2026-04-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid datetime format", () => {
    const result = KeyMetadataSchema.safeParse({
      keyId: "key-id-123",
      createdAt: "not-a-date",
      lastUsedAt: null,
      rotationDueAt: "2026-04-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HealthCheckResultSchema
// ---------------------------------------------------------------------------

describe("HealthCheckResultSchema", () => {
  it("accepts valid health check result", () => {
    const result = HealthCheckResultSchema.safeParse({
      delegationId: "delegation_01",
      domain: "acme.com",
      status: "healthy",
      checkedAt: "2026-02-15T00:00:00.000Z",
      error: null,
      canImpersonateAdmin: true,
      scopesValid: true,
    });
    expect(result.success).toBe(true);
  });

  it("accepts revoked status with error", () => {
    const result = HealthCheckResultSchema.safeParse({
      delegationId: "delegation_01",
      domain: "acme.com",
      status: "revoked",
      checkedAt: "2026-02-15T00:00:00.000Z",
      error: "unauthorized_client",
      canImpersonateAdmin: false,
      scopesValid: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid status value", () => {
    const result = HealthCheckResultSchema.safeParse({
      delegationId: "delegation_01",
      domain: "acme.com",
      status: "invalid_status",
      checkedAt: "2026-02-15T00:00:00.000Z",
      error: null,
      canImpersonateAdmin: true,
      scopesValid: true,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CachedImpersonationTokenSchema
// ---------------------------------------------------------------------------

describe("CachedImpersonationTokenSchema", () => {
  it("accepts valid cached token", () => {
    const result = CachedImpersonationTokenSchema.safeParse({
      accessToken: "ya29.mock-token",
      expiresAt: "2026-02-15T01:00:00.000Z",
      cachedAt: "2026-02-15T00:00:00.000Z",
      userEmail: "user@acme.com",
      delegationId: "delegation_01",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty access token", () => {
    const result = CachedImpersonationTokenSchema.safeParse({
      accessToken: "",
      expiresAt: "2026-02-15T01:00:00.000Z",
      cachedAt: "2026-02-15T00:00:00.000Z",
      userEmail: "user@acme.com",
      delegationId: "delegation_01",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OrgDelegationConfigSchema
// ---------------------------------------------------------------------------

describe("OrgDelegationConfigSchema", () => {
  it("accepts valid org delegation config", () => {
    const result = OrgDelegationConfigSchema.safeParse({
      delegationId: "delegation_01",
      domain: "acme.com",
      adminEmail: "admin@acme.com",
      delegationStatus: "active",
      saClientEmail: "sa@project.iam.gserviceaccount.com",
      saClientId: "123456789",
      activeUsersCount: 5,
      registrationDate: "2026-01-01T00:00:00.000Z",
      validatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid delegation status", () => {
    const result = OrgDelegationConfigSchema.safeParse({
      delegationId: "delegation_01",
      domain: "acme.com",
      adminEmail: "admin@acme.com",
      delegationStatus: "invalid",
      saClientEmail: "sa@project.iam.gserviceaccount.com",
      saClientId: "123456789",
      activeUsersCount: 0,
      registrationDate: null,
      validatedAt: null,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseServiceAccountKey / safeParseServiceAccountKey
// ---------------------------------------------------------------------------

describe("parseServiceAccountKey", () => {
  it("returns parsed key for valid input", () => {
    const result = parseServiceAccountKey(VALID_SA_KEY);
    expect(result.type).toBe("service_account");
    expect(result.project_id).toBe("test-project-123");
  });

  it("throws ZodError for invalid input", () => {
    expect(() => parseServiceAccountKey({ type: "user" })).toThrow();
  });
});

describe("safeParseServiceAccountKey", () => {
  it("returns success for valid input", () => {
    const result = safeParseServiceAccountKey(VALID_SA_KEY);
    expect(result.success).toBe(true);
  });

  it("returns error for invalid input without throwing", () => {
    const result = safeParseServiceAccountKey({ type: "user" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseEncryptedEnvelope
// ---------------------------------------------------------------------------

describe("parseEncryptedEnvelope", () => {
  it("returns parsed envelope for valid input", () => {
    const result = parseEncryptedEnvelope({
      iv: "abc",
      ciphertext: "def",
      encryptedDek: "ghi",
      dekIv: "jkl",
    });
    expect(result.iv).toBe("abc");
    expect(result.ciphertext).toBe("def");
  });

  it("throws for invalid envelope", () => {
    expect(() => parseEncryptedEnvelope({ iv: "" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Rotation due date computation
// ---------------------------------------------------------------------------

describe("computeRotationDueDate", () => {
  it("computes 90 days from creation date", () => {
    const created = new Date("2026-01-01T00:00:00Z");
    const due = computeRotationDueDate(created);
    // Verify exactly 90 days difference in milliseconds
    const diffMs = due.getTime() - created.getTime();
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
    expect(diffDays).toBe(90);
  });

  it("handles month boundaries correctly", () => {
    const created = new Date("2026-11-15T12:00:00Z");
    const due = computeRotationDueDate(created);
    // Verify exactly 90 days difference
    const diffMs = due.getTime() - created.getTime();
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
    expect(diffDays).toBe(90);
  });
});

describe("ROTATION_REMINDER_DAYS", () => {
  it("is 90 days", () => {
    expect(ROTATION_REMINDER_DAYS).toBe(90);
  });
});

describe("isKeyRotationDue", () => {
  it("returns false when key is fresh", () => {
    const created = new Date("2026-02-01T00:00:00Z");
    const now = new Date("2026-02-15T00:00:00Z"); // 14 days old
    expect(isKeyRotationDue(created, now)).toBe(false);
  });

  it("returns true when key is 90+ days old", () => {
    const created = new Date("2025-11-01T00:00:00Z");
    const now = new Date("2026-02-15T00:00:00Z"); // ~107 days old
    expect(isKeyRotationDue(created, now)).toBe(true);
  });

  it("returns true exactly at 90 days", () => {
    const created = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-04-01T00:00:00Z"); // exactly 90 days
    expect(isKeyRotationDue(created, now)).toBe(true);
  });

  it("returns false at 89 days", () => {
    const created = new Date("2026-01-01T00:00:00Z");
    const now = new Date("2026-03-31T00:00:00Z"); // 89 days
    expect(isKeyRotationDue(created, now)).toBe(false);
  });
});
