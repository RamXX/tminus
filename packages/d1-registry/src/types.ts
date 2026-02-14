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

/** Row shape for the `users` table. */
export interface UserRow {
  readonly user_id: string;
  readonly org_id: string;
  readonly email: string;
  readonly display_name: string | null;
  readonly created_at: string;
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

/** Valid entity types for the `deletion_certificates.entity_type` column. */
export type DeletionEntityType = "user" | "account" | "event";

/** Row shape for the `deletion_certificates` table. */
export interface DeletionCertificateRow {
  readonly cert_id: string;
  readonly entity_type: DeletionEntityType;
  readonly entity_id: string;
  readonly deleted_at: string;
  readonly proof_hash: string;
  readonly signature: string;
}
