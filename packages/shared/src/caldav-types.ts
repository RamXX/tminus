/**
 * @tminus/shared -- CalDAV protocol types and Zod schemas.
 *
 * Defines all types used by the CalDAV client for Apple iCloud Calendar
 * integration. Zod schemas provide runtime validation for deserialized
 * data per learnings from Phase 5C: any type persisted in AccountDO
 * must have symmetric encode/decode validated by Zod.
 *
 * References:
 * - RFC 4791 (CalDAV)
 * - RFC 5545 (iCalendar)
 * - Apple iCloud CalDAV: https://caldav.icloud.com
 */

// ---------------------------------------------------------------------------
// CalDAV credential types
// ---------------------------------------------------------------------------

/**
 * CalDAV credential payload stored in AccountDO's auth table.
 *
 * Apple iCloud Calendar uses app-specific passwords with HTTP Basic Auth.
 * The apple_id + app_specific_password are encrypted with AES-256-GCM
 * per AD-2 (same envelope encryption as OAuth tokens).
 *
 * Per learnings: using undefined (not false) for optional fields.
 */
export interface CalDavCredentials {
  /** Apple ID (email) used for authentication. */
  readonly apple_id: string;
  /** App-specific password generated at appleid.apple.com. */
  readonly app_specific_password: string;
  /** CalDAV principal URL discovered via PROPFIND. */
  readonly principal_url?: string;
  /** Calendar home set URL discovered via PROPFIND. */
  readonly calendar_home_url?: string;
}

// ---------------------------------------------------------------------------
// CalDAV calendar types
// ---------------------------------------------------------------------------

/**
 * A calendar discovered via CalDAV PROPFIND.
 */
export interface CalDavCalendar {
  /** The calendar's URL path on the CalDAV server. */
  readonly href: string;
  /** Display name of the calendar. */
  readonly displayName: string;
  /** Calendar color (hex). */
  readonly color?: string;
  /** ctag for change detection. Changes when any event in the calendar changes. */
  readonly ctag: string;
  /** Whether this is the default calendar. */
  readonly isDefault?: boolean;
}

/**
 * Per-calendar sync state stored in AccountDO.
 * ctag changes when any event in the calendar changes.
 */
export interface CalDavCalendarSyncState {
  /** Calendar URL path. */
  readonly href: string;
  /** Last known ctag for this calendar. */
  readonly ctag: string;
  /** Map of event URL -> etag for change detection. */
  readonly etags: Record<string, string>;
}

// ---------------------------------------------------------------------------
// CalDAV event types
// ---------------------------------------------------------------------------

/**
 * A raw CalDAV event (iCalendar VEVENT data + metadata).
 */
export interface CalDavEvent {
  /** Event URL path on the CalDAV server. */
  readonly href: string;
  /** ETag for conflict detection. */
  readonly etag: string;
  /** Raw iCalendar data (VCALENDAR containing VEVENT). */
  readonly icalData: string;
}

/**
 * Parsed VEVENT properties extracted from iCalendar data.
 * This is the intermediate representation between raw iCal text
 * and CanonicalEvent.
 */
export interface ParsedVEvent {
  /** UID from the VEVENT. */
  readonly uid: string;
  /** SUMMARY (event title). */
  readonly summary?: string;
  /** DESCRIPTION. */
  readonly description?: string;
  /** LOCATION. */
  readonly location?: string;
  /** DTSTART value. */
  readonly dtstart: string;
  /** DTSTART parameters (e.g., VALUE=DATE, TZID=...). */
  readonly dtstartParams?: Record<string, string>;
  /** DTEND value. */
  readonly dtend?: string;
  /** DTEND parameters. */
  readonly dtendParams?: Record<string, string>;
  /** STATUS (CONFIRMED, TENTATIVE, CANCELLED). */
  readonly status?: string;
  /** TRANSP (OPAQUE, TRANSPARENT). */
  readonly transp?: string;
  /** RRULE recurrence rule. */
  readonly rrule?: string;
  /** ATTENDEE list. */
  readonly attendees?: readonly string[];
  /** CLASS (PUBLIC, PRIVATE, CONFIDENTIAL). */
  readonly class?: string;
  /** DTSTAMP. */
  readonly dtstamp?: string;
  /** LAST-MODIFIED. */
  readonly lastModified?: string;
  /** X-TMINUS-MANAGED custom property for loop prevention. */
  readonly xTminusManaged?: string;
  /** X-TMINUS-CANONICAL-ID custom property. */
  readonly xTminusCanonicalId?: string;
}

// ---------------------------------------------------------------------------
// CalDAV client configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the CalDAV client.
 */
export interface CalDavClientConfig {
  /** CalDAV server base URL. Default: https://caldav.icloud.com */
  readonly serverUrl?: string;
  /** Apple ID for authentication. */
  readonly appleId: string;
  /** App-specific password for authentication. */
  readonly appSpecificPassword: string;
}

// ---------------------------------------------------------------------------
// CalDAV operation results
// ---------------------------------------------------------------------------

/**
 * Result of a CalDAV write operation (PUT or DELETE).
 */
export interface CalDavWriteResult {
  /** Whether the operation succeeded. */
  readonly ok: boolean;
  /** New etag after PUT (undefined for DELETE). */
  readonly etag?: string;
  /** Error message if not ok. */
  readonly error?: string;
}
