/**
 * @tminus/shared -- Microsoft Graph Calendar API abstraction layer.
 *
 * Thin wrapper over the Microsoft Graph REST API v1.0 that:
 * - Implements CalendarProvider interface (same as GoogleCalendarClient)
 * - Handles delta query pagination (@odata.nextLink / @odata.deltaLink)
 * - Returns typed responses compatible with Google's response shapes
 * - Throws specific error types for 401, 404, 429, and general API errors
 * - Handles non-JSON responses gracefully (HTML error pages from gateways)
 * - Implements client-side rate limiting at 4 req/sec/mailbox via token bucket
 * - Maps ProjectedEvent fields to Microsoft Graph event format
 * - Includes T-Minus managed markers via open extensions (com.tminus.metadata)
 * - Accepts injectable FetchFn for testability
 */

// setTimeout is available in all target runtimes (Workers, Node) but not
// declared when tsconfig has types: []. Declare it here for portability.
declare function setTimeout(callback: () => void, ms: number): unknown;

import type { ProjectedEvent } from "./types";
import type {
  CalendarProvider,
  FetchFn,
  ListEventsResponse,
  CalendarListEntry,
  WatchResponse,
} from "./google-api";
import type { MicrosoftGraphEvent } from "./normalize-microsoft";

// ---------------------------------------------------------------------------
// Error types (parallel to Google error classes)
// ---------------------------------------------------------------------------

/** Base class for all Microsoft Graph API errors. */
export class MicrosoftApiError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "MicrosoftApiError";
    this.statusCode = statusCode;
  }
}

/** 401 -- access token expired or invalid. Caller should refresh via AccountDO. */
export class MicrosoftTokenExpiredError extends MicrosoftApiError {
  constructor(message = "Access token expired or invalid") {
    super(message, 401);
    this.name = "MicrosoftTokenExpiredError";
  }
}

/** 404 -- requested resource not found. */
export class MicrosoftResourceNotFoundError extends MicrosoftApiError {
  constructor(message = "Resource not found") {
    super(message, 404);
    this.name = "MicrosoftResourceNotFoundError";
  }
}

/** 429 -- rate limited by Microsoft Graph. Includes Retry-After if available. */
export class MicrosoftRateLimitError extends MicrosoftApiError {
  readonly retryAfterSeconds?: number;

  constructor(message = "Rate limited by Microsoft Graph API", retryAfterSeconds?: number) {
    super(message, 429);
    this.name = "MicrosoftRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Subscription validation handshake failure. */
export class MicrosoftSubscriptionValidationError extends MicrosoftApiError {
  constructor(message = "Subscription validation handshake failed") {
    super(message, 400);
    this.name = "MicrosoftSubscriptionValidationError";
  }
}

// ---------------------------------------------------------------------------
// Token bucket rate limiter
// ---------------------------------------------------------------------------

/**
 * Token bucket rate limiter for client-side throttling.
 *
 * Microsoft Graph enforces 4 req/sec/mailbox. We implement client-side
 * rate limiting to avoid hitting server-side 429s, which are more expensive.
 *
 * The bucket starts full and refills at a constant rate.
 */
export class TokenBucket {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per millisecond
  private lastRefillTime: number;

  /**
   * @param capacity - Maximum number of tokens (burst size)
   * @param tokensPerSecond - Refill rate in tokens per second
   */
  constructor(capacity: number, tokensPerSecond: number) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = tokensPerSecond / 1000; // convert to per-ms
    this.lastRefillTime = Date.now();
  }

  /**
   * Acquire a token, waiting if necessary until one is available.
   * Returns a promise that resolves when a token is acquired.
   */
  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Calculate wait time until next token
    const deficit = 1 - this.tokens;
    const waitMs = Math.ceil(deficit / this.refillRate);

    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));

    this.refill();
    this.tokens -= 1;
  }

  /** Refill tokens based on elapsed time, capped at capacity. */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillTime;
    if (elapsed <= 0) return;

    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefillTime = now;
  }
}

// ---------------------------------------------------------------------------
// Microsoft Graph Calendar API base URL
// ---------------------------------------------------------------------------

const MS_GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/** Maximum subscription duration for calendar events: 3 days in milliseconds. */
const MAX_SUBSCRIPTION_DAYS = 3;

/** T-Minus open extension name for managed markers. */
const TMINUS_EXTENSION_NAME = "com.tminus.metadata";

// ---------------------------------------------------------------------------
// Configuration options
// ---------------------------------------------------------------------------

export interface MicrosoftClientOptions {
  /** Enable client-side rate limiting. Default: true. */
  enableRateLimiting?: boolean;
  /** Requests per second limit. Default: 4 (Microsoft's limit). */
  requestsPerSecond?: number;
}

// ---------------------------------------------------------------------------
// MicrosoftCalendarClient implementation
// ---------------------------------------------------------------------------

/**
 * Thin typed wrapper over the Microsoft Graph Calendar REST API.
 *
 * Implements CalendarProvider for uniform treatment by the sync engine.
 *
 * Usage:
 *   const client = new MicrosoftCalendarClient(accessToken);
 *   const calendars = await client.listCalendars();
 */
export class MicrosoftCalendarClient implements CalendarProvider {
  private readonly accessToken: string;
  private readonly fetchFn: FetchFn;
  private readonly rateLimiter: TokenBucket | null;

  constructor(
    accessToken: string,
    fetchFn?: FetchFn,
    options?: MicrosoftClientOptions,
  ) {
    this.accessToken = accessToken;
    this.fetchFn = fetchFn ?? globalThis.fetch.bind(globalThis);

    const enableRateLimiting = options?.enableRateLimiting ?? true;
    const rps = options?.requestsPerSecond ?? 4;
    this.rateLimiter = enableRateLimiting ? new TokenBucket(rps, rps) : null;
  }

  // -----------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------

  /**
   * List events from a calendar. Supports delta queries for incremental sync.
   *
   * Microsoft Graph uses delta queries differently from Google:
   * - syncToken is the full @odata.deltaLink URL from a previous response
   * - pageToken is the full @odata.nextLink URL for pagination
   *
   * When syncToken is provided, it's used as-is (it's a full URL with deltatoken).
   * When pageToken is provided, it's used as-is (it's a full URL with skiptoken).
   * When neither is provided, fetches all events from the calendar.
   */
  async listEvents(
    calendarId: string,
    syncToken?: string,
    pageToken?: string,
  ): Promise<ListEventsResponse> {
    // Determine the URL to call:
    // 1. pageToken takes precedence (continuing pagination)
    // 2. syncToken is the full deltaLink URL (incremental sync)
    // 3. Default: list all events from calendar
    let url: string;
    if (pageToken) {
      url = pageToken;
    } else if (syncToken) {
      url = syncToken;
    } else {
      url = `${MS_GRAPH_BASE}/me/calendars/${calendarId}/events?$expand=Extensions($filter=Id eq '${TMINUS_EXTENSION_NAME}')`;
    }

    const body = await this.request<MicrosoftEventsListRaw>(url, { method: "GET" });

    // Map Microsoft Graph events to GoogleCalendarEvent shape for compatibility
    const events = (body.value ?? []).map((msEvt) => ({
      id: msEvt.id,
      summary: msEvt.subject,
      description: msEvt.body?.content,
      location: msEvt.location?.displayName,
      start: msEvt.start
        ? { dateTime: msEvt.start.dateTime, timeZone: msEvt.start.timeZone }
        : undefined,
      end: msEvt.end
        ? { dateTime: msEvt.end.dateTime, timeZone: msEvt.end.timeZone }
        : undefined,
      status: msEvt.isCancelled ? "cancelled" : "confirmed",
      // Store raw Microsoft fields as well for the normalizer
      _msRaw: msEvt,
    }));

    return {
      events: events as ListEventsResponse["events"],
      nextPageToken: body["@odata.nextLink"],
      nextSyncToken: body["@odata.deltaLink"],
    };
  }

  /**
   * Insert (create) an event on a calendar.
   * Maps ProjectedEvent to Microsoft Graph event format and includes
   * T-Minus open extension for managed markers.
   * Returns the provider-assigned event ID.
   */
  async insertEvent(
    calendarId: string,
    event: ProjectedEvent,
  ): Promise<string> {
    const url = `${MS_GRAPH_BASE}/me/calendars/${calendarId}/events`;
    const msEvent = projectToMicrosoftEvent(event);

    const body = await this.request<{ id: string }>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msEvent),
    });
    return body.id;
  }

  /**
   * Patch (partial update) an existing event.
   * Microsoft PATCH uses /me/events/{id} (not scoped to calendar).
   */
  async patchEvent(
    calendarId: string,
    eventId: string,
    patch: Partial<ProjectedEvent>,
  ): Promise<void> {
    const url = `${MS_GRAPH_BASE}/me/events/${eventId}`;
    const msPatch = projectToMicrosoftEvent(patch as ProjectedEvent);

    await this.request<unknown>(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msPatch),
    });
  }

  /**
   * Delete an event. Microsoft DELETE uses /me/events/{id}.
   */
  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    const url = `${MS_GRAPH_BASE}/me/events/${eventId}`;
    await this.request<unknown>(url, { method: "DELETE" });
  }

  // -----------------------------------------------------------------------
  // Calendars
  // -----------------------------------------------------------------------

  /**
   * List all calendars the authenticated user has access to.
   * Maps Microsoft calendar properties to CalendarListEntry.
   */
  async listCalendars(): Promise<CalendarListEntry[]> {
    const url = `${MS_GRAPH_BASE}/me/calendars`;
    const body = await this.request<MicrosoftCalendarListRaw>(url, { method: "GET" });

    return (body.value ?? []).map((cal) => ({
      id: cal.id,
      summary: cal.name,
      primary: cal.isDefaultCalendar ?? false,
      accessRole: cal.canEdit ? "owner" : "reader",
    }));
  }

  /**
   * Create a new calendar.
   * Returns the provider-assigned calendar ID.
   */
  async insertCalendar(summary: string): Promise<string> {
    const url = `${MS_GRAPH_BASE}/me/calendars`;
    const body = await this.request<{ id: string }>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: summary }),
    });
    return body.id;
  }

  // -----------------------------------------------------------------------
  // Subscriptions (push notifications)
  // -----------------------------------------------------------------------

  /**
   * Create a subscription for calendar event changes.
   *
   * Microsoft subscriptions differ from Google watch channels:
   * - POST /subscriptions with changeType, notificationUrl, resource
   * - Max 3 days for calendar events
   * - Requires validation handshake (handled by webhook worker)
   * - Returns subscriptionId (mapped to channelId for CalendarProvider compatibility)
   *
   * @param calendarId - Calendar to watch
   * @param webhookUrl - URL to receive notifications
   * @param channelId - Unused for Microsoft (Google compatibility parameter)
   * @param token - Used as clientState for notification validation
   */
  async watchEvents(
    calendarId: string,
    webhookUrl: string,
    channelId: string,
    token: string,
  ): Promise<WatchResponse> {
    const url = `${MS_GRAPH_BASE}/subscriptions`;
    const expirationDateTime = new Date(
      Date.now() + MAX_SUBSCRIPTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const body = await this.request<MicrosoftSubscriptionRaw>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        changeType: "created,updated,deleted",
        notificationUrl: webhookUrl,
        resource: `/me/calendars/${calendarId}/events`,
        expirationDateTime,
        clientState: token,
      }),
    });

    return {
      channelId: body.id, // subscriptionId mapped to channelId
      resourceId: body.resource,
      expiration: body.expirationDateTime,
    };
  }

  /**
   * Stop receiving notifications for a subscription.
   * Microsoft uses DELETE /subscriptions/{id}.
   *
   * @param channelId - The subscriptionId (mapped from channelId)
   * @param resourceId - Unused for Microsoft (Google compatibility parameter)
   */
  async stopChannel(channelId: string, resourceId: string): Promise<void> {
    const url = `${MS_GRAPH_BASE}/subscriptions/${channelId}`;
    await this.request<unknown>(url, { method: "DELETE" });
  }

  // -----------------------------------------------------------------------
  // Internal: HTTP request with error mapping
  // -----------------------------------------------------------------------

  /**
   * Execute an authenticated request with error mapping and rate limiting.
   *
   * Error mapping:
   * - 401 -> MicrosoftTokenExpiredError
   * - 404 -> MicrosoftResourceNotFoundError
   * - 429 -> MicrosoftRateLimitError (with Retry-After if available)
   * - Other 4xx/5xx -> MicrosoftApiError
   *
   * Non-JSON responses (gateway errors) are handled gracefully:
   * - Attempts JSON.parse on response text
   * - Falls back to raw text if JSON.parse fails (SyntaxError)
   */
  private async request<T>(url: string, init: RequestInit): Promise<T> {
    // Rate limit: acquire a token before making the request
    if (this.rateLimiter) {
      await this.rateLimiter.acquire();
    }

    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.accessToken}`);

    const response = await this.fetchFn(url, {
      ...init,
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      const errorMessage = extractErrorMessage(errorText);

      switch (response.status) {
        case 401:
          throw new MicrosoftTokenExpiredError(errorMessage);
        case 404:
          throw new MicrosoftResourceNotFoundError(errorMessage);
        case 429: {
          const retryAfter = response.headers.get("Retry-After");
          const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : undefined;
          throw new MicrosoftRateLimitError(errorMessage, retryAfterSeconds);
        }
        default:
          throw new MicrosoftApiError(errorMessage, response.status);
      }
    }

    // 204 No Content (e.g., DELETE) -- return empty object
    if (response.status === 204) {
      return {} as T;
    }

    // Attempt to parse JSON, handle non-JSON responses gracefully
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      // Non-JSON successful response -- should not happen normally
      return {} as T;
    }
  }
}

// ---------------------------------------------------------------------------
// ProjectedEvent -> Microsoft Graph event mapping
// ---------------------------------------------------------------------------

/**
 * Convert a T-Minus ProjectedEvent into a Microsoft Graph event payload.
 *
 * Maps:
 * - summary -> subject
 * - description -> body.content
 * - location -> location.displayName
 * - start/end -> start/end (Microsoft format)
 * - transparency -> showAs
 * - visibility -> sensitivity
 * - extendedProperties -> open extension (com.tminus.metadata)
 */
function projectToMicrosoftEvent(event: ProjectedEvent): Record<string, unknown> {
  const msEvent: Record<string, unknown> = {};

  if (event.summary !== undefined) {
    msEvent.subject = event.summary;
  }

  if (event.description !== undefined) {
    msEvent.body = { contentType: "text", content: event.description };
  }

  if (event.location !== undefined) {
    msEvent.location = { displayName: event.location };
  }

  if (event.start) {
    msEvent.start = {
      dateTime: event.start.dateTime,
      timeZone: event.start.timeZone ?? "UTC",
    };
  }

  if (event.end) {
    msEvent.end = {
      dateTime: event.end.dateTime,
      timeZone: event.end.timeZone ?? "UTC",
    };
  }

  // Map transparency to showAs
  if (event.transparency !== undefined) {
    msEvent.showAs = event.transparency === "transparent" ? "free" : "busy";
  }

  // Map visibility to sensitivity
  if (event.visibility !== undefined) {
    msEvent.sensitivity = event.visibility === "default" ? "normal" : event.visibility;
  }

  // Include T-Minus managed markers as open extension
  if (event.extendedProperties?.private) {
    const props = event.extendedProperties.private;
    msEvent.extensions = [
      {
        "@odata.type": "microsoft.graph.openExtension",
        extensionName: TMINUS_EXTENSION_NAME,
        tminus: props.tminus,
        managed: props.managed,
        canonicalId: props.canonical_event_id,
        originAccount: props.origin_account_id,
      },
    ];
  }

  return msEvent;
}

// ---------------------------------------------------------------------------
// Error message extraction
// ---------------------------------------------------------------------------

/**
 * Attempt to extract a meaningful error message from response text.
 *
 * Microsoft Graph API returns JSON errors in the format:
 *   { "error": { "code": "...", "message": "..." } }
 *
 * Gateway errors may return HTML or plain text.
 * We try JSON first, fall back to raw text.
 */
function extractErrorMessage(rawText: string): string {
  try {
    const parsed = JSON.parse(rawText);
    if (parsed?.error?.message) {
      return parsed.error.message;
    }
    return rawText;
  } catch {
    // Not JSON -- return raw text (HTML gateway errors, plain text, etc.)
    return rawText;
  }
}

// ---------------------------------------------------------------------------
// Raw Microsoft Graph API response shapes (internal, not exported)
// ---------------------------------------------------------------------------

/** Raw shape from GET /me/calendars/{id}/events or delta query. */
interface MicrosoftEventsListRaw {
  value?: MicrosoftGraphEvent[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

/** Raw shape from GET /me/calendars. */
interface MicrosoftCalendarListRaw {
  value?: Array<{
    id: string;
    name: string;
    isDefaultCalendar?: boolean;
    canEdit?: boolean;
  }>;
}

/** Raw shape from POST /subscriptions. */
interface MicrosoftSubscriptionRaw {
  id: string;
  resource: string;
  expirationDateTime: string;
  clientState?: string;
}
