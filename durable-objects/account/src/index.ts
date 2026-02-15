/**
 * AccountDO -- per-account Durable Object for token refresh, sync cursor,
 * rate limiting, and watch channel lifecycle.
 *
 * Mandatory per AD-2 because:
 * - Token refresh must be serialized (one refresh at a time per account)
 * - Sync cursors must be serialized (avoid duplicate syncs)
 * - Google API quotas are per-account
 *
 * Security invariants:
 * - BR-8: Refresh tokens NEVER leave AccountDO boundary
 * - BR-4: Access tokens minted JIT by getAccessToken()
 * - NFR-9: AES-256-GCM with per-account DEK, DEK encrypted with master key
 */

import {
  ACCOUNT_DO_MIGRATIONS,
  applyMigrations,
  generateId,
} from "@tminus/shared";
import type { SqlStorageLike, FetchFn, ProviderType } from "@tminus/shared";
export type { FetchFn } from "@tminus/shared";
export type { ProviderType } from "@tminus/shared";
import {
  importMasterKey,
  encryptTokens,
  decryptTokens,
  reEncryptDek,
  extractDekForBackup,
} from "./crypto";
import type { EncryptedEnvelope, TokenPayload, DekBackupEntry } from "./crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Google OAuth2 token refresh endpoint. */
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Google OAuth2 token revocation endpoint. */
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** Microsoft OAuth2 token refresh endpoint (common tenant). */
const MS_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

/** Buffer before expiry to trigger a refresh (5 minutes). */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** The account_id key used in single-row tables. */
const ACCOUNT_ROW_KEY = "self";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChannelInfo {
  readonly channelId: string;
  readonly calendarId: string;
  readonly status: string;
  readonly expiryTs: string;
}

export interface HealthInfo {
  readonly lastSyncTs: string | null;
  readonly lastSuccessTs: string | null;
  readonly fullSyncNeeded: boolean;
}

export interface RevokeResult {
  /** Whether the token was successfully revoked server-side at Google. */
  readonly revoked: boolean;
}

export interface MsSubscriptionInfo {
  readonly subscriptionId: string;
  readonly resource: string;
  readonly clientState: string;
  readonly expiration: string;
}

// ---------------------------------------------------------------------------
// AccountDO class
// ---------------------------------------------------------------------------

/**
 * AccountDO manages a single external calendar account's OAuth tokens,
 * sync cursor, and watch channels.
 *
 * In production, this extends DurableObject and uses ctx.storage.sql.
 * For testing, it can be constructed with a SqlStorageLike adapter and
 * an injected fetch function.
 */
export class AccountDO {
  private readonly sql: SqlStorageLike;
  private readonly masterKeyHex: string;
  private readonly fetchFn: FetchFn;
  private migrated = false;

  /**
   * The provider type for this account.
   * Defaults to 'google'. Stored in the auth table's provider column.
   * Used to route to the correct CalendarProvider, normalizer, and classifier.
   */
  readonly provider: ProviderType;

  /**
   * Construct an AccountDO.
   *
   * @param sql - SqlStorage (real DO) or SqlStorageLike adapter (tests)
   * @param masterKeyHex - Hex-encoded 256-bit master key
   * @param fetchFn - Fetch function for API calls (defaults to globalThis.fetch)
   * @param provider - Calendar provider type (defaults to 'google')
   */
  constructor(
    sql: SqlStorageLike,
    masterKeyHex: string,
    fetchFn?: FetchFn,
    provider?: ProviderType,
  ) {
    this.sql = sql;
    this.masterKeyHex = masterKeyHex;
    this.fetchFn = fetchFn ?? globalThis.fetch.bind(globalThis);
    this.provider = provider ?? "google";
  }

  // -------------------------------------------------------------------------
  // Schema initialization
  // -------------------------------------------------------------------------

  /** Ensure schema is applied. Called lazily before any DB operation. */
  private ensureMigrated(): void {
    if (this.migrated) return;
    applyMigrations(this.sql, ACCOUNT_DO_MIGRATIONS, "account");
    this.migrated = true;
  }

  // -------------------------------------------------------------------------
  // Initialize: store encrypted tokens on first creation
  // -------------------------------------------------------------------------

  /**
   * Initialize this account DO with OAuth tokens and scopes.
   * Encrypts tokens with envelope encryption before storage.
   *
   * Called once during account onboarding.
   */
  async initialize(
    tokens: { access_token: string; refresh_token: string; expiry: string },
    scopes: string,
  ): Promise<void> {
    this.ensureMigrated();

    const masterKey = await importMasterKey(this.masterKeyHex);
    const envelope = await encryptTokens(masterKey, tokens);

    // Store encrypted tokens with provider type
    this.sql.exec(
      `INSERT OR REPLACE INTO auth (account_id, encrypted_tokens, scopes, provider, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      ACCOUNT_ROW_KEY,
      JSON.stringify(envelope),
      scopes,
      this.provider,
    );

    // Initialize sync state
    this.sql.exec(
      `INSERT OR IGNORE INTO sync_state (account_id) VALUES (?)`,
      ACCOUNT_ROW_KEY,
    );
  }

  // -------------------------------------------------------------------------
  // Token management (BR-8: refresh tokens never leave DO boundary)
  // -------------------------------------------------------------------------

  /**
   * Get a fresh access token. Decrypts, checks expiry, refreshes if needed.
   *
   * BR-4: Access tokens minted JIT.
   * BR-8: Only the access_token is returned -- refresh_token stays inside.
   */
  async getAccessToken(): Promise<string> {
    this.ensureMigrated();

    const masterKey = await importMasterKey(this.masterKeyHex);
    const tokens = await this.loadTokens(masterKey);

    // Check if the token is expired or about to expire
    const expiryMs = new Date(tokens.expiry).getTime();
    const now = Date.now();

    if (expiryMs - now > REFRESH_BUFFER_MS) {
      // Token is still valid
      return tokens.access_token;
    }

    // Token expired or expiring soon -- refresh
    const refreshed = await this.refreshAccessToken(
      masterKey,
      tokens.refresh_token,
    );

    return refreshed.access_token;
  }

  /**
   * Revoke all tokens and clear auth data.
   *
   * 1. Decrypts stored tokens to retrieve the refresh token
   * 2. Calls Google's OAuth revoke endpoint to invalidate the token server-side
   * 3. Deletes the local auth row REGARDLESS of whether the API call succeeded
   *
   * Returns { revoked: true } if Google accepted the revocation,
   * { revoked: false } if the API call failed or no tokens were stored.
   * Local auth data is always deleted either way.
   */
  async revokeTokens(): Promise<RevokeResult> {
    this.ensureMigrated();

    // Try to load tokens for server-side revocation
    let revoked = false;
    const rows = this.sql
      .exec<{ encrypted_tokens: string }>(
        "SELECT encrypted_tokens FROM auth WHERE account_id = ?",
        ACCOUNT_ROW_KEY,
      )
      .toArray();

    if (rows.length > 0) {
      if (this.provider === "google") {
        // Google has a standard token revocation endpoint
        try {
          const masterKey = await importMasterKey(this.masterKeyHex);
          const envelope: EncryptedEnvelope = JSON.parse(
            rows[0].encrypted_tokens,
          );
          const tokens = await decryptTokens(masterKey, envelope);

          const response = await this.fetchFn(GOOGLE_REVOKE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              token: tokens.refresh_token,
            }).toString(),
          });

          revoked = response.ok;
        } catch {
          // Token may already be revoked, expired, or network may be down.
          // Proceed with local deletion regardless.
          revoked = false;
        }
      } else {
        // Microsoft (and future providers) don't have a standard token
        // revocation endpoint accessible via simple HTTP. We just delete
        // the tokens locally. Mark as "revoked" since local cleanup succeeded.
        revoked = true;
      }
    }

    // Always delete local auth row, even if remote revocation failed
    this.sql.exec(
      `DELETE FROM auth WHERE account_id = ?`,
      ACCOUNT_ROW_KEY,
    );

    return { revoked };
  }

  // -------------------------------------------------------------------------
  // Key rotation (AC 1, 2, 8)
  // -------------------------------------------------------------------------

  /**
   * Rotate the master key: decrypt DEK with old key, re-encrypt with new key.
   *
   * This is atomic within the DO (single SQLite write). The token ciphertext
   * remains unchanged because tokens are encrypted with the DEK, not the
   * master key. Only the DEK's encryption wrapper changes.
   *
   * @param oldMasterKeyHex - Current master key (hex-encoded)
   * @param newMasterKeyHex - New master key (hex-encoded)
   */
  async rotateKey(
    oldMasterKeyHex: string,
    newMasterKeyHex: string,
  ): Promise<void> {
    this.ensureMigrated();

    const rows = this.sql
      .exec<{ encrypted_tokens: string }>(
        "SELECT encrypted_tokens FROM auth WHERE account_id = ?",
        ACCOUNT_ROW_KEY,
      )
      .toArray();

    if (rows.length === 0) {
      throw new Error("AccountDO.rotateKey: no tokens stored. Nothing to rotate.");
    }

    const oldMasterKey = await importMasterKey(oldMasterKeyHex);
    const newMasterKey = await importMasterKey(newMasterKeyHex);

    const envelope: EncryptedEnvelope = JSON.parse(rows[0].encrypted_tokens);

    // Re-encrypt DEK atomically: decrypt with old, encrypt with new
    const rotatedEnvelope = await reEncryptDek(
      oldMasterKey,
      newMasterKey,
      envelope,
    );

    // Atomic update in DO SQLite
    this.sql.exec(
      `UPDATE auth SET encrypted_tokens = ?, updated_at = datetime('now')
       WHERE account_id = ?`,
      JSON.stringify(rotatedEnvelope),
      ACCOUNT_ROW_KEY,
    );
  }

  // -------------------------------------------------------------------------
  // DEK backup/restore (AC 4, 5)
  // -------------------------------------------------------------------------

  /**
   * Export the encrypted DEK material for backup.
   *
   * Returns the encrypted DEK and its IV (still encrypted with master key).
   * The token ciphertext is NOT included in the backup -- only the DEK wrapper.
   *
   * @param accountId - External account identifier for the backup record
   */
  async getEncryptedDekForBackup(accountId: string): Promise<DekBackupEntry> {
    this.ensureMigrated();

    const rows = this.sql
      .exec<{ encrypted_tokens: string }>(
        "SELECT encrypted_tokens FROM auth WHERE account_id = ?",
        ACCOUNT_ROW_KEY,
      )
      .toArray();

    if (rows.length === 0) {
      throw new Error("AccountDO: no tokens stored. Nothing to backup.");
    }

    const envelope: EncryptedEnvelope = JSON.parse(rows[0].encrypted_tokens);
    return extractDekForBackup(accountId, envelope);
  }

  /**
   * Restore the encrypted DEK from a backup entry.
   *
   * Replaces the current encryptedDek and dekIv with values from the backup.
   * The token ciphertext (iv + ciphertext) is preserved from the existing envelope.
   *
   * WARNING: This should only be used for disaster recovery. The backup's
   * master key must match the current MASTER_KEY for decryption to work.
   */
  async restoreDekFromBackup(backup: DekBackupEntry): Promise<void> {
    this.ensureMigrated();

    const rows = this.sql
      .exec<{ encrypted_tokens: string }>(
        "SELECT encrypted_tokens FROM auth WHERE account_id = ?",
        ACCOUNT_ROW_KEY,
      )
      .toArray();

    if (rows.length === 0) {
      throw new Error("AccountDO: no tokens stored. Cannot restore DEK without existing token ciphertext.");
    }

    const existingEnvelope: EncryptedEnvelope = JSON.parse(rows[0].encrypted_tokens);

    // Replace only the DEK encryption, keep token ciphertext
    const restoredEnvelope: EncryptedEnvelope = {
      iv: existingEnvelope.iv,
      ciphertext: existingEnvelope.ciphertext,
      encryptedDek: backup.encryptedDek,
      dekIv: backup.dekIv,
    };

    this.sql.exec(
      `UPDATE auth SET encrypted_tokens = ?, updated_at = datetime('now')
       WHERE account_id = ?`,
      JSON.stringify(restoredEnvelope),
      ACCOUNT_ROW_KEY,
    );
  }

  // -------------------------------------------------------------------------
  // Encryption failure monitoring (AC 6, 7)
  // -------------------------------------------------------------------------

  /**
   * Record an encryption failure in the monitoring table.
   * Called internally when DEK decryption fails.
   */
  private recordEncryptionFailure(error: string): void {
    this.sql.exec(
      `INSERT INTO encryption_monitor (account_id, failure_count, last_failure_ts, last_failure_error)
       VALUES (?, 1, datetime('now'), ?)
       ON CONFLICT(account_id) DO UPDATE SET
         failure_count = failure_count + 1,
         last_failure_ts = datetime('now'),
         last_failure_error = ?`,
      ACCOUNT_ROW_KEY,
      error,
      error,
    );
  }

  /**
   * Record a successful encryption operation in the monitoring table.
   */
  private recordEncryptionSuccess(): void {
    this.sql.exec(
      `INSERT INTO encryption_monitor (account_id, failure_count, last_success_ts)
       VALUES (?, 0, datetime('now'))
       ON CONFLICT(account_id) DO UPDATE SET
         last_success_ts = datetime('now')`,
      ACCOUNT_ROW_KEY,
    );
  }

  /**
   * Get encryption failure monitoring info.
   *
   * Returns the current failure count and last failure details.
   * A failure_count > 0 is critical and should trigger alerts.
   */
  async getEncryptionHealth(): Promise<{
    failureCount: number;
    lastFailureTs: string | null;
    lastFailureError: string | null;
    lastSuccessTs: string | null;
  }> {
    this.ensureMigrated();

    const rows = this.sql
      .exec<{
        failure_count: number;
        last_failure_ts: string | null;
        last_failure_error: string | null;
        last_success_ts: string | null;
      }>(
        "SELECT failure_count, last_failure_ts, last_failure_error, last_success_ts FROM encryption_monitor WHERE account_id = ?",
        ACCOUNT_ROW_KEY,
      )
      .toArray();

    if (rows.length === 0) {
      return {
        failureCount: 0,
        lastFailureTs: null,
        lastFailureError: null,
        lastSuccessTs: null,
      };
    }

    return {
      failureCount: rows[0].failure_count,
      lastFailureTs: rows[0].last_failure_ts,
      lastFailureError: rows[0].last_failure_error,
      lastSuccessTs: rows[0].last_success_ts,
    };
  }

  // -------------------------------------------------------------------------
  // Token internal helpers
  // -------------------------------------------------------------------------

  /** Load and decrypt tokens from storage, with encryption monitoring. */
  private async loadTokens(masterKey: CryptoKey): Promise<TokenPayload> {
    const rows = this.sql
      .exec<{ encrypted_tokens: string }>(
        "SELECT encrypted_tokens FROM auth WHERE account_id = ?",
        ACCOUNT_ROW_KEY,
      )
      .toArray();

    if (rows.length === 0) {
      throw new Error("AccountDO: no tokens stored. Call initialize() first.");
    }

    const envelope: EncryptedEnvelope = JSON.parse(rows[0].encrypted_tokens);

    try {
      const tokens = await decryptTokens(masterKey, envelope);
      this.recordEncryptionSuccess();
      return tokens;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.recordEncryptionFailure(message);

      // Structured error log for monitoring/alerting
      console.error(JSON.stringify({
        level: "CRITICAL",
        event: "encryption_failure",
        component: "AccountDO",
        error: message,
        timestamp: new Date().toISOString(),
      }));

      throw err;
    }
  }

  /**
   * Get the token refresh URL for the current provider.
   * Google and Microsoft use different token endpoints.
   */
  private getTokenRefreshUrl(): string {
    switch (this.provider) {
      case "microsoft":
        return MS_TOKEN_URL;
      case "google":
      default:
        return GOOGLE_TOKEN_URL;
    }
  }

  /**
   * Refresh the access token using the refresh token.
   * Provider-aware: routes to the correct token endpoint based on this.provider.
   * Re-encrypts updated tokens and stores them.
   */
  private async refreshAccessToken(
    masterKey: CryptoKey,
    refreshToken: string,
  ): Promise<TokenPayload> {
    const tokenUrl = this.getTokenRefreshUrl();

    const response = await this.fetchFn(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Token refresh failed (${response.status}): ${body}`,
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };

    // Compute new expiry from expires_in seconds
    const expiry = new Date(
      Date.now() + data.expires_in * 1000,
    ).toISOString();

    const newTokens: TokenPayload = {
      access_token: data.access_token,
      refresh_token: refreshToken, // Neither Google nor Microsoft always return a new refresh token
      expiry,
    };

    // Re-encrypt and store
    const envelope = await encryptTokens(masterKey, newTokens);
    this.sql.exec(
      `UPDATE auth SET encrypted_tokens = ?, updated_at = datetime('now')
       WHERE account_id = ?`,
      JSON.stringify(envelope),
      ACCOUNT_ROW_KEY,
    );

    return newTokens;
  }

  // -------------------------------------------------------------------------
  // Sync cursor management
  // -------------------------------------------------------------------------

  /** Get the current sync token, or null if none set. */
  async getSyncToken(): Promise<string | null> {
    this.ensureMigrated();

    const rows = this.sql
      .exec<{ sync_token: string | null }>(
        "SELECT sync_token FROM sync_state WHERE account_id = ?",
        ACCOUNT_ROW_KEY,
      )
      .toArray();

    if (rows.length === 0) return null;
    return rows[0].sync_token;
  }

  /** Set the sync token after a successful incremental sync. */
  async setSyncToken(token: string): Promise<void> {
    this.ensureMigrated();

    this.sql.exec(
      `INSERT OR REPLACE INTO sync_state
       (account_id, sync_token, full_sync_needed, updated_at)
       VALUES (?, ?, 0, datetime('now'))`,
      ACCOUNT_ROW_KEY,
      token,
    );
  }

  // -------------------------------------------------------------------------
  // Watch channel lifecycle
  // -------------------------------------------------------------------------

  /**
   * Register a new watch channel for a calendar.
   * Generates a unique channel ID and stores it.
   */
  async registerChannel(
    calendarId: string,
  ): Promise<{ channelId: string; expiry: string }> {
    this.ensureMigrated();

    const channelId = generateId("calendar"); // using cal_ prefix for channel IDs
    // Default expiry: 7 days from now (Google Calendar watch max)
    const expiry = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();

    this.sql.exec(
      `INSERT INTO watch_channels
       (channel_id, account_id, expiry_ts, calendar_id, status, created_at)
       VALUES (?, ?, ?, ?, 'active', datetime('now'))`,
      channelId,
      ACCOUNT_ROW_KEY,
      expiry,
      calendarId,
    );

    return { channelId, expiry };
  }

  /**
   * Renew an existing watch channel by extending its expiry.
   * Throws if the channel does not exist.
   */
  async renewChannel(
    channelId: string,
  ): Promise<{ channelId: string; expiry: string }> {
    this.ensureMigrated();

    // Verify channel exists
    const rows = this.sql
      .exec<{ channel_id: string; calendar_id: string }>(
        "SELECT channel_id, calendar_id FROM watch_channels WHERE channel_id = ?",
        channelId,
      )
      .toArray();

    if (rows.length === 0) {
      throw new Error(`Watch channel not found: ${channelId}`);
    }

    const newExpiry = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();

    this.sql.exec(
      `UPDATE watch_channels SET expiry_ts = ?, status = 'active' WHERE channel_id = ?`,
      newExpiry,
      channelId,
    );

    return { channelId, expiry: newExpiry };
  }

  /**
   * Get the status of all watch channels for this account.
   */
  async getChannelStatus(): Promise<{ channels: ChannelInfo[] }> {
    this.ensureMigrated();

    const rows = this.sql
      .exec<{
        channel_id: string;
        calendar_id: string;
        status: string;
        expiry_ts: string;
      }>(
        "SELECT channel_id, calendar_id, status, expiry_ts FROM watch_channels WHERE account_id = ? ORDER BY created_at",
        ACCOUNT_ROW_KEY,
      )
      .toArray();

    return {
      channels: rows.map((r) => ({
        channelId: r.channel_id,
        calendarId: r.calendar_id,
        status: r.status,
        expiryTs: r.expiry_ts,
      })),
    };
  }

  /**
   * Stop all active watch channels and remove them from storage.
   *
   * Calls Google's channels.stop API for each active channel.
   * Errors from Google are logged but do not prevent cleanup --
   * channels may already be expired or stopped.
   *
   * After stopping, all channel rows are deleted from the DB.
   */
  async stopWatchChannels(): Promise<{ stopped: number; errors: number }> {
    this.ensureMigrated();

    const rows = this.sql
      .exec<{
        channel_id: string;
        resource_id: string | null;
        calendar_id: string;
        status: string;
      }>(
        "SELECT channel_id, resource_id, calendar_id, status FROM watch_channels WHERE account_id = ?",
        ACCOUNT_ROW_KEY,
      )
      .toArray();

    let stopped = 0;
    let errors = 0;

    for (const row of rows) {
      if (row.resource_id) {
        try {
          // Call Google channels.stop API
          await this.fetchFn(
            "https://www.googleapis.com/calendar/v3/channels/stop",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                id: row.channel_id,
                resourceId: row.resource_id,
              }),
            },
          );
          stopped++;
        } catch {
          // Channel may already be expired or stopped -- proceed anyway
          errors++;
        }
      }
    }

    // Delete all channel rows regardless of stop success
    this.sql.exec(
      `DELETE FROM watch_channels WHERE account_id = ?`,
      ACCOUNT_ROW_KEY,
    );

    return { stopped, errors };
  }

  // -------------------------------------------------------------------------
  // Microsoft subscription lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create a Microsoft Graph subscription for calendar event changes.
   *
   * Calls MicrosoftCalendarClient.watchEvents() to POST /subscriptions,
   * then stores the subscription data in the local ms_subscriptions table.
   *
   * @param webhookUrl - The notification URL Microsoft will POST to
   * @param calendarId - The calendar to watch
   * @param clientState - Shared secret for notification validation
   * @returns The subscription details (id, resource, expiration)
   */
  async createMsSubscription(
    webhookUrl: string,
    calendarId: string,
    clientState: string,
  ): Promise<{
    subscriptionId: string;
    resource: string;
    expiration: string;
  }> {
    this.ensureMigrated();

    // Get access token for Microsoft Graph API call
    const accessToken = await this.getAccessToken();

    // Build the subscription request to Microsoft Graph
    const resource = `/me/calendars/${calendarId}/events`;
    const expirationDateTime = new Date(
      Date.now() + 3 * 24 * 60 * 60 * 1000, // max 3 days for calendar events
    ).toISOString();

    const response = await this.fetchFn(
      "https://graph.microsoft.com/v1.0/subscriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          changeType: "created,updated,deleted",
          notificationUrl: webhookUrl,
          resource,
          expirationDateTime,
          clientState,
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Microsoft subscription creation failed (${response.status}): ${body}`,
      );
    }

    const data = (await response.json()) as {
      id: string;
      resource: string;
      expirationDateTime: string;
    };

    // Store subscription in local DO SQLite
    this.sql.exec(
      `INSERT OR REPLACE INTO ms_subscriptions
       (subscription_id, resource, client_state, expiration, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      data.id,
      data.resource,
      clientState,
      data.expirationDateTime,
    );

    return {
      subscriptionId: data.id,
      resource: data.resource,
      expiration: data.expirationDateTime,
    };
  }

  /**
   * Renew a Microsoft Graph subscription by extending its expiration.
   *
   * Microsoft subscriptions max 3 days for calendar events.
   * PATCH /subscriptions/{id} with new expirationDateTime.
   */
  async renewMsSubscription(
    subscriptionId: string,
  ): Promise<{ subscriptionId: string; expiration: string }> {
    this.ensureMigrated();

    // Verify subscription exists locally
    const rows = this.sql
      .exec<{ subscription_id: string; resource: string; client_state: string }>(
        "SELECT subscription_id, resource, client_state FROM ms_subscriptions WHERE subscription_id = ?",
        subscriptionId,
      )
      .toArray();

    if (rows.length === 0) {
      throw new Error(`Microsoft subscription not found: ${subscriptionId}`);
    }

    const accessToken = await this.getAccessToken();

    const newExpiration = new Date(
      Date.now() + 3 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const response = await this.fetchFn(
      `https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expirationDateTime: newExpiration,
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Microsoft subscription renewal failed (${response.status}): ${body}`,
      );
    }

    // Update local expiration
    this.sql.exec(
      "UPDATE ms_subscriptions SET expiration = ? WHERE subscription_id = ?",
      newExpiration,
      subscriptionId,
    );

    return { subscriptionId, expiration: newExpiration };
  }

  /**
   * Delete a Microsoft Graph subscription.
   *
   * DELETE /subscriptions/{id}, then remove from local storage.
   * Errors from Microsoft are logged but local deletion always occurs.
   */
  async deleteMsSubscription(subscriptionId: string): Promise<void> {
    this.ensureMigrated();

    try {
      const accessToken = await this.getAccessToken();

      await this.fetchFn(
        `https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );
    } catch (err) {
      // Subscription may already be expired -- proceed with local cleanup
      console.error("Microsoft subscription deletion API call failed:", err);
    }

    // Always delete locally
    this.sql.exec(
      "DELETE FROM ms_subscriptions WHERE subscription_id = ?",
      subscriptionId,
    );
  }

  /**
   * Get all Microsoft subscriptions stored in this AccountDO.
   * Used by cron worker to determine which subscriptions need renewal.
   */
  async getMsSubscriptions(): Promise<
    Array<{
      subscriptionId: string;
      resource: string;
      clientState: string;
      expiration: string;
    }>
  > {
    this.ensureMigrated();

    const rows = this.sql
      .exec<{
        subscription_id: string;
        resource: string;
        client_state: string;
        expiration: string;
      }>(
        "SELECT subscription_id, resource, client_state, expiration FROM ms_subscriptions ORDER BY created_at",
      )
      .toArray();

    return rows.map((r) => ({
      subscriptionId: r.subscription_id,
      resource: r.resource,
      clientState: r.client_state,
      expiration: r.expiration,
    }));
  }

  /**
   * Validate a clientState value against a specific subscription.
   * Returns true if the clientState matches the stored value.
   */
  async validateMsClientState(
    subscriptionId: string,
    clientState: string,
  ): Promise<boolean> {
    this.ensureMigrated();

    const rows = this.sql
      .exec<{ client_state: string }>(
        "SELECT client_state FROM ms_subscriptions WHERE subscription_id = ?",
        subscriptionId,
      )
      .toArray();

    if (rows.length === 0) return false;
    return rows[0].client_state === clientState;
  }

  // -------------------------------------------------------------------------
  // Health tracking
  // -------------------------------------------------------------------------

  /** Get the health status of this account's sync state. */
  async getHealth(): Promise<HealthInfo> {
    this.ensureMigrated();

    const rows = this.sql
      .exec<{
        last_sync_ts: string | null;
        last_success_ts: string | null;
        full_sync_needed: number;
      }>(
        "SELECT last_sync_ts, last_success_ts, full_sync_needed FROM sync_state WHERE account_id = ?",
        ACCOUNT_ROW_KEY,
      )
      .toArray();

    if (rows.length === 0) {
      return {
        lastSyncTs: null,
        lastSuccessTs: null,
        fullSyncNeeded: true,
      };
    }

    return {
      lastSyncTs: rows[0].last_sync_ts,
      lastSuccessTs: rows[0].last_success_ts,
      fullSyncNeeded: rows[0].full_sync_needed === 1,
    };
  }

  /** Mark a sync attempt as successful. */
  async markSyncSuccess(ts: string): Promise<void> {
    this.ensureMigrated();

    const rows = this.sql
      .exec<{ account_id: string }>(
        "SELECT account_id FROM sync_state WHERE account_id = ?",
        ACCOUNT_ROW_KEY,
      )
      .toArray();

    if (rows.length === 0) {
      // No sync state yet -- create one with success timestamps
      this.sql.exec(
        `INSERT INTO sync_state
         (account_id, last_sync_ts, last_success_ts, full_sync_needed, updated_at)
         VALUES (?, ?, ?, 0, datetime('now'))`,
        ACCOUNT_ROW_KEY,
        ts,
        ts,
      );
    } else {
      // Update existing row, preserving sync_token and other fields
      this.sql.exec(
        `UPDATE sync_state
         SET last_sync_ts = ?, last_success_ts = ?, updated_at = datetime('now')
         WHERE account_id = ?`,
        ts,
        ts,
        ACCOUNT_ROW_KEY,
      );
    }
  }

  /** Mark a sync attempt as failed (updates last_sync_ts but not last_success_ts). */
  async markSyncFailure(error: string): Promise<void> {
    this.ensureMigrated();

    const now = new Date().toISOString();

    // We need to preserve existing values while updating last_sync_ts
    const rows = this.sql
      .exec<{
        sync_token: string | null;
        last_success_ts: string | null;
        full_sync_needed: number;
      }>(
        "SELECT sync_token, last_success_ts, full_sync_needed FROM sync_state WHERE account_id = ?",
        ACCOUNT_ROW_KEY,
      )
      .toArray();

    if (rows.length === 0) {
      // No sync state yet - create one
      this.sql.exec(
        `INSERT INTO sync_state
         (account_id, last_sync_ts, full_sync_needed, updated_at)
         VALUES (?, ?, 1, datetime('now'))`,
        ACCOUNT_ROW_KEY,
        now,
      );
    } else {
      this.sql.exec(
        `UPDATE sync_state SET last_sync_ts = ?, updated_at = datetime('now')
         WHERE account_id = ?`,
        now,
        ACCOUNT_ROW_KEY,
      );
    }
  }

  // -------------------------------------------------------------------------
  // fetch() handler -- RPC-style routing for DO stub communication
  // -------------------------------------------------------------------------

  /**
   * Handle fetch requests from DO stubs. Routes requests by URL pathname
   * to the appropriate method.
   *
   * Workers call AccountDO via: `stub.fetch(new Request(url, { body }))`.
   * The pathname determines which method is invoked.
   */
  async handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      switch (pathname) {
        case "/getAccessToken": {
          const accessToken = await this.getAccessToken();
          return Response.json({ access_token: accessToken });
        }

        case "/getSyncToken": {
          const syncToken = await this.getSyncToken();
          return Response.json({ sync_token: syncToken });
        }

        case "/setSyncToken": {
          const body = (await request.json()) as { sync_token: string };
          await this.setSyncToken(body.sync_token);
          return Response.json({ ok: true });
        }

        case "/markSyncSuccess": {
          const body = (await request.json()) as { ts: string };
          await this.markSyncSuccess(body.ts);
          return Response.json({ ok: true });
        }

        case "/markSyncFailure": {
          const body = (await request.json()) as { error: string };
          await this.markSyncFailure(body.error);
          return Response.json({ ok: true });
        }

        case "/initialize": {
          const body = (await request.json()) as {
            tokens: {
              access_token: string;
              refresh_token: string;
              expiry: string;
            };
            scopes: string;
          };
          await this.initialize(body.tokens, body.scopes);
          return Response.json({ ok: true });
        }

        case "/revokeTokens": {
          const result = await this.revokeTokens();
          return Response.json({ ok: true, ...result });
        }

        case "/registerChannel": {
          const body = (await request.json()) as { calendar_id: string };
          const result = await this.registerChannel(body.calendar_id);
          return Response.json(result);
        }

        case "/getChannelStatus": {
          const result = await this.getChannelStatus();
          return Response.json(result);
        }

        case "/getHealth": {
          const result = await this.getHealth();
          return Response.json(result);
        }

        case "/getProvider": {
          return Response.json({ provider: this.provider });
        }

        case "/createMsSubscription": {
          const body = (await request.json()) as {
            webhook_url: string;
            calendar_id: string;
            client_state: string;
          };
          const result = await this.createMsSubscription(
            body.webhook_url,
            body.calendar_id,
            body.client_state,
          );
          return Response.json(result);
        }

        case "/renewMsSubscription": {
          const body = (await request.json()) as {
            subscription_id: string;
          };
          const result = await this.renewMsSubscription(body.subscription_id);
          return Response.json(result);
        }

        case "/deleteMsSubscription": {
          const body = (await request.json()) as {
            subscription_id: string;
          };
          await this.deleteMsSubscription(body.subscription_id);
          return Response.json({ ok: true });
        }

        case "/getMsSubscriptions": {
          const subscriptions = await this.getMsSubscriptions();
          return Response.json({ subscriptions });
        }

        case "/validateMsClientState": {
          const body = (await request.json()) as {
            subscription_id: string;
            client_state: string;
          };
          const valid = await this.validateMsClientState(
            body.subscription_id,
            body.client_state,
          );
          return Response.json({ valid });
        }

        case "/rotateKey": {
          const body = (await request.json()) as {
            old_master_key_hex: string;
            new_master_key_hex: string;
          };
          await this.rotateKey(body.old_master_key_hex, body.new_master_key_hex);
          return Response.json({ ok: true });
        }

        case "/getEncryptedDekForBackup": {
          const body = (await request.json()) as { account_id: string };
          const backup = await this.getEncryptedDekForBackup(body.account_id);
          return Response.json(backup);
        }

        case "/restoreDekFromBackup": {
          const body = (await request.json()) as {
            accountId: string;
            encryptedDek: string;
            dekIv: string;
            backedUpAt: string;
          };
          await this.restoreDekFromBackup(body);
          return Response.json({ ok: true });
        }

        case "/getEncryptionHealth": {
          const encHealth = await this.getEncryptionHealth();
          return Response.json(encHealth);
        }

        default:
          return new Response(`Unknown action: ${pathname}`, { status: 404 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 500 });
    }
  }
}
