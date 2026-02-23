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

/** Compatibility default for legacy single-cursor callers. */
const DEFAULT_SCOPE_CALENDAR_ID = "primary";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * OAuth client credentials needed for token refresh requests.
 * Both Google and Microsoft require client_id and client_secret
 * in token refresh requests for web application OAuth clients.
 */
export interface OAuthCredentials {
  readonly googleClientId: string;
  readonly googleClientSecret: string;
  readonly msClientId: string;
  readonly msClientSecret: string;
}

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

export interface TokenInfo {
  readonly expiresAt: string | null;
  readonly hasTokens: boolean;
  readonly provider: ProviderType;
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

export interface CalendarScopeInfo {
  readonly scopeId: string;
  readonly providerCalendarId: string;
  readonly displayName: string | null;
  readonly calendarRole: string;
  readonly enabled: boolean;
  readonly syncEnabled: boolean;
}

export interface ScopedWatchLifecycleInfo {
  readonly lifecycleId: string;
  readonly providerCalendarId: string;
  readonly provider: string;
  readonly lifecycleKind: string;
  readonly status: string;
  readonly providerChannelId: string | null;
  readonly providerResourceId: string | null;
  readonly providerSubscriptionId: string | null;
  readonly clientState: string | null;
  readonly expiryTs: string;
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
  private readonly oauthCredentials?: OAuthCredentials;
  private migrated = false;
  private refreshInFlight: Promise<TokenPayload> | null = null;

  /**
   * The provider type for this account.
   * Defaults to 'google'. Stored in the auth table's provider column.
   * Used to route to the correct CalendarProvider, normalizer, and classifier.
   */
  private provider: ProviderType;

  /**
   * Construct an AccountDO.
   *
   * @param sql - SqlStorage (real DO) or SqlStorageLike adapter (tests)
   * @param masterKeyHex - Hex-encoded 256-bit master key
   * @param fetchFn - Fetch function for API calls (defaults to globalThis.fetch)
   * @param provider - Calendar provider type (defaults to 'google')
   * @param oauthCredentials - OAuth client credentials for token refresh (required in production)
   */
  constructor(
    sql: SqlStorageLike,
    masterKeyHex: string,
    fetchFn?: FetchFn,
    provider?: ProviderType,
    oauthCredentials?: OAuthCredentials,
  ) {
    this.sql = sql;
    this.masterKeyHex = masterKeyHex;
    this.fetchFn = fetchFn ?? globalThis.fetch.bind(globalThis);
    this.provider = provider ?? "google";
    this.oauthCredentials = oauthCredentials;
  }

  /** Narrow unknown values to supported OAuth calendar providers. */
  private static isCalendarProvider(value: unknown): value is ProviderType {
    return value === "google" || value === "microsoft";
  }

  // -------------------------------------------------------------------------
  // Schema initialization
  // -------------------------------------------------------------------------

  /** Ensure schema is applied. Called lazily before any DB operation. */
  private ensureMigrated(): void {
    if (this.migrated) return;
    applyMigrations(this.sql, ACCOUNT_DO_MIGRATIONS, "account");
    this.seedScopedStateFromLegacy();
    this.migrated = true;
  }

  /**
   * Seed scoped tables from legacy rows.
   *
   * This runs once on first DO access after migration and is idempotent.
   * Existing scoped rows are preserved.
   */
  private seedScopedStateFromLegacy(): void {
    const existingScopes = this.sql
      .exec<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM calendar_scopes WHERE account_id = ?",
        ACCOUNT_ROW_KEY,
      )
      .toArray();

    if ((existingScopes[0]?.cnt ?? 0) === 0) {
      const calendarIds = new Set<string>();

      const googleCalendars = this.sql
        .exec<{ calendar_id: string }>(
          "SELECT DISTINCT calendar_id FROM watch_channels WHERE account_id = ?",
          ACCOUNT_ROW_KEY,
        )
        .toArray();
      for (const row of googleCalendars) {
        if (row.calendar_id) calendarIds.add(row.calendar_id);
      }

      const msResources = this.sql
        .exec<{ resource: string }>(
          "SELECT resource FROM ms_subscriptions",
        )
        .toArray();
      for (const row of msResources) {
        const parsed = this.parseMsCalendarIdFromResource(row.resource);
        if (parsed) calendarIds.add(parsed);
      }

      if (calendarIds.size === 0) {
        calendarIds.add(DEFAULT_SCOPE_CALENDAR_ID);
      }

      for (const calendarId of calendarIds) {
        const role = calendarId === DEFAULT_SCOPE_CALENDAR_ID
          ? "primary"
          : "secondary";
        this.upsertCalendarScopeRow({
          providerCalendarId: calendarId,
          calendarRole: role,
          displayName: null,
          enabled: true,
          syncEnabled: true,
        });
      }
    }

    const legacySyncRows = this.sql
      .exec<{
        sync_token: string | null;
        last_sync_ts: string | null;
        last_success_ts: string | null;
        full_sync_needed: number;
      }>(
        `SELECT sync_token, last_sync_ts, last_success_ts, full_sync_needed
         FROM sync_state
         WHERE account_id = ?`,
        ACCOUNT_ROW_KEY,
      )
      .toArray();

    if (legacySyncRows.length > 0) {
      const legacy = legacySyncRows[0];
      const scopes = this.sql
        .exec<{ provider_calendar_id: string }>(
          "SELECT provider_calendar_id FROM calendar_scopes WHERE account_id = ?",
          ACCOUNT_ROW_KEY,
        )
        .toArray();

      for (const scope of scopes) {
        this.sql.exec(
          `INSERT OR IGNORE INTO scoped_sync_state
           (account_id, provider_calendar_id, sync_token, last_sync_ts, last_success_ts, full_sync_needed, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
          ACCOUNT_ROW_KEY,
          scope.provider_calendar_id,
          legacy.sync_token,
          legacy.last_sync_ts,
          legacy.last_success_ts,
          legacy.full_sync_needed,
        );
      }
    }

    const legacyWatches = this.sql
      .exec<{
        channel_id: string;
        calendar_id: string;
        status: string;
        resource_id: string | null;
        expiry_ts: string;
      }>(
        `SELECT channel_id, calendar_id, status, resource_id, expiry_ts
         FROM watch_channels
         WHERE account_id = ?`,
        ACCOUNT_ROW_KEY,
      )
      .toArray();

    for (const row of legacyWatches) {
      this.upsertScopedWatchLifecycle({
        lifecycleId: `watch:${row.channel_id}`,
        providerCalendarId: row.calendar_id,
        provider: "google",
        lifecycleKind: "watch",
        status: row.status,
        providerChannelId: row.channel_id,
        providerResourceId: row.resource_id,
        providerSubscriptionId: null,
        clientState: null,
        expiryTs: row.expiry_ts,
      });
    }

    const legacySubs = this.sql
      .exec<{
        subscription_id: string;
        resource: string;
        client_state: string;
        expiration: string;
      }>(
        "SELECT subscription_id, resource, client_state, expiration FROM ms_subscriptions",
      )
      .toArray();

    for (const row of legacySubs) {
      const calendarId = this.parseMsCalendarIdFromResource(row.resource)
        ?? DEFAULT_SCOPE_CALENDAR_ID;
      this.upsertCalendarScopeRow({
        providerCalendarId: calendarId,
        calendarRole: calendarId === DEFAULT_SCOPE_CALENDAR_ID ? "primary" : "secondary",
        displayName: null,
        enabled: true,
        syncEnabled: true,
      });
      this.upsertScopedWatchLifecycle({
        lifecycleId: `subscription:${row.subscription_id}`,
        providerCalendarId: calendarId,
        provider: "microsoft",
        lifecycleKind: "subscription",
        status: "active",
        providerChannelId: null,
        providerResourceId: row.resource,
        providerSubscriptionId: row.subscription_id,
        clientState: row.client_state,
        expiryTs: row.expiration,
      });
    }
  }

  private parseMsCalendarIdFromResource(resource: string): string | null {
    const match = /^\/me\/calendars\/([^/]+)\/events$/.exec(resource);
    if (!match?.[1]) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  /**
   * Resolve the effective provider for this account from local persisted state.
   *
   * Production wrappers instantiate AccountDO without a fixed provider, so this
   * method is the source of truth for runtime routing (Google vs Microsoft).
   */
  private resolveProvider(): ProviderType {
    this.ensureMigrated();

    const authRows = this.sql
      .exec<{ provider: string | null }>(
        "SELECT provider FROM auth WHERE account_id = ?",
        ACCOUNT_ROW_KEY,
      )
      .toArray();

    let resolved: ProviderType = this.provider;
    if (
      authRows.length > 0 &&
      AccountDO.isCalendarProvider(authRows[0].provider)
    ) {
      resolved = authRows[0].provider;
    }

    // Self-heal legacy rows where provider was persisted as "google" for
    // Microsoft accounts before provider-aware initialization was enforced.
    if (resolved === "google") {
      const msSubs = this.sql
        .exec<{ cnt: number }>(
          "SELECT COUNT(*) as cnt FROM ms_subscriptions",
        )
        .toArray();
      if ((msSubs[0]?.cnt ?? 0) > 0) {
        resolved = "microsoft";
      }
    }

    if (resolved !== this.provider) {
      this.provider = resolved;
    }

    if (authRows.length > 0 && authRows[0].provider !== resolved) {
      this.sql.exec(
        `UPDATE auth
         SET provider = ?, updated_at = datetime('now')
         WHERE account_id = ?`,
        resolved,
        ACCOUNT_ROW_KEY,
      );
    }

    return resolved;
  }

  /** Force provider for this account and persist it when auth row exists. */
  private setProvider(provider: ProviderType): void {
    this.ensureMigrated();
    this.provider = provider;
    this.sql.exec(
      `UPDATE auth
       SET provider = ?, updated_at = datetime('now')
       WHERE account_id = ?`,
      provider,
      ACCOUNT_ROW_KEY,
    );
  }

  private upsertCalendarScopeRow(scope: {
    providerCalendarId: string;
    displayName: string | null;
    calendarRole: string;
    enabled: boolean;
    syncEnabled: boolean;
  }): void {
    const existing = this.sql
      .exec<{ scope_id: string }>(
        `SELECT scope_id FROM calendar_scopes
         WHERE account_id = ? AND provider_calendar_id = ?`,
        ACCOUNT_ROW_KEY,
        scope.providerCalendarId,
      )
      .toArray();

    const scopeId = existing[0]?.scope_id ?? generateId("calendar");
    this.sql.exec(
      `INSERT OR REPLACE INTO calendar_scopes
       (scope_id, account_id, provider_calendar_id, display_name, calendar_role, enabled, sync_enabled, created_at, updated_at)
       VALUES (
         ?, ?, ?, ?, ?, ?, ?,
         COALESCE((SELECT created_at FROM calendar_scopes WHERE scope_id = ?), datetime('now')),
         datetime('now')
       )`,
      scopeId,
      ACCOUNT_ROW_KEY,
      scope.providerCalendarId,
      scope.displayName,
      scope.calendarRole,
      scope.enabled ? 1 : 0,
      scope.syncEnabled ? 1 : 0,
      scopeId,
    );
  }

  private ensureScopedSyncRow(providerCalendarId: string): void {
    this.sql.exec(
      `INSERT OR IGNORE INTO scoped_sync_state (account_id, provider_calendar_id)
       VALUES (?, ?)`,
      ACCOUNT_ROW_KEY,
      providerCalendarId,
    );
  }

  private upsertScopedWatchLifecycle(row: {
    lifecycleId: string;
    providerCalendarId: string;
    provider: string;
    lifecycleKind: string;
    status: string;
    providerChannelId: string | null;
    providerResourceId: string | null;
    providerSubscriptionId: string | null;
    clientState: string | null;
    expiryTs: string;
  }): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO scoped_watch_lifecycle
       (lifecycle_id, account_id, provider_calendar_id, provider, lifecycle_kind, status,
        provider_channel_id, provider_resource_id, provider_subscription_id, client_state,
        expiry_ts, metadata_json, created_at, updated_at)
       VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}',
         COALESCE((SELECT created_at FROM scoped_watch_lifecycle WHERE lifecycle_id = ?), datetime('now')),
         datetime('now')
       )`,
      row.lifecycleId,
      ACCOUNT_ROW_KEY,
      row.providerCalendarId,
      row.provider,
      row.lifecycleKind,
      row.status,
      row.providerChannelId,
      row.providerResourceId,
      row.providerSubscriptionId,
      row.clientState,
      row.expiryTs,
      row.lifecycleId,
    );
  }

  private getDefaultScopeCalendarId(): string {
    const scoped = this.sql
      .exec<{ provider_calendar_id: string }>(
        `SELECT provider_calendar_id
         FROM calendar_scopes
         WHERE account_id = ? AND enabled = 1 AND sync_enabled = 1
         ORDER BY created_at ASC
         LIMIT 1`,
        ACCOUNT_ROW_KEY,
      )
      .toArray();

    if (scoped.length > 0) {
      return scoped[0].provider_calendar_id;
    }

    return DEFAULT_SCOPE_CALENDAR_ID;
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
    provider?: ProviderType,
  ): Promise<void> {
    this.ensureMigrated();
    const effectiveProvider = provider ?? this.resolveProvider();
    this.provider = effectiveProvider;

    const masterKey = await importMasterKey(this.masterKeyHex);
    const envelope = await encryptTokens(masterKey, tokens);

    // Store encrypted tokens with provider type
    this.sql.exec(
      `INSERT OR REPLACE INTO auth (account_id, encrypted_tokens, scopes, provider, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      ACCOUNT_ROW_KEY,
      JSON.stringify(envelope),
      scopes,
      effectiveProvider,
    );

    // Initialize sync state
    this.sql.exec(
      `INSERT OR IGNORE INTO sync_state (account_id) VALUES (?)`,
      ACCOUNT_ROW_KEY,
    );

    this.upsertCalendarScopeRow({
      providerCalendarId: DEFAULT_SCOPE_CALENDAR_ID,
      displayName: null,
      calendarRole: "primary",
      enabled: true,
      syncEnabled: true,
    });
    this.ensureScopedSyncRow(DEFAULT_SCOPE_CALENDAR_ID);
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
  async getAccessToken(providerOverride?: ProviderType): Promise<string> {
    this.ensureMigrated();
    if (providerOverride) {
      this.setProvider(providerOverride);
    } else {
      this.resolveProvider();
    }

    const masterKey = await importMasterKey(this.masterKeyHex);
    const tokens = await this.loadTokens(masterKey);

    // Check if the token is expired or about to expire
    const expiryMs = new Date(tokens.expiry).getTime();
    const now = Date.now();

    if (expiryMs - now > REFRESH_BUFFER_MS) {
      // Token is still valid
      return tokens.access_token;
    }

    // Token expired or expiring soon -- refresh. Use single-flight to avoid
    // concurrent refresh races that can invalidate rotated refresh tokens.
    const attemptedRefreshToken = tokens.refresh_token;
    try {
      const refreshed = await this.refreshAccessTokenSingleFlight(
        masterKey,
        attemptedRefreshToken,
      );
      return refreshed.access_token;
    } catch (err) {
      // Recovery path for refresh token rotation races:
      // if another in-flight refresh already rotated tokens, reload and reuse.
      if (err instanceof Error && err.message.includes("invalid_grant")) {
        const latestTokens = await this.loadTokens(masterKey);
        const latestExpiryMs = new Date(latestTokens.expiry).getTime();
        if (
          latestTokens.refresh_token !== attemptedRefreshToken &&
          latestExpiryMs - Date.now() > REFRESH_BUFFER_MS
        ) {
          return latestTokens.access_token;
        }
      }
      throw err;
    }
  }

  /**
   * Serialize refresh-token usage within this DO instance.
   */
  private async refreshAccessTokenSingleFlight(
    masterKey: CryptoKey,
    refreshToken: string,
  ): Promise<TokenPayload> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = (async () => {
        try {
          return await this.refreshAccessToken(masterKey, refreshToken);
        } finally {
          this.refreshInFlight = null;
        }
      })();
    }
    return this.refreshInFlight;
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
    const provider = this.resolveProvider();

    // Try to load tokens for server-side revocation
    let revoked = false;
    const rows = this.sql
      .exec<{ encrypted_tokens: string }>(
        "SELECT encrypted_tokens FROM auth WHERE account_id = ?",
        ACCOUNT_ROW_KEY,
      )
      .toArray();

    if (rows.length > 0) {
      if (provider === "google") {
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
    switch (this.resolveProvider()) {
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
    const provider = this.resolveProvider();
    const tokenUrl = this.getTokenRefreshUrl();

    // Build request body with client credentials per OAuth2 spec.
    // Google and Microsoft both require client_id and client_secret
    // for web application type OAuth clients.
    const params: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    };

    if (this.oauthCredentials) {
      if (provider === "microsoft") {
        params.client_id = this.oauthCredentials.msClientId;
        params.client_secret = this.oauthCredentials.msClientSecret;
      } else {
        // google (default)
        params.client_id = this.oauthCredentials.googleClientId;
        params.client_secret = this.oauthCredentials.googleClientSecret;
      }
    }

    const response = await this.fetchFn(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
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
      refresh_token?: string;
    };

    // Compute new expiry from expires_in seconds
    const expiry = new Date(
      Date.now() + data.expires_in * 1000,
    ).toISOString();

    // Some providers (notably Microsoft) can rotate refresh tokens during
    // refresh flows. Persist the rotated token when present, otherwise keep
    // using the prior refresh token.
    const refreshedToken =
      typeof data.refresh_token === "string" && data.refresh_token.length > 0
        ? data.refresh_token
        : refreshToken;

    const newTokens: TokenPayload = {
      access_token: data.access_token,
      refresh_token: refreshedToken,
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

  /**
   * Create or update a scoped calendar record for this account.
   */
  async upsertCalendarScope(scope: {
    providerCalendarId: string;
    displayName?: string | null;
    calendarRole?: string;
    enabled?: boolean;
    syncEnabled?: boolean;
  }): Promise<void> {
    this.ensureMigrated();

    this.upsertCalendarScopeRow({
      providerCalendarId: scope.providerCalendarId,
      displayName: scope.displayName ?? null,
      calendarRole: scope.calendarRole ?? (
        scope.providerCalendarId === DEFAULT_SCOPE_CALENDAR_ID
          ? "primary"
          : "secondary"
      ),
      enabled: scope.enabled ?? true,
      syncEnabled: scope.syncEnabled ?? true,
    });
    this.ensureScopedSyncRow(scope.providerCalendarId);
  }

  /**
   * List all scoped calendars associated with this account.
   */
  async listCalendarScopes(): Promise<CalendarScopeInfo[]> {
    this.ensureMigrated();

    const rows = this.sql
      .exec<{
        scope_id: string;
        provider_calendar_id: string;
        display_name: string | null;
        calendar_role: string;
        enabled: number;
        sync_enabled: number;
      }>(
        `SELECT scope_id, provider_calendar_id, display_name, calendar_role, enabled, sync_enabled
         FROM calendar_scopes
         WHERE account_id = ?
         ORDER BY created_at`,
        ACCOUNT_ROW_KEY,
      )
      .toArray();

    return rows.map((row) => ({
      scopeId: row.scope_id,
      providerCalendarId: row.provider_calendar_id,
      displayName: row.display_name,
      calendarRole: row.calendar_role,
      enabled: row.enabled === 1,
      syncEnabled: row.sync_enabled === 1,
    }));
  }

  /**
   * Get a scoped sync token by provider calendar ID.
   */
  async getScopedSyncToken(providerCalendarId: string): Promise<string | null> {
    this.ensureMigrated();

    const rows = this.sql
      .exec<{ sync_token: string | null }>(
        `SELECT sync_token
         FROM scoped_sync_state
         WHERE account_id = ? AND provider_calendar_id = ?`,
        ACCOUNT_ROW_KEY,
        providerCalendarId,
      )
      .toArray();

    if (rows.length === 0) return null;
    return rows[0].sync_token;
  }

  /**
   * Set scoped sync cursor state for a specific provider calendar.
   */
  async setScopedSyncToken(providerCalendarId: string, token: string): Promise<void> {
    this.ensureMigrated();

    this.upsertCalendarScopeRow({
      providerCalendarId,
      displayName: null,
      calendarRole: providerCalendarId === DEFAULT_SCOPE_CALENDAR_ID ? "primary" : "secondary",
      enabled: true,
      syncEnabled: true,
    });

    this.sql.exec(
      `INSERT OR REPLACE INTO scoped_sync_state
       (account_id, provider_calendar_id, sync_token, full_sync_needed, updated_at)
       VALUES (?, ?, ?, 0, datetime('now'))`,
      ACCOUNT_ROW_KEY,
      providerCalendarId,
      token,
    );
  }

  /** Get the current sync token, or null if none set. */
  async getSyncToken(): Promise<string | null> {
    this.ensureMigrated();

    const rows = this.sql
      .exec<{ sync_token: string | null }>(
        "SELECT sync_token FROM sync_state WHERE account_id = ?",
        ACCOUNT_ROW_KEY,
      )
      .toArray();

    if (rows.length > 0 && rows[0].sync_token !== null) {
      return rows[0].sync_token;
    }

    // Backfill compatibility: if legacy row is empty, try scoped default.
    const defaultScope = this.getDefaultScopeCalendarId();
    return this.getScopedSyncToken(defaultScope);
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

    // Keep scoped cursor in sync for legacy callers.
    const defaultScope = this.getDefaultScopeCalendarId();
    await this.setScopedSyncToken(defaultScope, token);
  }

  /**
   * List provider-neutral scoped watch/subscription lifecycle rows.
   */
  async getScopedWatchLifecycle(
    providerCalendarId?: string,
  ): Promise<ScopedWatchLifecycleInfo[]> {
    this.ensureMigrated();

    const rows = providerCalendarId
      ? this.sql
        .exec<{
          lifecycle_id: string;
          provider_calendar_id: string;
          provider: string;
          lifecycle_kind: string;
          status: string;
          provider_channel_id: string | null;
          provider_resource_id: string | null;
          provider_subscription_id: string | null;
          client_state: string | null;
          expiry_ts: string;
        }>(
          `SELECT lifecycle_id, provider_calendar_id, provider, lifecycle_kind, status,
                  provider_channel_id, provider_resource_id, provider_subscription_id, client_state, expiry_ts
           FROM scoped_watch_lifecycle
           WHERE account_id = ? AND provider_calendar_id = ?
           ORDER BY created_at`,
          ACCOUNT_ROW_KEY,
          providerCalendarId,
        )
        .toArray()
      : this.sql
        .exec<{
          lifecycle_id: string;
          provider_calendar_id: string;
          provider: string;
          lifecycle_kind: string;
          status: string;
          provider_channel_id: string | null;
          provider_resource_id: string | null;
          provider_subscription_id: string | null;
          client_state: string | null;
          expiry_ts: string;
        }>(
          `SELECT lifecycle_id, provider_calendar_id, provider, lifecycle_kind, status,
                  provider_channel_id, provider_resource_id, provider_subscription_id, client_state, expiry_ts
           FROM scoped_watch_lifecycle
           WHERE account_id = ?
           ORDER BY created_at`,
          ACCOUNT_ROW_KEY,
        )
        .toArray();

    return rows.map((row) => ({
      lifecycleId: row.lifecycle_id,
      providerCalendarId: row.provider_calendar_id,
      provider: row.provider,
      lifecycleKind: row.lifecycle_kind,
      status: row.status,
      providerChannelId: row.provider_channel_id,
      providerResourceId: row.provider_resource_id,
      providerSubscriptionId: row.provider_subscription_id,
      clientState: row.client_state,
      expiryTs: row.expiry_ts,
    }));
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

    this.upsertCalendarScopeRow({
      providerCalendarId: calendarId,
      displayName: null,
      calendarRole: calendarId === DEFAULT_SCOPE_CALENDAR_ID ? "primary" : "secondary",
      enabled: true,
      syncEnabled: true,
    });
    this.ensureScopedSyncRow(calendarId);
    this.upsertScopedWatchLifecycle({
      lifecycleId: `watch:${channelId}`,
      providerCalendarId: calendarId,
      provider: "google",
      lifecycleKind: "watch",
      status: "active",
      providerChannelId: channelId,
      providerResourceId: null,
      providerSubscriptionId: null,
      clientState: null,
      expiryTs: expiry,
    });

    return { channelId, expiry };
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
   * Store a watch channel created externally (e.g. during onboarding workflow).
   *
   * Unlike registerChannel(), which generates its own channel_id, this method
   * accepts all fields from the caller -- typically the Google Calendar API
   * response forwarded by the OnboardingWorkflow.
   */
  async storeWatchChannel(
    channelId: string,
    resourceId: string,
    expiration: string,
    calendarId: string,
  ): Promise<void> {
    this.ensureMigrated();

    this.sql.exec(
      `INSERT OR REPLACE INTO watch_channels
       (channel_id, account_id, resource_id, expiry_ts, calendar_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', datetime('now'))`,
      channelId,
      ACCOUNT_ROW_KEY,
      resourceId,
      expiration,
      calendarId,
    );

    this.upsertCalendarScopeRow({
      providerCalendarId: calendarId,
      displayName: null,
      calendarRole: calendarId === DEFAULT_SCOPE_CALENDAR_ID ? "primary" : "secondary",
      enabled: true,
      syncEnabled: true,
    });
    this.ensureScopedSyncRow(calendarId);
    this.upsertScopedWatchLifecycle({
      lifecycleId: `watch:${channelId}`,
      providerCalendarId: calendarId,
      provider: "google",
      lifecycleKind: "watch",
      status: "active",
      providerChannelId: channelId,
      providerResourceId: resourceId,
      providerSubscriptionId: null,
      clientState: null,
      expiryTs: expiration,
    });
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

      this.upsertScopedWatchLifecycle({
        lifecycleId: `watch:${row.channel_id}`,
        providerCalendarId: row.calendar_id,
        provider: "google",
        lifecycleKind: "watch",
        status: "stopped",
        providerChannelId: row.channel_id,
        providerResourceId: row.resource_id,
        providerSubscriptionId: null,
        clientState: null,
        expiryTs: new Date().toISOString(),
      });
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
    // Calendar IDs can contain reserved URL path characters. Keep the resource
    // path URL-safe so Graph subscriptions always target the intended calendar.
    const resource = `/me/calendars/${encodeURIComponent(calendarId)}/events`;
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

    this.upsertCalendarScopeRow({
      providerCalendarId: calendarId,
      displayName: null,
      calendarRole: calendarId === DEFAULT_SCOPE_CALENDAR_ID ? "primary" : "secondary",
      enabled: true,
      syncEnabled: true,
    });
    this.ensureScopedSyncRow(calendarId);
    this.upsertScopedWatchLifecycle({
      lifecycleId: `subscription:${data.id}`,
      providerCalendarId: calendarId,
      provider: "microsoft",
      lifecycleKind: "subscription",
      status: "active",
      providerChannelId: null,
      providerResourceId: data.resource,
      providerSubscriptionId: data.id,
      clientState,
      expiryTs: data.expirationDateTime,
    });

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

    const calendarId = this.parseMsCalendarIdFromResource(rows[0].resource)
      ?? DEFAULT_SCOPE_CALENDAR_ID;
    this.upsertScopedWatchLifecycle({
      lifecycleId: `subscription:${subscriptionId}`,
      providerCalendarId: calendarId,
      provider: "microsoft",
      lifecycleKind: "subscription",
      status: "active",
      providerChannelId: null,
      providerResourceId: rows[0].resource,
      providerSubscriptionId: subscriptionId,
      clientState: rows[0].client_state,
      expiryTs: newExpiration,
    });

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
    const rows = this.sql
      .exec<{ resource: string; client_state: string }>(
        "SELECT resource, client_state FROM ms_subscriptions WHERE subscription_id = ?",
        subscriptionId,
      )
      .toArray();

    this.sql.exec(
      "DELETE FROM ms_subscriptions WHERE subscription_id = ?",
      subscriptionId,
    );

    if (rows.length > 0) {
      const calendarId = this.parseMsCalendarIdFromResource(rows[0].resource)
        ?? DEFAULT_SCOPE_CALENDAR_ID;
      this.upsertScopedWatchLifecycle({
        lifecycleId: `subscription:${subscriptionId}`,
        providerCalendarId: calendarId,
        provider: "microsoft",
        lifecycleKind: "subscription",
        status: "deleted",
        providerChannelId: null,
        providerResourceId: rows[0].resource,
        providerSubscriptionId: subscriptionId,
        clientState: rows[0].client_state,
        expiryTs: new Date().toISOString(),
      });
    }
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

  /**
   * Return non-sensitive token metadata for diagnostics/UI.
   *
   * Never returns token values -- only expiry and presence flags.
   */
  async getTokenInfo(): Promise<TokenInfo> {
    this.ensureMigrated();
    const provider = this.resolveProvider();

    const rows = this.sql
      .exec<{ encrypted_tokens: string }>(
        "SELECT encrypted_tokens FROM auth WHERE account_id = ?",
        ACCOUNT_ROW_KEY,
      )
      .toArray();

    if (rows.length === 0) {
      return {
        expiresAt: null,
        hasTokens: false,
        provider,
      };
    }

    try {
      const masterKey = await importMasterKey(this.masterKeyHex);
      const envelope: EncryptedEnvelope = JSON.parse(rows[0].encrypted_tokens);
      const tokens = await decryptTokens(masterKey, envelope);
      return {
        expiresAt: typeof tokens.expiry === "string" ? tokens.expiry : null,
        hasTokens: true,
        provider,
      };
    } catch (err) {
      console.error(
        "AccountDO.getTokenInfo: failed to read token metadata",
        err instanceof Error ? err.message : String(err),
      );
      return {
        expiresAt: null,
        hasTokens: false,
        provider,
      };
    }
  }

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

    if (rows.length > 0) {
      return {
        lastSyncTs: rows[0].last_sync_ts,
        lastSuccessTs: rows[0].last_success_ts,
        fullSyncNeeded: rows[0].full_sync_needed === 1,
      };
    }

    const defaultScope = this.getDefaultScopeCalendarId();
    const scopedRows = this.sql
      .exec<{
        last_sync_ts: string | null;
        last_success_ts: string | null;
        full_sync_needed: number;
      }>(
        `SELECT last_sync_ts, last_success_ts, full_sync_needed
         FROM scoped_sync_state
         WHERE account_id = ? AND provider_calendar_id = ?`,
        ACCOUNT_ROW_KEY,
        defaultScope,
      )
      .toArray();

    if (scopedRows.length === 0) {
      return {
        lastSyncTs: null,
        lastSuccessTs: null,
        fullSyncNeeded: true,
      };
    }

    return {
      lastSyncTs: scopedRows[0].last_sync_ts,
      lastSuccessTs: scopedRows[0].last_success_ts,
      fullSyncNeeded: scopedRows[0].full_sync_needed === 1,
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
         SET last_sync_ts = ?, last_success_ts = ?, full_sync_needed = 0, updated_at = datetime('now')
         WHERE account_id = ?`,
        ts,
        ts,
        ACCOUNT_ROW_KEY,
      );
    }

    const defaultScope = this.getDefaultScopeCalendarId();
    this.sql.exec(
      `INSERT INTO scoped_sync_state
       (account_id, provider_calendar_id, last_sync_ts, last_success_ts, full_sync_needed, updated_at)
       VALUES (?, ?, ?, ?, 0, datetime('now'))
       ON CONFLICT(account_id, provider_calendar_id) DO UPDATE SET
         last_sync_ts = excluded.last_sync_ts,
         last_success_ts = excluded.last_success_ts,
         full_sync_needed = 0,
         updated_at = datetime('now')`,
      ACCOUNT_ROW_KEY,
      defaultScope,
      ts,
      ts,
    );
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

    const defaultScope = this.getDefaultScopeCalendarId();
    this.sql.exec(
      `INSERT INTO scoped_sync_state
       (account_id, provider_calendar_id, last_sync_ts, full_sync_needed, updated_at)
       VALUES (?, ?, ?, 1, datetime('now'))
       ON CONFLICT(account_id, provider_calendar_id) DO UPDATE SET
         last_sync_ts = excluded.last_sync_ts,
         updated_at = datetime('now')`,
      ACCOUNT_ROW_KEY,
      defaultScope,
      now,
    );
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
          const body = request.method === "POST"
            ? await request
              .json()
              .then((v) => v as { provider?: ProviderType })
              .catch(() => ({} as { provider?: ProviderType }))
            : ({} as { provider?: ProviderType });
          const providerOverride = AccountDO.isCalendarProvider(body.provider)
            ? body.provider
            : undefined;
          const accessToken = await this.getAccessToken(providerOverride);
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

        case "/upsertCalendarScope": {
          const body = (await request.json()) as {
            provider_calendar_id: string;
            display_name?: string | null;
            calendar_role?: string;
            enabled?: boolean;
            sync_enabled?: boolean;
          };
          await this.upsertCalendarScope({
            providerCalendarId: body.provider_calendar_id,
            displayName: body.display_name ?? null,
            calendarRole: body.calendar_role,
            enabled: body.enabled,
            syncEnabled: body.sync_enabled,
          });
          return Response.json({ ok: true });
        }

        case "/listCalendarScopes": {
          const scopes = await this.listCalendarScopes();
          return Response.json({ scopes });
        }

        case "/getScopedSyncToken": {
          const body = (await request.json()) as { provider_calendar_id: string };
          const syncToken = await this.getScopedSyncToken(body.provider_calendar_id);
          return Response.json({ sync_token: syncToken });
        }

        case "/setScopedSyncToken": {
          const body = (await request.json()) as {
            provider_calendar_id: string;
            sync_token: string;
          };
          await this.setScopedSyncToken(body.provider_calendar_id, body.sync_token);
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
            provider?: ProviderType;
          };
          const providerOverride = AccountDO.isCalendarProvider(body.provider)
            ? body.provider
            : undefined;
          await this.initialize(body.tokens, body.scopes, providerOverride);
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

        case "/storeWatchChannel": {
          const body = (await request.json()) as {
            channel_id: string;
            resource_id: string;
            expiration: string;
            calendar_id: string;
          };
          await this.storeWatchChannel(
            body.channel_id,
            body.resource_id,
            body.expiration,
            body.calendar_id,
          );
          return Response.json({ ok: true });
        }

        case "/getChannelStatus": {
          const result = await this.getChannelStatus();
          return Response.json(result);
        }

        case "/getScopedWatchLifecycle": {
          const body = request.method === "POST"
            ? (await request.json()) as { provider_calendar_id?: string }
            : {};
          const lifecycle = await this.getScopedWatchLifecycle(body.provider_calendar_id);
          return Response.json({ lifecycle });
        }

        case "/getHealth": {
          const result = await this.getHealth();
          return Response.json(result);
        }

        case "/getTokenInfo": {
          const result = await this.getTokenInfo();
          return Response.json(result);
        }

        case "/getProvider": {
          return Response.json({ provider: this.resolveProvider() });
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
