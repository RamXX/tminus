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
  /** ISO8601 timestamp of the last sync attempt. NULL if never synced. */
  readonly last_sync_ts: string | null;
  /** Google Calendar push notification resource ID. NULL if no channel. */
  readonly resource_id: string | null;
  /** Rolling error count (incremented on sync failure, reset on success). */
  readonly error_count: number;
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
  /** JSON string of DeletionSummary (counts of deleted items). NULL for legacy certificates. */
  readonly deletion_summary: string | null;
}

/** Valid status values for the `key_rotation_log.status` column. */
export type KeyRotationStatus = "started" | "completed" | "failed";

/** Row shape for the `key_rotation_log` table. */
export interface KeyRotationLogRow {
  readonly rotation_id: string;
  readonly account_id: string;
  readonly status: KeyRotationStatus;
  readonly error_message: string | null;
  readonly started_at: string;
  readonly completed_at: string | null;
}

/** Valid detail level values for MCP policy edges. */
export type McpPolicyDetailLevel = "BUSY" | "TITLE" | "FULL";

/** Valid calendar kind values for MCP policy edges. */
export type McpPolicyCalendarKind = "BUSY_OVERLAY" | "TRUE_MIRROR";

/** Row shape for the `mcp_policies` table. */
export interface McpPolicyRow {
  readonly policy_id: string;
  readonly user_id: string;
  readonly from_account: string;
  readonly to_account: string;
  readonly detail_level: McpPolicyDetailLevel;
  readonly calendar_kind: McpPolicyCalendarKind;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Valid subscription tier values for the `subscriptions.tier` column. */
export type SubscriptionTier = "free" | "premium" | "enterprise";

/** Valid subscription status values for the `subscriptions.status` column. */
export type BillingSubscriptionStatus = "active" | "past_due" | "cancelled" | "unpaid" | "trialing";

/** Row shape for the `subscriptions` table. */
export interface SubscriptionRow {
  readonly subscription_id: string;
  readonly user_id: string;
  readonly tier: SubscriptionTier;
  readonly stripe_customer_id: string | null;
  readonly stripe_subscription_id: string | null;
  readonly current_period_end: string | null;
  readonly status: BillingSubscriptionStatus;
  readonly grace_period_end: string | null;
  readonly cancel_at_period_end: number;
  readonly previous_tier: SubscriptionTier | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Valid event types for the billing_events audit log. */
export type BillingEventType =
  | "checkout_completed"
  | "subscription_upgraded"
  | "subscription_downgraded"
  | "subscription_renewed"
  | "subscription_cancelled"
  | "subscription_deleted"
  | "payment_failed"
  | "payment_recovered"
  | "grace_period_started"
  | "grace_period_expired";

/** Row shape for the `billing_events` table. */
export interface BillingEventRow {
  readonly event_id: string;
  readonly user_id: string;
  readonly subscription_id: string | null;
  readonly event_type: BillingEventType;
  readonly stripe_event_id: string | null;
  readonly old_tier: SubscriptionTier | null;
  readonly new_tier: SubscriptionTier | null;
  readonly old_status: BillingSubscriptionStatus | null;
  readonly new_status: BillingSubscriptionStatus | null;
  readonly metadata: string | null;
  readonly created_at: string;
}

/** Valid source values for MCP events. */
export type McpEventSource = "mcp" | "provider" | "ui" | "system";

/** Valid status values for MCP events (matches Google Calendar API). */
export type McpEventStatus = "confirmed" | "tentative" | "cancelled";

/** Row shape for the `mcp_events` table. */
export interface McpEventRow {
  readonly event_id: string;
  readonly user_id: string;
  readonly account_id: string | null;
  readonly title: string;
  readonly start_ts: string;
  readonly end_ts: string;
  readonly timezone: string;
  readonly description: string | null;
  readonly location: string | null;
  readonly source: McpEventSource;
  readonly status: McpEventStatus;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Valid status values for group scheduling sessions. */
export type GroupSessionStatus =
  | "gathering"
  | "candidates_ready"
  | "committed"
  | "cancelled"
  | "expired";

/** Row shape for the `group_scheduling_sessions` table (Phase 4D). */
export interface GroupSchedulingSessionRow {
  readonly session_id: string;
  readonly creator_user_id: string;
  readonly participant_ids_json: string;
  readonly title: string;
  readonly status: GroupSessionStatus;
  readonly created_at: string;
}

// ---------------------------------------------------------------------------
// Org policies (Migration 0017)
// ---------------------------------------------------------------------------

/** Valid org policy types. */
export type OrgPolicyType =
  | "mandatory_working_hours"
  | "minimum_vip_priority"
  | "required_projection_detail"
  | "max_account_count";

/** Row shape for the `org_policies` table. */
export interface OrgPolicyRow {
  readonly policy_id: string;
  readonly org_id: string;
  readonly policy_type: OrgPolicyType;
  readonly config_json: string;
  readonly created_at: string;
  readonly created_by: string;
}

// ---------------------------------------------------------------------------
// Device tokens (Migration 0019)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Org installations (Migration 0021)
// ---------------------------------------------------------------------------

/** Valid status values for org-level Marketplace installations. */
export type OrgInstallationStatus = "active" | "inactive";

/** Row shape for the `org_installations` table. */
export interface OrgInstallationRow {
  readonly install_id: string;
  readonly google_customer_id: string;
  readonly org_id: string | null;
  readonly admin_email: string;
  readonly admin_google_sub: string;
  readonly scopes_granted: string | null;
  readonly status: OrgInstallationStatus;
  readonly installed_at: string;
  readonly deactivated_at: string | null;
}

// ---------------------------------------------------------------------------
// Device tokens (Migration 0019)
// ---------------------------------------------------------------------------

/** Valid platform values for device tokens. */
export type DeviceTokenPlatform = "ios" | "android" | "web";

/** Row shape for the `device_tokens` table. */
export interface DeviceTokenRow {
  readonly token_id: string;
  readonly user_id: string;
  readonly device_token: string;
  readonly platform: DeviceTokenPlatform;
  readonly created_at: string;
  readonly updated_at: string;
}
