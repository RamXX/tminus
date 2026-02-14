/**
 * tminus-webhook -- Google Calendar push notification receiver.
 *
 * Receives POST /webhook/google from Google Calendar push notifications,
 * validates the channel_token against D1, and enqueues SYNC_INCREMENTAL
 * messages to sync-queue for actual sync processing.
 *
 * Key invariant: ALWAYS return 200 to Google. Non-200 responses trigger
 * exponential backoff and eventual channel expiry.
 */

import type { SyncIncrementalMessage, AccountId } from "@tminus/shared";

// ---------------------------------------------------------------------------
// Google webhook header names
// ---------------------------------------------------------------------------

const HEADER_CHANNEL_ID = "X-Goog-Channel-ID";
const HEADER_RESOURCE_ID = "X-Goog-Resource-ID";
const HEADER_RESOURCE_STATE = "X-Goog-Resource-State";
const HEADER_CHANNEL_TOKEN = "X-Goog-Channel-Token";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle a Google push notification webhook.
 *
 * Always returns 200 to Google regardless of outcome. Failures are logged
 * but never surfaced as HTTP errors (Google would back off).
 */
async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const channelId = request.headers.get(HEADER_CHANNEL_ID);
  const resourceId = request.headers.get(HEADER_RESOURCE_ID);
  const resourceState = request.headers.get(HEADER_RESOURCE_STATE);
  const channelToken = request.headers.get(HEADER_CHANNEL_TOKEN);

  // Missing headers -- log and return 200 (don't anger Google)
  if (!channelId || !resourceId || !resourceState || !channelToken) {
    console.warn("Webhook received with missing Google headers", {
      hasChannelId: !!channelId,
      hasResourceId: !!resourceId,
      hasResourceState: !!resourceState,
      hasChannelToken: !!channelToken,
    });
    return new Response("OK", { status: 200 });
  }

  // 'sync' is Google's initial ping when the watch channel is created.
  // Acknowledge it without enqueueing any work.
  if (resourceState === "sync") {
    console.log("Webhook sync ping received", { channelId });
    return new Response("OK", { status: 200 });
  }

  // Look up the account by channel_token. This simultaneously verifies
  // authenticity (the token is a secret shared at watch creation time)
  // and identifies which account to sync.
  let accountRow: { account_id: string } | null = null;
  try {
    accountRow = await env.DB
      .prepare("SELECT account_id FROM accounts WHERE channel_token = ?1")
      .bind(channelToken)
      .first<{ account_id: string }>();
  } catch (err) {
    console.error("D1 query failed during webhook processing", err);
    return new Response("OK", { status: 200 });
  }

  if (!accountRow) {
    console.warn("Webhook received for unknown channel_token", {
      channelId,
      resourceState,
    });
    return new Response("OK", { status: 200 });
  }

  // Enqueue SYNC_INCREMENTAL for the sync-consumer to process
  const msg: SyncIncrementalMessage = {
    type: "SYNC_INCREMENTAL",
    account_id: accountRow.account_id as AccountId,
    channel_id: channelId,
    resource_id: resourceId,
    ping_ts: new Date().toISOString(),
  };

  try {
    await env.SYNC_QUEUE.send(msg);
    console.log("Enqueued SYNC_INCREMENTAL", {
      accountId: accountRow.account_id,
      channelId,
      resourceState,
    });
  } catch (err) {
    // Queue send failed -- log but still return 200 to Google.
    // The daily reconciliation will catch any missed updates.
    console.error("Failed to enqueue SYNC_INCREMENTAL", err);
  }

  return new Response("OK", { status: 200 });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Creates the worker handler. Factory pattern allows tests to inject
 * dependencies if needed in the future.
 */
export function createHandler() {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      const { pathname } = url;
      const method = request.method;

      // POST /webhook/google -- main webhook endpoint
      if (method === "POST" && pathname === "/webhook/google") {
        return handleWebhook(request, env);
      }

      // GET /health -- health check
      if (method === "GET" && pathname === "/health") {
        return new Response("OK", { status: 200 });
      }

      // Everything else -- 404
      return new Response("Not Found", { status: 404 });
    },
  };
}

// ---------------------------------------------------------------------------
// Default export for Cloudflare Workers runtime
// ---------------------------------------------------------------------------

const handler = createHandler();
export default handler;
