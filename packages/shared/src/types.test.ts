import { describe, it, expect, expectTypeOf } from "vitest";
import type {
  UserId,
  AccountId,
  EventId,
  PolicyId,
  CalendarId,
  JournalId,
  DetailLevel,
  CalendarKind,
  MirrorState,
  EventDateTime,
  CanonicalEvent,
  ProjectedEvent,
  PolicyEdge,
  ProviderDelta,
  SyncIncrementalMessage,
  SyncFullMessage,
  UpsertMirrorMessage,
  DeleteMirrorMessage,
  ReconcileAccountMessage,
  ApplyResult,
  AccountHealth,
  ApiResponse,
} from "./types";

describe("types.ts -- branded ID types", () => {
  it("UserId is assignable from string", () => {
    const id = "usr_abc123" as UserId;
    expectTypeOf(id).toEqualTypeOf<UserId>();
    // At runtime, branded types are still strings
    expect(typeof id).toBe("string");
    expect(id).toBe("usr_abc123");
  });

  it("AccountId is assignable from string", () => {
    const id = "acc_xyz" as AccountId;
    expectTypeOf(id).toEqualTypeOf<AccountId>();
    expect(typeof id).toBe("string");
  });

  it("EventId is assignable from string", () => {
    const id = "evt_123" as EventId;
    expectTypeOf(id).toEqualTypeOf<EventId>();
    expect(typeof id).toBe("string");
  });

  it("PolicyId is assignable from string", () => {
    const id = "pol_abc" as PolicyId;
    expectTypeOf(id).toEqualTypeOf<PolicyId>();
    expect(typeof id).toBe("string");
  });

  it("CalendarId is assignable from string", () => {
    const id = "cal_abc" as CalendarId;
    expectTypeOf(id).toEqualTypeOf<CalendarId>();
    expect(typeof id).toBe("string");
  });

  it("JournalId is assignable from string", () => {
    const id = "jrn_abc" as JournalId;
    expectTypeOf(id).toEqualTypeOf<JournalId>();
    expect(typeof id).toBe("string");
  });

  it("branded IDs are not interchangeable at the type level", () => {
    // This is a compile-time check -- at runtime they are all strings.
    // We verify the brands exist by asserting type inequality.
    expectTypeOf<UserId>().not.toEqualTypeOf<AccountId>();
    expectTypeOf<AccountId>().not.toEqualTypeOf<EventId>();
    expectTypeOf<EventId>().not.toEqualTypeOf<PolicyId>();
    expectTypeOf<PolicyId>().not.toEqualTypeOf<CalendarId>();
    expectTypeOf<CalendarId>().not.toEqualTypeOf<JournalId>();
    expectTypeOf<JournalId>().not.toEqualTypeOf<UserId>();
  });
});

describe("types.ts -- union types", () => {
  it("DetailLevel accepts valid values", () => {
    const levels: DetailLevel[] = ["BUSY", "TITLE", "FULL"];
    expect(levels).toHaveLength(3);
    expectTypeOf<DetailLevel>().toEqualTypeOf<"BUSY" | "TITLE" | "FULL">();
  });

  it("CalendarKind accepts valid values", () => {
    const kinds: CalendarKind[] = ["BUSY_OVERLAY", "TRUE_MIRROR"];
    expect(kinds).toHaveLength(2);
    expectTypeOf<CalendarKind>().toEqualTypeOf<
      "BUSY_OVERLAY" | "TRUE_MIRROR"
    >();
  });

  it("MirrorState accepts all five states", () => {
    const states: MirrorState[] = [
      "PENDING",
      "ACTIVE",
      "DELETED",
      "TOMBSTONED",
      "ERROR",
    ];
    expect(states).toHaveLength(5);
    expectTypeOf<MirrorState>().toEqualTypeOf<
      "PENDING" | "ACTIVE" | "DELETED" | "TOMBSTONED" | "ERROR"
    >();
  });
});

describe("types.ts -- domain object shapes", () => {
  const now = new Date().toISOString();

  const sampleEvent: CanonicalEvent = {
    canonical_event_id: "evt_01" as EventId,
    origin_account_id: "acc_01" as AccountId,
    origin_event_id: "google_evt_xyz",
    title: "Team standup",
    description: "Daily sync",
    location: "Zoom",
    start: { dateTime: "2025-06-15T09:00:00Z" },
    end: { dateTime: "2025-06-15T09:30:00Z", timeZone: "America/Chicago" },
    all_day: false,
    status: "confirmed",
    visibility: "default",
    transparency: "opaque",
    recurrence_rule: "RRULE:FREQ=DAILY",
    source: "provider",
    version: 1,
    created_at: now,
    updated_at: now,
  };

  it("CanonicalEvent has required fields", () => {
    expect(sampleEvent.canonical_event_id).toBe("evt_01");
    expect(sampleEvent.origin_account_id).toBe("acc_01");
    expect(sampleEvent.start.dateTime).toBe("2025-06-15T09:00:00Z");
    expect(sampleEvent.all_day).toBe(false);
    expect(sampleEvent.status).toBe("confirmed");
    expect(sampleEvent.version).toBe(1);
  });

  it("EventDateTime supports timed events with dateTime", () => {
    const timed: EventDateTime = {
      dateTime: "2025-06-15T09:00:00",
      timeZone: "America/Chicago",
    };
    expect(timed.dateTime).toBe("2025-06-15T09:00:00");
    expect(timed.timeZone).toBe("America/Chicago");
    expect(timed.date).toBeUndefined();
  });

  it("EventDateTime supports all-day events with date", () => {
    const allDay: EventDateTime = { date: "2025-06-15" };
    expect(allDay.date).toBe("2025-06-15");
    expect(allDay.dateTime).toBeUndefined();
    expect(allDay.timeZone).toBeUndefined();
  });

  it("ProjectedEvent has Google Calendar API shape", () => {
    const projected: ProjectedEvent = {
      summary: "Team standup",
      start: sampleEvent.start,
      end: sampleEvent.end,
      transparency: "opaque",
      visibility: "default",
      extendedProperties: {
        private: {
          tminus: "true",
          managed: "true",
          canonical_event_id: "evt_01",
          origin_account_id: "acc_01",
        },
      },
    };
    expect(projected.summary).toBe("Team standup");
    expect(projected.extendedProperties.private.tminus).toBe("true");
    expect(projected.extendedProperties.private.canonical_event_id).toBe("evt_01");
  });

  it("PolicyEdge defines projection direction", () => {
    const edge: PolicyEdge = {
      detail_level: "BUSY",
      calendar_kind: "BUSY_OVERLAY",
    };
    expect(edge.detail_level).toBe("BUSY");
    expect(edge.calendar_kind).toBe("BUSY_OVERLAY");
  });

  it("ProviderDelta represents create/update/delete", () => {
    const created: ProviderDelta = {
      type: "created",
      origin_event_id: "google_evt_new",
      origin_account_id: "acc_01" as AccountId,
      event: {
        origin_account_id: "acc_01" as AccountId,
        origin_event_id: "google_evt_new",
        title: "New event",
        start: { dateTime: "2025-07-01T10:00:00Z" },
        end: { dateTime: "2025-07-01T11:00:00Z" },
        all_day: false,
        status: "confirmed",
        visibility: "default",
        transparency: "opaque",
      },
    };
    expect(created.type).toBe("created");
    expect(created.event?.title).toBe("New event");

    const deleted: ProviderDelta = {
      type: "deleted",
      origin_event_id: "google_evt_old",
      origin_account_id: "acc_01" as AccountId,
    };
    expect(deleted.type).toBe("deleted");
    expect(deleted.event).toBeUndefined();
  });
});

describe("types.ts -- queue message types", () => {
  it("SyncIncrementalMessage has discriminant type field", () => {
    const msg: SyncIncrementalMessage = {
      type: "SYNC_INCREMENTAL",
      account_id: "acc_01" as AccountId,
      channel_id: "ch_abc",
      resource_id: "res_xyz",
      ping_ts: "2025-06-15T12:00:00Z",
      calendar_id: null,
    };
    expect(msg.type).toBe("SYNC_INCREMENTAL");
    expect(msg.account_id).toBe("acc_01");
  });

  it("SyncFullMessage has reason field", () => {
    const reasons: SyncFullMessage["reason"][] = [
      "onboarding",
      "reconcile",
      "token_410",
    ];
    expect(reasons).toHaveLength(3);

    const msg: SyncFullMessage = {
      type: "SYNC_FULL",
      account_id: "acc_01" as AccountId,
      reason: "reconcile",
    };
    expect(msg.type).toBe("SYNC_FULL");
  });

  it("UpsertMirrorMessage includes projected payload", () => {
    const msg: UpsertMirrorMessage = {
      type: "UPSERT_MIRROR",
      canonical_event_id: "evt_01" as EventId,
      target_account_id: "acc_02" as AccountId,
      target_calendar_id: "cal_busy" as CalendarId,
      projected_payload: {
        summary: "Busy",
        start: { dateTime: "2025-06-15T09:00:00Z" },
        end: { dateTime: "2025-06-15T09:30:00Z" },
        transparency: "opaque",
        visibility: "private",
        extendedProperties: {
          private: {
            tminus: "true",
            managed: "true",
            canonical_event_id: "evt_01",
            origin_account_id: "acc_01",
          },
        },
      },
      idempotency_key: "idem_abc",
    };
    expect(msg.type).toBe("UPSERT_MIRROR");
    expect(msg.projected_payload.summary).toBe("Busy");
    expect(msg.projected_payload.extendedProperties.private.canonical_event_id).toBe("evt_01");
  });

  it("DeleteMirrorMessage has provider_event_id", () => {
    const msg: DeleteMirrorMessage = {
      type: "DELETE_MIRROR",
      canonical_event_id: "evt_01" as EventId,
      target_account_id: "acc_02" as AccountId,
      provider_event_id: "google_evt_mirror",
      idempotency_key: "idem_del_abc",
    };
    expect(msg.type).toBe("DELETE_MIRROR");
    expect(msg.provider_event_id).toBe("google_evt_mirror");
  });

  it("ReconcileAccountMessage has account_id and reason", () => {
    const msg: ReconcileAccountMessage = {
      type: "RECONCILE_ACCOUNT",
      account_id: "acc_01" as AccountId,
      reason: "scheduled",
    };
    expect(msg.type).toBe("RECONCILE_ACCOUNT");
    expect(msg.reason).toBe("scheduled");
  });
});

describe("types.ts -- result and response types", () => {
  it("ApplyResult tracks counts and errors", () => {
    const result: ApplyResult = {
      created: 3,
      updated: 1,
      deleted: 0,
      mirrors_enqueued: 6,
      errors: [{ origin_event_id: "bad_evt", error: "parse failure" }],
    };
    expect(result.created).toBe(3);
    expect(result.mirrors_enqueued).toBe(6);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toBe("parse failure");
  });

  it("ApplyResult can have zero errors", () => {
    const result: ApplyResult = {
      created: 1,
      updated: 0,
      deleted: 0,
      mirrors_enqueued: 2,
      errors: [],
    };
    expect(result.errors).toHaveLength(0);
  });

  it("AccountHealth captures account state", () => {
    const health: AccountHealth = {
      account_id: "acc_01" as AccountId,
      status: "healthy",
      last_sync_ts: "2025-06-15T12:00:00Z",
      last_success_ts: "2025-06-15T12:00:00Z",
      error_message: null,
      watch_channel_active: true,
      token_valid: true,
    };
    expect(health.status).toBe("healthy");
    expect(health.watch_channel_active).toBe(true);

    const degraded: AccountHealth = {
      account_id: "acc_02" as AccountId,
      status: "error",
      last_sync_ts: null,
      last_success_ts: null,
      error_message: "Token refresh failed",
      watch_channel_active: false,
      token_valid: false,
    };
    expect(degraded.status).toBe("error");
    expect(degraded.error_message).toBe("Token refresh failed");
  });

  it("ApiResponse discriminated union narrows on ok field", () => {
    const success: ApiResponse<string> = { ok: true, data: "hello" };
    const failure: ApiResponse<string> = {
      ok: false,
      error: "not found",
      code: 404,
    };

    if (success.ok) {
      expect(success.data).toBe("hello");
    }
    if (!failure.ok) {
      expect(failure.error).toBe("not found");
      expect(failure.code).toBe(404);
    }
  });

  it("ApiResponse failure code is optional", () => {
    const failure: ApiResponse<number> = { ok: false, error: "server error" };
    if (!failure.ok) {
      expect(failure.code).toBeUndefined();
    }
  });
});
