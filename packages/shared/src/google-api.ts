/**
 * @tminus/shared -- Google Calendar API abstraction layer.
 *
 * Thin wrapper over the Google Calendar REST API that:
 * - Provides typed methods for all Calendar operations used in Phase 1
 * - Handles pagination (events.list returns pageToken for continuation)
 * - Returns typed responses for events, calendars, and watch channels
 * - Throws specific error types for 401, 404, 410, 429, and general API errors
 * - Implements CalendarProvider interface for future multi-provider support (Phase 5)
 * - Accepts injectable FetchFn for testability (same pattern as AccountDO/OAuth worker)
 */

import type { GoogleCalendarEvent, ProjectedEvent, EventDateTime } from "./types";

// ---------------------------------------------------------------------------
// Injectable fetch type (matches existing codebase pattern)
// ---------------------------------------------------------------------------

/**
 * Injectable fetch function for testing. In production this is
 * globalThis.fetch; in tests it can be replaced with a mock.
 */
export type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/** Response from events.list endpoint. */
export interface ListEventsResponse {
  readonly events: GoogleCalendarEvent[];
  readonly nextPageToken?: string;
  readonly nextSyncToken?: string;
}

/** A calendar entry from calendarList.list. */
export interface CalendarListEntry {
  readonly id: string;
  readonly summary: string;
  readonly primary?: boolean;
  readonly accessRole: string;
}

/** Response from events/watch endpoint. */
export interface WatchResponse {
  readonly channelId: string;
  readonly resourceId: string;
  /** Unix millisecond timestamp as string. */
  readonly expiration: string;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Base class for all Google Calendar API errors. */
export class GoogleApiError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "GoogleApiError";
    this.statusCode = statusCode;
  }
}

/** 401 -- access token expired or invalid. Caller should refresh via AccountDO. */
export class TokenExpiredError extends GoogleApiError {
  constructor(message = "Access token expired or invalid") {
    super(message, 401);
    this.name = "TokenExpiredError";
  }
}

/** 404 -- requested resource not found. */
export class ResourceNotFoundError extends GoogleApiError {
  constructor(message = "Resource not found") {
    super(message, 404);
    this.name = "ResourceNotFoundError";
  }
}

/** 410 Gone -- syncToken is no longer valid. Caller must do a full sync. */
export class SyncTokenExpiredError extends GoogleApiError {
  constructor(message = "Sync token expired, full sync required") {
    super(message, 410);
    this.name = "SyncTokenExpiredError";
  }
}

/** 429 -- rate limited by Google. Caller should back off and retry. */
export class RateLimitError extends GoogleApiError {
  constructor(message = "Rate limited by Google Calendar API") {
    super(message, 429);
    this.name = "RateLimitError";
  }
}

// ---------------------------------------------------------------------------
// Provider abstraction interface (Phase 5: Microsoft Calendar, CalDAV, etc.)
// ---------------------------------------------------------------------------

/**
 * Calendar provider abstraction. GoogleCalendarClient implements this.
 * In Phase 5, MicrosoftCalendarClient will also implement it, allowing
 * the sync engine to treat all providers uniformly.
 */
export interface CalendarProvider {
  listEvents(
    calendarId: string,
    syncToken?: string,
    pageToken?: string,
  ): Promise<ListEventsResponse>;

  insertEvent(
    calendarId: string,
    event: ProjectedEvent,
  ): Promise<string>; // returns providerEventId

  patchEvent(
    calendarId: string,
    eventId: string,
    patch: Partial<ProjectedEvent>,
  ): Promise<void>;

  deleteEvent(calendarId: string, eventId: string): Promise<void>;

  listCalendars(): Promise<CalendarListEntry[]>;

  insertCalendar(summary: string): Promise<string>; // returns calendarId

  watchEvents(
    calendarId: string,
    webhookUrl: string,
    channelId: string,
    token: string,
  ): Promise<WatchResponse>;

  stopChannel(channelId: string, resourceId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Google Calendar REST API base URL
// ---------------------------------------------------------------------------

const GOOGLE_CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

// ---------------------------------------------------------------------------
// GoogleCalendarClient implementation
// ---------------------------------------------------------------------------

/**
 * Thin typed wrapper over the Google Calendar REST API.
 *
 * Usage:
 *   const client = new GoogleCalendarClient(accessToken);
 *   const { events, nextSyncToken } = await client.listEvents("primary");
 */
export class GoogleCalendarClient implements CalendarProvider {
  private readonly accessToken: string;
  private readonly fetchFn: FetchFn;

  constructor(accessToken: string, fetchFn?: FetchFn) {
    this.accessToken = accessToken;
    this.fetchFn = fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  // -----------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------

  /**
   * List events from a calendar. Supports both incremental sync (via syncToken)
   * and pagination (via pageToken).
   *
   * Automatically paginates through ALL pages, accumulating events, and returns
   * the nextSyncToken from the final page. The Google Calendar API only returns
   * nextSyncToken on the last page of results.
   *
   * When syncToken is provided, returns only events changed since the token was issued.
   * A 410 Gone response means the syncToken is stale -- throws SyncTokenExpiredError.
   *
   * @param calendarId - Calendar ID (e.g., "primary")
   * @param syncToken - Sync token from a previous listEvents call (incremental sync)
   * @param pageToken - Page token to resume pagination from (optional, rarely needed)
   */
  async listEvents(
    calendarId: string,
    syncToken?: string,
    pageToken?: string,
  ): Promise<ListEventsResponse> {
    const allEvents: GoogleCalendarEvent[] = [];
    let currentPageToken: string | undefined = pageToken;
    let nextSyncToken: string | undefined;

    do {
      const params = new URLSearchParams();

      // Expand recurring series into concrete instances so future occurrences
      // are visible in the canonical store, and include cancelled entries so
      // delete deltas are observable during sync.
      params.set("singleEvents", "true");
      params.set("showDeleted", "true");
      params.set("maxResults", "2500");

      if (syncToken) {
        // Incremental sync -- syncToken is included on every page request
        params.set("syncToken", syncToken);
      }
      if (currentPageToken) {
        params.set("pageToken", currentPageToken);
      }

      const url = `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
      const body = await this.request<GoogleEventsListRaw>(url, { method: "GET" });

      allEvents.push(...(body.items ?? []));
      currentPageToken = body.nextPageToken;

      // nextSyncToken is only present on the final page
      if (body.nextSyncToken) {
        nextSyncToken = body.nextSyncToken;
      }
    } while (currentPageToken);

    return {
      events: allEvents,
      nextPageToken: undefined,
      nextSyncToken,
    };
  }

  /**
   * Insert (create) an event on a calendar.
   * Returns the provider-assigned event ID.
   */
  async insertEvent(
    calendarId: string,
    event: ProjectedEvent,
  ): Promise<string> {
    const url = `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`;
    const body = await this.request<{ id: string }>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    return body.id;
  }

  /**
   * Patch (partial update) an existing event.
   */
  async patchEvent(
    calendarId: string,
    eventId: string,
    patch: Partial<ProjectedEvent>,
  ): Promise<void> {
    const url = `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
    await this.request<unknown>(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  /**
   * Delete an event from a calendar.
   */
  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    const url = `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
    // DELETE returns 204 No Content on success -- handle in request()
    await this.request<unknown>(url, { method: "DELETE" });
  }

  // -----------------------------------------------------------------------
  // Calendars
  // -----------------------------------------------------------------------

  /**
   * List all calendars the authenticated user has access to.
   */
  async listCalendars(): Promise<CalendarListEntry[]> {
    const url = `${GOOGLE_CALENDAR_BASE}/users/me/calendarList`;
    const body = await this.request<GoogleCalendarListRaw>(url, { method: "GET" });

    return (body.items ?? []).map((item) => ({
      id: item.id,
      summary: item.summary,
      primary: item.primary,
      accessRole: item.accessRole,
    }));
  }

  /**
   * Create a new secondary calendar.
   * Returns the provider-assigned calendar ID.
   */
  async insertCalendar(summary: string): Promise<string> {
    const url = `${GOOGLE_CALENDAR_BASE}/calendars`;
    const body = await this.request<{ id: string }>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary }),
    });
    return body.id;
  }

  // -----------------------------------------------------------------------
  // Push notifications (watch channels)
  // -----------------------------------------------------------------------

  /**
   * Set up a push notification channel for event changes.
   * Returns channel info including resourceId and expiration.
   */
  async watchEvents(
    calendarId: string,
    webhookUrl: string,
    channelId: string,
    token: string,
  ): Promise<WatchResponse> {
    const url = `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/watch`;
    const body = await this.request<GoogleWatchRaw>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: channelId,
        type: "web_hook",
        address: webhookUrl,
        token,
      }),
    });

    return {
      channelId: body.id,
      resourceId: body.resourceId,
      expiration: body.expiration,
    };
  }

  /**
   * Stop receiving push notifications for a channel.
   */
  async stopChannel(channelId: string, resourceId: string): Promise<void> {
    const url = `${GOOGLE_CALENDAR_BASE}/channels/stop`;
    await this.request<unknown>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: channelId, resourceId }),
    });
  }

  // -----------------------------------------------------------------------
  // Internal: HTTP request with error mapping
  // -----------------------------------------------------------------------

  /**
   * Execute an authenticated request and map HTTP errors to typed exceptions.
   *
   * Error mapping:
   * - 401 -> TokenExpiredError
   * - 404 -> ResourceNotFoundError
   * - 410 -> SyncTokenExpiredError
   * - 429 -> RateLimitError
   * - Other 4xx/5xx -> GoogleApiError
   */
  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.accessToken}`);

    const response = await this.fetchFn(url, {
      ...init,
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");

      switch (response.status) {
        case 401:
          throw new TokenExpiredError(errorText);
        case 404:
          throw new ResourceNotFoundError(errorText);
        case 410:
          throw new SyncTokenExpiredError(errorText);
        case 429:
          throw new RateLimitError(errorText);
        default:
          throw new GoogleApiError(errorText, response.status);
      }
    }

    // 204 No Content (e.g., DELETE, stopChannel) -- return empty object
    if (response.status === 204) {
      return {} as T;
    }

    return (await response.json()) as T;
  }
}

// ---------------------------------------------------------------------------
// Raw Google API response shapes (internal, not exported)
// ---------------------------------------------------------------------------

/** Raw shape from GET /calendars/{id}/events */
interface GoogleEventsListRaw {
  items?: GoogleCalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

/** Raw shape from GET /users/me/calendarList */
interface GoogleCalendarListRaw {
  items?: Array<{
    id: string;
    summary: string;
    primary?: boolean;
    accessRole: string;
  }>;
}

/** Raw shape from POST /calendars/{id}/events/watch */
interface GoogleWatchRaw {
  id: string;
  resourceId: string;
  expiration: string;
}
