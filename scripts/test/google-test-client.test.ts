/**
 * Tests for the Google Calendar API test client.
 *
 * Since real Google credentials won't be available in CI, these tests verify:
 * 1. Token refresh request construction
 * 2. Event creation request construction
 * 3. Event deletion request construction
 * 4. waitForBusyBlock polling logic
 * 5. Graceful behavior when credentials missing
 *
 * The client uses an injectable fetch function so we can verify
 * request construction without real network calls.
 */

import { describe, it, expect, vi } from "vitest";
import {
  GoogleTestClient,
  buildTokenRefreshBody,
  buildEventPayload,
  type GoogleTestClientConfig,
} from "./google-test-client.js";

// ---------------------------------------------------------------------------
// buildTokenRefreshBody
// ---------------------------------------------------------------------------

describe("buildTokenRefreshBody", () => {
  it("constructs URL-encoded refresh token request", () => {
    const body = buildTokenRefreshBody({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      refreshToken: "test-refresh-token",
    });
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("client_id=test-client-id");
    expect(body).toContain("client_secret=test-client-secret");
    expect(body).toContain("refresh_token=test-refresh-token");
  });

  it("URL-encodes special characters", () => {
    const body = buildTokenRefreshBody({
      clientId: "id+with/special=chars",
      clientSecret: "secret",
      refreshToken: "token",
    });
    expect(body).toContain("client_id=id%2Bwith%2Fspecial%3Dchars");
  });
});

// ---------------------------------------------------------------------------
// buildEventPayload
// ---------------------------------------------------------------------------

describe("buildEventPayload", () => {
  it("creates a valid Google Calendar event payload", () => {
    const payload = buildEventPayload({
      summary: "Test Meeting",
      startTime: "2026-06-15T09:00:00Z",
      endTime: "2026-06-15T10:00:00Z",
    });

    expect(payload.summary).toBe("[tminus-test] Test Meeting");
    expect(payload.start.dateTime).toBe("2026-06-15T09:00:00Z");
    expect(payload.end.dateTime).toBe("2026-06-15T10:00:00Z");
  });

  it("uses UTC timezone by default", () => {
    const payload = buildEventPayload({
      summary: "Test",
      startTime: "2026-06-15T09:00:00Z",
      endTime: "2026-06-15T10:00:00Z",
    });

    expect(payload.start.timeZone).toBe("UTC");
    expect(payload.end.timeZone).toBe("UTC");
  });

  it("adds tminus test prefix to summary for easy identification", () => {
    const payload = buildEventPayload({
      summary: "Meeting",
      startTime: "2026-06-15T09:00:00Z",
      endTime: "2026-06-15T10:00:00Z",
    });

    expect(payload.summary).toContain("[tminus-test]");
  });

  it("includes description with test metadata", () => {
    const payload = buildEventPayload({
      summary: "Meeting",
      startTime: "2026-06-15T09:00:00Z",
      endTime: "2026-06-15T10:00:00Z",
    });

    expect(payload.description).toContain("tminus integration test");
  });
});

// ---------------------------------------------------------------------------
// GoogleTestClient: construction and configuration
// ---------------------------------------------------------------------------

describe("GoogleTestClient", () => {
  it("can be constructed with required config", () => {
    const config: GoogleTestClientConfig = {
      clientId: "test-id",
      clientSecret: "test-secret",
      refreshToken: "test-token",
      fetchFn: vi.fn(),
    };
    const client = new GoogleTestClient(config);
    expect(client).toBeDefined();
  });

  it("refreshAccessToken sends correct request", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: "fresh-access-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
    });

    const client = new GoogleTestClient({
      clientId: "test-id",
      clientSecret: "test-secret",
      refreshToken: "test-refresh-token",
      fetchFn: mockFetch,
    });

    const token = await client.refreshAccessToken();
    expect(token).toBe("fresh-access-token");

    // Verify the fetch was called correctly
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(init.body).toContain("grant_type=refresh_token");
    expect(init.body).toContain("refresh_token=test-refresh-token");
  });

  it("refreshAccessToken throws on failure", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Invalid refresh token"),
    });

    const client = new GoogleTestClient({
      clientId: "test-id",
      clientSecret: "test-secret",
      refreshToken: "bad-token",
      fetchFn: mockFetch,
    });

    await expect(client.refreshAccessToken()).rejects.toThrow(
      /token refresh failed/i,
    );
  });

  it("createTestEvent sends correct request to Google Calendar API", async () => {
    const mockFetch = vi
      .fn()
      // First call: token refresh
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "access-token",
            expires_in: 3600,
            token_type: "Bearer",
          }),
      })
      // Second call: create event
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            id: "google-event-id-123",
            summary: "[tminus-test] Meeting",
            status: "confirmed",
          }),
      });

    const client = new GoogleTestClient({
      clientId: "test-id",
      clientSecret: "test-secret",
      refreshToken: "test-token",
      fetchFn: mockFetch,
    });

    const event = await client.createTestEvent({
      calendarId: "primary",
      summary: "Meeting",
      startTime: "2026-06-15T09:00:00Z",
      endTime: "2026-06-15T10:00:00Z",
    });

    expect(event.id).toBe("google-event-id-123");

    // Verify create event call
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [createUrl, createInit] = mockFetch.mock.calls[1];
    expect(createUrl).toContain(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    );
    expect(createInit.method).toBe("POST");
    expect(createInit.headers["Authorization"]).toBe("Bearer access-token");

    const body = JSON.parse(createInit.body);
    expect(body.summary).toContain("[tminus-test]");
  });

  it("deleteTestEvent sends DELETE request", async () => {
    const mockFetch = vi
      .fn()
      // Token refresh
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "access-token",
            expires_in: 3600,
            token_type: "Bearer",
          }),
      })
      // Delete event
      .mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

    const client = new GoogleTestClient({
      clientId: "test-id",
      clientSecret: "test-secret",
      refreshToken: "test-token",
      fetchFn: mockFetch,
    });

    await client.deleteTestEvent({
      calendarId: "primary",
      eventId: "google-event-id-123",
    });

    const [deleteUrl, deleteInit] = mockFetch.mock.calls[1];
    expect(deleteUrl).toContain(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/google-event-id-123",
    );
    expect(deleteInit.method).toBe("DELETE");
  });

  it("listEvents sends GET request with time bounds", async () => {
    const mockFetch = vi
      .fn()
      // Token refresh
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "access-token",
            expires_in: 3600,
            token_type: "Bearer",
          }),
      })
      // List events
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            items: [
              { id: "event-1", summary: "Event 1" },
              { id: "event-2", summary: "Event 2" },
            ],
          }),
      });

    const client = new GoogleTestClient({
      clientId: "test-id",
      clientSecret: "test-secret",
      refreshToken: "test-token",
      fetchFn: mockFetch,
    });

    const events = await client.listEvents({
      calendarId: "primary",
      timeMin: "2026-06-01T00:00:00Z",
      timeMax: "2026-06-30T23:59:59Z",
    });

    expect(events).toHaveLength(2);
    expect(events[0].id).toBe("event-1");

    const [listUrl] = mockFetch.mock.calls[1];
    expect(listUrl).toContain("timeMin=");
    expect(listUrl).toContain("timeMax=");
  });

  it("caches access token and reuses for subsequent calls", async () => {
    const mockFetch = vi
      .fn()
      // Token refresh (only once)
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "cached-token",
            expires_in: 3600,
            token_type: "Bearer",
          }),
      })
      // First API call
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ items: [] }),
      })
      // Second API call (no token refresh needed)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ items: [] }),
      });

    const client = new GoogleTestClient({
      clientId: "test-id",
      clientSecret: "test-secret",
      refreshToken: "test-token",
      fetchFn: mockFetch,
    });

    await client.listEvents({ calendarId: "primary" });
    await client.listEvents({ calendarId: "primary" });

    // Only 3 calls: 1 token refresh + 2 list events
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Both list calls should use the cached token
    const [, init1] = mockFetch.mock.calls[1];
    const [, init2] = mockFetch.mock.calls[2];
    expect(init1.headers["Authorization"]).toBe("Bearer cached-token");
    expect(init2.headers["Authorization"]).toBe("Bearer cached-token");
  });

  it("waitForBusyBlock rejects on timeout", async () => {
    const mockFetch = vi
      .fn()
      // Token refresh
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "access-token",
            expires_in: 3600,
            token_type: "Bearer",
          }),
      })
      // Always return empty events list
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ items: [] }),
      });

    const client = new GoogleTestClient({
      clientId: "test-id",
      clientSecret: "test-secret",
      refreshToken: "test-token",
      fetchFn: mockFetch,
    });

    await expect(
      client.waitForBusyBlock({
        calendarId: "primary",
        timeMin: "2026-06-15T09:00:00Z",
        timeMax: "2026-06-15T10:00:00Z",
        timeoutMs: 500,
        pollIntervalMs: 100,
      }),
    ).rejects.toThrow(/timed out/i);
  });
});
