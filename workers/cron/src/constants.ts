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

// ---------------------------------------------------------------------------
// Renewal thresholds
// ---------------------------------------------------------------------------

/** Renew channels that expire within this window (24 hours). */
export const CHANNEL_RENEWAL_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Microsoft subscription max lifetime: 3 days (4230 min for calendar events).
 * Renew at 75% lifetime = ~2.25 days = 54 hours.
 */
export const MS_SUBSCRIPTION_RENEWAL_THRESHOLD_MS = 54 * 60 * 60 * 1000;
