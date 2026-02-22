import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvent, fetchEvents, listSessions, updateEvent } from "./api";

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

  it("normalizes UTC dateTimes without explicit offset to Z-form", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify(
          makeEnvelope([
            {
              canonical_event_id: "evt_ms_1",
              title: "MS Event",
              start: {
                dateTime: "2026-02-19T00:00:00.0000000",
                timeZone: "UTC",
              },
              end: {
                dateTime: "2026-02-19T00:30:00.0000000",
                timeZone: "UTC",
              },
            },
          ]),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const events = await fetchEvents("jwt-ms");

    expect(events).toHaveLength(1);
    expect(events[0].start).toBe("2026-02-19T00:00:00.0000000Z");
    expect(events[0].end).toBe("2026-02-19T00:30:00.0000000Z");
  });

  it("normalizes Microsoft UTC aliases without explicit offset to Z-form", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify(
          makeEnvelope([
            {
              canonical_event_id: "evt_ms_utc_alias",
              title: "MS UTC Alias Event",
              start: {
                dateTime: "2026-02-19T18:00:00.0000000",
                timeZone: "Coordinated Universal Time",
              },
              end: {
                dateTime: "2026-02-19T19:00:00.0000000",
                timeZone: "UTC+00:00",
              },
            },
          ]),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const events = await fetchEvents("jwt-ms-utc-alias");

    expect(events).toHaveLength(1);
    expect(events[0].start).toBe("2026-02-19T18:00:00.0000000Z");
    expect(events[0].end).toBe("2026-02-19T19:00:00.0000000Z");
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

describe("api listSessions paginated response unwrapping", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("unwraps paginated { items, total } into a plain SchedulingSession array", async () => {
    const sessions = [
      {
        session_id: "sess_1",
        status: "pending",
        duration_minutes: 30,
        window_start: "2026-02-20T00:00:00Z",
        window_end: "2026-02-22T00:00:00Z",
        participants: [{ account_id: "acc_1", email: "a@example.com" }],
        constraints: {
          avoid_early_morning: false,
          avoid_late_evening: false,
          prefer_existing_gaps: true,
        },
        candidates: [],
        created_at: "2026-02-15T10:00:00Z",
        updated_at: "2026-02-15T10:00:00Z",
      },
      {
        session_id: "sess_2",
        status: "candidates_ready",
        duration_minutes: 60,
        window_start: "2026-02-20T00:00:00Z",
        window_end: "2026-02-22T00:00:00Z",
        participants: [{ account_id: "acc_2", email: "b@example.com" }],
        constraints: {
          avoid_early_morning: true,
          avoid_late_evening: true,
          prefer_existing_gaps: false,
        },
        candidates: [
          {
            candidate_id: "cand_1",
            start: "2026-02-20T10:00:00Z",
            end: "2026-02-20T10:30:00Z",
            score: 0.9,
            explanation: "Good slot",
          },
        ],
        created_at: "2026-02-15T09:00:00Z",
        updated_at: "2026-02-15T09:05:00Z",
      },
    ];

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify(makeEnvelope({ items: sessions, total: 2 })),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await listSessions("jwt-sched");

    // Must be a plain array, not { items, total }
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0].session_id).toBe("sess_1");
    expect(result[1].session_id).toBe("sess_2");
    expect(result[1].candidates).toHaveLength(1);

    // Verify .find works (the original crash site)
    const found = result.find((s) => s.session_id === "sess_2");
    expect(found).toBeDefined();
    expect(found!.status).toBe("candidates_ready");
  });

  it("returns empty array when backend returns zero sessions", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify(makeEnvelope({ items: [], total: 0 })),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await listSessions("jwt-empty");

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });
});
