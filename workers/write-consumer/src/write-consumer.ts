/**
 * write-consumer -- Processes write-queue messages for mirror creation,
 * update, and deletion with idempotency.
 *
 * Provider-agnostic: works with any CalendarProvider (Google or Microsoft).
 * The calendarClientFactory injected at construction determines which provider
 * API is used for the target account.
 *
 * Handles two message types:
 * - UPSERT_MIRROR: Create or update mirror events in target calendars
 * - DELETE_MANAGED_MIRROR: Remove mirror events from target calendars
 *
 * Key behaviors:
 * - Idempotency via projection hash comparison (Invariant D)
 * - Busy overlay calendar auto-creation when missing
 * - Mirror state tracking (PENDING -> ACTIVE, ACTIVE -> DELETED, * -> ERROR)
 * - Error handling with typed retry strategies per provider API error (Google + Microsoft)
 * - Extended properties / open extensions set on all managed events (loop prevention)
 */

import {
  GoogleCalendarClient,
  GoogleApiError,
  TokenExpiredError,
  RateLimitError,
  ResourceNotFoundError,
  SyncTokenExpiredError,
  MicrosoftApiError,
  MicrosoftTokenExpiredError,
  MicrosoftRateLimitError,
  MicrosoftResourceNotFoundError,
  BUSY_OVERLAY_CALENDAR_NAME,
} from "@tminus/shared";
import type {
  UpsertMirrorMessage,
  DeleteManagedMirrorMessage,
  MirrorState,
  CalendarProvider,
  FetchFn,
} from "@tminus/shared";

/** Do not patch already-created historical mirrors older than this many days. */
const HISTORICAL_PATCH_SKIP_DAYS = 30;
const HISTORICAL_PATCH_SKIP_MS = HISTORICAL_PATCH_SKIP_DAYS * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal interface for reading/writing mirror state in UserGraphDO's SQL. */
export interface MirrorStore {
  getMirror(
    canonicalEventId: string,
    targetAccountId: string,
  ): MirrorRow | null;

  updateMirrorState(
    canonicalEventId: string,
    targetAccountId: string,
    update: MirrorUpdate,
  ): void;

  getBusyOverlayCalendar(accountId: string): string | null;

  storeBusyOverlayCalendar(
    accountId: string,
    providerCalendarId: string,
  ): void;
}

/** A row from the event_mirrors table. */
export interface MirrorRow {
  canonical_event_id: string;
  target_account_id: string;
  target_calendar_id: string;
  provider_event_id: string | null;
  last_projected_hash: string | null;
  last_write_ts: string | null;
  state: string;
  error_message: string | null;
}

/** Fields that can be updated on a mirror row. */
export interface MirrorUpdate {
  provider_event_id?: string;
  last_projected_hash?: string;
  last_write_ts?: string;
  state: MirrorState;
  error_message?: string | null;
  target_calendar_id?: string;
}

/** Interface for obtaining access tokens from AccountDO. */
export interface TokenProvider {
  getAccessToken(accountId: string): Promise<string>;
}

/** Result of processing a single message. */
export interface ProcessResult {
  readonly success: boolean;
  readonly action: "created" | "updated" | "deleted" | "skipped" | "error";
  readonly error?: string;
  /** Whether the message should be retried. */
  readonly retry: boolean;
}

// ---------------------------------------------------------------------------
// Error classification and retry strategy
// ---------------------------------------------------------------------------

interface RetryStrategy {
  readonly shouldRetry: boolean;
  readonly maxRetries: number;
}

/**
 * Classify a provider API error into a retry strategy.
 *
 * Handles both Google and Microsoft error types uniformly:
 *
 * | Error               | Strategy              | Max Retries |
 * |---------------------|-----------------------|-------------|
 * | 429 (rate limit)    | Exponential backoff   | 5           |
 * | 500/503 (server)    | Backoff               | 3           |
 * | 401 (token expired) | Refresh token, retry  | 1           |
 * | 403 (forbidden)     | Mark ERROR, no retry  | 0           |
 * | Other 4xx           | Mark ERROR, no retry  | 0           |
 */
function classifyError(err: unknown): RetryStrategy {
  // Google rate limit
  if (err instanceof RateLimitError) {
    return { shouldRetry: true, maxRetries: 5 };
  }
  // Microsoft rate limit
  if (err instanceof MicrosoftRateLimitError) {
    return { shouldRetry: true, maxRetries: 5 };
  }
  // Google token expired
  if (err instanceof TokenExpiredError) {
    return { shouldRetry: true, maxRetries: 1 };
  }
  // Microsoft token expired
  if (err instanceof MicrosoftTokenExpiredError) {
    return { shouldRetry: true, maxRetries: 1 };
  }
  // Google API errors (by status code)
  if (err instanceof GoogleApiError) {
    if (err.statusCode === 500 || err.statusCode === 503) {
      return { shouldRetry: true, maxRetries: 3 };
    }
    if (err.statusCode === 403) {
      const msg = err.message.toLowerCase();
      if (
        msg.includes("rate limit") ||
        msg.includes("ratelimit") ||
        msg.includes("quota")
      ) {
        return { shouldRetry: true, maxRetries: 5 };
      }
      return { shouldRetry: false, maxRetries: 0 };
    }
    // Other 4xx errors: no retry
    return { shouldRetry: false, maxRetries: 0 };
  }
  // Microsoft API errors (by status code)
  if (err instanceof MicrosoftApiError) {
    if (err.statusCode === 500 || err.statusCode === 503) {
      return { shouldRetry: true, maxRetries: 3 };
    }
    if (err.statusCode === 403) {
      return { shouldRetry: false, maxRetries: 0 };
    }
    // Other 4xx errors (404, etc.): no retry
    return { shouldRetry: false, maxRetries: 0 };
  }
  if (err instanceof Error) {
    const message = err.message.toLowerCase();

    // AccountDO "no tokens stored" means the account was never initialized
    // or has been revoked. Retrying cannot recover this message.
    if (message.includes("no tokens stored")) {
      return { shouldRetry: false, maxRetries: 0 };
    }

    // OAuth refresh failures like invalid_grant require account relink.
    // Retrying only churns the queue and delays healthy account writes.
    if (message.includes("invalid_grant") || message.includes("token refresh failed (400)")) {
      return { shouldRetry: false, maxRetries: 0 };
    }
  }
  // Unknown errors: retry once
  return { shouldRetry: true, maxRetries: 1 };
}

function parseProjectedEventEndMs(message: UpsertMirrorMessage): number | null {
  const end = message.projected_payload?.end;
  if (!end) return null;

  const raw = end.dateTime ?? end.date;
  if (!raw) return null;

  // For all-day dates, interpret as midnight UTC for cutoff comparisons.
  const normalized = end.date ? `${raw}T00:00:00Z` : raw;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------
// WriteConsumer class
// ---------------------------------------------------------------------------

/**
 * Core write-consumer logic, designed for testability.
 *
 * Dependencies are injected:
 * - mirrorStore: reads/writes mirror state (backed by UserGraphDO's SQL)
 * - tokenProvider: gets access tokens (backed by AccountDO stubs)
 * - calendarClientFactory: creates CalendarProvider instances (for mocking)
 */
export class WriteConsumer {
  private readonly mirrorStore: MirrorStore;
  private readonly tokenProvider: TokenProvider;
  private readonly calendarClientFactory: (
    accessToken: string,
  ) => CalendarProvider;

  constructor(opts: {
    mirrorStore: MirrorStore;
    tokenProvider: TokenProvider;
    calendarClientFactory?: (accessToken: string) => CalendarProvider;
  }) {
    this.mirrorStore = opts.mirrorStore;
    this.tokenProvider = opts.tokenProvider;
    this.calendarClientFactory =
      opts.calendarClientFactory ??
      ((token: string) => new GoogleCalendarClient(token));
  }

  // -------------------------------------------------------------------------
  // Provider not-found helpers (self-healing upsert path)
  // -------------------------------------------------------------------------

  /**
   * Returns true when a provider error indicates a missing event/calendar.
   *
   * For UPSERT flows this should trigger self-healing:
   * - Missing event on PATCH => recreate via INSERT.
   * - Missing target calendar on INSERT => recreate busy overlay calendar + retry.
   */
  private isNotFoundError(err: unknown): boolean {
    return (
      err instanceof ResourceNotFoundError ||
      err instanceof SyncTokenExpiredError ||
      err instanceof MicrosoftResourceNotFoundError ||
      (err instanceof GoogleApiError &&
        (err.statusCode === 404 || err.statusCode === 410)) ||
      (err instanceof MicrosoftApiError && err.statusCode === 404)
    );
  }

  /**
   * Decode a provider event ID once when it appears to be URL-encoded.
   *
   * Some historical rows can carry encoded IDs (e.g. `%2F`), which would be
   * encoded again by provider clients and produce false 404s on delete.
   */
  private decodeProviderEventIdIfNeeded(providerEventId: string): string {
    if (!providerEventId.includes("%")) {
      return providerEventId;
    }
    try {
      const decoded = decodeURIComponent(providerEventId);
      return decoded.length > 0 ? decoded : providerEventId;
    } catch {
      return providerEventId;
    }
  }

  /**
   * Microsoft returns 400 "Id is malformed." when an event ID is double-encoded.
   */
  private isMalformedMicrosoftIdError(err: unknown): boolean {
    return (
      err instanceof MicrosoftApiError &&
      err.statusCode === 400 &&
      err.message.toLowerCase().includes("id is malformed")
    );
  }

  /**
   * Insert mirror event, recreating busy overlay calendar if needed.
   *
   * Calendar deletion/drift can happen outside T-Minus. A direct insert into a
   * stale calendar ID should not permanently break mirror convergence.
   */
  private async insertWithCalendarRecovery(
    client: CalendarProvider,
    msg: UpsertMirrorMessage,
    targetCalendarId: string,
  ): Promise<{ providerEventId: string; targetCalendarId: string }> {
    try {
      const providerEventId = await client.insertEvent(
        targetCalendarId,
        msg.projected_payload,
      );
      return { providerEventId, targetCalendarId };
    } catch (insertErr) {
      if (!this.isNotFoundError(insertErr)) {
        throw insertErr;
      }

      // Recover from missing/broken calendar by creating a fresh overlay and retrying once.
      const recoveredCalendarId = await client.insertCalendar(
        BUSY_OVERLAY_CALENDAR_NAME,
      );
      this.mirrorStore.storeBusyOverlayCalendar(
        msg.target_account_id,
        recoveredCalendarId,
      );
      const providerEventId = await client.insertEvent(
        recoveredCalendarId,
        msg.projected_payload,
      );
      return { providerEventId, targetCalendarId: recoveredCalendarId };
    }
  }

  // -------------------------------------------------------------------------
  // processMessage -- main entry point per message
  // -------------------------------------------------------------------------

  /**
   * Process a single write-queue message.
   * Returns a ProcessResult indicating what action was taken.
   */
  async processMessage(
    message: UpsertMirrorMessage | DeleteManagedMirrorMessage,
  ): Promise<ProcessResult> {
    switch (message.type) {
      case "UPSERT_MIRROR":
        return this.handleUpsert(message);
      case "DELETE_MANAGED_MIRROR":
        return this.handleDelete(message);
      default:
        return {
          success: false,
          action: "error",
          error: `Unknown message type: ${(message as { type: string }).type}`,
          retry: false,
        };
    }
  }

  // -------------------------------------------------------------------------
  // handleUpsert -- UPSERT_MIRROR processing
  // -------------------------------------------------------------------------

  private async handleUpsert(
    msg: UpsertMirrorMessage,
  ): Promise<ProcessResult> {
    // Step 1: Load the latest mirror row from UserGraphDO state.
    const mirror = this.mirrorStore.getMirror(
      msg.canonical_event_id,
      msg.target_account_id,
    );

    // Mirror row missing means this message is stale (event/policy edge removed)
    // or superseded. Never create provider-side ghosts from orphaned queue work.
    if (!mirror) {
      return {
        success: true,
        action: "skipped",
        retry: false,
      };
    }

    // Mirror is in a terminal or deletion-in-progress state. Do not upsert --
    // the delete lifecycle takes precedence over stale upsert queue messages.
    if (
      mirror.state === "DELETING" ||
      mirror.state === "DELETED" ||
      mirror.state === "TOMBSTONED"
    ) {
      return {
        success: true,
        action: "skipped",
        retry: false,
      };
    }

    // Optional for backward compatibility with older queue messages.
    const messageProjectedHash = msg.projected_hash ?? null;

    // If a newer projection hash is already recorded, this queue item is stale.
    // Skip to preserve "latest state wins" under out-of-order delivery.
    if (
      messageProjectedHash &&
      mirror.last_projected_hash &&
      mirror.last_projected_hash !== messageProjectedHash
    ) {
      return {
        success: true,
        action: "skipped",
        retry: false,
      };
    }

    // Idempotency: only skip when this message proves it already represents
    // the ACTIVE hash. For legacy messages without projected_hash, we process
    // them to avoid skipping needed writes.
    if (
      messageProjectedHash &&
      mirror.state === "ACTIVE" &&
      mirror.provider_event_id &&
      mirror.last_projected_hash === messageProjectedHash
    ) {
      return {
        success: true,
        action: "skipped",
        retry: false,
      };
    }

    // Historical backfill acceleration:
    // If the mirror already exists at the provider (provider_event_id present)
    // and this update is only about old history, converge state to ACTIVE
    // without issuing provider PATCH calls.
    const projectedEndMs = parseProjectedEventEndMs(msg);
    if (
      mirror.provider_event_id &&
      projectedEndMs !== null &&
      projectedEndMs < Date.now() - HISTORICAL_PATCH_SKIP_MS
    ) {
      const now = new Date().toISOString();
      this.mirrorStore.updateMirrorState(
        msg.canonical_event_id,
        msg.target_account_id,
        {
          last_write_ts: now,
          state: "ACTIVE",
          error_message: null,
          ...(messageProjectedHash
            ? { last_projected_hash: messageProjectedHash }
            : {}),
        },
      );

      return { success: true, action: "skipped", retry: false };
    }

    try {
      // Step 2: Get access token for target account
      const accessToken = await this.tokenProvider.getAccessToken(
        msg.target_account_id,
      );
      const client = this.calendarClientFactory(accessToken);

      // Step 3: Resolve the target calendar
      // Use string for targetCalendarId since it may be reassigned to a
      // Google API result (which returns plain strings, not branded CalendarId)
      let targetCalendarId: string = msg.target_calendar_id as string;

      // Check if this is a placeholder calendar ID (same as account_id).
      // UserGraphDO uses to_account_id as default target_calendar_id when
      // the actual busy overlay calendar hasn't been created yet.
      if (targetCalendarId === (msg.target_account_id as string)) {
        const existingCalId = this.mirrorStore.getBusyOverlayCalendar(
          msg.target_account_id,
        );
        if (existingCalId) {
          targetCalendarId = existingCalId;
        } else {
          // Auto-create busy overlay calendar
          const newCalId = await client.insertCalendar(
            BUSY_OVERLAY_CALENDAR_NAME,
          );
          this.mirrorStore.storeBusyOverlayCalendar(
            msg.target_account_id,
            newCalId,
          );
          targetCalendarId = newCalId;
        }
      }

      // Step 4: Create or patch the event
      if (mirror?.provider_event_id) {
        // PATCH existing event.
        // If provider says the event no longer exists, recreate it via INSERT.
        try {
          await client.patchEvent(
            targetCalendarId,
            mirror.provider_event_id,
            msg.projected_payload,
          );
        } catch (patchErr) {
          if (!this.isNotFoundError(patchErr)) {
            throw patchErr;
          }

          const recreated = await this.insertWithCalendarRecovery(
            client,
            msg,
            targetCalendarId,
          );
          targetCalendarId = recreated.targetCalendarId;

          const now = new Date().toISOString();
          this.mirrorStore.updateMirrorState(
            msg.canonical_event_id,
            msg.target_account_id,
            {
              provider_event_id: recreated.providerEventId,
              last_write_ts: now,
              state: "ACTIVE",
              error_message: null,
              target_calendar_id: targetCalendarId,
              ...(messageProjectedHash
                ? { last_projected_hash: messageProjectedHash }
                : {}),
            },
          );

          return { success: true, action: "created", retry: false };
        }

        const now = new Date().toISOString();
        this.mirrorStore.updateMirrorState(
          msg.canonical_event_id,
          msg.target_account_id,
          {
            last_write_ts: now,
            state: "ACTIVE",
            error_message: null,
            target_calendar_id: targetCalendarId,
            ...(messageProjectedHash
              ? { last_projected_hash: messageProjectedHash }
              : {}),
          },
        );

        return { success: true, action: "updated", retry: false };
      } else {
        // INSERT new event
        const inserted = await this.insertWithCalendarRecovery(
          client,
          msg,
          targetCalendarId,
        );
        targetCalendarId = inserted.targetCalendarId;

        const now = new Date().toISOString();
        this.mirrorStore.updateMirrorState(
          msg.canonical_event_id,
          msg.target_account_id,
          {
            provider_event_id: inserted.providerEventId,
            last_write_ts: now,
            state: "ACTIVE",
            error_message: null,
            target_calendar_id: targetCalendarId,
            ...(messageProjectedHash
              ? { last_projected_hash: messageProjectedHash }
              : {}),
          },
        );

        return { success: true, action: "created", retry: false };
      }
    } catch (err) {
      return this.handleError(
        err,
        msg.canonical_event_id,
        msg.target_account_id,
      );
    }
  }

  // -------------------------------------------------------------------------
  // handleDelete -- DELETE_MANAGED_MIRROR processing
  // -------------------------------------------------------------------------

  private async handleDelete(msg: DeleteManagedMirrorMessage): Promise<ProcessResult> {
    // If no provider_event_id, there is nothing to delete at the provider.
    // Transition directly to DELETED (no provider-side work needed).
    if (!msg.provider_event_id) {
      this.mirrorStore.updateMirrorState(
        msg.canonical_event_id,
        msg.target_account_id,
        {
          state: "DELETED",
          error_message: null,
        },
      );
      return { success: true, action: "deleted", retry: false };
    }

    // State machine step 1: Mark as DELETING before attempting provider deletion.
    // This ensures the mirror row survives until provider-side deletion is confirmed.
    this.mirrorStore.updateMirrorState(
      msg.canonical_event_id,
      msg.target_account_id,
      {
        state: "DELETING",
        error_message: null,
      },
    );

    try {
      const accessToken = await this.tokenProvider.getAccessToken(
        msg.target_account_id,
      );
      const client = this.calendarClientFactory(accessToken);

      // Look up the mirror to get the target calendar ID
      const mirror = this.mirrorStore.getMirror(
        msg.canonical_event_id,
        msg.target_account_id,
      );
      const calendarId =
        msg.target_calendar_id ??
        mirror?.target_calendar_id ??
        "primary";
      const fallbackEventId = this.decodeProviderEventIdIfNeeded(
        msg.provider_event_id,
      );
      let deletedAtProvider = false;

      // SAFETY: Pre-flight ownership verification (TM-h9ih).
      // Before deleting, fetch the event and verify T-Minus owns it.
      // This prevents deleting events outside the federation graph.
      const eventIdToVerify = msg.provider_event_id;
      try {
        const existing = await client.getEvent(calendarId, eventIdToVerify);
        if (existing) {
          // Check Google markers (extendedProperties.private)
          const gProps = existing.extendedProperties?.private;
          const isGoogleManaged =
            gProps?.["tminus"] === "true" && gProps?.["managed"] === "true";
          // Check Microsoft markers (extensions array or categories)
          const msExt = (existing as Record<string, unknown>)["extensions"] as
            | Array<{ extensionName?: string; tminus?: string; managed?: string }>
            | undefined;
          const tminusExt = msExt?.find(
            (e) => e.extensionName === "com.tminus.metadata",
          );
          const isMsManaged =
            (tminusExt?.tminus === "true" && tminusExt?.managed === "true") ||
            (
              Array.isArray(
                (existing as Record<string, unknown>)["categories"],
              ) &&
              (
                (existing as Record<string, unknown>)["categories"] as string[]
              ).includes("T-Minus Managed")
            );
          if (!isGoogleManaged && !isMsManaged) {
            console.error(
              "write-consumer: BLOCKED delete -- event is NOT a T-Minus managed mirror",
              {
                canonical_event_id: msg.canonical_event_id,
                target_account_id: msg.target_account_id,
                provider_event_id: msg.provider_event_id,
                calendar_id: calendarId,
                has_ext_props: !!gProps,
                has_ms_extensions: !!msExt,
              },
            );
            // Do NOT delete. Mark mirror as DELETED to prevent retry loops.
            this.mirrorStore.updateMirrorState(
              msg.canonical_event_id,
              msg.target_account_id,
              {
                state: "DELETED",
                error_message: "blocked: event not owned by tminus",
              },
            );
            return { success: true, action: "deleted", retry: false };
          }
        }
        // If existing is null, the event is already gone -- proceed to delete
        // attempt which will naturally 404 and be handled below.
      } catch (verifyErr) {
        // If pre-flight fetch fails (rate limit, auth, etc.), do NOT proceed
        // with a blind delete. Let the message retry later.
        console.error(
          "write-consumer: pre-flight ownership check failed, will retry",
          {
            canonical_event_id: msg.canonical_event_id,
            provider_event_id: msg.provider_event_id,
            error: verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
          },
        );
        throw verifyErr;
      }

      try {
        await client.deleteEvent(calendarId, msg.provider_event_id);
        deletedAtProvider = true;
      } catch (err) {
        // Retry once with a decoded ID to handle historical encoded IDs.
        if (
          fallbackEventId !== msg.provider_event_id &&
          (this.isNotFoundError(err) || this.isMalformedMicrosoftIdError(err))
        ) {
          try {
            await client.deleteEvent(calendarId, fallbackEventId);
            deletedAtProvider = true;
          } catch (retryErr) {
            if (
              !this.isNotFoundError(retryErr) &&
              !this.isMalformedMicrosoftIdError(retryErr)
            ) {
              throw retryErr;
            }
            err = retryErr;
          }
        }

        if (!deletedAtProvider) {
          // For DELETE operations, 404 and 410 mean the event is already gone.
          // That's success -- the desired end state (event removed) is achieved.
          //
          // Google Calendar API returns:
          //   404 -> ResourceNotFoundError (event never existed or long-deleted)
          //   410 -> SyncTokenExpiredError (event recently deleted, "Gone")
          //
          // Microsoft Graph API returns:
          //   404 -> MicrosoftResourceNotFoundError
          //
          // Defense in depth: also check generic GoogleApiError/MicrosoftApiError
          // with statusCode 404 or 410, in case the error is not the specific subclass.
          const isAlreadyGone =
            err instanceof ResourceNotFoundError ||
            err instanceof SyncTokenExpiredError ||
            err instanceof MicrosoftResourceNotFoundError ||
            (err instanceof GoogleApiError &&
              (err.statusCode === 404 || err.statusCode === 410)) ||
            (err instanceof MicrosoftApiError && err.statusCode === 404);
          if (!isAlreadyGone) {
            throw err;
          }
          // Origin-provider deletes do not always have a mirror row. Log this
          // case to avoid silent false-success when provider IDs drift.
          if (!mirror) {
            console.warn(
              "write-consumer: provider event not found during delete with no mirror row",
              {
                canonical_event_id: msg.canonical_event_id,
                target_account_id: msg.target_account_id,
                target_calendar_id: calendarId,
                provider_event_id: msg.provider_event_id,
                decoded_provider_event_id:
                  fallbackEventId !== msg.provider_event_id
                    ? fallbackEventId
                    : undefined,
              },
            );
          }
          // Event already deleted, proceed to update mirror state
        }
      }

      // State machine step 2: Provider-side deletion confirmed -> DELETED
      this.mirrorStore.updateMirrorState(
        msg.canonical_event_id,
        msg.target_account_id,
        {
          state: "DELETED",
          error_message: null,
        },
      );

      return { success: true, action: "deleted", retry: false };
    } catch (err) {
      return this.handleError(
        err,
        msg.canonical_event_id,
        msg.target_account_id,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  private handleError(
    err: unknown,
    canonicalEventId: string,
    targetAccountId: string,
  ): ProcessResult {
    const strategy = classifyError(err);
    const errorMessage =
      err instanceof Error ? err.message : String(err);

    if (!strategy.shouldRetry) {
      // Permanent failure: mark mirror as ERROR
      this.mirrorStore.updateMirrorState(canonicalEventId, targetAccountId, {
        state: "ERROR",
        error_message: errorMessage,
      });
      return {
        success: false,
        action: "error",
        error: errorMessage,
        retry: false,
      };
    }

    // Transient failure: signal for retry
    // The Cloudflare queue retry mechanism handles actual retries.
    // We do NOT mark as ERROR here -- leave state as PENDING so the
    // next attempt can proceed. After max_retries are exhausted by
    // the queue runtime, the message goes to DLQ.
    return {
      success: false,
      action: "error",
      error: errorMessage,
      retry: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Export classifyError for unit testing
// ---------------------------------------------------------------------------

export { classifyError };
