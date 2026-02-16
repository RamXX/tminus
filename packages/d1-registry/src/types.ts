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

// ---------------------------------------------------------------------------
// Org delegations (Migration 0022, TM-9iu.1 + TM-9iu.2)
// ---------------------------------------------------------------------------

/** Valid delegation status values for the `org_delegations.delegation_status` column. */
export type OrgDelegationStatus = "pending" | "active" | "revoked";

/** Valid health check status values. */
export type DelegationHealthCheckStatus = "healthy" | "degraded" | "revoked" | "unknown";

/** Row shape for the `org_delegations` table (with TM-9iu.2 extensions). */
export interface OrgDelegationRow {
  readonly delegation_id: string;
  readonly domain: string;
  readonly admin_email: string;
  readonly delegation_status: OrgDelegationStatus;
  /** Encrypted service account key (JSON envelope: {iv, ciphertext, encryptedDek, dekIv}). */
  readonly encrypted_sa_key: string;
  readonly sa_client_email: string;
  readonly sa_client_id: string;
  readonly validated_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  /** Number of active users in this org delegation. */
  readonly active_users_count: number;
  /** Explicit registration timestamp. */
  readonly registration_date: string | null;
  /** When the current service account key was uploaded. */
  readonly sa_key_created_at: string | null;
  /** Last time the SA key was used for impersonation. */
  readonly sa_key_last_used_at: string | null;
  /** When the SA key should be rotated (90 days from creation). */
  readonly sa_key_rotation_due_at: string | null;
  /** Old encrypted key during zero-downtime rotation. */
  readonly previous_encrypted_sa_key: string | null;
  /** private_key_id of the old key during rotation. */
  readonly previous_sa_key_id: string | null;
  /** Last delegation health check timestamp. */
  readonly last_health_check_at: string | null;
  /** Result of last health check. */
  readonly health_check_status: DelegationHealthCheckStatus;
}

// ---------------------------------------------------------------------------
// Impersonation token cache (Migration 0024, TM-9iu.2)
// ---------------------------------------------------------------------------

/** Row shape for the `impersonation_token_cache` table. */
export interface ImpersonationTokenCacheRow {
  readonly cache_id: string;
  readonly delegation_id: string;
  readonly user_email: string;
  /** Encrypted access token (same AES-256-GCM envelope pattern). */
  readonly encrypted_token: string;
  /** ISO 8601 timestamp when the cached token expires. */
  readonly token_expires_at: string;
  readonly created_at: string;
  readonly updated_at: string;
}

// ---------------------------------------------------------------------------
// Delegation audit log (Migration 0024, TM-9iu.2)
// ---------------------------------------------------------------------------

/** Valid audit action types for delegation events. */
export type DelegationAuditAction =
  | "token_issued"
  | "token_refreshed"
  | "token_cached"
  | "health_check"
  | "key_rotated"
  | "delegation_revoked";

/** Row shape for the `delegation_audit_log` table. */
export interface DelegationAuditLogRow {
  readonly audit_id: string;
  readonly delegation_id: string;
  readonly domain: string;
  readonly user_email: string;
  readonly action: DelegationAuditAction;
  readonly details: string | null;
  readonly created_at: string;
}

// ---------------------------------------------------------------------------
// Org discovered users (Migration 0025, TM-9iu.3)
// ---------------------------------------------------------------------------

/** Valid lifecycle status values for discovered users. */
export type DiscoveredUserStatus = "active" | "suspended" | "removed";

/** Row shape for the `org_discovered_users` table. */
export interface OrgDiscoveredUserRow {
  readonly discovery_id: string;
  readonly delegation_id: string;
  readonly google_user_id: string;
  readonly email: string;
  readonly display_name: string | null;
  readonly org_unit_path: string | null;
  readonly status: DiscoveredUserStatus;
  readonly account_id: string | null;
  readonly last_synced_at: string | null;
  readonly discovered_at: string;
  readonly status_changed_at: string;
  readonly removed_at: string | null;
}

// ---------------------------------------------------------------------------
// Org discovery config (Migration 0025, TM-9iu.3)
// ---------------------------------------------------------------------------

/** Valid sync mode values for discovery configuration. */
export type DiscoverySyncMode = "proactive" | "lazy";

/** Row shape for the `org_discovery_config` table. */
export interface OrgDiscoveryConfigRow {
  readonly config_id: string;
  readonly delegation_id: string;
  /** JSON array of OU paths to include (null = all users). */
  readonly ou_filter_json: string | null;
  /** JSON array of email addresses to exclude (null = no exclusions). */
  readonly excluded_emails: string | null;
  /** 'proactive' = background sync immediately, 'lazy' = sync on first visit. */
  readonly sync_mode: DiscoverySyncMode;
  /** Days to retain data after user is removed from org. */
  readonly retention_days: number;
  /** ISO 8601 timestamp of last directory API discovery run. */
  readonly last_discovery_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

// ---------------------------------------------------------------------------
// Compliance audit log (Migration 0026, TM-9iu.5)
// ---------------------------------------------------------------------------

/** Valid compliance audit action types. */
export type ComplianceAuditAction =
  | "delegation_created"
  | "delegation_rotated"
  | "user_discovered"
  | "user_suspended"
  | "user_removed"
  | "config_updated"
  | "token_issued"
  | "admin_action";

/** Valid audit result types. */
export type ComplianceAuditResult = "success" | "failure" | "error";

/** Row shape for the `compliance_audit_log` table. */
export interface ComplianceAuditLogRow {
  readonly entry_id: string;
  readonly org_id: string;
  readonly timestamp: string;
  readonly actor: string;
  readonly action: ComplianceAuditAction;
  readonly target: string;
  readonly result: ComplianceAuditResult;
  readonly ip_address: string;
  readonly user_agent: string;
  readonly details: string | null;
  readonly previous_hash: string;
  readonly entry_hash: string;
}

// ---------------------------------------------------------------------------
// Org rate limit config (Migration 0026, TM-9iu.5)
// ---------------------------------------------------------------------------

/** Row shape for the `org_rate_limit_config` table. */
export interface OrgRateLimitConfigRow {
  readonly org_id: string;
  readonly api_max_requests: number;
  readonly api_window_seconds: number;
  readonly directory_max_requests: number;
  readonly directory_window_seconds: number;
  readonly impersonation_max_requests: number;
  readonly impersonation_window_seconds: number;
  readonly created_at: string;
  readonly updated_at: string;
}

// ---------------------------------------------------------------------------
// Org quota config (Migration 0026, TM-9iu.5)
// ---------------------------------------------------------------------------

/** Row shape for the `org_quota_config` table. */
export interface OrgQuotaConfigRow {
  readonly org_id: string;
  readonly max_discovered_users: number;
  readonly max_delegations: number;
  readonly max_api_calls_daily: number;
  readonly retention_days: number;
  readonly created_at: string;
  readonly updated_at: string;
}

// ---------------------------------------------------------------------------
// Org quota usage (Migration 0026, TM-9iu.5)
// ---------------------------------------------------------------------------

/** Valid quota types for usage tracking. */
export type OrgQuotaType = "discovered_users" | "delegations" | "api_calls_daily";

/** Row shape for the `org_quota_usage` table. */
export interface OrgQuotaUsageRow {
  readonly org_id: string;
  readonly quota_type: OrgQuotaType;
  readonly period_key: string;
  readonly usage_count: number;
  readonly updated_at: string;
}

// ---------------------------------------------------------------------------
// Org rate limit counters (Migration 0026, TM-9iu.5)
// ---------------------------------------------------------------------------

/** Row shape for the `org_rate_limit_counters` table. */
export interface OrgRateLimitCounterRow {
  readonly counter_key: string;
  readonly count: number;
  readonly expires_at: string;
}
