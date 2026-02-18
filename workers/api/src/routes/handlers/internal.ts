/**
 * Route handler: Internal/admin endpoints.
 *
 * These endpoints are NOT part of the public /v1/ API. They use a shared
 * secret (ADMIN_KEY) for authentication instead of JWT/API key auth.
 *
 * Endpoints:
 * - POST /internal/accounts/:id/renew-channel
 *   Force-renew a Google Calendar webhook channel for an account.
 *   Replicates the same logic as handleChannelRenewal in the cron worker.
 */

import { renewWebhookChannel } from "@tminus/shared";
import type { ChannelRenewalResult } from "@tminus/shared";
import {
  matchRoute,
  jsonResponse,
  successEnvelope,
  errorEnvelope,
  ErrorCode,
} from "../shared";

// ---------------------------------------------------------------------------
// Admin auth helper
// ---------------------------------------------------------------------------

/**
 * Validate the admin key from the X-Admin-Key header.
 * Returns true if the key matches the configured ADMIN_KEY secret.
 */
function validateAdminKey(request: Request, env: Env): boolean {
  const adminKey = env.ADMIN_KEY;
  if (!adminKey) return false;

  const providedKey = request.headers.get("X-Admin-Key");
  if (!providedKey) return false;

  // Constant-time comparison is ideal but not critical for admin keys
  // (not user-facing, low volume). Using simple equality for clarity.
  return providedKey === adminKey;
}

// ---------------------------------------------------------------------------
// Channel renewal logic (delegates to @tminus/shared)
// ---------------------------------------------------------------------------

// Re-export ChannelRenewalResult type for consumers of this module
export type { ChannelRenewalResult } from "@tminus/shared";

/**
 * Re-register a Google Calendar watch channel for an account.
 *
 * Delegates to the shared renewWebhookChannel() function from @tminus/shared
 * (TM-1s05: extracted to eliminate duplication with the cron worker).
 *
 * This wrapper handles API-specific concerns:
 * - Validating WEBHOOK_URL is configured (cron always has it)
 * - Constructing the AccountDO stub from Env bindings
 *
 * Throws on failure with a descriptive error message.
 */
export async function renewChannelForAccount(
  env: Env,
  accountId: string,
  oldChannelId: string | null,
  oldResourceId: string | null,
): Promise<ChannelRenewalResult> {
  const webhookUrl = env.WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("WEBHOOK_URL not configured");
  }

  const doId = env.ACCOUNT.idFromName(accountId);
  const stub = env.ACCOUNT.get(doId);

  return renewWebhookChannel({
    accountId,
    oldChannelId,
    oldResourceId,
    accountDOStub: stub,
    db: env.DB,
    webhookUrl,
  });
}

// ---------------------------------------------------------------------------
// POST /internal/accounts/:id/renew-channel
// ---------------------------------------------------------------------------

/**
 * Force-renew a Google Calendar webhook channel for an account.
 *
 * Auth: X-Admin-Key header must match env.ADMIN_KEY.
 * Returns: new channel details (channel_id, resource_id, expiry) on success.
 * Errors:
 * - 401: Missing/invalid admin key
 * - 404: Account not found
 * - 400: Account is not a Google account or has no webhook support
 * - 500: Channel renewal failed (token refresh, Google API error, etc.)
 */
async function handleRenewChannel(
  _request: Request,
  env: Env,
  accountId: string,
): Promise<Response> {
  // Look up the account in D1
  const row = await env.DB.prepare(
    `SELECT account_id, provider, status, channel_id, resource_id
     FROM accounts WHERE account_id = ?1`,
  )
    .bind(accountId)
    .first<{
      account_id: string;
      provider: string;
      status: string;
      channel_id: string | null;
      resource_id: string | null;
    }>();

  if (!row) {
    return jsonResponse(
      errorEnvelope("Account not found", "NOT_FOUND"),
      ErrorCode.NOT_FOUND,
    );
  }

  // Only Google accounts have webhook channels
  if (row.provider !== "google") {
    return jsonResponse(
      errorEnvelope(
        `Account ${accountId} is a ${row.provider} account, not Google. Webhook channels are Google-specific.`,
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Account must be active
  if (row.status !== "active") {
    return jsonResponse(
      errorEnvelope(
        `Account ${accountId} has status '${row.status}'. Only active accounts can renew channels.`,
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Perform the renewal
  try {
    const result = await renewChannelForAccount(
      env,
      accountId,
      row.channel_id,
      row.resource_id,
    );

    return jsonResponse(successEnvelope(result), 200);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Channel renewal failed";
    console.error(`Channel renewal failed for account ${accountId}:`, err);
    return jsonResponse(
      errorEnvelope(message, "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ---------------------------------------------------------------------------
// Internal route dispatcher
// ---------------------------------------------------------------------------

/**
 * Route internal/admin requests.
 *
 * Returns a Response if the request matches an internal route, or null
 * to delegate to the next handler.
 *
 * All internal routes require X-Admin-Key authentication.
 */
export async function routeInternalRequest(
  request: Request,
  method: string,
  pathname: string,
  env: Env,
): Promise<Response | null> {
  // Only match /internal/* paths
  if (!pathname.startsWith("/internal/")) return null;

  // All internal routes require admin key auth
  if (!validateAdminKey(request, env)) {
    return jsonResponse(
      errorEnvelope("Missing or invalid admin key", "AUTH_REQUIRED"),
      ErrorCode.AUTH_REQUIRED,
    );
  }

  // POST /internal/accounts/:id/renew-channel
  const renewMatch = matchRoute(
    pathname,
    "/internal/accounts/:id/renew-channel",
  );
  if (renewMatch && method === "POST") {
    return handleRenewChannel(request, env, renewMatch.params[0]);
  }

  return jsonResponse(
    errorEnvelope("Not Found", "NOT_FOUND"),
    ErrorCode.NOT_FOUND,
  );
}
