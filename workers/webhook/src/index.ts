/**
 * tminus-webhook -- Provider-agnostic push notification receiver.
 *
 * Routes webhook requests to provider-specific handlers based on URL path:
 * - POST /webhook/google  -> Google Calendar push notification handler
 * - POST /webhook/microsoft -> Microsoft Graph change notification handler
 *
 * Google handler: Receives POST /webhook/google from Google Calendar push
 * notifications, validates the channel_token against D1, and enqueues
 * SYNC_INCREMENTAL messages to sync-queue for actual sync processing.
 *
 * Microsoft handler: Handles two Microsoft Graph flows:
 * a. Subscription validation handshake: ?validationToken=<token> -> return token as plain text
 * b. Change notifications: validate clientState, enqueue SYNC_INCREMENTAL per notification
 *
 * Key invariant: ALWAYS return 200 to Google. Non-200 responses trigger
 * exponential backoff and eventual channel expiry.
 * Microsoft expects 202 Accepted for successful notification processing.
 */

import type { SyncIncrementalMessage, AccountId } from "@tminus/shared";
import { buildHealthResponse } from "@tminus/shared";

// ---------------------------------------------------------------------------
// Google webhook header names
// ---------------------------------------------------------------------------

const HEADER_CHANNEL_ID = "X-Goog-Channel-ID";
const HEADER_RESOURCE_ID = "X-Goog-Resource-ID";
const HEADER_RESOURCE_STATE = "X-Goog-Resource-State";
const HEADER_CHANNEL_TOKEN = "X-Goog-Channel-Token";

// ---------------------------------------------------------------------------
// Microsoft notification types
// ---------------------------------------------------------------------------

/**
 * A single Microsoft Graph change notification.
 * Part of the notification POST body's "value" array.
 */
interface MicrosoftChangeNotification {
  readonly subscriptionId: string;
  readonly changeType: string;
  readonly clientState?: string;
  readonly resource: string;
  readonly resourceData?: {
    readonly "@odata.type"?: string;
    readonly id?: string;
  };
}

/**
 * The top-level Microsoft Graph notification payload.
 * Contains an array of change notifications.
 */
interface MicrosoftNotificationPayload {
  readonly value: MicrosoftChangeNotification[];
}

// ---------------------------------------------------------------------------
// Google Handler
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
// Microsoft webhook handler
// ---------------------------------------------------------------------------

/**
 * Handle a Microsoft Graph change notification.
 *
 * Two flows:
 * 1. Validation handshake: Microsoft POSTs with ?validationToken=<token>.
 *    Must respond with the token as plain text, 200 OK, within 10 seconds.
 * 2. Change notifications: POST with JSON body containing notifications.
 *    Validate clientState, look up subscriptionId -> account_id in D1,
 *    enqueue SYNC_INCREMENTAL for each valid notification.
 *    Return 202 Accepted.
 */
async function handleMicrosoftWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);

  // Flow 1: Subscription validation handshake
  const validationToken = url.searchParams.get("validationToken");
  if (validationToken) {
    console.log("Microsoft subscription validation handshake received");
    return new Response(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Flow 2: Change notification processing
  let payload: MicrosoftNotificationPayload;
  try {
    payload = await request.json() as MicrosoftNotificationPayload;
  } catch {
    // Malformed body (not JSON, load balancer probes, etc.)
    console.warn("Microsoft webhook: failed to parse JSON body");
    return new Response("Bad Request", { status: 400 });
  }

  // Validate payload has notifications
  if (!payload.value || !Array.isArray(payload.value) || payload.value.length === 0) {
    console.warn("Microsoft webhook: empty or missing 'value' array");
    return new Response("Accepted", { status: 202 });
  }

  // Process each notification
  for (const notification of payload.value) {
    // First try direct lookup via accounts.channel_id (canonical source).
    // Fallback to ms_subscriptions table for legacy rows.
    let accountRow: { account_id: string; channel_token: string | null } | null = null;
    try {
      accountRow = await env.DB
        .prepare(
          `SELECT account_id, channel_token
           FROM accounts
           WHERE provider = 'microsoft'
             AND status = 'active'
             AND channel_id = ?1`,
        )
        .bind(notification.subscriptionId)
        .first<{ account_id: string; channel_token: string | null }>();

      if (!accountRow) {
        accountRow = await env.DB
          .prepare(
            `SELECT a.account_id, a.channel_token
             FROM ms_subscriptions ms
             JOIN accounts a ON a.account_id = ms.account_id
             WHERE ms.subscription_id = ?1`,
          )
          .bind(notification.subscriptionId)
          .first<{ account_id: string; channel_token: string | null }>();
      }
    } catch (err) {
      console.error("D1 query failed for Microsoft subscription lookup", err);
      continue;
    }

    if (!accountRow) {
      console.warn("Microsoft webhook: unknown subscriptionId", {
        subscriptionId: notification.subscriptionId,
      });
      continue;
    }

    // Validate clientState against per-account channel_token when available.
    // Fallback to env-level secret for older subscriptions.
    const expectedClientState = accountRow.channel_token ?? env.MS_WEBHOOK_CLIENT_STATE;
    if (notification.clientState !== expectedClientState) {
      console.warn("Microsoft webhook: clientState mismatch", {
        subscriptionId: notification.subscriptionId,
        accountId: accountRow.account_id,
      });
      return new Response("Forbidden", { status: 403 });
    }

    // Enqueue SYNC_INCREMENTAL
    const msg: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: accountRow.account_id as AccountId,
      channel_id: notification.subscriptionId,
      resource_id: notification.resource,
      ping_ts: new Date().toISOString(),
    };

    try {
      await env.SYNC_QUEUE.send(msg);
      console.log("Enqueued SYNC_INCREMENTAL for Microsoft notification", {
        accountId: accountRow.account_id,
        subscriptionId: notification.subscriptionId,
        changeType: notification.changeType,
      });
    } catch (err) {
      console.error("Failed to enqueue SYNC_INCREMENTAL for Microsoft notification", err);
    }
  }

  // Microsoft expects 202 Accepted for successful notification processing
  return new Response("Accepted", { status: 202 });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Creates the worker handler. Factory pattern allows tests to inject
 * dependencies if needed in the future.
 *
 * Routes webhook requests by provider path:
 * - POST /webhook/google    -> Google Calendar handler
 * - POST /webhook/microsoft -> Microsoft Graph handler
 */
export function createHandler() {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      const { pathname } = url;
      const method = request.method;

      // POST /webhook/google -- Google Calendar push notifications
      if (method === "POST" && pathname === "/webhook/google") {
        return handleWebhook(request, env);
      }

      // POST /webhook/microsoft -- Microsoft Graph notifications
      if (method === "POST" && pathname === "/webhook/microsoft") {
        return handleMicrosoftWebhook(request, env);
      }

      // GET /health -- health check
      if (method === "GET" && pathname === "/health") {
        const healthBody = buildHealthResponse(
          "tminus-webhook",
          "0.0.1",
          env.ENVIRONMENT ?? "development",
          [
            { name: "DB", type: "d1", available: !!env.DB },
            { name: "SYNC_QUEUE", type: "queue", available: !!env.SYNC_QUEUE },
          ],
        );
        return new Response(JSON.stringify(healthBody), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
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
