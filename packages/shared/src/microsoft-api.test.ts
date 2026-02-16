/**
 * @tminus/shared -- Unit tests for Microsoft Graph Calendar API abstraction layer.
 *
 * All tests use a mock FetchFn to verify:
 * - Correct URL construction and HTTP methods for Graph API
 * - Request body serialization (JSON)
 * - Authorization header injection (Bearer token)
 * - Response parsing and type mapping
 * - Delta query pagination (skipToken + deltaToken via @odata links)
 * - Error mapping (401, 404, 429, general)
 * - Non-JSON response handling (gateway errors)
 * - Client-side rate limiting (token bucket at 4 req/sec)
 * - CalendarProvider interface compliance
 * - Open extension-based T-Minus managed markers
 *
 * Credential-gated real API tests require MS_TEST_REFRESH_TOKEN env var.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ProjectedEvent, EventDateTime } from "./types";
import type { CalendarProvider, FetchFn, ListEventsResponse, CalendarListEntry, WatchResponse } from "./google-api";
import {
  MicrosoftCalendarClient,
  MicrosoftApiError,
  MicrosoftTokenExpiredError,
  MicrosoftResourceNotFoundError,
  MicrosoftRateLimitError,
  MicrosoftSubscriptionValidationError,
  TokenBucket,
} from "./microsoft-api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.test-ms-token";
const BASE_URL = "https://graph.microsoft.com/v1.0";

/** Build a mock FetchFn that returns a successful JSON response. */
function mockFetch(body: unknown, status = 200): FetchFn {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

/** Build a mock FetchFn that returns an error response. */
function mockFetchError(status: number, body = "Error", headers?: Record<string, string>): FetchFn {
  return vi.fn(async () =>
    new Response(body, { status, headers }),
  );
}

/** Build a mock FetchFn that returns 204 No Content. */
function mockFetch204(): FetchFn {
  return vi.fn(async () =>
    new Response(null, { status: 204 }),
  );
}

/** A sample ProjectedEvent for insert/patch tests. */
function sampleProjectedEvent(): ProjectedEvent {
  return {
    summary: "Busy",
    start: { dateTime: "2025-06-15T09:00:00Z" },
    end: { dateTime: "2025-06-15T09:30:00Z" },
    transparency: "opaque",
    visibility: "private",
    extendedProperties: {
      private: {
        tminus: "true",
        managed: "true",
        canonical_event_id: "evt_01HXYZ000012345678901234AB",
        origin_account_id: "acc_01HXYZ000012345678901234AB",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

describe("Microsoft error classes", () => {
  it("MicrosoftApiError is base class with statusCode", () => {
    const err = new MicrosoftApiError("test error", 500);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MicrosoftApiError);
    expect(err.name).toBe("MicrosoftApiError");
    expect(err.statusCode).toBe(500);
    expect(err.message).toBe("test error");
  });

  it("MicrosoftTokenExpiredError defaults to 401", () => {
    const err = new MicrosoftTokenExpiredError();
    expect(err).toBeInstanceOf(MicrosoftApiError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("MicrosoftTokenExpiredError");
    expect(err.statusCode).toBe(401);
    expect(err.message).toBe("Access token expired or invalid");
  });

  it("MicrosoftTokenExpiredError accepts custom message", () => {
    const err = new MicrosoftTokenExpiredError("Custom 401");
    expect(err.message).toBe("Custom 401");
    expect(err.statusCode).toBe(401);
  });

  it("MicrosoftResourceNotFoundError defaults to 404", () => {
    const err = new MicrosoftResourceNotFoundError();
    expect(err).toBeInstanceOf(MicrosoftApiError);
    expect(err.name).toBe("MicrosoftResourceNotFoundError");
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe("Resource not found");
  });

  it("MicrosoftRateLimitError defaults to 429 with retryAfter", () => {
    const err = new MicrosoftRateLimitError();
    expect(err).toBeInstanceOf(MicrosoftApiError);
    expect(err.name).toBe("MicrosoftRateLimitError");
    expect(err.statusCode).toBe(429);
    expect(err.message).toBe("Rate limited by Microsoft Graph API");
    expect(err.retryAfterSeconds).toBeUndefined();
  });

  it("MicrosoftRateLimitError stores retryAfterSeconds", () => {
    const err = new MicrosoftRateLimitError("throttled", 30);
    expect(err.retryAfterSeconds).toBe(30);
    expect(err.message).toBe("throttled");
  });

  it("MicrosoftSubscriptionValidationError has correct name", () => {
    const err = new MicrosoftSubscriptionValidationError("handshake failed");
    expect(err).toBeInstanceOf(MicrosoftApiError);
    expect(err.name).toBe("MicrosoftSubscriptionValidationError");
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe("handshake failed");
  });

  it("error classes have correct inheritance chain", () => {
    const base = new MicrosoftApiError("test", 418);
    const token = new MicrosoftTokenExpiredError();
    const notFound = new MicrosoftResourceNotFoundError();
    const rateLimit = new MicrosoftRateLimitError();
    const subVal = new MicrosoftSubscriptionValidationError("fail");

    // All extend MicrosoftApiError
    expect(token).toBeInstanceOf(MicrosoftApiError);
    expect(notFound).toBeInstanceOf(MicrosoftApiError);
    expect(rateLimit).toBeInstanceOf(MicrosoftApiError);
    expect(subVal).toBeInstanceOf(MicrosoftApiError);

    // All extend Error
    expect(base).toBeInstanceOf(Error);
    expect(token).toBeInstanceOf(Error);
    expect(notFound).toBeInstanceOf(Error);
    expect(rateLimit).toBeInstanceOf(Error);
    expect(subVal).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// Token bucket rate limiter
// ---------------------------------------------------------------------------

describe("TokenBucket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows bursts up to capacity", async () => {
    const bucket = new TokenBucket(4, 4); // 4 tokens, 4 per sec
    // Should be able to consume 4 immediately
    for (let i = 0; i < 4; i++) {
      await bucket.acquire();
    }
    // All 4 should have been consumed immediately (no waiting)
  });

  it("acquire blocks when bucket is empty", async () => {
    const bucket = new TokenBucket(2, 2); // 2 tokens, 2 per sec

    // Drain the bucket
    await bucket.acquire();
    await bucket.acquire();

    // Third acquire should not resolve immediately
    let resolved = false;
    const p = bucket.acquire().then(() => { resolved = true; });

    // After 0ms, should still be blocked
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);

    // After 500ms (1 token refill at 2/sec), should resolve
    await vi.advanceTimersByTimeAsync(500);
    await p;
    expect(resolved).toBe(true);
  });

  it("refills tokens over time", async () => {
    const bucket = new TokenBucket(4, 4); // 4 tokens, 4 per sec

    // Drain all tokens
    for (let i = 0; i < 4; i++) {
      await bucket.acquire();
    }

    // After 1 second, 4 tokens should have refilled
    await vi.advanceTimersByTimeAsync(1000);

    // Should be able to consume 4 again
    for (let i = 0; i < 4; i++) {
      await bucket.acquire();
    }
  });

  it("does not exceed capacity on refill", async () => {
    const bucket = new TokenBucket(4, 4);

    // Wait 5 seconds -- would produce 20 tokens but capacity is 4
    await vi.advanceTimersByTimeAsync(5000);

    // Should only allow 4 immediate consumes
    for (let i = 0; i < 4; i++) {
      await bucket.acquire();
    }

    // 5th should block
    let resolved = false;
    bucket.acquire().then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MicrosoftCalendarClient.listCalendars
// ---------------------------------------------------------------------------

describe("MicrosoftCalendarClient.listCalendars", () => {
  it("sends GET to /me/calendars with Authorization header", async () => {
    const fetchFn = mockFetch({
      value: [
        { id: "cal_1", name: "Calendar", isDefaultCalendar: true, canEdit: true },
        { id: "cal_2", name: "Work", isDefaultCalendar: false, canEdit: true },
      ],
    });
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    const calendars = await client.listCalendars();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/me/calendars`);
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${TEST_TOKEN}`);
  });

  it("maps Microsoft calendar response to CalendarListEntry", async () => {
    const fetchFn = mockFetch({
      value: [
        { id: "cal_primary", name: "Calendar", isDefaultCalendar: true, canEdit: true },
        { id: "cal_work", name: "Work Calendar", isDefaultCalendar: false, canEdit: false },
      ],
    });
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    const calendars = await client.listCalendars();

    expect(calendars).toHaveLength(2);
    expect(calendars[0]).toEqual({
      id: "cal_primary",
      summary: "Calendar",
      primary: true,
      accessRole: "owner",
    });
    expect(calendars[1]).toEqual({
      id: "cal_work",
      summary: "Work Calendar",
      primary: false,
      accessRole: "reader",
    });
  });

  it("returns empty array when value is undefined", async () => {
    const fetchFn = mockFetch({});
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    const calendars = await client.listCalendars();

    expect(calendars).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MicrosoftCalendarClient.listEvents
// ---------------------------------------------------------------------------

describe("MicrosoftCalendarClient.listEvents", () => {
  it("sends GET to /me/calendars/{id}/events with filtered $expand for full sync (no syncToken)", async () => {
    const fetchFn = mockFetch({
      value: [
        {
          id: "ms_evt_1",
          subject: "Team Meeting",
          start: { dateTime: "2025-06-15T09:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2025-06-15T10:00:00.0000000", timeZone: "UTC" },
        },
      ],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=abc123",
    });
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    const result = await client.listEvents("cal_1");

    const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    // Microsoft Graph requires filtered $expand to avoid 400 ErrorGraphExtensionExpandRequiresFilter
    expect(url).toBe(
      `${BASE_URL}/me/calendars/cal_1/events?$expand=Extensions($filter=Id eq 'com.tminus.metadata')`,
    );
  });

  it("returns events mapped to GoogleCalendarEvent shape", async () => {
    const fetchFn = mockFetch({
      value: [
        {
          id: "ms_evt_1",
          subject: "Meeting",
          start: { dateTime: "2025-06-15T09:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2025-06-15T10:00:00.0000000", timeZone: "UTC" },
        },
      ],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=new_delta",
    });
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    const result = await client.listEvents("cal_1");

    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe("ms_evt_1");
    expect(result.nextSyncToken).toBe("https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=new_delta");
  });

  it("uses deltaLink URL directly when syncToken is provided (incremental sync)", async () => {
    const deltaUrl = "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=prev_token";
    const fetchFn = mockFetch({
      value: [
        {
          id: "ms_evt_changed",
          subject: "Updated event",
          start: { dateTime: "2025-06-15T11:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2025-06-15T12:00:00.0000000", timeZone: "UTC" },
        },
      ],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=new_token",
    });
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    const result = await client.listEvents("cal_1", deltaUrl);

    const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(deltaUrl);
    expect(result.events).toHaveLength(1);
    expect(result.nextSyncToken).toBe("https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=new_token");
  });

  it("handles pagination via @odata.nextLink (skipToken)", async () => {
    const fetchFn = mockFetch({
      value: [
        {
          id: "ms_evt_page1",
          subject: "Page 1",
          start: { dateTime: "2025-06-15T09:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2025-06-15T10:00:00.0000000", timeZone: "UTC" },
        },
      ],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendars/cal_1/events?$skiptoken=page2",
    });
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    const result = await client.listEvents("cal_1");

    expect(result.events).toHaveLength(1);
    expect(result.nextPageToken).toBe("https://graph.microsoft.com/v1.0/me/calendars/cal_1/events?$skiptoken=page2");
    expect(result.nextSyncToken).toBeUndefined();
  });

  it("uses pageToken URL directly when pageToken is provided", async () => {
    const pageUrl = "https://graph.microsoft.com/v1.0/me/calendars/cal_1/events?$skiptoken=page2";
    const fetchFn = mockFetch({
      value: [
        {
          id: "ms_evt_page2",
          subject: "Page 2",
          start: { dateTime: "2025-06-15T09:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2025-06-15T10:00:00.0000000", timeZone: "UTC" },
        },
      ],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=final",
    });
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    const result = await client.listEvents("cal_1", undefined, pageUrl);

    const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(pageUrl);
  });

  it("includes filtered $expand=Extensions in default URL to avoid Graph API 400 error", async () => {
    const fetchFn = mockFetch({
      value: [],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=test",
    });
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    await client.listEvents("cal_special");

    const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    // Must use filtered expand to avoid ErrorGraphExtensionExpandRequiresFilter
    expect(url).toContain("$expand=Extensions($filter=Id eq 'com.tminus.metadata')");
    // Must NOT contain bare $expand=extensions (no filter)
    expect(url).not.toMatch(/\$expand=extensions(?!\()/i);
  });

  it("does NOT modify syncToken (deltaLink) URL -- API returns complete URLs", async () => {
    const deltaUrl =
      "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=prev_token&$expand=Extensions";
    const fetchFn = mockFetch({
      value: [],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=new_token",
    });
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    await client.listEvents("cal_1", deltaUrl);

    const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    // syncToken URL must be used exactly as provided -- no modification
    expect(url).toBe(deltaUrl);
  });

  it("does NOT modify pageToken (nextLink) URL -- API returns complete URLs", async () => {
    const pageUrl =
      "https://graph.microsoft.com/v1.0/me/calendars/cal_1/events?$skiptoken=page2&$expand=Extensions";
    const fetchFn = mockFetch({
      value: [],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=final",
    });
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    await client.listEvents("cal_1", undefined, pageUrl);

    const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    // pageToken URL must be used exactly as provided -- no modification
    expect(url).toBe(pageUrl);
  });

  it("returns empty events array when value is missing", async () => {
    const fetchFn = mockFetch({
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=empty",
    });
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    const result = await client.listEvents("cal_1");

    expect(result.events).toEqual([]);
    expect(result.nextSyncToken).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// MicrosoftCalendarClient.insertEvent
// ---------------------------------------------------------------------------

describe("MicrosoftCalendarClient.insertEvent", () => {
  it("sends POST to /me/calendars/{id}/events with correct body", async () => {
    const fetchFn = mockFetch({ id: "ms_new_evt_123" });
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);
    const event = sampleProjectedEvent();

    const eventId = await client.insertEvent("cal_1", event);

    expect(eventId).toBe("ms_new_evt_123");

    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/me/calendars/cal_1/events`);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");

    const sentBody = JSON.parse(init.body);
    // ProjectedEvent fields are mapped to Microsoft format
    expect(sentBody.subject).toBe("Busy");
    expect(sentBody.start).toBeDefined();
    expect(sentBody.end).toBeDefined();
  });

  it("maps ProjectedEvent to Microsoft Graph event format", async () => {
    const fetchFn = mockFetch({ id: "ms_evt_mapped" });
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);
    const event: ProjectedEvent = {
      summary: "Test Meeting",
      description: "A description",
      location: "Room 42",
      start: { dateTime: "2025-06-15T09:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2025-06-15T10:00:00Z", timeZone: "UTC" },
      transparency: "opaque",
      visibility: "private",
      extendedProperties: {
        private: {
          tminus: "true",
          managed: "true",
          canonical_event_id: "evt_01HXYZ000012345678901234AB",
          origin_account_id: "acc_01HXYZ000012345678901234AB",
        },
      },
    };

    await client.insertEvent("cal_1", event);

    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    const sentBody = JSON.parse(init.body);
    expect(sentBody.subject).toBe("Test Meeting");
    expect(sentBody.body).toEqual({ contentType: "text", content: "A description" });
    expect(sentBody.location).toEqual({ displayName: "Room 42" });
    expect(sentBody.start).toEqual({ dateTime: "2025-06-15T09:00:00Z", timeZone: "UTC" });
    expect(sentBody.end).toEqual({ dateTime: "2025-06-15T10:00:00Z", timeZone: "UTC" });
    expect(sentBody.showAs).toBe("busy");
    expect(sentBody.sensitivity).toBe("private");
  });

  it("includes T-Minus open extension for managed markers", async () => {
    const fetchFn = mockFetch({ id: "ms_evt_ext" });
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);
    const event = sampleProjectedEvent();

    await client.insertEvent("cal_1", event);

    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    const sentBody = JSON.parse(init.body);
    expect(sentBody.extensions).toBeDefined();
    expect(sentBody.extensions).toHaveLength(1);
    expect(sentBody.extensions[0]["@odata.type"]).toBe("microsoft.graph.openExtension");
    expect(sentBody.extensions[0].extensionName).toBe("com.tminus.metadata");
    expect(sentBody.extensions[0].tminus).toBe("true");
    expect(sentBody.extensions[0].managed).toBe("true");
    expect(sentBody.extensions[0].canonicalId).toBe("evt_01HXYZ000012345678901234AB");
    expect(sentBody.extensions[0].originAccount).toBe("acc_01HXYZ000012345678901234AB");
  });

  it("sends Authorization header", async () => {
    const fetchFn = mockFetch({ id: "evt_id" });
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    await client.insertEvent("cal_1", sampleProjectedEvent());

    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${TEST_TOKEN}`);
  });
});

// ---------------------------------------------------------------------------
// MicrosoftCalendarClient.patchEvent
// ---------------------------------------------------------------------------

describe("MicrosoftCalendarClient.patchEvent", () => {
  it("sends PATCH to /me/events/{id} with correct body", async () => {
    const fetchFn = mockFetch({ id: "ms_evt_123", subject: "Updated" });
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    const patch: Partial<ProjectedEvent> = {
      summary: "Updated meeting",
      start: { dateTime: "2025-06-15T10:00:00Z", timeZone: "UTC" },
    };
    await client.patchEvent("cal_1", "ms_evt_123", patch);

    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/me/events/ms_evt_123`);
    expect(init.method).toBe("PATCH");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");

    const sentBody = JSON.parse(init.body);
    expect(sentBody.subject).toBe("Updated meeting");
  });

  it("returns void (no return value)", async () => {
    const fetchFn = mockFetch({ id: "ms_evt_123" });
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    const result = await client.patchEvent("cal_1", "ms_evt_123", { summary: "New" });

    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MicrosoftCalendarClient.deleteEvent
// ---------------------------------------------------------------------------

describe("MicrosoftCalendarClient.deleteEvent", () => {
  it("sends DELETE to /me/events/{id}", async () => {
    const fetchFn = mockFetch204();
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    await client.deleteEvent("cal_1", "ms_evt_to_delete");

    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/me/events/ms_evt_to_delete`);
    expect(init.method).toBe("DELETE");
  });

  it("returns void on 204 No Content", async () => {
    const fetchFn = mockFetch204();
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    const result = await client.deleteEvent("cal_1", "ms_evt_123");

    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MicrosoftCalendarClient.insertCalendar
// ---------------------------------------------------------------------------

describe("MicrosoftCalendarClient.insertCalendar", () => {
  it("sends POST to /me/calendars with name and returns calendar ID", async () => {
    const fetchFn = mockFetch({ id: "new_ms_cal_123" });
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    const calId = await client.insertCalendar("T-Minus Busy Overlay");

    expect(calId).toBe("new_ms_cal_123");

    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/me/calendars`);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");

    const sentBody = JSON.parse(init.body);
    expect(sentBody).toEqual({ name: "T-Minus Busy Overlay" });
  });
});

// ---------------------------------------------------------------------------
// MicrosoftCalendarClient.watchEvents
// ---------------------------------------------------------------------------

describe("MicrosoftCalendarClient.watchEvents", () => {
  it("sends POST to /subscriptions with correct body", async () => {
    const fetchFn = mockFetch({
      id: "sub_abc123",
      resource: "/me/calendars/cal_1/events",
      expirationDateTime: "2025-06-18T09:00:00Z",
    });
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    const result = await client.watchEvents(
      "cal_1",
      "https://api.tminus.app/webhook/microsoft",
      "channel_unused", // channelId is not used for Microsoft (subscriptions use subscriptionId)
      "client_state_secret",
    );

    expect(result.channelId).toBe("sub_abc123"); // subscriptionId mapped to channelId
    expect(result.resourceId).toBe("/me/calendars/cal_1/events");
    expect(result.expiration).toBe("2025-06-18T09:00:00Z");

    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/subscriptions`);
    expect(init.method).toBe("POST");

    const sentBody = JSON.parse(init.body);
    expect(sentBody.changeType).toBe("created,updated,deleted");
    expect(sentBody.notificationUrl).toBe("https://api.tminus.app/webhook/microsoft");
    expect(sentBody.resource).toBe(`/me/calendars/cal_1/events`);
    expect(sentBody.clientState).toBe("client_state_secret");
    expect(sentBody.expirationDateTime).toBeDefined();
  });

  it("sets expirationDateTime to ~3 days from now", async () => {
    const fetchFn = mockFetch({
      id: "sub_123",
      resource: "/me/calendars/cal_1/events",
      expirationDateTime: "2025-06-18T09:00:00Z",
    });
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    await client.watchEvents("cal_1", "https://hook.test", "ch", "secret");

    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    const sentBody = JSON.parse(init.body);
    const expiration = new Date(sentBody.expirationDateTime);
    const now = new Date();
    const diffMs = expiration.getTime() - now.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);

    // Should be approximately 3 days (between 2.9 and 3.1 to account for test timing)
    expect(diffDays).toBeGreaterThan(2.9);
    expect(diffDays).toBeLessThan(3.1);
  });
});

// ---------------------------------------------------------------------------
// MicrosoftCalendarClient.stopChannel
// ---------------------------------------------------------------------------

describe("MicrosoftCalendarClient.stopChannel", () => {
  it("sends DELETE to /subscriptions/{subscriptionId}", async () => {
    const fetchFn = mockFetch204();
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    await client.stopChannel("sub_abc123", "resource_unused");

    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/subscriptions/sub_abc123`);
    expect(init.method).toBe("DELETE");
  });

  it("returns void on success", async () => {
    const fetchFn = mockFetch204();
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    const result = await client.stopChannel("sub_1", "res_unused");

    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("MicrosoftCalendarClient -- error handling", () => {
  it("throws MicrosoftTokenExpiredError on 401", async () => {
    const fetchFn = mockFetchError(401, "Unauthorized");
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    await expect(client.listCalendars()).rejects.toThrow(MicrosoftTokenExpiredError);

    try {
      await client.listCalendars();
    } catch (err) {
      expect(err).toBeInstanceOf(MicrosoftTokenExpiredError);
      expect(err).toBeInstanceOf(MicrosoftApiError);
      expect((err as MicrosoftTokenExpiredError).statusCode).toBe(401);
    }
  });

  it("throws MicrosoftResourceNotFoundError on 404", async () => {
    const fetchFn = mockFetchError(404, "Not Found");
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    await expect(client.deleteEvent("cal_1", "nonexistent")).rejects.toThrow(
      MicrosoftResourceNotFoundError,
    );
  });

  it("throws MicrosoftRateLimitError on 429", async () => {
    const fetchFn = mockFetchError(429, "Throttled", { "Retry-After": "30" });
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    await expect(client.listCalendars()).rejects.toThrow(MicrosoftRateLimitError);

    try {
      await client.listCalendars();
    } catch (err) {
      expect(err).toBeInstanceOf(MicrosoftRateLimitError);
      expect((err as MicrosoftRateLimitError).retryAfterSeconds).toBe(30);
    }
  });

  it("throws MicrosoftApiError on 403 Forbidden", async () => {
    const fetchFn = mockFetchError(403, "Forbidden");
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    await expect(client.listCalendars()).rejects.toThrow(MicrosoftApiError);

    try {
      await client.listCalendars();
    } catch (err) {
      expect(err).toBeInstanceOf(MicrosoftApiError);
      expect(err).not.toBeInstanceOf(MicrosoftTokenExpiredError);
      expect((err as MicrosoftApiError).statusCode).toBe(403);
    }
  });

  it("throws MicrosoftApiError on 500 with plain text body", async () => {
    const fetchFn = mockFetchError(500, "<html>Internal Server Error</html>");
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    await expect(client.listCalendars()).rejects.toThrow(MicrosoftApiError);

    try {
      await client.listCalendars();
    } catch (err) {
      expect((err as MicrosoftApiError).statusCode).toBe(500);
      // Should contain the raw text, not crash on JSON.parse
      expect((err as MicrosoftApiError).message).toContain("Internal Server Error");
    }
  });

  it("handles non-JSON 502 gateway error gracefully", async () => {
    const fetchFn = mockFetchError(502, "Bad Gateway");
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    await expect(client.listEvents("cal_1")).rejects.toThrow(MicrosoftApiError);

    try {
      await client.listEvents("cal_1");
    } catch (err) {
      expect((err as MicrosoftApiError).statusCode).toBe(502);
      expect((err as MicrosoftApiError).message).toContain("Bad Gateway");
    }
  });

  it("handles non-JSON 503 gateway error gracefully", async () => {
    const fetchFn = mockFetchError(503, "<html><body>Service Unavailable</body></html>");
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    await expect(client.insertCalendar("Test")).rejects.toThrow(MicrosoftApiError);

    try {
      await client.insertCalendar("Test");
    } catch (err) {
      expect((err as MicrosoftApiError).statusCode).toBe(503);
      expect((err as MicrosoftApiError).message).toContain("Service Unavailable");
    }
  });

  it("extracts error message from JSON error response", async () => {
    const jsonError = JSON.stringify({
      error: { code: "InvalidAuthenticationToken", message: "Access token has expired." },
    });
    const fetchFn = mockFetchError(401, jsonError, { "Content-Type": "application/json" });
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    try {
      await client.listCalendars();
    } catch (err) {
      expect(err).toBeInstanceOf(MicrosoftTokenExpiredError);
      // Should extract the structured error message
      expect((err as MicrosoftApiError).message).toContain("Access token has expired");
    }
  });
});

// ---------------------------------------------------------------------------
// CalendarProvider interface compliance
// ---------------------------------------------------------------------------

describe("MicrosoftCalendarClient -- CalendarProvider interface", () => {
  it("implements CalendarProvider interface", () => {
    const fetchFn = mockFetch({});
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);

    // Type-level check: assign to CalendarProvider
    const provider: CalendarProvider = client;

    // Runtime check: all methods exist and are functions
    expect(typeof provider.listEvents).toBe("function");
    expect(typeof provider.insertEvent).toBe("function");
    expect(typeof provider.patchEvent).toBe("function");
    expect(typeof provider.deleteEvent).toBe("function");
    expect(typeof provider.listCalendars).toBe("function");
    expect(typeof provider.insertCalendar).toBe("function");
    expect(typeof provider.watchEvents).toBe("function");
    expect(typeof provider.stopChannel).toBe("function");
  });

  it("can be used polymorphically via CalendarProvider", async () => {
    const fetchFn = mockFetch({
      value: [
        {
          id: "ms_evt_1",
          subject: "Test Event",
          start: { dateTime: "2025-06-15T09:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2025-06-15T10:00:00.0000000", timeZone: "UTC" },
        },
      ],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=abc",
    });

    const provider: CalendarProvider = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn);
    const result = await provider.listEvents("cal_1");

    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe("ms_evt_1");
  });
});

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe("MicrosoftCalendarClient -- constructor", () => {
  it("uses provided fetchFn instead of globalThis.fetch", async () => {
    const customFetch = mockFetch({ value: [] });
    const client = new MicrosoftCalendarClient(TEST_TOKEN, customFetch);

    await client.listCalendars();

    expect(customFetch).toHaveBeenCalledTimes(1);
  });

  it("uses access token in Authorization header for every request", async () => {
    const fetchFn = mockFetch({ id: "cal_1" });
    const client = new MicrosoftCalendarClient("my_special_ms_token", fetchFn);

    await client.insertCalendar("Test Cal");

    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer my_special_ms_token");
  });

  it("can be created without rate limiter (no rate limiting)", async () => {
    const fetchFn = mockFetch({ value: [] });
    const client = new MicrosoftCalendarClient(TEST_TOKEN, fetchFn, { enableRateLimiting: false });

    await client.listCalendars();

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
