/**
 * tminus-cron -- Scheduled maintenance worker.
 *
 * Five cron responsibilities:
 * 1. Google channel renewal (every 6h): renew Google watch channels expiring within 24h
 * 2. Microsoft subscription renewal (every 6h): renew MS subscriptions at 75% lifetime
 * 3. Token health check (every 12h): verify account tokens, mark errors
 * 4. Drift reconciliation (daily 03:00 UTC): enqueue RECONCILE_ACCOUNT messages
 * 5. Social drift computation (daily 04:00 UTC): compute drift for all users, store alerts
 *
 * Design decisions:
 * - Each responsibility is a separate function for testability
 * - Errors in one account do not block processing of others (log + continue)
 * - AccountDO communication via HTTP fetch on DO stubs (standard CF pattern)
 * - D1 queries only touch active accounts (except channel renewal which also checks expiry)
 * - Per ADR-6: Daily reconciliation, not weekly
 */

import type { ReconcileAccountMessage, AccountId, DeleteMirrorMessage, EventId } from "@tminus/shared";
import {
  GoogleCalendarClient,
  generateId,
  computeContentHash,
  detectFeedChanges,
  classifyFeedError,
  isRateLimited,
  buildConditionalHeaders,
  DEFAULT_REFRESH_INTERVAL_MS,
  normalizeIcsFeedEvents,
} from "@tminus/shared";
import {
  CRON_CHANNEL_RENEWAL,
  CRON_TOKEN_HEALTH,
  CRON_RECONCILIATION,
  CRON_DELETION_CHECK,
  CRON_HOLD_EXPIRY,
  CRON_DRIFT_COMPUTATION,
  CRON_FEED_REFRESH,
  CHANNEL_RENEWAL_THRESHOLD_MS,
  CHANNEL_LIVENESS_THRESHOLD_MS,
  MS_SUBSCRIPTION_RENEWAL_THRESHOLD_MS,
} from "./constants";

// ---------------------------------------------------------------------------
// Workflow class re-export (required by wrangler for Workflow hosting)
// ---------------------------------------------------------------------------

export { ReconcileWorkflow } from "@tminus/workflow-reconcile";

// ---------------------------------------------------------------------------
// D1 row types (query results)
// ---------------------------------------------------------------------------

interface ExpiringChannelRow {
  readonly account_id: string;
  readonly channel_id: string;
  readonly channel_token: string;
  readonly channel_expiry_ts: string;
}

/**
 * Row type for the channel liveness check.
 * Channels that have not seen a sync in CHANNEL_LIVENESS_THRESHOLD_MS
 * are considered silently dead (Google may stop delivering push notifications
 * at any time, even before channel expiry).
 *
 * See: TM-ucl1 root cause analysis.
 */
interface StaleChannelRow {
  readonly account_id: string;
  readonly channel_id: string;
  readonly channel_token: string;
  readonly channel_expiry_ts: string;
  readonly last_sync_ts: string | null;
}

interface ActiveAccountRow {
  readonly account_id: string;
  readonly user_id: string;
}

interface MsAccountRow {
  readonly account_id: string;
}

// ---------------------------------------------------------------------------
// Channel Renewal (every 6h) -- Google
// ---------------------------------------------------------------------------

/**
 * Query D1 for Google accounts that need channel re-registration:
 *
 * 1. EXPIRING: channels expiring within CHANNEL_RENEWAL_THRESHOLD_MS (24h)
 * 2. STALE: channels that have not seen a sync in CHANNEL_LIVENESS_THRESHOLD_MS (12h)
 *    despite being "active" -- Google may silently stop delivering push
 *    notifications even before channel expiry (documented behavior).
 *
 * For each account found:
 * 1. Get access token from AccountDO
 * 2. Stop the old channel with Google (best-effort, may already be dead)
 * 3. Register a new channel with Google via Calendar API
 * 4. Store the new channel in AccountDO and update D1
 *
 * BUG FIX (TM-ucl1): Previously this only called AccountDO.renewChannel()
 * which bumped the local expiry timestamp but NEVER re-registered with Google.
 * This meant channel "renewal" was a no-op from Google's perspective.
 */
async function handleChannelRenewal(env: Env): Promise<void> {
  const now = Date.now();
  const expiryThresholdTs = new Date(
    now + CHANNEL_RENEWAL_THRESHOLD_MS,
  ).toISOString();
  const livenessThresholdTs = new Date(
    now - CHANNEL_LIVENESS_THRESHOLD_MS,
  ).toISOString();

  // Query 1: Channels expiring within 24 hours
  const { results: expiringResults } = await env.DB
    .prepare(
      `SELECT account_id, channel_id, channel_token, channel_expiry_ts
       FROM accounts
       WHERE status = ?1
         AND provider = 'google'
         AND channel_id IS NOT NULL
         AND channel_expiry_ts IS NOT NULL
         AND channel_expiry_ts <= ?2`,
    )
    .bind("active", expiryThresholdTs)
    .all<ExpiringChannelRow>();

  // Query 2: Channels that are alive per expiry but have not synced recently
  // (silently dead -- Google stopped delivering)
  const { results: staleResults } = await env.DB
    .prepare(
      `SELECT account_id, channel_id, channel_token, channel_expiry_ts, last_sync_ts
       FROM accounts
       WHERE status = ?1
         AND provider = 'google'
         AND channel_id IS NOT NULL
         AND channel_expiry_ts IS NOT NULL
         AND channel_expiry_ts > ?2
         AND (last_sync_ts IS NULL OR last_sync_ts <= ?3)`,
    )
    .bind("active", expiryThresholdTs, livenessThresholdTs)
    .all<StaleChannelRow>();

  // Deduplicate by account_id (an account could appear in both queries)
  const seen = new Set<string>();
  const accountsToRenew: Array<{
    account_id: string;
    channel_id: string;
    channel_token: string;
    reason: string;
  }> = [];

  for (const row of expiringResults) {
    if (!seen.has(row.account_id)) {
      seen.add(row.account_id);
      accountsToRenew.push({
        account_id: row.account_id,
        channel_id: row.channel_id,
        channel_token: row.channel_token,
        reason: `expiring (${row.channel_expiry_ts})`,
      });
    }
  }

  for (const row of staleResults) {
    if (!seen.has(row.account_id)) {
      seen.add(row.account_id);
      accountsToRenew.push({
        account_id: row.account_id,
        channel_id: row.channel_id,
        channel_token: row.channel_token,
        reason: `stale (last_sync: ${row.last_sync_ts ?? "never"})`,
      });
    }
  }

  console.log(
    `Channel renewal: ${expiringResults.length} expiring, ${staleResults.length} stale, ${accountsToRenew.length} total to renew`,
  );

  for (const account of accountsToRenew) {
    try {
      await reRegisterChannel(env, account.account_id, account.channel_id, account.reason);
    } catch (err) {
      console.error(
        `Channel re-registration error for account ${account.account_id} (${account.reason}):`,
        err,
      );
    }
  }
}

/**
 * Re-register a Google Calendar watch channel for an account.
 *
 * Steps:
 * 1. Get access token from AccountDO
 * 2. Stop the old channel with Google (best-effort)
 * 3. Register a new channel with Google
 * 4. Store new channel in AccountDO via storeWatchChannel
 * 5. Update D1 with new channel_id, channel_token, channel_expiry_ts
 */
async function reRegisterChannel(
  env: Env,
  accountId: string,
  oldChannelId: string,
  reason: string,
): Promise<void> {
  const doId = env.ACCOUNT.idFromName(accountId);
  const stub = env.ACCOUNT.get(doId);

  // Step 1: Get access token from AccountDO
  const tokenResponse = await stub.fetch(
    new Request("https://account-do.internal/getAccessToken", {
      method: "POST",
    }),
  );

  if (!tokenResponse.ok) {
    console.error(
      `Channel renewal: failed to get access token for account ${accountId}: ${tokenResponse.status}`,
    );
    return;
  }

  const { access_token } = (await tokenResponse.json()) as { access_token: string };
  const client = new GoogleCalendarClient(access_token);

  // Step 2: Get resource_id for the old channel from D1 (needed for stop)
  const resourceRow = await env.DB
    .prepare("SELECT resource_id FROM accounts WHERE account_id = ?1")
    .bind(accountId)
    .first<{ resource_id: string | null }>();

  // Best-effort: stop old channel (may already be dead/expired)
  if (resourceRow?.resource_id) {
    try {
      await client.stopChannel(oldChannelId, resourceRow.resource_id);
      console.log(`Channel renewal: stopped old channel ${oldChannelId} for account ${accountId}`);
    } catch (err) {
      // 404 means channel already expired/deleted -- that's fine
      console.warn(
        `Channel renewal: could not stop old channel ${oldChannelId} (expected if already dead):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Step 3: Register new channel with Google
  const newChannelId = generateId("calendar");
  const newToken = generateId("calendar");

  let watchResponse;
  try {
    watchResponse = await client.watchEvents(
      "primary",
      env.WEBHOOK_URL,
      newChannelId,
      newToken,
    );
  } catch (err) {
    console.error(
      `Channel renewal: failed to register new channel for account ${accountId}:`,
      err,
    );
    return;
  }

  // Step 4: Store new channel in AccountDO
  const storeResponse = await stub.fetch(
    new Request("https://account-do.internal/storeWatchChannel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel_id: watchResponse.channelId,
        resource_id: watchResponse.resourceId,
        expiration: watchResponse.expiration,
        calendar_id: "primary",
      }),
    }),
  );

  if (!storeResponse.ok) {
    console.error(
      `Channel renewal: failed to store new channel in AccountDO for account ${accountId}: ${storeResponse.status}`,
    );
    return;
  }

  // Step 5: Update D1 with new channel info
  const expiryTs = new Date(parseInt(watchResponse.expiration, 10)).toISOString();
  await env.DB
    .prepare(
      `UPDATE accounts
       SET channel_id = ?1, channel_token = ?2, channel_expiry_ts = ?3, resource_id = ?4
       WHERE account_id = ?5`,
    )
    .bind(
      watchResponse.channelId,
      newToken,
      expiryTs,
      watchResponse.resourceId,
      accountId,
    )
    .run();

  console.log(
    `Channel renewal: re-registered for account ${accountId} (reason: ${reason}). ` +
      `New channel: ${watchResponse.channelId}, expires: ${expiryTs}`,
  );
}

// ---------------------------------------------------------------------------
// Microsoft Subscription Renewal (every 6h)
// ---------------------------------------------------------------------------

/**
 * Query D1 for active Microsoft accounts and renew their subscriptions
 * if they're at or past 75% of their 3-day lifetime (54 hours).
 *
 * For each Microsoft account:
 * 1. Call AccountDO.getMsSubscriptions() to get all subscriptions
 * 2. For each subscription expiring within MS_SUBSCRIPTION_RENEWAL_THRESHOLD_MS,
 *    call AccountDO.renewMsSubscription()
 */
async function handleMsSubscriptionRenewal(env: Env): Promise<void> {
  const { results } = await env.DB
    .prepare(
      `SELECT account_id FROM accounts
       WHERE status = ?1 AND provider = ?2`,
    )
    .bind("active", "microsoft")
    .all<MsAccountRow>();

  console.log(
    `Microsoft subscription renewal: found ${results.length} active Microsoft accounts`,
  );

  for (const row of results) {
    try {
      const doId = env.ACCOUNT.idFromName(row.account_id);
      const stub = env.ACCOUNT.get(doId);

      // Get all subscriptions for this account
      const subsResponse = await stub.fetch(
        new Request("https://account-do.internal/getMsSubscriptions", {
          method: "GET",
        }),
      );

      if (!subsResponse.ok) {
        console.error(
          `Failed to get Microsoft subscriptions for account ${row.account_id}: ${subsResponse.status}`,
        );
        continue;
      }

      const subsData = (await subsResponse.json()) as {
        subscriptions: Array<{
          subscriptionId: string;
          expiration: string;
        }>;
      };

      const renewalThreshold = new Date(
        Date.now() + MS_SUBSCRIPTION_RENEWAL_THRESHOLD_MS,
      );

      for (const sub of subsData.subscriptions) {
        const expirationDate = new Date(sub.expiration);

        // Renew if expiration is within the threshold window
        if (expirationDate <= renewalThreshold) {
          try {
            const renewResponse = await stub.fetch(
              new Request("https://account-do.internal/renewMsSubscription", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  subscription_id: sub.subscriptionId,
                }),
              }),
            );

            if (!renewResponse.ok) {
              console.error(
                `Microsoft subscription renewal failed for account ${row.account_id}, sub ${sub.subscriptionId}: ${renewResponse.status}`,
              );
            } else {
              console.log(
                `Microsoft subscription renewed for account ${row.account_id}, sub ${sub.subscriptionId}`,
              );
            }
          } catch (err) {
            console.error(
              `Microsoft subscription renewal error for account ${row.account_id}, sub ${sub.subscriptionId}:`,
              err,
            );
          }
        }
      }
    } catch (err) {
      console.error(
        `Microsoft subscription renewal error for account ${row.account_id}:`,
        err,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Token Health Check (every 12h)
// ---------------------------------------------------------------------------

/**
 * Query D1 for all active accounts, call AccountDO.getHealth() to check
 * token status, and attempt refresh via AccountDO.getAccessToken().
 * If refresh fails, mark account status='error' in D1.
 */
async function handleTokenHealth(env: Env): Promise<void> {
  const { results } = await env.DB
    .prepare("SELECT account_id, user_id FROM accounts WHERE status = ?1")
    .bind("active")
    .all<ActiveAccountRow>();

  console.log(`Token health check: found ${results.length} active accounts`);

  for (const row of results) {
    try {
      const doId = env.ACCOUNT.idFromName(row.account_id);
      const stub = env.ACCOUNT.get(doId);

      // Step 1: Check health
      const healthResponse = await stub.fetch(
        new Request("https://account-do.internal/getHealth", {
          method: "GET",
        }),
      );

      if (!healthResponse.ok) {
        console.error(
          `Health check failed for account ${row.account_id}: ${healthResponse.status}`,
        );
        continue;
      }

      // Step 2: Attempt token refresh to verify token validity
      const tokenResponse = await stub.fetch(
        new Request("https://account-do.internal/getAccessToken", {
          method: "GET",
        }),
      );

      if (!tokenResponse.ok) {
        // Token refresh failed -- mark account as error in D1
        console.error(
          `Token refresh failed for account ${row.account_id}: ${tokenResponse.status}. Marking as error.`,
        );

        await env.DB
          .prepare("UPDATE accounts SET status = ?1 WHERE account_id = ?2")
          .bind("error", row.account_id)
          .run();
      } else {
        console.log(`Token healthy for account ${row.account_id}`);
      }
    } catch (err) {
      console.error(
        `Token health error for account ${row.account_id}:`,
        err,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Drift Reconciliation Dispatch (daily 03:00 UTC)
// ---------------------------------------------------------------------------

/**
 * Query D1 for all active accounts and enqueue RECONCILE_ACCOUNT messages
 * for each. Per ADR-6: daily, not weekly. Google push notifications are
 * best-effort and can silently stop.
 *
 * This is a queue-only operation -- no AccountDO calls needed.
 */
async function handleReconciliation(env: Env): Promise<void> {
  const { results } = await env.DB
    .prepare("SELECT account_id, user_id FROM accounts WHERE status = ?1")
    .bind("active")
    .all<ActiveAccountRow>();

  console.log(
    `Drift reconciliation: enqueuing ${results.length} active accounts`,
  );

  for (const row of results) {
    try {
      const msg: ReconcileAccountMessage = {
        type: "RECONCILE_ACCOUNT",
        account_id: row.account_id as AccountId,
        reason: "scheduled",
      };

      await env.RECONCILE_QUEUE.send(msg);
      console.log(`Enqueued RECONCILE_ACCOUNT for account ${row.account_id}`);
    } catch (err) {
      console.error(
        `Failed to enqueue reconciliation for account ${row.account_id}:`,
        err,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Deletion Check (every hour)
// ---------------------------------------------------------------------------

interface PendingDeletionRow {
  readonly request_id: string;
  readonly user_id: string;
  readonly scheduled_at: string;
}

/**
 * Query D1 for pending deletion requests whose grace period has expired
 * (scheduled_at <= now). For each, update status to 'processing' and
 * trigger the DeletionWorkflow.
 *
 * If the DELETION_WORKFLOW binding is not yet configured (the workflow
 * is implemented in a separate story), we log a warning but still mark
 * the request as processing so it does not get re-triggered.
 */
async function handleDeletionCheck(env: Env): Promise<void> {
  const now = new Date().toISOString();

  const { results } = await env.DB
    .prepare(
      `SELECT request_id, user_id, scheduled_at
       FROM deletion_requests
       WHERE status = ?1 AND scheduled_at <= ?2`,
    )
    .bind("pending", now)
    .all<PendingDeletionRow>();

  console.log(`Deletion check: found ${results.length} requests past grace period`);

  for (const row of results) {
    try {
      // Mark as processing FIRST (idempotent -- prevents duplicate triggers)
      await env.DB
        .prepare(
          "UPDATE deletion_requests SET status = 'processing' WHERE request_id = ?1 AND status = 'pending'",
        )
        .bind(row.request_id)
        .run();

      // Trigger DeletionWorkflow (if binding exists)
      if (env.DELETION_WORKFLOW) {
        await env.DELETION_WORKFLOW.create({
          id: `deletion-${row.request_id}`,
          params: {
            request_id: row.request_id,
            user_id: row.user_id,
          },
        });
        console.log(
          `DeletionWorkflow triggered for request ${row.request_id} (user ${row.user_id})`,
        );
      } else {
        console.warn(
          `DeletionWorkflow binding not configured. Request ${row.request_id} marked as processing but workflow not triggered.`,
        );
      }
    } catch (err) {
      console.error(
        `Deletion check error for request ${row.request_id}:`,
        err,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Hold Expiry Cleanup (every hour at :30)
// ---------------------------------------------------------------------------

interface ExpiredHoldRow {
  readonly hold_id: string;
  readonly session_id: string;
  readonly account_id: string;
  readonly provider_event_id: string | null;
}

/**
 * Query UserGraphDO for expired tentative holds and clean them up.
 *
 * For each active user, calls UserGraphDO.getExpiredHolds(). For each
 * expired hold with a provider_event_id, enqueues a DELETE_MIRROR message
 * to remove the tentative event from the calendar. Then transitions the
 * hold status to 'expired'.
 *
 * TM-82s.4: After expiring all holds for a session, also updates the
 * session status to 'expired' if all holds for that session are now
 * in terminal states (expired/released/committed).
 *
 * This implements AC-4/AC-6: "Automatic release on expiry / Cron-based expiry cleanup".
 */
async function handleHoldExpiry(env: Env): Promise<void> {
  // Get all active users (they each have a UserGraphDO with schedule_holds)
  const { results } = await env.DB
    .prepare(
      `SELECT DISTINCT user_id FROM accounts WHERE status = ?1`,
    )
    .bind("active")
    .all<{ user_id: string }>();

  console.log(`Hold expiry cleanup: checking ${results.length} active users`);

  let totalExpired = 0;
  let totalDeleted = 0;
  // Track session_ids that had holds expired to check if session should also expire
  const sessionIdsToCheck = new Set<string>();

  for (const row of results) {
    try {
      const doId = env.USER_GRAPH.idFromName(row.user_id);
      const stub = env.USER_GRAPH.get(doId);

      // Query for expired holds
      const response = await stub.fetch(
        new Request("https://user-graph.internal/getExpiredHolds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      );

      if (!response.ok) {
        console.error(
          `Failed to get expired holds for user ${row.user_id}: ${response.status}`,
        );
        continue;
      }

      const { holds } = (await response.json()) as {
        holds: ExpiredHoldRow[];
      };

      if (holds.length === 0) continue;

      totalExpired += holds.length;

      // Enqueue DELETE_MIRROR messages for holds with provider events
      for (const hold of holds) {
        if (hold.provider_event_id) {
          try {
            const deleteMsg: DeleteMirrorMessage = {
              type: "DELETE_MIRROR",
              canonical_event_id: `hold_${hold.hold_id}` as EventId,
              target_account_id: hold.account_id as AccountId,
              provider_event_id: hold.provider_event_id,
              idempotency_key: `hold_expire_${hold.hold_id}`,
            };
            await env.WRITE_QUEUE.send(deleteMsg);
            totalDeleted++;
          } catch (err) {
            console.error(
              `Failed to enqueue delete for hold ${hold.hold_id}:`,
              err,
            );
          }
        }

        // Transition hold to 'expired' status
        try {
          await stub.fetch(
            new Request("https://user-graph.internal/updateHoldStatus", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                hold_id: hold.hold_id,
                status: "expired",
              }),
            }),
          );
          // Track session for potential session-level expiry
          sessionIdsToCheck.add(hold.session_id);
        } catch (err) {
          console.error(
            `Failed to expire hold ${hold.hold_id}:`,
            err,
          );
        }
      }

      // TM-82s.4: For each session that had holds expired, check if ALL
      // holds for that session are now in terminal states. If so, expire
      // the session itself.
      for (const sessionId of sessionIdsToCheck) {
        try {
          await stub.fetch(
            new Request("https://user-graph.internal/expireSessionIfAllHoldsTerminal", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ session_id: sessionId }),
            }),
          );
        } catch (err) {
          console.error(
            `Failed to check/expire session ${sessionId}:`,
            err,
          );
        }
      }
      sessionIdsToCheck.clear();
    } catch (err) {
      console.error(
        `Hold expiry error for user ${row.user_id}:`,
        err,
      );
    }
  }

  console.log(
    `Hold expiry cleanup: expired ${totalExpired} holds, enqueued ${totalDeleted} deletes`,
  );
}

// ---------------------------------------------------------------------------
// Social Drift Computation (daily 04:00 UTC)
// ---------------------------------------------------------------------------

/**
 * For each active user, compute drift report via UserGraphDO.getDriftReport(),
 * then store the resulting alerts via UserGraphDO.storeDriftAlerts().
 *
 * Runs after reconciliation (03:00 UTC) so that event data is fresh.
 * Errors in one user do not block processing of others.
 */
async function handleDriftComputation(env: Env): Promise<void> {
  // Get all distinct active users
  const { results } = await env.DB
    .prepare(
      `SELECT DISTINCT user_id FROM accounts WHERE status = ?1`,
    )
    .bind("active")
    .all<{ user_id: string }>();

  console.log(
    `Social drift computation: processing ${results.length} active users`,
  );

  let totalAlerts = 0;

  for (const row of results) {
    try {
      const doId = env.USER_GRAPH.idFromName(row.user_id);
      const stub = env.USER_GRAPH.get(doId);

      // Step 1: Get drift report
      const reportResponse = await stub.fetch(
        new Request("https://user-graph.internal/getDriftReport", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
      );

      if (!reportResponse.ok) {
        console.error(
          `Drift computation: failed to get drift report for user ${row.user_id}: ${reportResponse.status}`,
        );
        continue;
      }

      const report = (await reportResponse.json()) as {
        overdue: Array<{
          relationship_id: string;
          display_name: string | null;
          category: string;
          drift_ratio: number;
          days_overdue: number;
          urgency: number;
        }>;
        total_tracked: number;
        total_overdue: number;
        computed_at: string;
      };

      // Step 2: Store alerts
      const storeResponse = await stub.fetch(
        new Request("https://user-graph.internal/storeDriftAlerts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ report }),
        }),
      );

      if (!storeResponse.ok) {
        console.error(
          `Drift computation: failed to store alerts for user ${row.user_id}: ${storeResponse.status}`,
        );
        continue;
      }

      const storeResult = (await storeResponse.json()) as { stored: number };
      totalAlerts += storeResult.stored;

      console.log(
        `Drift computation: user ${row.user_id}: ${report.total_overdue} overdue out of ${report.total_tracked} tracked`,
      );
    } catch (err) {
      console.error(
        `Drift computation error for user ${row.user_id}:`,
        err,
      );
    }
  }

  console.log(
    `Social drift computation: stored ${totalAlerts} total alerts across ${results.length} users`,
  );
}

// ---------------------------------------------------------------------------
// ICS Feed Refresh (every 15 minutes) -- TM-d17.3
// ---------------------------------------------------------------------------

interface IcsFeedAccountRow {
  readonly account_id: string;
  readonly user_id: string;
  readonly provider_subject: string; // stores the feed URL
  readonly feed_etag: string | null;
  readonly feed_last_modified: string | null;
  readonly feed_content_hash: string | null;
  readonly feed_last_refresh_at: string | null;
  readonly feed_last_fetch_at: string | null;
  readonly feed_consecutive_failures: number;
  readonly feed_refresh_interval_ms: number | null;
}

/**
 * Query D1 for all active ICS feed accounts and refresh each one.
 *
 * For each feed:
 * 1. Check rate limit (max 1 request per feed per 5 minutes, BR-4)
 * 2. Check if refresh is due based on configured interval
 * 3. Fetch feed URL with HTTP conditional headers (ETag/Last-Modified, BR-2)
 * 4. Detect changes via content hashing
 * 5. If changed, parse events and apply deltas to UserGraphDO
 * 6. Update D1 with refresh metadata
 *
 * Errors in one feed do not block processing of others.
 */
async function handleFeedRefresh(env: Env): Promise<void> {
  const { results } = await env.DB
    .prepare(
      `SELECT account_id, user_id, provider_subject,
              feed_etag, feed_last_modified, feed_content_hash,
              feed_last_refresh_at, feed_last_fetch_at,
              feed_consecutive_failures,
              feed_refresh_interval_ms
       FROM accounts
       WHERE status = ?1 AND provider = ?2`,
    )
    .bind("active", "ics_feed")
    .all<IcsFeedAccountRow>();

  console.log(`ICS feed refresh: found ${results.length} active feeds`);

  let refreshed = 0;
  let skipped = 0;
  let errored = 0;

  for (const feed of results) {
    try {
      const now = Date.now();

      // BR-4: Rate limit -- max 1 request per feed per 5 minutes
      if (isRateLimited(feed.feed_last_fetch_at, now)) {
        skipped++;
        continue;
      }

      // Check if refresh is due based on configured interval
      const intervalMs = feed.feed_refresh_interval_ms ?? DEFAULT_REFRESH_INTERVAL_MS;
      if (intervalMs === 0) {
        // Manual-only feeds: skip automatic refresh
        skipped++;
        continue;
      }

      if (feed.feed_last_refresh_at) {
        const elapsed = now - new Date(feed.feed_last_refresh_at).getTime();
        if (elapsed < intervalMs) {
          skipped++;
          continue;
        }
      }

      // Build conditional headers (BR-2: minimize bandwidth)
      const headers = buildConditionalHeaders({
        etag: feed.feed_etag ?? undefined,
        lastModified: feed.feed_last_modified ?? undefined,
      });

      // Fetch the feed
      let response: Response;
      try {
        response = await fetch(feed.provider_subject, { headers });
      } catch (err) {
        // Network error / timeout
        console.error(
          `ICS feed fetch failed for account ${feed.account_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        const newFailures = feed.feed_consecutive_failures + 1;
        await env.DB
          .prepare(
            `UPDATE accounts
             SET feed_last_fetch_at = ?1,
                 feed_consecutive_failures = ?2
             WHERE account_id = ?3`,
          )
          .bind(new Date(now).toISOString(), newFailures, feed.account_id)
          .run();
        errored++;
        continue;
      }

      // Record fetch timestamp
      const fetchTimestamp = new Date(now).toISOString();

      // Handle error responses
      if (!response.ok && response.status !== 304) {
        const errorClass = classifyFeedError(response.status);
        const newFailures = feed.feed_consecutive_failures + 1;

        console.error(
          `ICS feed HTTP ${response.status} for account ${feed.account_id}: ${errorClass.category}`,
        );

        // Mark feed as error if dead (404/410) or auth required (401/403)
        const newStatus = errorClass.userActionRequired ? "error" : "active";
        await env.DB
          .prepare(
            `UPDATE accounts
             SET feed_last_fetch_at = ?1,
                 feed_consecutive_failures = ?2,
                 status = ?3
             WHERE account_id = ?4`,
          )
          .bind(fetchTimestamp, newFailures, newStatus, feed.account_id)
          .run();
        errored++;
        continue;
      }

      // Detect changes
      const responseBody = response.status === 304 ? null : await response.text();
      const etag = response.headers.get("ETag") ?? feed.feed_etag ?? undefined;
      const lastModified = response.headers.get("Last-Modified") ?? feed.feed_last_modified ?? undefined;

      const changeResult = detectFeedChanges({
        httpStatus: response.status,
        responseBody,
        previousContentHash: feed.feed_content_hash ?? undefined,
        etag,
        lastModified,
      });

      if (!changeResult.changed) {
        // No change -- just update timestamps
        await env.DB
          .prepare(
            `UPDATE accounts
             SET feed_last_fetch_at = ?1,
                 feed_last_refresh_at = ?2,
                 feed_consecutive_failures = 0,
                 feed_etag = ?3,
                 feed_last_modified = ?4
             WHERE account_id = ?5`,
          )
          .bind(
            fetchTimestamp,
            fetchTimestamp,
            changeResult.newEtag ?? feed.feed_etag,
            changeResult.newLastModified ?? feed.feed_last_modified,
            feed.account_id,
          )
          .run();
        refreshed++;
        continue;
      }

      // Feed changed -- parse events and apply deltas
      const icsText = responseBody!;
      const feedEvents = normalizeIcsFeedEvents(icsText, feed.account_id);

      // Build deltas for UserGraphDO
      const deltas = feedEvents.map((evt) => ({
        type: "created" as const,
        origin_event_id: evt.origin_event_id,
        origin_account_id: evt.origin_account_id,
        event: {
          origin_account_id: evt.origin_account_id,
          origin_event_id: evt.origin_event_id,
          title: evt.title,
          description: evt.description,
          location: evt.location,
          start: evt.start,
          end: evt.end,
          all_day: evt.all_day,
          status: evt.status,
          visibility: evt.visibility,
          transparency: evt.transparency,
          recurrence_rule: evt.recurrence_rule,
        },
      }));

      // Apply deltas to UserGraphDO
      const doId = env.USER_GRAPH.idFromName(feed.user_id);
      const stub = env.USER_GRAPH.get(doId);

      const doResp = await stub.fetch(
        new Request("https://user-graph.internal/applyProviderDelta", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            account_id: feed.account_id,
            deltas,
          }),
        }),
      );

      if (!doResp.ok) {
        console.error(
          `ICS feed delta apply failed for account ${feed.account_id}: ${doResp.status}`,
        );
        errored++;
        continue;
      }

      // Build event sequence map for future per-event diffing
      const eventSequencesMap: Record<string, number> = {};
      // Parse raw events to get UID -> SEQUENCE mapping
      // We use the normalized events; SEQUENCE is not in NormalizedFeedEvent so we
      // default to 0 for now. The per-event diff is still valid via UID presence/absence.
      for (const evt of feedEvents) {
        eventSequencesMap[evt.origin_event_id] = 0;
      }

      // Update D1 with all refresh metadata
      await env.DB
        .prepare(
          `UPDATE accounts
           SET feed_last_fetch_at = ?1,
               feed_last_refresh_at = ?2,
               feed_consecutive_failures = 0,
               feed_etag = ?3,
               feed_last_modified = ?4,
               feed_content_hash = ?5,
               feed_event_sequences_json = ?6
           WHERE account_id = ?7`,
        )
        .bind(
          fetchTimestamp,
          fetchTimestamp,
          changeResult.newEtag ?? null,
          changeResult.newLastModified ?? null,
          changeResult.newContentHash ?? null,
          JSON.stringify(eventSequencesMap),
          feed.account_id,
        )
        .run();

      refreshed++;
      console.log(
        `ICS feed refreshed account ${feed.account_id}: ${feedEvents.length} events applied`,
      );
    } catch (err) {
      console.error(
        `ICS feed refresh error for account ${feed.account_id}:`,
        err,
      );
      errored++;
    }
  }

  console.log(
    `ICS feed refresh: ${refreshed} refreshed, ${skipped} skipped, ${errored} errored`,
  );
}

// ---------------------------------------------------------------------------
// Scheduled handler dispatch
// ---------------------------------------------------------------------------

// Dispatch to the appropriate handler based on the cron schedule.
// Each cron string from wrangler.toml maps to exactly one handler.
// Google channel renewal and Microsoft subscription renewal share the same schedule
// (every 6 hours) but are separate operations.
async function handleScheduled(
  event: ScheduledEvent,
  env: Env,
): Promise<void> {
  const { cron } = event;

  switch (cron) {
    case CRON_CHANNEL_RENEWAL:
      await handleChannelRenewal(env);
      await handleMsSubscriptionRenewal(env);
      break;

    case CRON_TOKEN_HEALTH:
      await handleTokenHealth(env);
      break;

    case CRON_RECONCILIATION:
      await handleReconciliation(env);
      break;

    case CRON_DELETION_CHECK:
      await handleDeletionCheck(env);
      break;

    case CRON_HOLD_EXPIRY:
      await handleHoldExpiry(env);
      break;

    case CRON_DRIFT_COMPUTATION:
      await handleDriftComputation(env);
      break;

    case CRON_FEED_REFRESH:
      await handleFeedRefresh(env);
      break;

    default:
      console.warn(`Unknown cron schedule: ${cron}`);
  }
}

// ---------------------------------------------------------------------------
// Factory + default export
// ---------------------------------------------------------------------------

/**
 * Creates the worker handler. Factory pattern allows tests to invoke
 * handlers directly with injected dependencies.
 */
export function createHandler() {
  return {
    async fetch(
      request: Request,
      _env: Env,
      _ctx: ExecutionContext,
    ): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return new Response("OK", { status: 200 });
      }

      return new Response("Not Found", { status: 404 });
    },

    async scheduled(
      event: ScheduledEvent,
      env: Env,
      _ctx: ExecutionContext,
    ): Promise<void> {
      await handleScheduled(event, env);
    },
  };
}

const handler = createHandler();
export default handler;
