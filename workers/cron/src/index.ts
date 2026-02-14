/**
 * tminus-cron -- Scheduled maintenance worker.
 *
 * Three cron responsibilities:
 * 1. Channel renewal (every 6h): renew Google watch channels expiring within 24h
 * 2. Token health check (every 12h): verify account tokens, mark errors
 * 3. Drift reconciliation (daily 03:00 UTC): enqueue RECONCILE_ACCOUNT messages
 *
 * Design decisions:
 * - Each responsibility is a separate function for testability
 * - Errors in one account do not block processing of others (log + continue)
 * - AccountDO communication via HTTP fetch on DO stubs (standard CF pattern)
 * - D1 queries only touch active accounts (except channel renewal which also checks expiry)
 * - Per ADR-6: Daily reconciliation, not weekly
 */

import type { ReconcileAccountMessage, AccountId } from "@tminus/shared";

// ---------------------------------------------------------------------------
// Cron schedule constants (must match wrangler.toml [triggers].crons)
// ---------------------------------------------------------------------------

/** Channel renewal: every 6 hours. */
export const CRON_CHANNEL_RENEWAL = "0 */6 * * *";

/** Token health check: every 12 hours. */
export const CRON_TOKEN_HEALTH = "0 */12 * * *";

/** Drift reconciliation: daily at 03:00 UTC. */
export const CRON_RECONCILIATION = "0 3 * * *";

// ---------------------------------------------------------------------------
// Channel renewal threshold
// ---------------------------------------------------------------------------

/** Renew channels that expire within this window (24 hours). */
export const CHANNEL_RENEWAL_THRESHOLD_MS = 24 * 60 * 60 * 1000;

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

// ---------------------------------------------------------------------------
// Channel Renewal (every 6h)
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
// Scheduled handler dispatch
// ---------------------------------------------------------------------------

// Dispatch to the appropriate handler based on the cron schedule.
// Each cron string from wrangler.toml maps to exactly one handler.
async function handleScheduled(
  event: ScheduledEvent,
  env: Env,
): Promise<void> {
  const { cron } = event;

  switch (cron) {
    case CRON_CHANNEL_RENEWAL:
      await handleChannelRenewal(env);
      break;

    case CRON_TOKEN_HEALTH:
      await handleTokenHealth(env);
      break;

    case CRON_RECONCILIATION:
      await handleReconciliation(env);
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
