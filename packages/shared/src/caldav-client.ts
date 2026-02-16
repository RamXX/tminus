/**
 * @tminus/shared -- CalDAV client for Apple iCloud Calendar.
 *
 * Implements the CalDAV protocol (RFC 4791) over HTTPS to communicate
 * with Apple's caldav.icloud.com server. Uses HTTP Basic Auth with
 * app-specific passwords.
 *
 * Provides:
 * - Calendar discovery via PROPFIND
 * - Event retrieval via REPORT (calendar-query, calendar-multiget)
 * - Event mutation via PUT/DELETE
 * - Incremental sync via ctag/etag change detection
 *
 * Accepts injectable FetchFn for testability (same pattern as
 * GoogleCalendarClient and MicrosoftCalendarClient).
 */

import type { FetchFn, ListEventsResponse, CalendarListEntry, WatchResponse } from "./google-api";
import type { CalendarProvider } from "./google-api";
import type { ProjectedEvent } from "./types";
import type {
  CalDavCalendar,
  CalDavEvent,
  CalDavClientConfig,
  CalDavWriteResult,
  CalDavCalendarSyncState,
} from "./caldav-types";
import {
  buildPrincipalPropfind,
  buildCalendarHomePropfind,
  buildCalendarListPropfind,
  buildCalendarQuery,
  buildCalendarMultiget,
  buildEtagPropfind,
  parsePrincipalResponse,
  parseCalendarHomeResponse,
  parseCalendarListResponse,
  parseCalendarDataResponse,
  parseEtagResponse,
} from "./caldav-xml";
import { parseVEvents } from "./ical-parse";
import { buildVEvent, foldLine } from "./ical";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default Apple iCloud CalDAV server URL. */
const APPLE_CALDAV_BASE = "https://caldav.icloud.com";

/** CRLF line ending for iCalendar. */
const CRLF = "\r\n";

// ---------------------------------------------------------------------------
// Error types (parallel to Google and Microsoft error classes)
// ---------------------------------------------------------------------------

/** Base class for all CalDAV API errors. */
export class CalDavApiError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "CalDavApiError";
    this.statusCode = statusCode;
  }
}

/** 401 -- invalid credentials. */
export class CalDavAuthError extends CalDavApiError {
  constructor(message = "CalDAV authentication failed: invalid Apple ID or app-specific password") {
    super(message, 401);
    this.name = "CalDavAuthError";
  }
}

/** 404 -- resource not found. */
export class CalDavNotFoundError extends CalDavApiError {
  constructor(message = "CalDAV resource not found") {
    super(message, 404);
    this.name = "CalDavNotFoundError";
  }
}

/** 409 -- conflict (etag mismatch on write). */
export class CalDavConflictError extends CalDavApiError {
  constructor(message = "CalDAV conflict: event was modified since last read") {
    super(message, 409);
    this.name = "CalDavConflictError";
  }
}

// ---------------------------------------------------------------------------
// CalDAV Client
// ---------------------------------------------------------------------------

/**
 * CalDAV client for Apple iCloud Calendar.
 *
 * Implements CalendarProvider for uniform treatment by the sync engine.
 * Uses HTTP Basic Auth with Apple ID + app-specific password.
 *
 * Usage:
 *   const client = new CalDavClient({
 *     appleId: "user@icloud.com",
 *     appSpecificPassword: "xxxx-xxxx-xxxx-xxxx",
 *   });
 *   const calendars = await client.discoverCalendars();
 */
export class CalDavClient implements CalendarProvider {
  private readonly serverUrl: string;
  private readonly appleId: string;
  private readonly appSpecificPassword: string;
  private readonly fetchFn: FetchFn;

  /** Cached principal URL. */
  private principalUrl: string | null = null;
  /** Cached calendar home URL. */
  private calendarHomeUrl: string | null = null;

  constructor(config: CalDavClientConfig, fetchFn?: FetchFn) {
    this.serverUrl = config.serverUrl ?? APPLE_CALDAV_BASE;
    this.appleId = config.appleId;
    this.appSpecificPassword = config.appSpecificPassword;
    this.fetchFn = fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  // -----------------------------------------------------------------------
  // CalDAV-specific operations
  // -----------------------------------------------------------------------

  /**
   * Validate credentials by performing a PROPFIND on the server root.
   * Returns true if authentication succeeds, false otherwise.
   */
  async validateCredentials(): Promise<boolean> {
    try {
      await this.discoverPrincipal();
      return true;
    } catch (err) {
      if (err instanceof CalDavAuthError) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Discover the current user's principal URL via PROPFIND.
   */
  async discoverPrincipal(): Promise<string> {
    if (this.principalUrl) return this.principalUrl;

    const xml = buildPrincipalPropfind();
    const response = await this.propfind(this.serverUrl + "/", xml);
    const principal = parsePrincipalResponse(response);

    if (!principal) {
      throw new CalDavApiError("Failed to discover CalDAV principal URL", 500);
    }

    this.principalUrl = principal;
    return principal;
  }

  /**
   * Discover the calendar home set URL.
   */
  async discoverCalendarHome(): Promise<string> {
    if (this.calendarHomeUrl) return this.calendarHomeUrl;

    const principalUrl = await this.discoverPrincipal();
    const xml = buildCalendarHomePropfind();
    const fullUrl = this.resolveUrl(principalUrl);
    const response = await this.propfind(fullUrl, xml);
    const calHome = parseCalendarHomeResponse(response);

    if (!calHome) {
      throw new CalDavApiError("Failed to discover calendar home set", 500);
    }

    this.calendarHomeUrl = calHome;
    return calHome;
  }

  /**
   * Discover all calendars in the user's calendar home.
   */
  async discoverCalendars(): Promise<CalDavCalendar[]> {
    const calHome = await this.discoverCalendarHome();
    const xml = buildCalendarListPropfind();
    const fullUrl = this.resolveUrl(calHome);
    const response = await this.propfind(fullUrl, xml, 1);
    return parseCalendarListResponse(response);
  }

  /**
   * Fetch all events from a calendar via REPORT calendar-query.
   * Used for full sync.
   */
  async fetchAllEvents(calendarHref: string): Promise<CalDavEvent[]> {
    const xml = buildCalendarQuery();
    const fullUrl = this.resolveUrl(calendarHref);
    const response = await this.report(fullUrl, xml);
    return parseCalendarDataResponse(response);
  }

  /**
   * Fetch specific events by href via REPORT calendar-multiget.
   */
  async fetchEvents(
    calendarHref: string,
    eventHrefs: readonly string[],
  ): Promise<CalDavEvent[]> {
    if (eventHrefs.length === 0) return [];

    const xml = buildCalendarMultiget(eventHrefs);
    const fullUrl = this.resolveUrl(calendarHref);
    const response = await this.report(fullUrl, xml);
    return parseCalendarDataResponse(response);
  }

  /**
   * Get etags for all events in a calendar.
   * Used for incremental sync: compare against stored etags.
   */
  async getEventEtags(calendarHref: string): Promise<Record<string, string>> {
    const xml = buildEtagPropfind();
    const fullUrl = this.resolveUrl(calendarHref);
    const response = await this.propfind(fullUrl, xml, 1);
    return parseEtagResponse(response);
  }

  /**
   * Perform incremental sync for a calendar using ctag/etag comparison.
   *
   * Algorithm:
   * 1. Get current ctag for the calendar
   * 2. If ctag matches stored ctag, no changes -- return empty
   * 3. If ctag differs, fetch current etags for all events
   * 4. Compare with stored etags to find new/modified/deleted events
   * 5. Fetch full data for new/modified events
   * 6. Return new sync state + changed events
   */
  async incrementalSync(
    calendarHref: string,
    storedState: CalDavCalendarSyncState | null,
  ): Promise<{
    events: CalDavEvent[];
    deleted: string[];
    newState: CalDavCalendarSyncState;
  }> {
    // Get current calendar ctag
    const calendars = await this.discoverCalendars();
    const calendar = calendars.find((c) => c.href === calendarHref);
    if (!calendar) {
      throw new CalDavNotFoundError(`Calendar not found: ${calendarHref}`);
    }

    // If ctag matches, nothing changed
    if (storedState && storedState.ctag === calendar.ctag) {
      return {
        events: [],
        deleted: [],
        newState: storedState,
      };
    }

    // Get current etags
    const currentEtags = await this.getEventEtags(calendarHref);

    const storedEtags = storedState?.etags ?? {};

    // Find new/modified events (href present with different etag)
    const changedHrefs: string[] = [];
    for (const [href, etag] of Object.entries(currentEtags)) {
      if (storedEtags[href] !== etag) {
        changedHrefs.push(href);
      }
    }

    // Find deleted events (href in stored but not in current)
    const deleted: string[] = [];
    for (const href of Object.keys(storedEtags)) {
      if (!(href in currentEtags)) {
        deleted.push(href);
      }
    }

    // Fetch full data for changed events
    const events =
      changedHrefs.length > 0
        ? await this.fetchEvents(calendarHref, changedHrefs)
        : [];

    return {
      events,
      deleted,
      newState: {
        href: calendarHref,
        ctag: calendar.ctag,
        etags: currentEtags,
      },
    };
  }

  /**
   * Create or update an event via PUT.
   *
   * @param calendarHref - Calendar URL path
   * @param eventUid - UID for the event
   * @param icalData - Full iCalendar data
   * @param etag - If provided, used as If-Match for conflict detection
   * @returns Write result with new etag
   */
  async putEvent(
    calendarHref: string,
    eventUid: string,
    icalData: string,
    etag?: string,
  ): Promise<CalDavWriteResult> {
    const eventUrl = this.resolveUrl(
      `${calendarHref}${eventUid}.ics`,
    );

    const headers: Record<string, string> = {
      "Content-Type": "text/calendar; charset=utf-8",
    };

    if (etag) {
      headers["If-Match"] = `"${etag}"`;
    } else {
      headers["If-None-Match"] = "*";
    }

    try {
      const response = await this.request(eventUrl, {
        method: "PUT",
        headers,
        body: icalData,
      });

      const newEtag =
        response.headers.get("ETag")?.replace(/"/g, "") ?? undefined;

      return { ok: true, etag: newEtag };
    } catch (err) {
      if (err instanceof CalDavConflictError) {
        return { ok: false, error: "Conflict: event was modified" };
      }
      if (err instanceof CalDavApiError) {
        return { ok: false, error: err.message };
      }
      throw err;
    }
  }

  /**
   * Delete an event via CalDAV DELETE (low-level).
   *
   * Returns a CalDavWriteResult rather than throwing, parallel to putEvent.
   * The CalendarProvider-compliant deleteEvent() wraps this method.
   *
   * @param calendarHref - Calendar URL path
   * @param eventUid - UID for the event
   * @param etag - If provided, used as If-Match for conflict detection
   */
  async deleteEventCalDav(
    calendarHref: string,
    eventUid: string,
    etag?: string,
  ): Promise<CalDavWriteResult> {
    const eventUrl = this.resolveUrl(
      `${calendarHref}${eventUid}.ics`,
    );

    const headers: Record<string, string> = {};
    if (etag) {
      headers["If-Match"] = `"${etag}"`;
    }

    try {
      await this.request(eventUrl, {
        method: "DELETE",
        headers,
      });
      return { ok: true };
    } catch (err) {
      if (err instanceof CalDavApiError) {
        return { ok: false, error: err.message };
      }
      throw err;
    }
  }

  /**
   * Delete an event from a calendar.
   *
   * CalendarProvider-compliant: accepts (calendarId, eventId), returns
   * Promise<void>, and throws CalDavApiError on failure.
   */
  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    const result = await this.deleteEventCalDav(calendarId, eventId);

    if (!result.ok) {
      throw new CalDavApiError(
        `Failed to delete event: ${result.error}`,
        500,
      );
    }
  }

  // -----------------------------------------------------------------------
  // CalendarProvider interface implementation
  // -----------------------------------------------------------------------

  /**
   * List events from a calendar.
   *
   * For CalDAV, syncToken is the serialized CalDavCalendarSyncState JSON.
   * If no syncToken, does a full sync.
   */
  async listEvents(
    calendarId: string,
    syncToken?: string,
    _pageToken?: string,
  ): Promise<ListEventsResponse> {
    const storedState: CalDavCalendarSyncState | null = syncToken
      ? JSON.parse(syncToken)
      : null;

    const { events, deleted, newState } = await this.incrementalSync(
      calendarId,
      storedState,
    );

    // Parse iCalendar data into GoogleCalendarEvent-compatible shape
    // The sync engine will classify and normalize these via the CalDAV normalizer
    const parsedEvents = [];
    for (const caldavEvent of events) {
      const vevents = parseVEvents(caldavEvent.icalData);
      for (const vevent of vevents) {
        parsedEvents.push({
          id: vevent.uid,
          summary: vevent.summary,
          description: vevent.description,
          location: vevent.location,
          status: vevent.status?.toLowerCase() === "cancelled" ? "cancelled" : "confirmed",
          // Store raw CalDAV data for the normalizer
          _caldavRaw: vevent,
          _caldavEtag: caldavEvent.etag,
          _caldavHref: caldavEvent.href,
        });
      }
    }

    // Add deleted events as cancelled
    for (const href of deleted) {
      parsedEvents.push({
        id: href,
        status: "cancelled",
      });
    }

    return {
      events: parsedEvents as ListEventsResponse["events"],
      nextSyncToken: JSON.stringify(newState),
    };
  }

  /**
   * Insert a mirror event via CalDAV PUT.
   * Returns the event UID as the provider event ID.
   */
  async insertEvent(
    calendarId: string,
    event: ProjectedEvent,
  ): Promise<string> {
    const uid = generateCalDavUid();
    const icalData = projectedEventToICal(event, uid);
    const result = await this.putEvent(calendarId, uid, icalData);

    if (!result.ok) {
      throw new CalDavApiError(
        `Failed to create event: ${result.error}`,
        500,
      );
    }

    return uid;
  }

  /**
   * Patch (update) an existing event.
   * CalDAV requires PUT with full payload, so we rebuild from the projected event.
   */
  async patchEvent(
    calendarId: string,
    eventId: string,
    patch: Partial<ProjectedEvent>,
  ): Promise<void> {
    const icalData = projectedEventToICal(patch as ProjectedEvent, eventId);
    const result = await this.putEvent(calendarId, eventId, icalData);

    if (!result.ok) {
      throw new CalDavApiError(
        `Failed to update event: ${result.error}`,
        500,
      );
    }
  }

  /**
   * List all calendars the authenticated user has access to.
   */
  async listCalendars(): Promise<CalendarListEntry[]> {
    const calendars = await this.discoverCalendars();
    return calendars.map((cal, index) => ({
      id: cal.href,
      summary: cal.displayName,
      primary: index === 0 || cal.isDefault === true,
      accessRole: "owner",
    }));
  }

  /**
   * Create a new calendar.
   * CalDAV uses MKCALENDAR method -- not commonly needed for Apple Calendar.
   * Throws not-implemented since Apple Calendar doesn't support programmatic calendar creation easily.
   */
  async insertCalendar(_summary: string): Promise<string> {
    throw new CalDavApiError(
      "Calendar creation is not supported via CalDAV for Apple Calendar",
      501,
    );
  }

  /**
   * Watch events -- not supported for CalDAV.
   * CalDAV uses polling (ctag/etag) instead of push notifications.
   */
  async watchEvents(
    _calendarId: string,
    _webhookUrl: string,
    _channelId: string,
    _token: string,
  ): Promise<WatchResponse> {
    throw new CalDavApiError(
      "Push notifications are not supported for CalDAV. Use polling with ctag/etag.",
      501,
    );
  }

  /**
   * Stop channel -- not applicable for CalDAV.
   */
  async stopChannel(_channelId: string, _resourceId: string): Promise<void> {
    // No-op: CalDAV doesn't have push notification channels
  }

  // -----------------------------------------------------------------------
  // Internal: HTTP methods
  // -----------------------------------------------------------------------

  /**
   * Perform a PROPFIND request.
   * @param depth - WebDAV Depth header (0 = self only, 1 = self + children)
   */
  private async propfind(
    url: string,
    xml: string,
    depth: 0 | 1 = 0,
  ): Promise<string> {
    const response = await this.request(url, {
      method: "PROPFIND",
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        Depth: String(depth),
      },
      body: xml,
    });

    return response.text();
  }

  /**
   * Perform a REPORT request.
   */
  private async report(url: string, xml: string): Promise<string> {
    const response = await this.request(url, {
      method: "REPORT",
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        Depth: "1",
      },
      body: xml,
    });

    return response.text();
  }

  /**
   * Make an authenticated HTTP request to the CalDAV server.
   * Uses HTTP Basic Auth per CalDAV spec.
   */
  private async request(
    url: string,
    init: RequestInit & { headers?: Record<string, string> },
  ): Promise<Response> {
    const headers = new Headers(init.headers);

    // HTTP Basic Auth: base64(appleId:appSpecificPassword)
    const credentials = btoa(`${this.appleId}:${this.appSpecificPassword}`);
    headers.set("Authorization", `Basic ${credentials}`);

    const response = await this.fetchFn(url, {
      ...init,
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");

      switch (response.status) {
        case 401:
          throw new CalDavAuthError();
        case 404:
          throw new CalDavNotFoundError(errorText);
        case 409:
        case 412: // Precondition failed (etag mismatch)
          throw new CalDavConflictError(errorText);
        default:
          throw new CalDavApiError(errorText, response.status);
      }
    }

    return response;
  }

  /**
   * Resolve a relative URL against the server base.
   */
  private resolveUrl(path: string): string {
    if (path.startsWith("http://") || path.startsWith("https://")) {
      return path;
    }
    // Remove trailing slash from base, ensure path starts with /
    const base = this.serverUrl.replace(/\/$/, "");
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `${base}${normalizedPath}`;
  }
}

// ---------------------------------------------------------------------------
// Helper: generate CalDAV UID
// ---------------------------------------------------------------------------

/**
 * Generate a unique CalDAV UID.
 * Format: tminus-<random>@tminus.app
 */
function generateCalDavUid(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let random = "";
  for (let i = 0; i < 24; i++) {
    random += chars[Math.floor(Math.random() * chars.length)];
  }
  return `tminus-${random}@tminus.app`;
}

// ---------------------------------------------------------------------------
// Helper: convert ProjectedEvent to iCalendar for mirror writes
// ---------------------------------------------------------------------------

/**
 * Convert a T-Minus ProjectedEvent into an iCalendar VCALENDAR document
 * suitable for CalDAV PUT.
 *
 * Includes X-TMINUS-MANAGED and X-TMINUS-CANONICAL-ID custom properties
 * for loop prevention (Invariant E).
 */
function projectedEventToICal(
  event: ProjectedEvent,
  uid: string,
): string {
  const lines: string[] = [];

  lines.push("BEGIN:VCALENDAR");
  lines.push("VERSION:2.0");
  lines.push("PRODID:-//T-Minus//Calendar Mirror//EN");
  lines.push("BEGIN:VEVENT");

  lines.push(`UID:${uid}`);
  lines.push(`DTSTAMP:${formatNowAsICalDateTime()}`);

  // SUMMARY
  if (event.summary) {
    lines.push(`SUMMARY:${escapeICalText(event.summary)}`);
  }

  // DESCRIPTION
  if (event.description) {
    lines.push(`DESCRIPTION:${escapeICalText(event.description)}`);
  }

  // LOCATION
  if (event.location) {
    lines.push(`LOCATION:${escapeICalText(event.location)}`);
  }

  // DTSTART / DTEND
  if (event.start.date) {
    lines.push(`DTSTART;VALUE=DATE:${event.start.date.replace(/-/g, "")}`);
  } else if (event.start.dateTime) {
    if (event.start.timeZone) {
      lines.push(`DTSTART;TZID=${event.start.timeZone}:${formatDateTimeForICal(event.start.dateTime)}`);
    } else {
      lines.push(`DTSTART:${formatDateTimeForICal(event.start.dateTime)}`);
    }
  }

  if (event.end.date) {
    lines.push(`DTEND;VALUE=DATE:${event.end.date.replace(/-/g, "")}`);
  } else if (event.end.dateTime) {
    if (event.end.timeZone) {
      lines.push(`DTEND;TZID=${event.end.timeZone}:${formatDateTimeForICal(event.end.dateTime)}`);
    } else {
      lines.push(`DTEND:${formatDateTimeForICal(event.end.dateTime)}`);
    }
  }

  // TRANSP
  lines.push(`TRANSP:${event.transparency.toUpperCase()}`);

  // CLASS (visibility)
  if (event.visibility === "private") {
    lines.push("CLASS:PRIVATE");
  } else if (event.visibility === "default") {
    lines.push("CLASS:PUBLIC");
  }

  // T-Minus managed markers (loop prevention -- Invariant E)
  if (event.extendedProperties?.private) {
    const props = event.extendedProperties.private;
    if (props.tminus === "true" && props.managed === "true") {
      lines.push("X-TMINUS-MANAGED:true");
    }
    if (props.canonical_event_id) {
      lines.push(`X-TMINUS-CANONICAL-ID:${props.canonical_event_id}`);
    }
  }

  lines.push("END:VEVENT");
  lines.push("END:VCALENDAR");

  return lines.map(foldLine).join(CRLF) + CRLF;
}

/**
 * Escape special iCalendar TEXT characters.
 */
function escapeICalText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/**
 * Format current time as iCalendar DTSTAMP.
 */
function formatNowAsICalDateTime(): string {
  const now = new Date();
  return now
    .toISOString()
    .replace(/-/g, "")
    .replace(/:/g, "")
    .replace(/\.\d{3}/, "");
}

/**
 * Format an ISO 8601 datetime for iCalendar.
 */
function formatDateTimeForICal(dateTime: string): string {
  return dateTime
    .replace(/-/g, "")
    .replace(/:/g, "")
    .replace(/\.\d{3}/, "");
}
