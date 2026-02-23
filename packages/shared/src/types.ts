/**
 * @tminus/shared -- Domain types for the T-Minus calendar federation engine.
 *
 * Branded ID types use intersection with a phantom brand field to prevent
 * accidental mixing of different ID kinds at the type level.
 */

// ---------------------------------------------------------------------------
// Branded ID types
// ---------------------------------------------------------------------------

/** Branded string type helper. Prevents mixing different ID kinds. */
type Brand<T extends string> = string & { readonly __brand: T };

/** Unique identifier for a user (prefix: usr_) */
export type UserId = Brand<"UserId">;

/** Unique identifier for a linked calendar account (prefix: acc_) */
export type AccountId = Brand<"AccountId">;

/** Unique identifier for a canonical event (prefix: evt_) */
export type EventId = Brand<"EventId">;

/** Unique identifier for a policy (prefix: pol_) */
export type PolicyId = Brand<"PolicyId">;

/** Unique identifier for a calendar (prefix: cal_) */
export type CalendarId = Brand<"CalendarId">;

/** Unique identifier for a journal entry (prefix: jrn_) */
export type JournalId = Brand<"JournalId">;

// ---------------------------------------------------------------------------
// Union / enum-like types
// ---------------------------------------------------------------------------

/** How much detail a policy edge projects. */
export type DetailLevel = "BUSY" | "TITLE" | "FULL";

/** The kind of calendar created for mirroring. */
export type CalendarKind = "BUSY_OVERLAY" | "TRUE_MIRROR";

/**
 * State of a mirror entry in event_mirrors.
 *
 * Lifecycle state machine:
 *   PENDING -> ACTIVE      (write-consumer confirms provider-side creation)
 *   ACTIVE  -> DELETING    (UserGraphDO marks mirror for deletion, enqueues DELETE_MIRROR)
 *   DELETING -> DELETED    (write-consumer confirms provider-side deletion)
 *   DELETED -> TOMBSTONED  (GC/cleanup process marks for eventual hard-delete)
 *   *       -> ERROR       (any unrecoverable provider error)
 */
export type MirrorState =
  | "PENDING"
  | "ACTIVE"
  | "DELETING"
  | "DELETED"
  | "TOMBSTONED"
  | "ERROR";

// ---------------------------------------------------------------------------
// Google Calendar API types (provider-level, pre-classification)
// ---------------------------------------------------------------------------

/**
 * Represents a raw event from the Google Calendar API.
 * This is the shape we receive from the provider before classification
 * or canonicalization. Used by classifyEvent() (Invariant A).
 */
export interface GoogleCalendarEvent {
  /** Provider-assigned event ID. */
  readonly id?: string;
  /** Event title / summary. */
  readonly summary?: string;
  /** Event description / notes. */
  readonly description?: string;
  /** Event location (free-form text or address). */
  readonly location?: string;
  /** Start time of the event. */
  readonly start?: EventDateTime;
  /** End time of the event. */
  readonly end?: EventDateTime;
  /**
   * Event status from Google Calendar API.
   * 'confirmed' | 'tentative' | 'cancelled'.
   * 'cancelled' indicates the event was deleted.
   */
  readonly status?: string;
  /**
   * Event visibility: 'default' | 'public' | 'private' | 'confidential'.
   * Controls who can see event details.
   */
  readonly visibility?: string;
  /**
   * Event transparency: 'opaque' | 'transparent'.
   * Controls whether the event blocks time on the calendar.
   */
  readonly transparency?: string;
  /**
   * Recurrence rules (RRULE, EXRULE, RDATE, EXDATE) as an array of strings.
   * Only present on the recurring event definition (not individual instances).
   * Example: ["RRULE:FREQ=WEEKLY;BYDAY=MO"]
   */
  readonly recurrence?: readonly string[];
  /** Extended properties set by applications (including T-Minus). */
  readonly extendedProperties?: {
    readonly private?: Record<string, string>;
    readonly shared?: Record<string, string>;
  };
}

/**
 * Classification of a provider event (Invariant A).
 *
 * - 'origin': A real user-created event that T-Minus should track.
 * - 'managed_mirror': A mirror event created by T-Minus (tminus='true' AND managed='true').
 *    Must NEVER be treated as a new origin (Invariant E / Risk R1 loop prevention).
 * - 'foreign_managed': Created by another system. Currently treated as origin,
 *    but the type exists for future differentiation.
 */
export type EventClassification = "origin" | "managed_mirror" | "foreign_managed";

// ---------------------------------------------------------------------------
// Core domain objects
// ---------------------------------------------------------------------------

/**
 * ISO 8601 datetime or date for Google Calendar API.
 * Timed events use dateTime + optional timeZone.
 * All-day events use date only.
 */
export interface EventDateTime {
  /** ISO 8601 datetime (e.g. "2025-06-15T09:00:00Z"). Present for timed events. */
  readonly dateTime?: string;
  /** YYYY-MM-DD date string. Present for all-day events. */
  readonly date?: string;
  /** IANA timezone (e.g. "America/Chicago"). Undefined for UTC or all-day. */
  readonly timeZone?: string;
}

/**
 * The canonical event -- single source of truth for a calendar event.
 * Derived from the canonical_events SQL schema in PLAN.md.
 */
export interface CanonicalEvent {
  readonly canonical_event_id: EventId;
  readonly origin_account_id: AccountId;
  /** Provider calendar ID where the origin event currently lives. */
  readonly origin_calendar_id?: string;
  /** Provider-specific event ID from the origin account. */
  readonly origin_event_id: string;
  readonly title?: string;
  readonly description?: string;
  readonly location?: string;
  readonly start: EventDateTime;
  readonly end: EventDateTime;
  readonly all_day: boolean;
  readonly status: "confirmed" | "tentative" | "cancelled";
  readonly visibility: "default" | "public" | "private" | "confidential";
  readonly transparency: "opaque" | "transparent";
  readonly recurrence_rule?: string;
  /** How the event entered the system. */
  readonly source: "provider" | "ui" | "mcp" | "system" | "ics_feed";
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
  /**
   * Per-field authority tracking. Maps field names to authority strings
   * ("provider:<account_id>" or "tminus"). Empty or absent for legacy events.
   * Added by TM-teqr for authority visibility.
   */
  readonly authority_markers?: Record<string, string>;
}

/**
 * A projected event payload, created by applying a policy's detail_level
 * to a CanonicalEvent. This is the Google Calendar API shape written to
 * mirror calendars.
 */
export interface ProjectedEvent {
  readonly summary: string;
  readonly description?: string;
  readonly location?: string;
  readonly start: EventDateTime;
  readonly end: EventDateTime;
  readonly transparency: "opaque" | "transparent";
  readonly visibility: "default" | "private";
  readonly extendedProperties: {
    readonly private: {
      readonly tminus: "true";
      readonly managed: "true";
      readonly canonical_event_id: string;
      readonly origin_account_id: string;
    };
  };
}

/**
 * A directional policy edge controlling how events project
 * from one account to another.
 */
export interface PolicyEdge {
  readonly detail_level: DetailLevel;
  readonly calendar_kind: CalendarKind;
}

/**
 * A normalized delta from a provider (Google Calendar, etc.).
 * Represents one create, update, or delete that sync-consumer produces.
 */
export interface ProviderDelta {
  readonly type: "created" | "updated" | "deleted";
  readonly origin_event_id: string;
  readonly origin_account_id: AccountId;
  /** Provider calendar ID for the source event when known. */
  readonly origin_calendar_id?: string;
  /** Full event payload. Present for created/updated, absent for deleted. */
  readonly event?: Omit<
    CanonicalEvent,
    "canonical_event_id" | "version" | "created_at" | "updated_at" | "source"
  >;
}

// ---------------------------------------------------------------------------
// Queue message types
// ---------------------------------------------------------------------------

/** Webhook-triggered incremental sync (sync-queue). */
export interface SyncIncrementalMessage {
  readonly type: "SYNC_INCREMENTAL";
  readonly account_id: AccountId;
  readonly channel_id: string;
  readonly resource_id: string;
  readonly ping_ts: string;
  /**
   * The specific calendar this notification pertains to.
   * Null when the webhook channel/subscription predates per-scope routing
   * or when the scope could not be resolved (telemetry emitted in that case).
   */
  readonly calendar_id: string | null;
  /** Microsoft Graph change type from the webhook notification (e.g., "deleted", "updated", "created"). */
  readonly webhook_change_type?: string;
  /**
   * Microsoft Graph resourceData.id from the webhook notification.
   * Present when provided by Graph and used as the most reliable event-id
   * hint for delete notifications (resource path can vary in shape/encoding).
   */
  readonly webhook_resource_data_id?: string;
}

/** Full sync request -- onboarding, reconcile, or 410 recovery (sync-queue). */
export interface SyncFullMessage {
  readonly type: "SYNC_FULL";
  readonly account_id: AccountId;
  readonly reason: "onboarding" | "reconcile" | "token_410";
}

/** Request to create or update a mirror event (write-queue). */
export interface UpsertMirrorMessage {
  readonly type: "UPSERT_MIRROR";
  readonly canonical_event_id: EventId;
  readonly target_account_id: AccountId;
  readonly target_calendar_id: CalendarId;
  /**
   * Projection hash used to detect stale/out-of-order queue messages.
   * Optional for backward compatibility with older enqueued messages.
   */
  readonly projected_hash?: string;
  readonly projected_payload: ProjectedEvent;
  readonly idempotency_key: string;
}

/** Request to delete a mirror event (write-queue). */
export interface DeleteMirrorMessage {
  readonly type: "DELETE_MIRROR";
  readonly canonical_event_id: EventId;
  readonly target_account_id: AccountId;
  /**
   * Target calendar the provider event lives in.
   * Optional for backward compatibility with older enqueued messages.
   */
  readonly target_calendar_id?: CalendarId;
  readonly provider_event_id: string;
  readonly idempotency_key: string;
}

/** Reason codes for reconciliation triggers. */
export type ReconcileReasonCode = "scheduled" | "manual" | "drift_detected";

/** Request to reconcile a specific account (reconcile-queue). */
export interface ReconcileAccountMessage {
  readonly type: "RECONCILE_ACCOUNT";
  readonly account_id: AccountId;
  readonly reason: ReconcileReasonCode;
  /**
   * Optional: restrict reconciliation to a single calendar scope.
   * When null/undefined, reconcile iterates all scoped calendars.
   */
  readonly scope?: string | null;
}

// ---------------------------------------------------------------------------
// Result / response types
// ---------------------------------------------------------------------------

/** Result of applying provider deltas to the canonical store. */
export interface ApplyResult {
  readonly created: number;
  readonly updated: number;
  readonly deleted: number;
  readonly mirrors_enqueued: number;
  readonly errors: ReadonlyArray<{
    readonly origin_event_id: string;
    readonly error: string;
  }>;
}

/** Health status for a linked account. */
export interface AccountHealth {
  readonly account_id: AccountId;
  readonly status: "healthy" | "degraded" | "error" | "disconnected";
  readonly last_sync_ts: string | null;
  readonly last_success_ts: string | null;
  readonly error_message: string | null;
  readonly watch_channel_active: boolean;
  readonly token_valid: boolean;
}

/**
 * Discriminated union for API responses.
 * Consumers narrow via `if (resp.ok)` or `if (!resp.ok)`.
 */
export type ApiResponse<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string; readonly code?: number };
