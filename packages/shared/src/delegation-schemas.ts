/**
 * Zod schemas for domain-wide delegation runtime validation (TM-9iu.2).
 *
 * These schemas validate the shape of service account credentials after
 * decryption/deserialization round-trips. This catches schema evolution
 * bugs (e.g., Google changing their service account key format) at
 * deserialization time rather than at API call time.
 *
 * Design decision: Zod schemas are the source of truth for credential
 * shapes. The TypeScript types in jwt-assertion.ts are derived from
 * these schemas for consistency.
 */

import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Service account key schema (Google Cloud JSON key file)
// ---------------------------------------------------------------------------

/**
 * Zod schema for a Google Cloud service account JSON key.
 * Validates the structure after decryption from encrypted envelope.
 */
export const ServiceAccountKeySchema = z.object({
  type: z.literal("service_account"),
  project_id: z.string().min(1),
  private_key_id: z.string().min(1),
  private_key: z
    .string()
    .min(1)
    .refine(
      (key) => key.includes("PRIVATE KEY"),
      "Must be a PEM-encoded private key",
    ),
  client_email: z
    .string()
    .min(1)
    .refine(
      (email) => email.includes("@") && email.includes(".iam.gserviceaccount.com"),
      "Must be a service account email (name@project.iam.gserviceaccount.com)",
    ),
  client_id: z.string().min(1),
  auth_uri: z.string().url().optional(),
  token_uri: z.string().url(),
});

/** Type derived from Zod schema. */
export type ValidatedServiceAccountKey = z.infer<typeof ServiceAccountKeySchema>;

// ---------------------------------------------------------------------------
// Encrypted envelope schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for the AES-256-GCM encrypted envelope.
 * Validates structure after JSON.parse of stored encrypted data.
 */
export const EncryptedEnvelopeSchema = z.object({
  iv: z.string().min(1),
  ciphertext: z.string().min(1),
  encryptedDek: z.string().min(1),
  dekIv: z.string().min(1),
});

export type ValidatedEncryptedEnvelope = z.infer<typeof EncryptedEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Key metadata schema
// ---------------------------------------------------------------------------

/**
 * Metadata about a service account key for rotation tracking.
 */
export const KeyMetadataSchema = z.object({
  /** private_key_id from the Google SA key. */
  keyId: z.string().min(1),
  /** When the key was first uploaded to T-Minus. */
  createdAt: z.string().datetime(),
  /** Last time this key was used for JWT signing. */
  lastUsedAt: z.string().datetime().nullable(),
  /** When key rotation is recommended (90 days from creation). */
  rotationDueAt: z.string().datetime(),
});

export type KeyMetadata = z.infer<typeof KeyMetadataSchema>;

// ---------------------------------------------------------------------------
// Delegation health check result
// ---------------------------------------------------------------------------

export const DelegationHealthStatusSchema = z.enum([
  "healthy",
  "degraded",
  "revoked",
  "unknown",
]);

export type DelegationHealthStatus = z.infer<typeof DelegationHealthStatusSchema>;

export const HealthCheckResultSchema = z.object({
  delegationId: z.string().min(1),
  domain: z.string().min(1),
  status: DelegationHealthStatusSchema,
  checkedAt: z.string().datetime(),
  /** Error message if health check failed. */
  error: z.string().nullable(),
  /** Whether the admin user's impersonation still works. */
  canImpersonateAdmin: z.boolean(),
  /** Whether calendar API scopes are still granted. */
  scopesValid: z.boolean(),
});

export type HealthCheckResult = z.infer<typeof HealthCheckResultSchema>;

// ---------------------------------------------------------------------------
// Impersonation token cache entry
// ---------------------------------------------------------------------------

export const CachedImpersonationTokenSchema = z.object({
  accessToken: z.string().min(1),
  /** ISO 8601 timestamp of token expiry. */
  expiresAt: z.string().datetime(),
  /** ISO 8601 timestamp of when this was cached. */
  cachedAt: z.string().datetime(),
  /** Email of the impersonated user. */
  userEmail: z.string().email(),
  /** Delegation ID the token was issued under. */
  delegationId: z.string().min(1),
});

export type CachedImpersonationToken = z.infer<typeof CachedImpersonationTokenSchema>;

// ---------------------------------------------------------------------------
// Org delegation record
// ---------------------------------------------------------------------------

export const OrgDelegationConfigSchema = z.object({
  delegationId: z.string().min(1),
  domain: z.string().min(1),
  adminEmail: z.string().email(),
  delegationStatus: z.enum(["pending", "active", "revoked"]),
  saClientEmail: z.string().min(1),
  saClientId: z.string().min(1),
  activeUsersCount: z.number().int().min(0),
  registrationDate: z.string().datetime().nullable(),
  validatedAt: z.string().datetime().nullable(),
});

export type OrgDelegationConfig = z.infer<typeof OrgDelegationConfigSchema>;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate and parse a decrypted service account key using the Zod schema.
 * Throws ZodError with details if validation fails.
 *
 * Use this after decrypt round-trips to catch schema evolution bugs.
 */
export function parseServiceAccountKey(data: unknown): ValidatedServiceAccountKey {
  return ServiceAccountKeySchema.parse(data);
}

/**
 * Safely validate a service account key without throwing.
 * Returns { success: true, data } or { success: false, error }.
 */
export function safeParseServiceAccountKey(data: unknown) {
  return ServiceAccountKeySchema.safeParse(data);
}

/**
 * Validate an encrypted envelope structure after JSON.parse.
 * Throws ZodError if structure is invalid.
 */
export function parseEncryptedEnvelope(data: unknown): ValidatedEncryptedEnvelope {
  return EncryptedEnvelopeSchema.parse(data);
}

/** Rotation due date: 90 days from creation. */
export const ROTATION_REMINDER_DAYS = 90;

/**
 * Compute the rotation due date for a key created at the given timestamp.
 *
 * Uses millisecond arithmetic instead of Date.setDate() to avoid DST
 * timezone drift. Date.setDate() operates in local time, so adding days
 * across a DST boundary shifts the UTC result by +/- 1 hour.
 */
export function computeRotationDueDate(createdAt: Date): Date {
  const msPerDay = 24 * 60 * 60 * 1000;
  return new Date(createdAt.getTime() + ROTATION_REMINDER_DAYS * msPerDay);
}

/**
 * Check if a key is due for rotation based on its creation date.
 */
export function isKeyRotationDue(createdAt: Date, now: Date = new Date()): boolean {
  const due = computeRotationDueDate(createdAt);
  return now >= due;
}
