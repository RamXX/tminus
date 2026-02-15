/**
 * tminus-cron -- Scheduled maintenance worker.
 *
 * Four cron responsibilities:
 * 1. Google channel renewal (every 6h): renew Google watch channels expiring within 24h
 * 2. Microsoft subscription renewal (every 6h): renew MS subscriptions at 75% lifetime
 * 3. Token health check (every 12h): verify account tokens, mark errors
 * 4. Drift reconciliation (daily 03:00 UTC): enqueue RECONCILE_ACCOUNT messages
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
  CRON_CHANNEL_RENEWAL,
  CRON_TOKEN_HEALTH,
  CRON_RECONCILIATION,
  CRON_DELETION_CHECK,
  CRON_HOLD_EXPIRY,
  CHANNEL_RENEWAL_THRESHOLD_MS,
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
  readonly channel_expiry_ts: string;
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
 * Query D1 for accounts with channels expiring within CHANNEL_RENEWAL_THRESHOLD_MS
 * and call AccountDO.renewChannel() for each.
 *
 * Only processes active accounts with non-null channel_id and channel_expiry_ts.
 */
async function handleChannelRenewal(env: Env): Promise<void> {
  const thresholdTs = new Date(
    Date.now() + CHANNEL_RENEWAL_THRESHOLD_MS,
  ).toISOString();

  const { results } = await env.DB
    .prepare(
      `SELECT account_id, channel_id, channel_expiry_ts
       FROM accounts
       WHERE status = ?1
         AND channel_id IS NOT NULL
         AND channel_expiry_ts IS NOT NULL
         AND channel_expiry_ts <= ?2`,
    )
    .bind("active", thresholdTs)
    .all<ExpiringChannelRow>();

  console.log(`Channel renewal: found ${results.length} expiring channels`);

  for (const row of results) {
    try {
      const doId = env.ACCOUNT.idFromName(row.account_id);
      const stub = env.ACCOUNT.get(doId);

      const response = await stub.fetch(
        new Request("https://account-do.internal/renewChannel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channelId: row.channel_id }),
        }),
      );

      if (!response.ok) {
        console.error(
          `Channel renewal failed for account ${row.account_id}: ${response.status}`,
        );
      } else {
        console.log(`Channel renewed for account ${row.account_id}`);
      }
    } catch (err) {
      console.error(
        `Channel renewal error for account ${row.account_id}:`,
        err,
      );
    }
  }
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
 * This implements AC-5: "Expired holds cleaned up by cron".
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
        } catch (err) {
          console.error(
            `Failed to expire hold ${hold.hold_id}:`,
            err,
          );
        }
      }
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
