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
 * - DELETE_MIRROR: Remove mirror events from target calendars
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
  DeleteMirrorMessage,
  MirrorState,
  CalendarProvider,
  FetchFn,
} from "@tminus/shared";

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
  // processMessage -- main entry point per message
  // -------------------------------------------------------------------------

  /**
   * Process a single write-queue message.
   * Returns a ProcessResult indicating what action was taken.
   */
  async processMessage(
    message: UpsertMirrorMessage | DeleteMirrorMessage,
  ): Promise<ProcessResult> {
    switch (message.type) {
      case "UPSERT_MIRROR":
        return this.handleUpsert(message);
      case "DELETE_MIRROR":
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
    // Step 1: Idempotency check (Invariant D)
    // Check if the mirror's last_projected_hash already matches
    const mirror = this.mirrorStore.getMirror(
      msg.canonical_event_id,
      msg.target_account_id,
    );

    if (mirror && mirror.state === "ACTIVE" && mirror.provider_event_id) {
      // Idempotency: this mirror was already successfully written.
      // The message was enqueued because the hash differed at enqueue time,
      // but a previous delivery attempt already completed the write and set
      // state=ACTIVE. On retry, we skip to avoid duplicate writes.
      return {
        success: true,
        action: "skipped",
        retry: false,
      };
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
        // PATCH existing event
        await client.patchEvent(
          targetCalendarId,
          mirror.provider_event_id,
          msg.projected_payload,
        );

        const now = new Date().toISOString();
        this.mirrorStore.updateMirrorState(
          msg.canonical_event_id,
          msg.target_account_id,
          {
            last_write_ts: now,
            state: "ACTIVE",
            error_message: null,
            target_calendar_id: targetCalendarId,
          },
        );

        return { success: true, action: "updated", retry: false };
      } else {
        // INSERT new event
        const providerEventId = await client.insertEvent(
          targetCalendarId,
          msg.projected_payload,
        );

        const now = new Date().toISOString();
        this.mirrorStore.updateMirrorState(
          msg.canonical_event_id,
          msg.target_account_id,
          {
            provider_event_id: providerEventId,
            last_write_ts: now,
            state: "ACTIVE",
            error_message: null,
            target_calendar_id: targetCalendarId,
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
  // handleDelete -- DELETE_MIRROR processing
  // -------------------------------------------------------------------------

  private async handleDelete(msg: DeleteMirrorMessage): Promise<ProcessResult> {
    // If no provider_event_id, there is nothing to delete at the provider
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
      const calendarId = mirror?.target_calendar_id ?? "primary";

      try {
        await client.deleteEvent(calendarId, msg.provider_event_id);
      } catch (err) {
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
        // Event already deleted, proceed to update mirror state
      }

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
