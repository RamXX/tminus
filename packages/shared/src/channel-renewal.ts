/**
 * @tminus/shared -- Shared webhook channel renewal logic.
 *
 * Extracted from duplicated implementations in:
 * - workers/cron/src/index.ts (reRegisterChannel)
 * - workers/api/src/routes/handlers/internal.ts (renewChannelForAccount)
 *
 * Both workers implement the same 5-step Google Calendar channel renewal flow.
 * This module provides a single implementation both can call, preventing
 * divergence as the protocol evolves (e.g., new steps, refined error handling).
 *
 * See: TM-1s05 (tech debt: duplicated channel renewal logic)
 */

import { GoogleCalendarClient } from "./google-api";
import { generateId } from "./id";
import type { WatchResponse } from "./google-api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal interface for the AccountDO stub. Both workers provide this
 * through Cloudflare's DurableObjectStub.fetch(), but the shared function
 * only needs the fetch method. This avoids coupling to the full CF types.
 */
export interface AccountDOStub {
  fetch(input: Request): Promise<Response>;
}

/**
 * Minimal interface for D1 statement execution. Matches the subset of
 * D1Database used by the renewal flow. This avoids coupling to the full
 * Cloudflare D1Database type which is only available in worker environments.
 */
export interface ChannelRenewalDB {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
    };
  };
}

/**
 * Parameters for the shared channel renewal function.
 * Callers (cron worker, API worker) construct this from their
 * respective Env bindings and request context.
 */
export interface RenewWebhookChannelParams {
  /** The account ID to renew the channel for. */
  accountId: string;
  /** The old channel ID to stop (best-effort). Null if no previous channel. */
  oldChannelId: string | null;
  /** The old resource ID needed to stop the old channel. Null if unknown. */
  oldResourceId: string | null;
  /** The AccountDO stub (provides getAccessToken and storeWatchChannel). */
  accountDOStub: AccountDOStub;
  /** D1 database for updating the accounts table. */
  db: ChannelRenewalDB;
  /** The webhook URL for Google Calendar push notifications. */
  webhookUrl: string;
}

/**
 * Result of a successful channel renewal.
 * Contains all new channel details needed by callers.
 */
export interface ChannelRenewalResult {
  account_id: string;
  channel_id: string;
  resource_id: string;
  expiry: string;
  previous_channel_id: string | null;
}

// ---------------------------------------------------------------------------
// Core renewal function
// ---------------------------------------------------------------------------

/**
 * Re-register a Google Calendar watch channel for an account.
 *
 * Steps:
 * 1. Get access token from AccountDO
 * 2. Stop the old channel with Google (best-effort, may already be dead)
 * 3. Register a new channel with Google via Calendar API
 * 4. Store new channel in AccountDO via storeWatchChannel
 * 5. Update D1 with new channel_id, channel_token, channel_expiry_ts
 *
 * Throws on failure with a descriptive error message. Callers are
 * responsible for catch/log behavior appropriate to their context
 * (cron: log and continue; API: return 500).
 */
export async function renewWebhookChannel(
  params: RenewWebhookChannelParams,
): Promise<ChannelRenewalResult> {
  const {
    accountId,
    oldChannelId,
    oldResourceId,
    accountDOStub,
    db,
    webhookUrl,
  } = params;

  // Step 1: Get access token from AccountDO
  const tokenResponse = await accountDOStub.fetch(
    new Request("https://account-do.internal/getAccessToken", {
      method: "POST",
    }),
  );

  if (!tokenResponse.ok) {
    throw new Error(
      `Failed to get access token for account ${accountId}: ${tokenResponse.status}`,
    );
  }

  const { access_token } = (await tokenResponse.json()) as {
    access_token: string;
  };
  const client = new GoogleCalendarClient(access_token);

  // Step 2: Stop old channel (best-effort, may already be dead/expired)
  if (oldChannelId && oldResourceId) {
    try {
      await client.stopChannel(oldChannelId, oldResourceId);
    } catch {
      // Expected if channel already expired or was deleted.
      // Google returns 404 for dead channels -- that's fine.
    }
  }

  // Step 3: Register new channel with Google
  const newChannelId = generateId("calendar");
  const newToken = generateId("calendar");

  const watchResponse: WatchResponse = await client.watchEvents(
    "primary",
    webhookUrl,
    newChannelId,
    newToken,
  );

  // Step 4: Store new channel in AccountDO
  const storeResponse = await accountDOStub.fetch(
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
    throw new Error(
      `Failed to store new channel in AccountDO for account ${accountId}: ${storeResponse.status}`,
    );
  }

  // Step 5: Update D1 with new channel info
  const expiryTs = new Date(
    parseInt(watchResponse.expiration, 10),
  ).toISOString();

  await db
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

  return {
    account_id: accountId,
    channel_id: watchResponse.channelId,
    resource_id: watchResponse.resourceId,
    expiry: expiryTs,
    previous_channel_id: oldChannelId,
  };
}
