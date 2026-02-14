/**
 * Google Calendar API test client for real integration tests.
 *
 * Uses actual Google Calendar API with pre-authorized refresh tokens.
 * Provides helpers for creating, listing, deleting events and
 * waiting for busy overlay blocks to appear.
 *
 * Design:
 * - Injectable fetch function for testability
 * - Token caching with expiry awareness
 * - All test events get a [tminus-test] prefix for easy cleanup
 * - waitForBusyBlock polls until timeout
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GoogleTestClientConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Injectable fetch function. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

export interface CreateEventParams {
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

interface TokenRefreshParams {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

interface GoogleEvent {
  id: string;
  summary?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  [key: string]: unknown;
}

interface GoogleEventPayload {
  summary: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const TEST_EVENT_PREFIX = "[tminus-test]";

// ---------------------------------------------------------------------------
// buildTokenRefreshBody: construct URL-encoded form body
// ---------------------------------------------------------------------------

export function buildTokenRefreshBody(params: TokenRefreshParams): string {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    refresh_token: params.refreshToken,
  });
  return body.toString();
}

// ---------------------------------------------------------------------------
// buildEventPayload: construct Google Calendar event JSON
// ---------------------------------------------------------------------------

export function buildEventPayload(params: {
  summary: string;
  startTime: string;
  endTime: string;
}): GoogleEventPayload {
  return {
    summary: `${TEST_EVENT_PREFIX} ${params.summary}`,
    description:
      "Created by tminus integration test. Safe to delete if found orphaned.",
    start: {
      dateTime: params.startTime,
      timeZone: "UTC",
    },
    end: {
      dateTime: params.endTime,
      timeZone: "UTC",
    },
  };
}

// ---------------------------------------------------------------------------
// GoogleTestClient
// ---------------------------------------------------------------------------

export class GoogleTestClient {
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

  constructor(config: GoogleTestClientConfig) {
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

    const response = await this.fetchFn(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Token refresh failed (${response.status}): ${text}`,
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
  // Calendar operations
  // -------------------------------------------------------------------------

  async createTestEvent(params: CreateEventParams): Promise<GoogleEvent> {
    const token = await this.getAccessToken();
    const payload = buildEventPayload({
      summary: params.summary,
      startTime: params.startTime,
      endTime: params.endTime,
    });

    const url = `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(params.calendarId)}/events`;

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

    const event = (await response.json()) as GoogleEvent;

    // Track for cleanup
    this.createdEvents.push({
      calendarId: params.calendarId,
      eventId: event.id,
    });

    return event;
  }

  async deleteTestEvent(params: DeleteEventParams): Promise<void> {
    const token = await this.getAccessToken();
    const url = `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(params.calendarId)}/events/${encodeURIComponent(params.eventId)}`;

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

  async listEvents(params: ListEventsParams): Promise<GoogleEvent[]> {
    const token = await this.getAccessToken();

    const url = new URL(
      `${GOOGLE_CALENDAR_BASE}/calendars/${encodeURIComponent(params.calendarId)}/events`,
    );
    if (params.timeMin) url.searchParams.set("timeMin", params.timeMin);
    if (params.timeMax) url.searchParams.set("timeMax", params.timeMax);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");

    const response = await this.fetchFn(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`List events failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as { items?: GoogleEvent[] };
    return data.items ?? [];
  }

  async waitForBusyBlock(params: WaitForBusyBlockParams): Promise<GoogleEvent> {
    const timeoutMs = params.timeoutMs ?? 30_000;
    const pollIntervalMs = params.pollIntervalMs ?? 2000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const events = await this.listEvents({
        calendarId: params.calendarId,
        timeMin: params.timeMin,
        timeMax: params.timeMax,
      });

      // Look for a busy block (created by tminus sync)
      const busyBlock = events.find(
        (e) =>
          e.summary?.toLowerCase().includes("busy") ||
          e.status === "confirmed",
      );

      if (busyBlock) {
        return busyBlock;
      }

      await sleep(pollIntervalMs);
    }

    throw new Error(
      `Timed out waiting for busy block on calendar ${params.calendarId} ` +
        `between ${params.timeMin} and ${params.timeMax} after ${timeoutMs}ms`,
    );
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
          `Failed to clean up test event ${event.eventId} on calendar ${event.calendarId}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// sleep utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
