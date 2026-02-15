/**
 * Unit tests for ICS feed import route handlers.
 *
 * Tests the handleImportFeed and handleListFeeds functions with
 * mocked fetch, D1, and DO namespace dependencies.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleImportFeed, handleListFeeds } from "./feeds";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:feed-event-001@example.com
DTSTART:20260301T090000Z
DTEND:20260301T100000Z
SUMMARY:Team Standup
DESCRIPTION:Daily standup
END:VEVENT
BEGIN:VEVENT
UID:feed-event-002@example.com
DTSTART:20260302T140000Z
DTEND:20260302T150000Z
SUMMARY:Design Review
END:VEVENT
END:VCALENDAR`;

const EMPTY_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
END:VCALENDAR`;

const TEST_USER_ID = "usr_01HXY000000000000000000001";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockAuth() {
  return { userId: TEST_USER_ID };
}

function createMockD1(opts?: {
  runShouldFail?: boolean;
}): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(..._params: unknown[]) {
          return {
            run() {
              if (opts?.runShouldFail) {
                return Promise.reject(new Error("D1 write failed"));
              }
              return Promise.resolve({
                success: true,
                results: [],
                meta: { duration: 0, rows_read: 0, rows_written: 1, last_row_id: 1, changed_db: true, size_after: 0, changes: 1 },
              });
            },
            all<T>() {
              return Promise.resolve({ results: [] as T[] });
            },
            first<T>(): Promise<T | null> {
              return Promise.resolve(null);
            },
          };
        },
      };
    },
    exec: vi.fn(),
    batch: vi.fn(),
    dump: vi.fn(),
  } as unknown as D1Database;
}

function createMockDONamespace(opts?: {
  doShouldFail?: boolean;
}): DurableObjectNamespace {
  return {
    idFromName(name: string) {
      return {
        toString: () => name,
        name,
        equals: () => false,
      } as unknown as DurableObjectId;
    },
    get(_id: DurableObjectId) {
      return {
        async fetch(_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
          if (opts?.doShouldFail) {
            return new Response(JSON.stringify({ error: "DO failed" }), { status: 500 });
          }
          return new Response(
            JSON.stringify({ created: 2, updated: 0, deleted: 0, mirrors_enqueued: 0, errors: [] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        },
      } as unknown as DurableObjectStub;
    },
    idFromString: vi.fn(),
    newUniqueId: vi.fn(),
    jurisdiction: vi.fn(),
  } as unknown as DurableObjectNamespace;
}

// ---------------------------------------------------------------------------
// Global fetch mock for ICS fetching
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Tests: handleImportFeed
// ---------------------------------------------------------------------------

describe("handleImportFeed", () => {
  it("returns 400 for invalid JSON body", async () => {
    const request = new Request("https://api.test/v1/feeds", {
      method: "POST",
      body: "not json",
    });

    const resp = await handleImportFeed(request, createMockAuth(), {
      DB: createMockD1(),
      USER_GRAPH: createMockDONamespace(),
    });

    expect(resp.status).toBe(400);
    const body = await resp.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
  });

  it("returns 400 for missing url field", async () => {
    const request = new Request("https://api.test/v1/feeds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const resp = await handleImportFeed(request, createMockAuth(), {
      DB: createMockD1(),
      USER_GRAPH: createMockDONamespace(),
    });

    expect(resp.status).toBe(400);
    const body = await resp.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("url");
  });

  it("returns 400 for HTTP (non-HTTPS) URL", async () => {
    const request = new Request("https://api.test/v1/feeds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://example.com/cal.ics" }),
    });

    const resp = await handleImportFeed(request, createMockAuth(), {
      DB: createMockD1(),
      USER_GRAPH: createMockDONamespace(),
    });

    expect(resp.status).toBe(400);
    const body = await resp.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("HTTPS");
  });

  it("returns 502 when ICS fetch fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Not Found", { status: 404 }),
    );

    const request = new Request("https://api.test/v1/feeds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/missing.ics" }),
    });

    const resp = await handleImportFeed(request, createMockAuth(), {
      DB: createMockD1(),
      USER_GRAPH: createMockDONamespace(),
    });

    expect(resp.status).toBe(502);
  });

  it("returns 422 when ICS has no events", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(EMPTY_ICS, { status: 200, headers: { "Content-Type": "text/calendar" } }),
    );

    const request = new Request("https://api.test/v1/feeds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/empty.ics" }),
    });

    const resp = await handleImportFeed(request, createMockAuth(), {
      DB: createMockD1(),
      USER_GRAPH: createMockDONamespace(),
    });

    expect(resp.status).toBe(422);
  });

  it("successfully imports events and returns 201", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(VALID_ICS, { status: 200, headers: { "Content-Type": "text/calendar" } }),
    );

    const request = new Request("https://api.test/v1/feeds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/public.ics" }),
    });

    const resp = await handleImportFeed(request, createMockAuth(), {
      DB: createMockD1(),
      USER_GRAPH: createMockDONamespace(),
    });

    expect(resp.status).toBe(201);
    const body = await resp.json() as { ok: boolean; data: { events_imported: number; feed_url: string; account_id: string; date_range: { earliest: string; latest: string } } };
    expect(body.ok).toBe(true);
    expect(body.data.events_imported).toBe(2);
    expect(body.data.feed_url).toBe("https://example.com/public.ics");
    expect(body.data.account_id).toMatch(/^acc_/);
    expect(body.data.date_range.earliest).toBe("2026-03-01T09:00:00Z");
    expect(body.data.date_range.latest).toBe("2026-03-02T14:00:00Z");
  });

  it("returns 500 when D1 write fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(VALID_ICS, { status: 200, headers: { "Content-Type": "text/calendar" } }),
    );

    const request = new Request("https://api.test/v1/feeds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/public.ics" }),
    });

    const resp = await handleImportFeed(request, createMockAuth(), {
      DB: createMockD1({ runShouldFail: true }),
      USER_GRAPH: createMockDONamespace(),
    });

    expect(resp.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Tests: handleListFeeds
// ---------------------------------------------------------------------------

describe("handleListFeeds", () => {
  it("returns 200 with empty array when no feeds exist", async () => {
    const request = new Request("https://api.test/v1/feeds", { method: "GET" });

    const resp = await handleListFeeds(request, createMockAuth(), {
      DB: createMockD1(),
    });

    expect(resp.status).toBe(200);
    const body = await resp.json() as { ok: boolean; data: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });
});
