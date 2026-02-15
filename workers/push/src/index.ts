/**
 * tminus-push -- Push notification delivery worker.
 *
 * Responsibilities:
 * 1. Queue consumer: process push messages from tminus-push-queue
 * 2. HTTP API: device token registration/deregistration
 * 3. APNs delivery: send notifications via Apple Push Notification service
 * 4. Preference filtering: respect user notification settings + quiet hours
 *
 * Design decisions:
 * - Queue consumer pattern (not HTTP-triggered) for async delivery
 * - APNs JWT is generated per batch (cached 50 min by Apple)
 * - Invalid device tokens (BadDeviceToken, Unregistered) are auto-cleaned from D1
 * - UserGraphDO is consulted for notification preferences (per-user data)
 * - Queue retries handle transient APNs failures (max_retries in wrangler.toml)
 */

import type { PushMessage, NotificationSettings, APNsPayload } from "@tminus/shared";
import {
  buildAPNsPayload,
  shouldDeliverNotification,
  isValidNotificationType,
  defaultNotificationSettings,
} from "@tminus/shared";
import {
  generateAPNsJWT,
  sendToAPNs,
  APNS_UNREGISTERED_REASONS,
} from "./apns";
import type { APNsResult } from "./apns";

// ---------------------------------------------------------------------------
// D1 row types
// ---------------------------------------------------------------------------

interface DeviceTokenRow {
  readonly token_id: string;
  readonly user_id: string;
  readonly device_token: string;
  readonly platform: string;
}

// ---------------------------------------------------------------------------
// Queue consumer: process push messages
// ---------------------------------------------------------------------------

/**
 * Process a batch of push messages from the queue.
 *
 * For each message:
 * 1. Validate the message shape
 * 2. Look up user's notification preferences from UserGraphDO
 * 3. Check if notification should be delivered (type enabled + quiet hours)
 * 4. Look up device tokens from D1
 * 5. Build APNs payload and send to each device
 * 6. Clean up invalid device tokens
 */
async function handleQueueBatch(
  batch: MessageBatch<PushMessage>,
  env: Env,
): Promise<void> {
  // Generate APNs JWT once per batch (valid for ~50 min)
  let apnsJwt: string | null = null;
  try {
    apnsJwt = await generateAPNsJWT(
      env.APNS_KEY_ID,
      env.APNS_TEAM_ID,
      env.APNS_PRIVATE_KEY,
    );
  } catch (err) {
    console.error("Failed to generate APNs JWT:", err);
    // All messages will be retried by the queue
    batch.retryAll();
    return;
  }

  for (const message of batch.messages) {
    try {
      await processMessage(message.body, env, apnsJwt);
      message.ack();
    } catch (err) {
      console.error(
        `Failed to process push message for user ${message.body.user_id}:`,
        err,
      );
      message.retry();
    }
  }
}

/**
 * Process a single push message.
 */
async function processMessage(
  msg: PushMessage,
  env: Env,
  apnsJwt: string,
): Promise<void> {
  // Validate notification type
  if (!isValidNotificationType(msg.notification_type)) {
    console.warn(`Invalid notification type: ${msg.notification_type}`);
    return; // Drop invalid messages (don't retry)
  }

  // Fetch user notification preferences from UserGraphDO
  const settings = await getUserNotificationSettings(msg.user_id, env);

  // Check if notification should be delivered
  if (!shouldDeliverNotification(settings, msg.notification_type, new Date())) {
    console.log(
      `Notification suppressed for user ${msg.user_id}: type=${msg.notification_type}`,
    );
    return;
  }

  // Look up device tokens from D1
  const { results: tokens } = await env.DB
    .prepare(
      "SELECT token_id, user_id, device_token, platform FROM device_tokens WHERE user_id = ?1",
    )
    .bind(msg.user_id)
    .all<DeviceTokenRow>();

  if (tokens.length === 0) {
    console.log(`No device tokens for user ${msg.user_id}`);
    return;
  }

  // Build APNs payload
  const apnsPayload = buildAPNsPayload(msg);

  // Send to each iOS device token
  const iosTokens = tokens.filter((t) => t.platform === "ios");
  const results: APNsResult[] = [];

  for (const token of iosTokens) {
    const result = await sendToAPNs(
      token.device_token,
      apnsPayload,
      apnsJwt,
      env.APNS_TOPIC,
      env.ENVIRONMENT,
    );
    results.push(result);

    // Auto-clean invalid tokens
    if (!result.success && result.reason && APNS_UNREGISTERED_REASONS.has(result.reason)) {
      console.log(
        `Removing invalid device token ${token.token_id}: ${result.reason}`,
      );
      await env.DB
        .prepare("DELETE FROM device_tokens WHERE token_id = ?1")
        .bind(token.token_id)
        .run();
    }
  }

  const successCount = results.filter((r) => r.success).length;
  console.log(
    `Push delivered: user=${msg.user_id} type=${msg.notification_type} success=${successCount}/${results.length}`,
  );
}

/**
 * Fetches notification settings from UserGraphDO.
 * Falls back to defaults if the DO is unavailable or has no settings.
 */
async function getUserNotificationSettings(
  userId: string,
  env: Env,
): Promise<NotificationSettings> {
  try {
    const doId = env.USER_GRAPH.idFromName(userId);
    const stub = env.USER_GRAPH.get(doId);

    const response = await stub.fetch(
      new Request("https://user-graph.internal/getNotificationSettings", {
        method: "GET",
      }),
    );

    if (!response.ok) {
      return defaultNotificationSettings();
    }

    const data = (await response.json()) as NotificationSettings;
    return data;
  } catch {
    // DO unavailable -- fail open with defaults (all enabled, no quiet hours)
    return defaultNotificationSettings();
  }
}

// ---------------------------------------------------------------------------
// HTTP handler: device token management
// ---------------------------------------------------------------------------

/**
 * Handle HTTP requests for device token registration.
 *
 * POST /v1/device-tokens  -- Register a device token
 *   Body: { user_id, device_token, platform }
 *
 * DELETE /v1/device-tokens -- Deregister a device token
 *   Body: { user_id, device_token }
 *
 * GET /health -- Health check
 */
async function handleFetch(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return new Response("OK", { status: 200 });
  }

  if (url.pathname === "/v1/device-tokens") {
    if (request.method === "POST") {
      return handleRegisterToken(request, env);
    }
    if (request.method === "DELETE") {
      return handleDeregisterToken(request, env);
    }
    return new Response("Method Not Allowed", { status: 405 });
  }

  return new Response("Not Found", { status: 404 });
}

/**
 * Register a device token in D1.
 * Upserts: if the (user_id, device_token) pair already exists,
 * updates the updated_at timestamp.
 */
async function handleRegisterToken(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: { user_id?: string; device_token?: string; platform?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
  }

  if (!body.user_id || !body.device_token || !body.platform) {
    return jsonResponse(
      { ok: false, error: "Missing required fields: user_id, device_token, platform" },
      400,
    );
  }

  if (!["ios", "android", "web"].includes(body.platform)) {
    return jsonResponse(
      { ok: false, error: "Invalid platform. Must be ios, android, or web" },
      400,
    );
  }

  // Generate a deterministic token_id from user_id + device_token
  const tokenId = `dtk_${await hashTokenId(body.user_id, body.device_token)}`;

  try {
    await env.DB
      .prepare(
        `INSERT INTO device_tokens (token_id, user_id, device_token, platform)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(user_id, device_token) DO UPDATE SET
           platform = excluded.platform,
           updated_at = datetime('now')`,
      )
      .bind(tokenId, body.user_id, body.device_token, body.platform)
      .run();

    return jsonResponse({ ok: true, data: { token_id: tokenId } }, 201);
  } catch (err) {
    console.error("Failed to register device token:", err);
    return jsonResponse({ ok: false, error: "Failed to register device token" }, 500);
  }
}

/**
 * Deregister a device token from D1.
 */
async function handleDeregisterToken(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: { user_id?: string; device_token?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
  }

  if (!body.user_id || !body.device_token) {
    return jsonResponse(
      { ok: false, error: "Missing required fields: user_id, device_token" },
      400,
    );
  }

  try {
    const result = await env.DB
      .prepare(
        "DELETE FROM device_tokens WHERE user_id = ?1 AND device_token = ?2",
      )
      .bind(body.user_id, body.device_token)
      .run();

    const deleted = result.meta?.changes ?? 0;
    return jsonResponse({ ok: true, data: { deleted } }, 200);
  } catch (err) {
    console.error("Failed to deregister device token:", err);
    return jsonResponse({ ok: false, error: "Failed to deregister device token" }, 500);
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Hash user_id + device_token to create a deterministic token_id.
 * Uses SHA-256 truncated to 16 hex chars for compactness.
 */
async function hashTokenId(userId: string, deviceToken: string): Promise<string> {
  const data = new TextEncoder().encode(`${userId}:${deviceToken}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 16);
}

// ---------------------------------------------------------------------------
// Factory + default export
// ---------------------------------------------------------------------------

/**
 * Creates the worker handler. Factory pattern for testability.
 */
export function createHandler() {
  return {
    async fetch(
      request: Request,
      env: Env,
      _ctx: ExecutionContext,
    ): Promise<Response> {
      return handleFetch(request, env);
    },

    async queue(
      batch: MessageBatch<PushMessage>,
      env: Env,
      _ctx: ExecutionContext,
    ): Promise<void> {
      await handleQueueBatch(batch, env);
    },
  };
}

const handler = createHandler();
export default handler;

// Export for testing
export { handleFetch, handleQueueBatch, processMessage, getUserNotificationSettings, hashTokenId };
