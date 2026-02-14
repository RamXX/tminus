/**
 * Microsoft Graph Calendar API test client for real integration tests.
 *
 * Uses actual Microsoft Graph API with pre-authorized refresh tokens.
 * Provides helpers for creating, listing, deleting events and
 * waiting for busy overlay blocks to appear.
 *
 * Parallel to google-test-client.ts -- same structure, Microsoft-specific API.
 *
 * Design:
 * - Injectable fetch function for testability
 * - Token caching with expiry awareness
 * - All test events get a [tminus-test] prefix for easy cleanup
 * - waitForBusyBlock polls until timeout
 * - Uses Microsoft Graph open extensions (com.tminus.metadata) for managed marker detection
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MicrosoftTestClientConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Injectable fetch function. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

export interface CreateEventParams {
  /** Calendar ID. Use 'primary' for the default calendar (resolved to Graph API format). */
  calendarId: string;
  summary: string;
  startTime: string;
  endTime: string;
}

export interface DeleteEventParams {
  calendarId: string;
  eventId: string;
}

export interface ListEventsParams {
  calendarId: string;
  timeMin?: string;
  timeMax?: string;
}

export interface WaitForBusyBlockParams {
  calendarId: string;
  timeMin: string;
  timeMax: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

interface MicrosoftEvent {
  id: string;
  subject?: string;
  body?: { contentType?: string; content?: string };
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  showAs?: string;
  isAllDay?: boolean;
  isCancelled?: boolean;
  extensions?: Array<{
    extensionName?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

/** Normalized event shape returned to tests (parallel to GoogleTestClient). */
export interface NormalizedMsEvent {
  id: string;
  summary?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  showAs?: string;
  extensions?: Array<{
    extensionName?: string;
    [key: string]: unknown;
  }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MS_TOKEN_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MS_GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const TEST_EVENT_PREFIX = "[tminus-test]";

// ---------------------------------------------------------------------------
// buildTokenRefreshBody: construct URL-encoded form body
// ---------------------------------------------------------------------------

export function buildTokenRefreshBody(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): string {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    refresh_token: params.refreshToken,
    scope: "Calendars.ReadWrite User.Read offline_access",
  });
  return body.toString();
}

// ---------------------------------------------------------------------------
// buildEventPayload: construct Microsoft Graph event JSON
// ---------------------------------------------------------------------------

export function buildEventPayload(params: {
  summary: string;
  startTime: string;
  endTime: string;
}): Record<string, unknown> {
  return {
    subject: `${TEST_EVENT_PREFIX} ${params.summary}`,
    body: {
      contentType: "text",
      content:
        "Created by tminus integration test. Safe to delete if found orphaned.",
    },
    start: {
      dateTime: params.startTime,
      timeZone: "UTC",
    },
    end: {
      dateTime: params.endTime,
      timeZone: "UTC",
    },
    showAs: "busy",
  };
}

// ---------------------------------------------------------------------------
// MicrosoftTestClient
// ---------------------------------------------------------------------------

export class MicrosoftTestClient {
  private clientId: string;
  private clientSecret: string;
  private refreshToken: string;
  private fetchFn: typeof fetch;

  /** Cached access token. */
  private accessToken: string | null = null;
  /** When the cached token expires (epoch ms). */
  private tokenExpiresAt = 0;
  /** Track created events for cleanup. */
  private createdEvents: Array<{ calendarId: string; eventId: string }> = [];
  /** Cached default calendar ID. */
  private defaultCalendarId: string | null = null;

  constructor(config: MicrosoftTestClientConfig) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.refreshToken = config.refreshToken;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
  }

  // -------------------------------------------------------------------------
  // Token management
  // -------------------------------------------------------------------------

  async refreshAccessToken(): Promise<string> {
    const body = buildTokenRefreshBody({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      refreshToken: this.refreshToken,
    });

    const response = await this.fetchFn(MS_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Microsoft token refresh failed (${response.status}): ${text}`,
      );
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };

    this.accessToken = data.access_token;
    // Expire 60s early to avoid edge cases
    this.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;

    return this.accessToken;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }
    return this.refreshAccessToken();
  }

  // -------------------------------------------------------------------------
  // Calendar resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve 'primary' to the actual default calendar ID.
   * Microsoft Graph doesn't use 'primary' -- it uses the actual calendar ID.
   */
  private async resolveCalendarId(calendarId: string): Promise<string> {
    if (calendarId !== "primary") {
      return calendarId;
    }

    if (this.defaultCalendarId) {
      return this.defaultCalendarId;
    }

    const token = await this.getAccessToken();
    const url = `${MS_GRAPH_BASE}/me/calendars?$filter=isDefaultCalendar eq true`;

    const response = await this.fetchFn(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `List calendars failed (${response.status}): ${text}`,
      );
    }

    const data = (await response.json()) as {
      value?: Array<{ id: string; name: string; isDefaultCalendar?: boolean }>;
    };
    const defaultCal = data.value?.find((c) => c.isDefaultCalendar);
    if (!defaultCal) {
      throw new Error("No default calendar found in Microsoft account");
    }

    this.defaultCalendarId = defaultCal.id;
    return this.defaultCalendarId;
  }

  // -------------------------------------------------------------------------
  // Calendar operations
  // -------------------------------------------------------------------------

  async createTestEvent(params: CreateEventParams): Promise<NormalizedMsEvent> {
    const token = await this.getAccessToken();
    const calId = await this.resolveCalendarId(params.calendarId);
    const payload = buildEventPayload({
      summary: params.summary,
      startTime: params.startTime,
      endTime: params.endTime,
    });

    const url = `${MS_GRAPH_BASE}/me/calendars/${calId}/events`;

    const response = await this.fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Create event failed (${response.status}): ${text}`);
    }

    const event = (await response.json()) as MicrosoftEvent;

    // Track for cleanup
    this.createdEvents.push({
      calendarId: calId,
      eventId: event.id,
    });

    return normalizeMsEvent(event);
  }

  async deleteTestEvent(params: DeleteEventParams): Promise<void> {
    const token = await this.getAccessToken();
    // Microsoft DELETE uses /me/events/{id} (not scoped to calendar)
    const url = `${MS_GRAPH_BASE}/me/events/${encodeURIComponent(params.eventId)}`;

    const response = await this.fetchFn(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok && response.status !== 404) {
      const text = await response.text();
      throw new Error(`Delete event failed (${response.status}): ${text}`);
    }

    // Remove from tracked events
    this.createdEvents = this.createdEvents.filter(
      (e) => e.eventId !== params.eventId,
    );
  }

  async listEvents(params: ListEventsParams): Promise<NormalizedMsEvent[]> {
    const token = await this.getAccessToken();
    const calId = await this.resolveCalendarId(params.calendarId);

    // Use calendarView for time-bounded queries (returns expanded recurrences)
    let url: string;
    if (params.timeMin && params.timeMax) {
      url =
        `${MS_GRAPH_BASE}/me/calendars/${calId}/calendarView` +
        `?startDateTime=${encodeURIComponent(params.timeMin)}` +
        `&endDateTime=${encodeURIComponent(params.timeMax)}` +
        `&$expand=extensions`;
    } else {
      url = `${MS_GRAPH_BASE}/me/calendars/${calId}/events?$expand=extensions`;
    }

    const response = await this.fetchFn(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Prefer: 'outlook.timezone="UTC"',
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`List events failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as { value?: MicrosoftEvent[] };
    return (data.value ?? []).map(normalizeMsEvent);
  }

  async waitForBusyBlock(
    params: WaitForBusyBlockParams,
  ): Promise<NormalizedMsEvent> {
    const timeoutMs = params.timeoutMs ?? 30_000;
    const pollIntervalMs = params.pollIntervalMs ?? 2000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const events = await this.listEvents({
        calendarId: params.calendarId,
        timeMin: params.timeMin,
        timeMax: params.timeMax,
      });

      // Look for a busy block: subject contains "Busy" or has tminus extension
      const busyBlock = events.find(
        (e) =>
          e.summary?.toLowerCase().includes("busy") ||
          hasTminusExtension(e),
      );

      if (busyBlock) {
        return busyBlock;
      }

      await sleep(pollIntervalMs);
    }

    throw new Error(
      `Timed out waiting for busy block on Microsoft calendar ` +
        `between ${params.timeMin} and ${params.timeMax} after ${timeoutMs}ms`,
    );
  }

  /**
   * Get the resolved default calendar ID for this account.
   * Useful for tests that need to specify the target calendar.
   */
  async getDefaultCalendarId(): Promise<string> {
    return this.resolveCalendarId("primary");
  }

  // -------------------------------------------------------------------------
  // Cleanup: delete all events created during this test session
  // -------------------------------------------------------------------------

  async cleanupAllTestEvents(): Promise<void> {
    const events = [...this.createdEvents];
    for (const event of events) {
      try {
        await this.deleteTestEvent(event);
      } catch {
        // Best effort cleanup -- log but don't fail
        console.warn(
          `Failed to clean up Microsoft test event ${event.eventId}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a raw Microsoft Graph event to a consistent shape for tests. */
function normalizeMsEvent(msEvt: MicrosoftEvent): NormalizedMsEvent {
  return {
    id: msEvt.id,
    summary: msEvt.subject,
    status: msEvt.isCancelled ? "cancelled" : "confirmed",
    start: msEvt.start
      ? { dateTime: msEvt.start.dateTime, date: undefined }
      : undefined,
    end: msEvt.end
      ? { dateTime: msEvt.end.dateTime, date: undefined }
      : undefined,
    showAs: msEvt.showAs,
    extensions: msEvt.extensions,
  };
}

/** Check if a normalized event has a com.tminus.metadata open extension. */
function hasTminusExtension(event: NormalizedMsEvent): boolean {
  if (!event.extensions || event.extensions.length === 0) {
    return false;
  }
  return event.extensions.some(
    (ext) => ext.extensionName === "com.tminus.metadata",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
