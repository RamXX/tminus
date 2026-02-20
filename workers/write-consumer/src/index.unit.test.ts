import { describe, it, expect, vi } from "vitest";
import { createWriteQueueHandler } from "./index";
import type { UpsertMirrorMessage } from "@tminus/shared";

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

function createAccountNamespace(): DurableObjectNamespace {
  return {
    idFromName(name: string): DurableObjectId {
      return {
        toString: () => name,
        equals: () => false,
      } as unknown as DurableObjectId;
    },
    get(_id: DurableObjectId): DurableObjectStub {
      return {
        async fetch(): Promise<Response> {
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
