/**
 * Unit tests for MicrosoftTestClient.
 *
 * Tests the test client itself using mocked fetch responses,
 * parallel to google-test-client.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import {
  MicrosoftTestClient,
  buildTokenRefreshBody,
  buildEventPayload,
} from "./microsoft-test-client";

// ---------------------------------------------------------------------------
// buildTokenRefreshBody
// ---------------------------------------------------------------------------

describe("buildTokenRefreshBody", () => {
  it("produces correct URL-encoded form body", () => {
    const body = buildTokenRefreshBody({
      clientId: "test-client-id",
      clientSecret: "test-secret",
      refreshToken: "test-refresh-token",
    });

    const params = new URLSearchParams(body);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("client_id")).toBe("test-client-id");
    expect(params.get("client_secret")).toBe("test-secret");
    expect(params.get("refresh_token")).toBe("test-refresh-token");
    expect(params.get("scope")).toBe(
      "Calendars.ReadWrite User.Read offline_access",
    );
  });
});

// ---------------------------------------------------------------------------
// buildEventPayload
// ---------------------------------------------------------------------------

describe("buildEventPayload", () => {
  it("produces a Microsoft Graph event with [tminus-test] prefix", () => {
    const payload = buildEventPayload({
      summary: "My Meeting",
      startTime: "2025-06-15T14:00:00Z",
      endTime: "2025-06-15T15:00:00Z",
    });

    expect(payload.subject).toBe("[tminus-test] My Meeting");
    expect(payload.body).toEqual({
      contentType: "text",
      content:
        "Created by tminus integration test. Safe to delete if found orphaned.",
    });
    expect(payload.start).toEqual({
      dateTime: "2025-06-15T14:00:00Z",
      timeZone: "UTC",
    });
    expect(payload.end).toEqual({
      dateTime: "2025-06-15T15:00:00Z",
      timeZone: "UTC",
    });
    expect(payload.showAs).toBe("busy");
  });
});

// ---------------------------------------------------------------------------
// MicrosoftTestClient -- token management
// ---------------------------------------------------------------------------

describe("MicrosoftTestClient", () => {
  function createMockFetch(responses: Array<{ status: number; body: unknown }>) {
    let callIndex = 0;
    return vi.fn(async () => {
      const resp = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return {
        ok: resp.status >= 200 && resp.status < 300,
        status: resp.status,
        json: async () => resp.body,
        text: async () => JSON.stringify(resp.body),
      } as unknown as Response;
    });
  }

  it("refreshAccessToken exchanges refresh token for access token", async () => {
    const mockFetch = createMockFetch([
      {
        status: 200,
        body: { access_token: "new-access-token", expires_in: 3600 },
      },
    ]);

    const client = new MicrosoftTestClient({
      clientId: "test-id",
      clientSecret: "test-secret",
      refreshToken: "test-refresh",
      fetchFn: mockFetch,
    });

    const token = await client.refreshAccessToken();
    expect(token).toBe("new-access-token");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Verify it called the correct token endpoint
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("login.microsoftonline.com");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("refreshAccessToken throws on non-200 response", async () => {
    const mockFetch = createMockFetch([
      {
        status: 400,
        body: { error: "invalid_grant" },
      },
    ]);

    const client = new MicrosoftTestClient({
      clientId: "test-id",
      clientSecret: "test-secret",
      refreshToken: "bad-refresh",
      fetchFn: mockFetch,
    });

    await expect(client.refreshAccessToken()).rejects.toThrow(
      "Microsoft token refresh failed",
    );
  });

  // -------------------------------------------------------------------------
  // Calendar operations
  // -------------------------------------------------------------------------

  it("createTestEvent creates event and returns normalized shape", async () => {
    const mockFetch = createMockFetch([
      // Token refresh
      {
        status: 200,
        body: { access_token: "access-token", expires_in: 3600 },
      },
      // List calendars (to resolve 'primary')
      {
        status: 200,
        body: {
          value: [
            { id: "cal-123", name: "Calendar", isDefaultCalendar: true },
          ],
        },
      },
      // Create event
      {
        status: 201,
        body: {
          id: "event-abc",
          subject: "[tminus-test] Test Event",
          start: { dateTime: "2025-06-15T14:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2025-06-15T15:00:00.0000000", timeZone: "UTC" },
          showAs: "busy",
        },
      },
    ]);

    const client = new MicrosoftTestClient({
      clientId: "test-id",
      clientSecret: "test-secret",
      refreshToken: "test-refresh",
      fetchFn: mockFetch,
    });

    const event = await client.createTestEvent({
      calendarId: "primary",
      summary: "Test Event",
      startTime: "2025-06-15T14:00:00Z",
      endTime: "2025-06-15T15:00:00Z",
    });

    expect(event.id).toBe("event-abc");
    expect(event.summary).toBe("[tminus-test] Test Event");
    expect(event.status).toBe("confirmed");
  });

  it("deleteTestEvent sends DELETE to /me/events/{id}", async () => {
    const mockFetch = createMockFetch([
      // Token refresh
      {
        status: 200,
        body: { access_token: "access-token", expires_in: 3600 },
      },
      // Delete event (204 No Content)
      {
        status: 204,
        body: null,
      },
    ]);

    const client = new MicrosoftTestClient({
      clientId: "test-id",
      clientSecret: "test-secret",
      refreshToken: "test-refresh",
      fetchFn: mockFetch,
    });

    // Should not throw
    await client.deleteTestEvent({
      calendarId: "primary",
      eventId: "event-to-delete",
    });

    // Verify DELETE was called
    const deleteCall = mockFetch.mock.calls[1];
    const [url, init] = deleteCall;
    expect(url).toContain("/me/events/event-to-delete");
    expect((init as RequestInit).method).toBe("DELETE");
  });

  it("listEvents uses calendarView for time-bounded queries", async () => {
    const mockFetch = createMockFetch([
      // Token refresh
      {
        status: 200,
        body: { access_token: "access-token", expires_in: 3600 },
      },
      // Resolve calendar ID
      {
        status: 200,
        body: {
          value: [{ id: "cal-123", name: "Calendar", isDefaultCalendar: true }],
        },
      },
      // List events
      {
        status: 200,
        body: {
          value: [
            {
              id: "evt-1",
              subject: "Meeting 1",
              start: { dateTime: "2025-06-15T14:00:00.0000000", timeZone: "UTC" },
              end: { dateTime: "2025-06-15T15:00:00.0000000", timeZone: "UTC" },
              showAs: "busy",
            },
          ],
        },
      },
    ]);

    const client = new MicrosoftTestClient({
      clientId: "test-id",
      clientSecret: "test-secret",
      refreshToken: "test-refresh",
      fetchFn: mockFetch,
    });

    const events = await client.listEvents({
      calendarId: "primary",
      timeMin: "2025-06-15T00:00:00Z",
      timeMax: "2025-06-16T00:00:00Z",
    });

    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("evt-1");
    expect(events[0].summary).toBe("Meeting 1");

    // Verify calendarView was used
    const listCall = mockFetch.mock.calls[2];
    expect(listCall[0]).toContain("calendarView");
  });

  it("cleanupAllTestEvents deletes all tracked events", async () => {
    const mockFetch = createMockFetch([
      // Token refresh
      {
        status: 200,
        body: { access_token: "access-token", expires_in: 3600 },
      },
      // Resolve calendar ID
      {
        status: 200,
        body: {
          value: [{ id: "cal-123", name: "Calendar", isDefaultCalendar: true }],
        },
      },
      // Create event 1
      {
        status: 201,
        body: { id: "evt-1", subject: "[tminus-test] Event 1" },
      },
      // Create event 2
      {
        status: 201,
        body: { id: "evt-2", subject: "[tminus-test] Event 2" },
      },
      // Delete event 1
      { status: 204, body: null },
      // Delete event 2
      { status: 204, body: null },
    ]);

    const client = new MicrosoftTestClient({
      clientId: "test-id",
      clientSecret: "test-secret",
      refreshToken: "test-refresh",
      fetchFn: mockFetch,
    });

    await client.createTestEvent({
      calendarId: "primary",
      summary: "Event 1",
      startTime: "2025-06-15T14:00:00Z",
      endTime: "2025-06-15T15:00:00Z",
    });
    await client.createTestEvent({
      calendarId: "primary",
      summary: "Event 2",
      startTime: "2025-06-15T16:00:00Z",
      endTime: "2025-06-15T17:00:00Z",
    });

    // Should not throw, should delete both
    await client.cleanupAllTestEvents();

    // Count DELETE calls (calls 4 and 5 should be DELETE)
    const deleteCalls = mockFetch.mock.calls.filter(
      ([, init]) => (init as RequestInit).method === "DELETE",
    );
    expect(deleteCalls).toHaveLength(2);
  });
});
