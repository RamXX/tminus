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
import type { SqlStorageLike } from "@tminus/shared";
import {
  importMasterKey,
  encryptTokens,
  decryptTokens,
} from "./crypto";
import type { EncryptedEnvelope, TokenPayload } from "./crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Google OAuth2 token refresh endpoint. */
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

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

/**
 * Interface for the fetch function, allowing injection for testing.
 * In production this is globalThis.fetch; in tests it can be mocked.
 */
export type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

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
   * Construct an AccountDO.
   *
   * @param sql - SqlStorage (real DO) or SqlStorageLike adapter (tests)
   * @param masterKeyHex - Hex-encoded 256-bit master key
   * @param fetchFn - Fetch function for Google API calls (defaults to globalThis.fetch)
   */
  constructor(
    sql: SqlStorageLike,
    masterKeyHex: string,
    fetchFn?: FetchFn,
  ) {
    this.sql = sql;
    this.masterKeyHex = masterKeyHex;
    this.fetchFn = fetchFn ?? globalThis.fetch.bind(globalThis);
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

    // Store encrypted tokens
    this.sql.exec(
      `INSERT OR REPLACE INTO auth (account_id, encrypted_tokens, scopes, updated_at)
       VALUES (?, ?, ?, datetime('now'))`,
      ACCOUNT_ROW_KEY,
      JSON.stringify(envelope),
      scopes,
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
   * After this, the account is in a disconnected state.
   */
  async revokeTokens(): Promise<void> {
    this.ensureMigrated();

    this.sql.exec(
      `DELETE FROM auth WHERE account_id = ?`,
      ACCOUNT_ROW_KEY,
    );
  }

  // -------------------------------------------------------------------------
  // Token internal helpers
  // -------------------------------------------------------------------------

  /** Load and decrypt tokens from storage. */
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
    return decryptTokens(masterKey, envelope);
  }

  /**
   * Refresh the access token using the refresh token.
   * Re-encrypts updated tokens and stores them.
   */
  private async refreshAccessToken(
    masterKey: CryptoKey,
    refreshToken: string,
  ): Promise<TokenPayload> {
    const response = await this.fetchFn(GOOGLE_TOKEN_URL, {
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
      refresh_token: refreshToken, // Google doesn't always return a new refresh token
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
          await this.revokeTokens();
          return Response.json({ ok: true });
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

        default:
          return new Response(`Unknown action: ${pathname}`, { status: 404 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 500 });
    }
  }
}
