import { describe, it, expect, vi } from "vitest";
import { createWriteQueueHandler } from "./index";
import type { UpsertMirrorMessage, DeleteMirrorMessage } from "@tminus/shared";

interface StubCall {
  path: string;
  body: unknown;
}

function createMockDB(userId: string, provider: "google" | "microsoft"): D1Database {
  return {
    prepare(_sql: string) {
      return {
        bind(_accountId: string) {
          return {
            first<T>(): Promise<T | null> {
              return Promise.resolve({ user_id: userId, provider } as T);
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function createUserGraphNamespace(
  mirror: {
    canonical_event_id: string;
    target_account_id: string;
    target_calendar_id: string;
    provider_event_id: string | null;
    last_projected_hash: string | null;
    last_write_ts: string | null;
    state: string;
    error_message: string | null;
  } | null,
): DurableObjectNamespace & { calls: StubCall[] } {
  const calls: StubCall[] = [];

  return {
    calls,
    idFromName(name: string): DurableObjectId {
      return {
        toString: () => name,
        equals: () => false,
      } as unknown as DurableObjectId;
    },
    get(_id: DurableObjectId): DurableObjectStub {
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
          const req = input instanceof Request
            ? input
            : new Request(typeof input === "string" ? input : input.toString(), init);
          const url = new URL(req.url);

          let body: unknown = undefined;
          if (req.method !== "GET") {
            try {
              body = await req.json();
            } catch {
              body = undefined;
            }
          }
          calls.push({ path: url.pathname, body });

          if (url.pathname === "/getMirror") {
            return Response.json({ mirror });
          }
          if (url.pathname === "/recomputeProjections") {
            return Response.json({ enqueued: 1 });
          }
          if (url.pathname === "/getBusyOverlayCalendar") {
            return Response.json({ provider_calendar_id: null });
          }
          if (url.pathname === "/updateMirrorState") {
            return Response.json({ ok: true });
          }
          if (url.pathname === "/storeBusyOverlayCalendar") {
            return Response.json({ ok: true });
          }
          return Response.json({ ok: true });
        },
      } as unknown as DurableObjectStub;
    },
    idFromString(hexId: string): DurableObjectId {
      return {
        toString: () => hexId,
        equals: () => false,
      } as unknown as DurableObjectId;
    },
    newUniqueId(): DurableObjectId {
      return {
        toString: () => "unique",
        equals: () => false,
      } as unknown as DurableObjectId;
    },
    jurisdiction(_name: string): DurableObjectNamespace {
      return this;
    },
  } as unknown as DurableObjectNamespace & { calls: StubCall[] };
}

function createAccountNamespace(scopes?: Array<{
  providerCalendarId: string;
  enabled?: boolean;
  syncEnabled?: boolean;
}>): DurableObjectNamespace {
  return {
    idFromName(name: string): DurableObjectId {
      return {
        toString: () => name,
        equals: () => false,
      } as unknown as DurableObjectId;
    },
    get(_id: DurableObjectId): DurableObjectStub {
      return {
        async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
          const req = input instanceof Request
            ? input
            : new Request(typeof input === "string" ? input : input.toString(), init);
          const url = new URL(req.url);
          if (url.pathname === "/listCalendarScopes") {
            return Response.json({
              scopes: scopes ?? [],
            });
          }
          return Response.json({ access_token: "token" });
        },
      } as unknown as DurableObjectStub;
    },
    idFromString(hexId: string): DurableObjectId {
      return {
        toString: () => hexId,
        equals: () => false,
      } as unknown as DurableObjectId;
    },
    newUniqueId(): DurableObjectId {
      return {
        toString: () => "unique",
        equals: () => false,
      } as unknown as DurableObjectId;
    },
    jurisdiction(_name: string): DurableObjectNamespace {
      return this;
    },
  } as unknown as DurableObjectNamespace;
}

describe("write-consumer queue stale self-heal", () => {
  it("replays pending projection when an out-of-order stale upsert arrives", async () => {
    const message: UpsertMirrorMessage = {
      type: "UPSERT_MIRROR",
      canonical_event_id: "evt_01JSKE00M00000000000000001",
      target_account_id: "acc_01JSKE00MACCPVNTB000000001",
      target_calendar_id: "cal_busy",
      projected_hash: "hash_older",
      projected_payload: {
        summary: "Busy",
        start: { dateTime: "2026-02-20T15:00:00Z" },
        end: { dateTime: "2026-02-20T16:00:00Z" },
      },
      idempotency_key: "idem_older",
    };

    const userGraph = createUserGraphNamespace({
      canonical_event_id: message.canonical_event_id,
      target_account_id: message.target_account_id,
      target_calendar_id: message.target_calendar_id,
      provider_event_id: "provider_evt_1",
      last_projected_hash: "hash_newer",
      last_write_ts: "2026-02-19T00:00:00Z",
      state: "PENDING",
      error_message: null,
    });

    const ack = vi.fn();
    const retry = vi.fn();

    const batch = {
      messages: [{ body: message, ack, retry }],
    } as unknown as MessageBatch<UpsertMirrorMessage>;

    const env = {
      DB: createMockDB("usr_01JSKE00M00000000000000001", "google"),
      USER_GRAPH: userGraph,
      ACCOUNT: createAccountNamespace(),
    } as unknown as Env;

    const handler = createWriteQueueHandler();
    await handler.queue(batch, env);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(userGraph.calls.map((c) => c.path)).toEqual([
      "/getMirror",
      "/recomputeProjections",
    ]);
    expect(userGraph.calls[1].body).toEqual({
      canonical_event_id: message.canonical_event_id,
      force_requeue_pending: true,
    });
  });
});

describe("write-consumer queue placeholder upsert remap", () => {
  it("remaps placeholder UPSERT_MIRROR target calendar to primary for new mirrors", async () => {
    const message: UpsertMirrorMessage = {
      type: "UPSERT_MIRROR",
      canonical_event_id: "evt_01JSKE00M00000000000000055",
      target_account_id: "acc_01JSKE00MACCPVNTB000000055",
      target_calendar_id: "acc_01JSKE00MACCPVNTB000000055",
      projected_hash: "hash_new",
      projected_payload: {
        summary: "Mirror event",
        start: { dateTime: "2026-02-24T10:00:00Z" },
        end: { dateTime: "2026-02-24T11:00:00Z" },
      },
      idempotency_key: "idem_upsert_placeholder",
    };

    const userGraph = createUserGraphNamespace({
      canonical_event_id: message.canonical_event_id,
      target_account_id: message.target_account_id,
      target_calendar_id: message.target_calendar_id,
      provider_event_id: null,
      last_projected_hash: null,
      last_write_ts: null,
      state: "PENDING",
      error_message: null,
    });

    const externalUrls: string[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const request = input instanceof Request
        ? input
        : new Request(typeof input === "string" ? input : input.toString());
      const url = request.url;
      externalUrls.push(url);

      if (url.includes("/calendars/primary/events")) {
        return new Response(
          JSON.stringify({ id: "provider_evt_new_1" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          error: {
            code: 404,
            message: "Not Found",
            errors: [{ reason: "notFound", message: "Not Found" }],
          },
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    });

    const ack = vi.fn();
    const retry = vi.fn();
    const batch = {
      messages: [{ body: message, ack, retry }],
    } as unknown as MessageBatch<UpsertMirrorMessage>;

    const env = {
      DB: createMockDB("usr_01JSKE00M00000000000000001", "google"),
      USER_GRAPH: userGraph,
      ACCOUNT: createAccountNamespace(),
    } as unknown as Env;

    const handler = createWriteQueueHandler({ fetchFn });
    await handler.queue(batch, env);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    const primaryInsertUrl = externalUrls.find((url) =>
      url.includes("/calendar/v3/calendars/primary/events")
    );
    expect(primaryInsertUrl).toBeDefined();
    const parsedPrimaryInsertUrl = new URL(primaryInsertUrl!);
    expect(parsedPrimaryInsertUrl.searchParams.get("sendUpdates")).toBe("none");
    expect(parsedPrimaryInsertUrl.searchParams.get("sendNotifications")).toBe(
      "false",
    );
    expect(
      externalUrls.some((url) =>
        url.includes(
          "/calendars/acc_01JSKE00MACCPVNTB000000055/events",
        )),
    ).toBe(false);

    const updateCall = [...userGraph.calls]
      .reverse()
      .find((call) => call.path === "/updateMirrorState");
    expect(updateCall).toBeDefined();
    expect((updateCall?.body as { update?: { target_calendar_id?: string } }).update?.target_calendar_id)
      .toBe("primary");
  });
});

describe("write-consumer queue delete calendar remap", () => {
  it("remaps primary DELETE_MIRROR to single sync scope when mirror row is missing", async () => {
    const message: DeleteMirrorMessage = {
      type: "DELETE_MIRROR",
      canonical_event_id: "evt_01JSKE00M00000000000000009",
      target_account_id: "acc_01JSKE00MACCPVNTB000000009",
      target_calendar_id: "primary",
      provider_event_id: "origin_evt_123",
      idempotency_key: "idem_delete",
    };

    const userGraph = createUserGraphNamespace(null);
    const externalUrls: string[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const request = input instanceof Request
        ? input
        : new Request(typeof input === "string" ? input : input.toString());
      const url = request.url;
      externalUrls.push(url);
      if (url.includes("/calendars/work%40example.com/events/origin_evt_123")) {
        return new Response(null, { status: 204 });
      }
      return new Response(
        JSON.stringify({
          error: {
            code: 404,
            message: "Not Found",
            errors: [{ reason: "notFound", message: "Not Found" }],
          },
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    });

    const ack = vi.fn();
    const retry = vi.fn();
    const batch = {
      messages: [{ body: message, ack, retry }],
    } as unknown as MessageBatch<DeleteMirrorMessage>;

    const env = {
      DB: createMockDB("usr_01JSKE00M00000000000000001", "google"),
      USER_GRAPH: userGraph,
      ACCOUNT: createAccountNamespace([
        { providerCalendarId: "work@example.com", enabled: true, syncEnabled: true },
      ]),
    } as unknown as Env;

    const handler = createWriteQueueHandler({ fetchFn });
    await handler.queue(batch, env);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    const remappedDeleteUrl = externalUrls.find((url) =>
      url.includes(
        "/calendar/v3/calendars/work%40example.com/events/origin_evt_123",
      )
    );
    expect(remappedDeleteUrl).toBeDefined();
    const parsedRemappedDeleteUrl = new URL(remappedDeleteUrl!);
    expect(parsedRemappedDeleteUrl.searchParams.get("sendUpdates")).toBe("none");
    expect(
      parsedRemappedDeleteUrl.searchParams.get("sendNotifications"),
    ).toBe("false");
  });
});
