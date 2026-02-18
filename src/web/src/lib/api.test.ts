import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvent, fetchEvents, updateEvent } from "./api";

function makeEnvelope<T>(data: T) {
  return {
    ok: true,
    data,
  };
}

describe("api event contract adapters", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("normalizes canonical list payload into UI calendar events", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify(
          makeEnvelope([
            {
              canonical_event_id: "evt_1",
              title: "Team Standup",
              description: "Daily sync",
              start: { dateTime: "2026-02-18T16:00:00Z" },
              end: { dateTime: "2026-02-18T16:30:00Z" },
              origin_account_id: "acc_1",
              status: "confirmed",
            },
          ]),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const events = await fetchEvents("jwt-1", {
      start: "2026-02-18T00:00:00Z",
      end: "2026-02-19T00:00:00Z",
    });

    expect(events).toEqual([
      {
        canonical_event_id: "evt_1",
        summary: "Team Standup",
        description: "Daily sync",
        location: undefined,
        start: "2026-02-18T16:00:00Z",
        end: "2026-02-18T16:30:00Z",
        origin_account_id: "acc_1",
        origin_account_email: undefined,
        status: "confirmed",
        version: undefined,
        updated_at: undefined,
        mirrors: undefined,
      },
    ]);

    const firstCall = fetchMock.mock.calls[0] as unknown[];
    const path = String(firstCall[0]);
    const init = (firstCall[1] ?? {}) as RequestInit;
    expect(path).toContain("/api/v1/events?");
    expect(init.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer jwt-1",
      }),
    );
  });

  it("maps create payload to canonical API contract and resolves created event", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(makeEnvelope({ canonical_event_id: "evt_new" })),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            makeEnvelope({
              event: {
                canonical_event_id: "evt_new",
                title: "Coffee with Bob",
                start: { dateTime: "2026-02-18T20:00:00-05:00" },
                end: { dateTime: "2026-02-18T20:30:00-05:00" },
                description: "Discuss Q1 roadmap",
                location: "Cafe",
              },
              mirrors: [],
            }),
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const created = await createEvent("jwt-2", {
      summary: "Coffee with Bob",
      start: "2026-02-18T20:00:00-05:00",
      end: "2026-02-18T20:30:00-05:00",
      timezone: "America/New_York",
      description: "Discuss Q1 roadmap",
      location: "Cafe",
      source: "ui",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const createCall = fetchMock.mock.calls[0] as unknown[];
    const createPath = String(createCall[0]);
    const createInit = (createCall[1] ?? {}) as RequestInit;
    expect(createPath).toBe("/api/v1/events");
    const createBody = JSON.parse(String(createInit.body)) as Record<string, unknown>;
    expect(createBody).toEqual({
      title: "Coffee with Bob",
      start: {
        dateTime: "2026-02-18T20:00:00-05:00",
        timeZone: "America/New_York",
      },
      end: {
        dateTime: "2026-02-18T20:30:00-05:00",
        timeZone: "America/New_York",
      },
      description: "Discuss Q1 roadmap",
      location: "Cafe",
      source: "ui",
    });

    expect(fetchMock.mock.calls[1][0]).toBe("/api/v1/events/evt_new");
    expect(created.summary).toBe("Coffee with Bob");
    expect(created.start).toBe("2026-02-18T20:00:00-05:00");
    expect(created.end).toBe("2026-02-18T20:30:00-05:00");
  });

  it("maps update payload to canonical API contract", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(makeEnvelope({ canonical_event_id: "evt_123" })),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            makeEnvelope({
              event: {
                canonical_event_id: "evt_123",
                title: "Updated title",
                start: { dateTime: "2026-02-19T15:00:00Z" },
                end: { dateTime: "2026-02-19T16:00:00Z" },
              },
            }),
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const updated = await updateEvent("jwt-3", "evt_123", {
      summary: "Updated title",
      start: "2026-02-19T15:00:00Z",
      end: "2026-02-19T16:00:00Z",
      timezone: "UTC",
      description: "Updated description",
    });

    const updateCall = fetchMock.mock.calls[0] as unknown[];
    const updatePath = String(updateCall[0]);
    const updateInit = (updateCall[1] ?? {}) as RequestInit;
    expect(updatePath).toBe("/api/v1/events/evt_123");
    const updateBody = JSON.parse(String(updateInit.body)) as Record<string, unknown>;

    expect(updateBody).toEqual({
      title: "Updated title",
      start: { dateTime: "2026-02-19T15:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2026-02-19T16:00:00Z", timeZone: "UTC" },
      description: "Updated description",
    });
    expect(updated.summary).toBe("Updated title");
  });

  it("filters malformed list events that are missing start/end", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify(
          makeEnvelope([
            {
              canonical_event_id: "evt_ok",
              title: "Valid",
              start: { dateTime: "2026-02-18T10:00:00Z" },
              end: { dateTime: "2026-02-18T11:00:00Z" },
            },
            {
              canonical_event_id: "evt_bad",
              title: "Missing end",
              start: { dateTime: "2026-02-18T12:00:00Z" },
            },
          ]),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const events = await fetchEvents("jwt-4");

    expect(events).toHaveLength(1);
    expect(events[0].canonical_event_id).toBe("evt_ok");
  });
});
