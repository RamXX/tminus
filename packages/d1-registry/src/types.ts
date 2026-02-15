/**
 * @tminus/d1-registry -- TypeScript row types for D1 registry tables.
 *
 * These types represent the rows as they come back from D1 queries.
 * They use plain strings (not branded IDs) because D1 returns raw data;
 * callers can cast to branded types from @tminus/shared after retrieval.
 */

/** Row shape for the `orgs` table. */
export interface OrgRow {
  readonly org_id: string;
  readonly name: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Row shape for the `users` table (includes auth fields from migration 0003). */
export interface UserRow {
  readonly user_id: string;
  readonly org_id: string;
  readonly email: string;
  readonly display_name: string | null;
  readonly created_at: string;
  /** PBKDF2 hash in "<hex-salt>:<hex-key>" format. NULL for legacy/OAuth-only users. */
  readonly password_hash: string | null;
  /** Password version for JWT session invalidation on password change. */
  readonly password_version: number;
  /** Count of consecutive failed login attempts. */
  readonly failed_login_attempts: number;
  /** ISO8601 timestamp when lockout expires. NULL if not locked. */
  readonly locked_until: string | null;
}

/** Valid status values for the `accounts.status` column. */
export type AccountStatus = "active" | "revoked" | "error";

/** Row shape for the `accounts` table. */
export interface AccountRow {
  readonly account_id: string;
  readonly user_id: string;
  readonly provider: string;
  readonly provider_subject: string;
  readonly email: string;
  readonly status: AccountStatus;
  readonly channel_id: string | null;
  readonly channel_token: string | null;
  readonly channel_expiry_ts: string | null;
  readonly created_at: string;
}

/** Row shape for the `ms_subscriptions` table (Microsoft Graph webhook routing). */
export interface MsSubscriptionRow {
  readonly subscription_id: string;
  readonly account_id: string;
  readonly created_at: string;
}

/** Row shape for the `api_keys` table. */
export interface ApiKeyRow {
  readonly key_id: string;
  readonly user_id: string;
  readonly name: string;
  readonly prefix: string;
  readonly key_hash: string;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
  readonly created_at: string;
}

/** Valid entity types for the `deletion_certificates.entity_type` column. */
export type DeletionEntityType = "user" | "account" | "event";

/** Valid status values for the `deletion_requests.status` column. */
export type DeletionRequestStatus = "pending" | "processing" | "completed" | "cancelled";

/** Row shape for the `deletion_requests` table (GDPR Article 17). */
export interface DeletionRequestRow {
  readonly request_id: string;
  readonly user_id: string;
  readonly status: DeletionRequestStatus;
  readonly requested_at: string;
  readonly scheduled_at: string;
  readonly completed_at: string | null;
  readonly cancelled_at: string | null;
}

/** Row shape for the `deletion_certificates` table. */
export interface DeletionCertificateRow {
  readonly cert_id: string;
  readonly entity_type: DeletionEntityType;
  readonly entity_id: string;
  readonly deleted_at: string;
  readonly proof_hash: string;
  readonly signature: string;
}
