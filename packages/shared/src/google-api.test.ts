/**
 * @tminus/shared -- Unit tests for Google Calendar API abstraction layer.
 *
 * All tests use a mock FetchFn to verify:
 * - Correct URL construction and HTTP methods
 * - Request body serialization
 * - Authorization header injection
 * - Response parsing and type mapping
 * - Pagination handling (pageToken/syncToken)
 * - Error mapping (401, 404, 410, 429, general)
 * - CalendarProvider interface compliance
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProjectedEvent, EventDateTime } from "./types";
import {
  GoogleCalendarClient,
  type FetchFn,
  type CalendarProvider,
  type ListEventsResponse,
  type CalendarListEntry,
  type WatchResponse,
  GoogleApiError,
  TokenExpiredError,
  ResourceNotFoundError,
  SyncTokenExpiredError,
  RateLimitError,
} from "./google-api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_TOKEN = "ya29.test-access-token-abc123";
const BASE_URL = "https://www.googleapis.com/calendar/v3";

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
function mockFetchError(status: number, body = "Error"): FetchFn {
  return vi.fn(async () =>
    new Response(body, { status }),
  );
}

/** Build a mock FetchFn that returns 204 No Content. */
function mockFetch204(): FetchFn {
  return vi.fn(async () =>
    new Response(null, { status: 204 }),
  );
}

/**
 * Build a mock FetchFn that returns different responses on successive calls.
 * Each element in `responses` is returned in order; extra calls return the last response.
 */
function mockFetchSequence(responses: unknown[]): FetchFn {
  let callIndex = 0;
  return vi.fn(async () => {
    const body = responses[Math.min(callIndex, responses.length - 1)];
    callIndex++;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
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
// listEvents
// ---------------------------------------------------------------------------

describe("GoogleCalendarClient.listEvents", () => {
  it("sends GET with Authorization header to correct URL", async () => {
    const fetchFn = mockFetch({ items: [], nextSyncToken: "sync_abc" });
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    await client.listEvents("primary");

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/calendars/primary/events?`);
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${TEST_TOKEN}`);
  });

  it("returns events array from items", async () => {
    const items = [
      {
        id: "evt_google_1",
        summary: "Meeting",
        start: { dateTime: "2025-06-15T09:00:00Z" },
        end: { dateTime: "2025-06-15T10:00:00Z" },
      },
      {
        id: "evt_google_2",
        summary: "Lunch",
        start: { date: "2025-06-15" },
        end: { date: "2025-06-16" },
      },
    ];
    const fetchFn = mockFetch({ items, nextSyncToken: "sync_xyz" });
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    const result = await client.listEvents("primary");

    expect(result.events).toHaveLength(2);
    expect(result.events[0].id).toBe("evt_google_1");
    expect(result.events[0].summary).toBe("Meeting");
    expect(result.events[0].start?.dateTime).toBe("2025-06-15T09:00:00Z");
    // All-day event
    expect(result.events[1].id).toBe("evt_google_2");
    expect(result.events[1].start?.date).toBe("2025-06-15");
    expect(result.nextSyncToken).toBe("sync_xyz");
  });

  it("returns empty events array when items is undefined", async () => {
    const fetchFn = mockFetch({ nextSyncToken: "sync_empty" });
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    const result = await client.listEvents("primary");

    expect(result.events).toEqual([]);
    expect(result.nextSyncToken).toBe("sync_empty");
  });

  it("auto-paginates through all pages and returns final nextSyncToken", async () => {
    const fetchFn = mockFetchSequence([
      {
        items: [{ id: "evt_1", summary: "Page 1 event" }],
        nextPageToken: "page_token_2",
      },
      {
        items: [{ id: "evt_2", summary: "Page 2 event" }],
        nextPageToken: "page_token_3",
      },
      {
        items: [{ id: "evt_3", summary: "Page 3 event" }],
        nextSyncToken: "sync_final",
      },
    ]);
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    const result = await client.listEvents("primary");

    // All events from all pages are accumulated
    expect(result.events).toHaveLength(3);
    expect(result.events[0].id).toBe("evt_1");
    expect(result.events[1].id).toBe("evt_2");
    expect(result.events[2].id).toBe("evt_3");
    // nextSyncToken comes from the last page
    expect(result.nextSyncToken).toBe("sync_final");
    // nextPageToken is undefined since all pages were consumed
    expect(result.nextPageToken).toBeUndefined();
    // Verify 3 fetch calls were made
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("passes pageToken query parameter on subsequent pagination requests", async () => {
    const fetchFn = mockFetchSequence([
      {
        items: [{ id: "evt_1" }],
        nextPageToken: "page_tok_2",
      },
      {
        items: [{ id: "evt_2" }],
        nextSyncToken: "sync_done",
      },
    ]);
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    await client.listEvents("primary");

    // Second call should include the pageToken from the first response
    const [url2] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(url2).toContain("pageToken=page_tok_2");
  });

  it("uses caller-provided pageToken on initial request and continues paginating", async () => {
    // When caller provides a pageToken (e.g., resuming from a known page),
    // it is used for the first request. Pagination continues from there.
    const fetchFn = mockFetchSequence([
      {
        items: [{ id: "evt_mid" }],
        nextPageToken: "page_token_3",
      },
      {
        items: [{ id: "evt_last" }],
        nextSyncToken: "sync_final",
      },
    ]);
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    const result = await client.listEvents("primary", undefined, "page_token_2");

    const [url1] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url1).toContain("pageToken=page_token_2");

    const [url2] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(url2).toContain("pageToken=page_token_3");

    expect(result.events).toHaveLength(2);
    expect(result.nextSyncToken).toBe("sync_final");
  });

  it("sends syncToken as query parameter for incremental sync", async () => {
    const fetchFn = mockFetch({
      items: [{ id: "evt_changed", summary: "Updated event" }],
      nextSyncToken: "sync_new",
    });
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    const result = await client.listEvents("primary", "sync_old");

    const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("syncToken=sync_old");
    expect(result.events).toHaveLength(1);
    expect(result.nextSyncToken).toBe("sync_new");
  });

  it("sends both syncToken and pageToken when both provided on first request", async () => {
    const fetchFn = mockFetch({ items: [], nextSyncToken: "sync_final" });
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    await client.listEvents("primary", "sync_tok", "page_tok");

    const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("syncToken=sync_tok");
    expect(url).toContain("pageToken=page_tok");
  });

  it("auto-paginates incremental sync through all pages", async () => {
    // When incremental sync returns paginated results, listEvents should
    // follow all pages and return the nextSyncToken from the last page.
    const fetchFn = mockFetchSequence([
      {
        items: [{ id: "evt_changed_1", summary: "Changed 1" }],
        nextPageToken: "inc_page_2",
      },
      {
        items: [{ id: "evt_changed_2", summary: "Changed 2" }],
        nextSyncToken: "sync_new_token",
      },
    ]);
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    const result = await client.listEvents("primary", "sync_old_token");

    // First request should include syncToken
    const [url1] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url1).toContain("syncToken=sync_old_token");
    expect(url1).not.toContain("pageToken");

    // Second request should include syncToken AND pageToken from first response
    const [url2] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(url2).toContain("syncToken=sync_old_token");
    expect(url2).toContain("pageToken=inc_page_2");

    // All events accumulated
    expect(result.events).toHaveLength(2);
    expect(result.events[0].id).toBe("evt_changed_1");
    expect(result.events[1].id).toBe("evt_changed_2");
    // Final syncToken from last page
    expect(result.nextSyncToken).toBe("sync_new_token");
    expect(result.nextPageToken).toBeUndefined();
  });

  it("single-page response returns immediately without extra requests", async () => {
    const fetchFn = mockFetch({
      items: [{ id: "evt_1", summary: "Only event" }],
      nextSyncToken: "sync_single",
    });
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    const result = await client.listEvents("primary");

    expect(result.events).toHaveLength(1);
    expect(result.nextSyncToken).toBe("sync_single");
    expect(result.nextPageToken).toBeUndefined();
    // Only one fetch call -- no unnecessary pagination
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("throws SyncTokenExpiredError on 410 Gone", async () => {
    const fetchFn = mockFetchError(410, "Token expired");
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    await expect(client.listEvents("primary", "stale_sync_token")).rejects.toThrow(
      SyncTokenExpiredError,
    );
  });

  it("encodes calendarId in URL", async () => {
    const fetchFn = mockFetch({ items: [] });
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    await client.listEvents("user@example.com");

    const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("calendars/user%40example.com/events");
  });

  it("handles all-day events (date field instead of dateTime)", async () => {
    const items = [
      {
        id: "allday_1",
        summary: "Vacation",
        start: { date: "2025-07-01" },
        end: { date: "2025-07-08" },
      },
    ];
    const fetchFn = mockFetch({ items, nextSyncToken: "s1" });
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    const result = await client.listEvents("primary");

    expect(result.events[0].start?.date).toBe("2025-07-01");
    expect(result.events[0].start?.dateTime).toBeUndefined();
    expect(result.events[0].end?.date).toBe("2025-07-08");
  });
});

// ---------------------------------------------------------------------------
// insertEvent
// ---------------------------------------------------------------------------

describe("GoogleCalendarClient.insertEvent", () => {
  it("sends POST with correct body and returns event ID", async () => {
    const fetchFn = mockFetch({ id: "google_evt_new_123" });
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);
    const event = sampleProjectedEvent();

    const eventId = await client.insertEvent("primary", event);

    expect(eventId).toBe("google_evt_new_123");

    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/calendars/primary/events`);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");

    const sentBody = JSON.parse(init.body);
    expect(sentBody.summary).toBe("Busy");
    expect(sentBody.start.dateTime).toBe("2025-06-15T09:00:00Z");
    expect(sentBody.extendedProperties.private.tminus).toBe("true");
    expect(sentBody.extendedProperties.private.managed).toBe("true");
  });

  it("sends Authorization header", async () => {
    const fetchFn = mockFetch({ id: "evt_id" });
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    await client.insertEvent("primary", sampleProjectedEvent());

    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${TEST_TOKEN}`);
  });

  it("encodes calendarId in URL", async () => {
    const fetchFn = mockFetch({ id: "evt_id" });
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    await client.insertEvent("special/calendar@id.com", sampleProjectedEvent());

    const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("calendars/special%2Fcalendar%40id.com/events");
  });
});

// ---------------------------------------------------------------------------
// patchEvent
// ---------------------------------------------------------------------------

describe("GoogleCalendarClient.patchEvent", () => {
  it("sends PATCH with correct body to correct URL", async () => {
    const fetchFn = mockFetch({ id: "evt_123", summary: "Updated" });
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    const patch: Partial<ProjectedEvent> = {
      summary: "Updated meeting",
      start: { dateTime: "2025-06-15T10:00:00Z" },
    };
    await client.patchEvent("primary", "evt_123", patch);

    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/calendars/primary/events/evt_123`);
    expect(init.method).toBe("PATCH");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");

    const sentBody = JSON.parse(init.body);
    expect(sentBody.summary).toBe("Updated meeting");
    expect(sentBody.start.dateTime).toBe("2025-06-15T10:00:00Z");
  });

  it("returns void (no return value)", async () => {
    const fetchFn = mockFetch({ id: "evt_123" });
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    const result = await client.patchEvent("primary", "evt_123", { summary: "New" });

    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deleteEvent
// ---------------------------------------------------------------------------

describe("GoogleCalendarClient.deleteEvent", () => {
  it("sends DELETE to correct URL", async () => {
    const fetchFn = mockFetch204();
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    await client.deleteEvent("primary", "evt_to_delete");

    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/calendars/primary/events/evt_to_delete`);
    expect(init.method).toBe("DELETE");
  });

  it("returns void on 204 No Content", async () => {
    const fetchFn = mockFetch204();
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    const result = await client.deleteEvent("primary", "evt_123");

    expect(result).toBeUndefined();
  });

  it("encodes eventId in URL", async () => {
    const fetchFn = mockFetch204();
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    await client.deleteEvent("primary", "evt/special@id");

    const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("events/evt%2Fspecial%40id");
  });
});

// ---------------------------------------------------------------------------
// listCalendars
// ---------------------------------------------------------------------------

describe("GoogleCalendarClient.listCalendars", () => {
  it("sends GET to calendarList endpoint and returns mapped entries", async () => {
    const items = [
      { id: "primary", summary: "Primary Calendar", primary: true, accessRole: "owner" },
      { id: "cal_work", summary: "Work", accessRole: "writer" },
      { id: "cal_holiday", summary: "Holidays", accessRole: "reader" },
    ];
    const fetchFn = mockFetch({ items });
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    const calendars = await client.listCalendars();

    expect(calendars).toHaveLength(3);
    expect(calendars[0]).toEqual({
      id: "primary",
      summary: "Primary Calendar",
      primary: true,
      accessRole: "owner",
    });
    expect(calendars[1]).toEqual({
      id: "cal_work",
      summary: "Work",
      primary: undefined,
      accessRole: "writer",
    });

    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/users/me/calendarList`);
    expect(init.method).toBe("GET");
  });

  it("returns empty array when items is undefined", async () => {
    const fetchFn = mockFetch({});
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    const calendars = await client.listCalendars();

    expect(calendars).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// insertCalendar
// ---------------------------------------------------------------------------

describe("GoogleCalendarClient.insertCalendar", () => {
  it("sends POST to calendars endpoint with summary and returns calendar ID", async () => {
    const fetchFn = mockFetch({ id: "new_cal_id_123" });
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    const calId = await client.insertCalendar("T-Minus Busy Overlay");

    expect(calId).toBe("new_cal_id_123");

    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/calendars`);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");

    const sentBody = JSON.parse(init.body);
    expect(sentBody).toEqual({ summary: "T-Minus Busy Overlay" });
  });
});

// ---------------------------------------------------------------------------
// watchEvents
// ---------------------------------------------------------------------------

describe("GoogleCalendarClient.watchEvents", () => {
  it("sends watch request and returns channel info", async () => {
    const fetchFn = mockFetch({
      id: "channel_abc",
      resourceId: "resource_xyz",
      expiration: "1750000000000",
    });
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    const result = await client.watchEvents(
      "primary",
      "https://api.tminus.app/webhook",
      "channel_abc",
      "verify_token_123",
    );

    expect(result).toEqual({
      channelId: "channel_abc",
      resourceId: "resource_xyz",
      expiration: "1750000000000",
    });

    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/calendars/primary/events/watch`);
    expect(init.method).toBe("POST");

    const sentBody = JSON.parse(init.body);
    expect(sentBody).toEqual({
      id: "channel_abc",
      type: "web_hook",
      address: "https://api.tminus.app/webhook",
      token: "verify_token_123",
    });
  });
});

// ---------------------------------------------------------------------------
// stopChannel
// ---------------------------------------------------------------------------

describe("GoogleCalendarClient.stopChannel", () => {
  it("sends stop request with channelId and resourceId", async () => {
    const fetchFn = mockFetch204();
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    await client.stopChannel("channel_abc", "resource_xyz");

    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE_URL}/channels/stop`);
    expect(init.method).toBe("POST");

    const sentBody = JSON.parse(init.body);
    expect(sentBody).toEqual({
      id: "channel_abc",
      resourceId: "resource_xyz",
    });
  });

  it("returns void on success", async () => {
    const fetchFn = mockFetch204();
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    const result = await client.stopChannel("ch_1", "res_1");

    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("GoogleCalendarClient -- error handling", () => {
  it("throws TokenExpiredError on 401", async () => {
    const fetchFn = mockFetchError(401, "Unauthorized");
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    await expect(client.listEvents("primary")).rejects.toThrow(TokenExpiredError);

    try {
      await client.listEvents("primary");
    } catch (err) {
      expect(err).toBeInstanceOf(TokenExpiredError);
      expect(err).toBeInstanceOf(GoogleApiError);
      expect((err as TokenExpiredError).statusCode).toBe(401);
      expect((err as TokenExpiredError).message).toBe("Unauthorized");
    }
  });

  it("throws ResourceNotFoundError on 404", async () => {
    const fetchFn = mockFetchError(404, "Calendar not found");
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    await expect(client.deleteEvent("primary", "nonexistent")).rejects.toThrow(
      ResourceNotFoundError,
    );

    try {
      await client.deleteEvent("primary", "nonexistent");
    } catch (err) {
      expect(err).toBeInstanceOf(ResourceNotFoundError);
      expect(err).toBeInstanceOf(GoogleApiError);
      expect((err as ResourceNotFoundError).statusCode).toBe(404);
    }
  });

  it("throws SyncTokenExpiredError on 410 Gone", async () => {
    const fetchFn = mockFetchError(410, "Sync token expired");
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    await expect(client.listEvents("primary", "stale_token")).rejects.toThrow(
      SyncTokenExpiredError,
    );

    try {
      await client.listEvents("primary", "stale_token");
    } catch (err) {
      expect(err).toBeInstanceOf(SyncTokenExpiredError);
      expect(err).toBeInstanceOf(GoogleApiError);
      expect((err as SyncTokenExpiredError).statusCode).toBe(410);
    }
  });

  it("throws RateLimitError on 429", async () => {
    const fetchFn = mockFetchError(429, "Rate limit exceeded");
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    await expect(client.insertEvent("primary", sampleProjectedEvent())).rejects.toThrow(
      RateLimitError,
    );

    try {
      await client.insertEvent("primary", sampleProjectedEvent());
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect(err).toBeInstanceOf(GoogleApiError);
      expect((err as RateLimitError).statusCode).toBe(429);
    }
  });

  it("throws GoogleApiError on other 4xx errors (403)", async () => {
    const fetchFn = mockFetchError(403, "Forbidden");
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    await expect(client.listCalendars()).rejects.toThrow(GoogleApiError);

    try {
      await client.listCalendars();
    } catch (err) {
      expect(err).toBeInstanceOf(GoogleApiError);
      expect(err).not.toBeInstanceOf(TokenExpiredError);
      expect(err).not.toBeInstanceOf(ResourceNotFoundError);
      expect((err as GoogleApiError).statusCode).toBe(403);
      expect((err as GoogleApiError).message).toBe("Forbidden");
    }
  });

  it("throws GoogleApiError on 5xx errors (500)", async () => {
    const fetchFn = mockFetchError(500, "Internal Server Error");
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    await expect(client.patchEvent("primary", "evt_1", { summary: "x" })).rejects.toThrow(
      GoogleApiError,
    );

    try {
      await client.patchEvent("primary", "evt_1", { summary: "x" });
    } catch (err) {
      expect((err as GoogleApiError).statusCode).toBe(500);
      expect((err as GoogleApiError).message).toBe("Internal Server Error");
    }
  });

  it("throws GoogleApiError on 503 Service Unavailable", async () => {
    const fetchFn = mockFetchError(503, "Service Unavailable");
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

    await expect(client.watchEvents("primary", "https://x.com", "ch", "tk")).rejects.toThrow(
      GoogleApiError,
    );

    try {
      await client.watchEvents("primary", "https://x.com", "ch", "tk");
    } catch (err) {
      expect((err as GoogleApiError).statusCode).toBe(503);
    }
  });

  it("error classes have correct inheritance chain", () => {
    const token = new TokenExpiredError();
    const notFound = new ResourceNotFoundError();
    const syncGone = new SyncTokenExpiredError();
    const rateLimit = new RateLimitError();
    const general = new GoogleApiError("test", 418);

    // All extend GoogleApiError
    expect(token).toBeInstanceOf(GoogleApiError);
    expect(notFound).toBeInstanceOf(GoogleApiError);
    expect(syncGone).toBeInstanceOf(GoogleApiError);
    expect(rateLimit).toBeInstanceOf(GoogleApiError);

    // All extend Error
    expect(token).toBeInstanceOf(Error);
    expect(notFound).toBeInstanceOf(Error);
    expect(syncGone).toBeInstanceOf(Error);
    expect(rateLimit).toBeInstanceOf(Error);
    expect(general).toBeInstanceOf(Error);

    // Correct names
    expect(token.name).toBe("TokenExpiredError");
    expect(notFound.name).toBe("ResourceNotFoundError");
    expect(syncGone.name).toBe("SyncTokenExpiredError");
    expect(rateLimit.name).toBe("RateLimitError");
    expect(general.name).toBe("GoogleApiError");

    // Correct status codes
    expect(token.statusCode).toBe(401);
    expect(notFound.statusCode).toBe(404);
    expect(syncGone.statusCode).toBe(410);
    expect(rateLimit.statusCode).toBe(429);
    expect(general.statusCode).toBe(418);
  });

  it("error classes use default messages when none provided", () => {
    expect(new TokenExpiredError().message).toBe("Access token expired or invalid");
    expect(new ResourceNotFoundError().message).toBe("Resource not found");
    expect(new SyncTokenExpiredError().message).toBe("Sync token expired, full sync required");
    expect(new RateLimitError().message).toBe("Rate limited by Google Calendar API");
  });
});

// ---------------------------------------------------------------------------
// Provider interface compliance
// ---------------------------------------------------------------------------

describe("GoogleCalendarClient -- CalendarProvider interface", () => {
  it("implements CalendarProvider interface", () => {
    const fetchFn = mockFetch({});
    const client = new GoogleCalendarClient(TEST_TOKEN, fetchFn);

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
      items: [
        { id: "evt_1", summary: "Test", start: { dateTime: "2025-06-15T09:00:00Z" } },
      ],
      nextSyncToken: "sync_abc",
    });

    // Create via concrete class, use via interface
    const provider: CalendarProvider = new GoogleCalendarClient(TEST_TOKEN, fetchFn);
    const result = await provider.listEvents("primary");

    expect(result.events).toHaveLength(1);
    expect(result.events[0].summary).toBe("Test");
  });
});

// ---------------------------------------------------------------------------
// Constructor and fetch injection
// ---------------------------------------------------------------------------

describe("GoogleCalendarClient -- constructor", () => {
  it("uses provided fetchFn instead of globalThis.fetch", async () => {
    const customFetch = mockFetch({ items: [] });
    const client = new GoogleCalendarClient(TEST_TOKEN, customFetch);

    await client.listEvents("primary");

    expect(customFetch).toHaveBeenCalledTimes(1);
  });

  it("uses access token in Authorization header for every request", async () => {
    const fetchFn = mockFetch({ id: "cal_1" });
    const client = new GoogleCalendarClient("my_special_token", fetchFn);

    await client.insertCalendar("Test Cal");

    const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer my_special_token");
  });
});
