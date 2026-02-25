/**
 * Cron worker constants.
 *
 * Extracted from index.ts so that the worker entry point only exports
 * handler objects and Workflow classes (wrangler dev rejects non-handler
 * constant exports from entry points).
 */

// ---------------------------------------------------------------------------
// Cron schedule constants (must match wrangler.toml [triggers].crons)
// ---------------------------------------------------------------------------

/** Channel renewal: every 6 hours. */
export const CRON_CHANNEL_RENEWAL = "0 */6 * * *";

/** Token health check: every 12 hours. */
export const CRON_TOKEN_HEALTH = "0 */12 * * *";

/** Drift reconciliation: daily at 03:00 UTC. */
export const CRON_RECONCILIATION = "0 3 * * *";

/** Deletion check: every hour, checks for pending deletions past grace period. */
export const CRON_DELETION_CHECK = "0 * * * *";

/** ICS feed refresh + MS incremental sweep: hourly at :30 (was every 15min, reduced for cost). */
export const CRON_FEED_REFRESH = "30 * * * *";

// ---------------------------------------------------------------------------
// Renewal thresholds
// ---------------------------------------------------------------------------

/** Renew channels that expire within this window (24 hours). */
export const CHANNEL_RENEWAL_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * If no incremental sync has occurred in this window, the channel is
 * considered silently dead and will be force-renewed regardless of expiry.
 *
 * Google may stop delivering push notifications at any time (documented
 * behavior). 12 hours of silence on an active account is a strong signal.
 *
 * See: TM-ucl1 root cause analysis.
 */
export const CHANNEL_LIVENESS_THRESHOLD_MS = 12 * 60 * 60 * 1000;

/**
 * Microsoft subscription max lifetime: 3 days (4230 min for calendar events).
 * Renew at 75% lifetime = ~2.25 days = 54 hours.
 */
export const MS_SUBSCRIPTION_RENEWAL_THRESHOLD_MS = 54 * 60 * 60 * 1000;
