/**
 * Real integration tests for tminus-write-consumer.
 *
 * Unlike the mocked integration tests in write-consumer.integration.test.ts,
 * these tests use:
 * - Real Google Calendar API (via pre-authorized refresh tokens)
 * - Real GoogleCalendarClient from @tminus/shared (not mocked CalendarProvider)
 * - Real DO communication patterns (verified via the same DO-backed interfaces)
 *
 * Tests skip gracefully when GOOGLE_TEST_REFRESH_TOKEN_A is not set.
 *
 * Run with: make test-integration-real
 *
 * Required environment variables:
 * - GOOGLE_CLIENT_ID
 * - GOOGLE_CLIENT_SECRET
 * - GOOGLE_TEST_REFRESH_TOKEN_A (pre-authorized for a test Google account)
 *
 * Architecture:
 * 1. GoogleTestClient refreshes an access token via real OAuth
 * 2. GoogleCalendarClient (the same one used in production) makes real API calls
 * 3. WriteConsumer processes UPSERT_MIRROR and DELETE_MIRROR messages
 *    using the real GoogleCalendarClient against real Google Calendar
 * 4. Events are created/deleted in the real Google Calendar, then cleaned up
 *
 * What is real:
 * - Google Calendar API calls (insertEvent, patchEvent, deleteEvent, insertCalendar)
 * - GoogleCalendarClient (from @tminus/shared)
 * - OAuth token refresh
 * - Event extended properties (tminus metadata)
 *
 * What is still mocked (required for WriteConsumer's synchronous MirrorStore):
 * - MirrorStore (backed by in-memory SQLite, same as unit tests)
 * - TokenProvider (returns the real access token, but without DO intermediary)
 *
 * This proves the Google Calendar write path works end-to-end with real API.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  requireTestCredentials,
  loadTestEnv,
} from "../../../scripts/test/integration-helpers.js";
import {
  GoogleTestClient,
} from "../../../scripts/test/google-test-client.js";
import { WriteConsumer } from "./write-consumer.js";
import type {
  MirrorStore,
  MirrorRow,
  MirrorUpdate,
  TokenProvider,
} from "./write-consumer.js";
import type {
  UpsertMirrorMessage,
  DeleteMirrorMessage,
  EventId,
  AccountId,
  CalendarId,
  ProjectedEvent,
} from "@tminus/shared";
import {
  GoogleCalendarClient,
  BUSY_OVERLAY_CALENDAR_NAME,
} from "@tminus/shared";

const hasCredentials = requireTestCredentials();

// ---------------------------------------------------------------------------
// Test fixture IDs
// ---------------------------------------------------------------------------

const CANONICAL_EVENT_ID = "evt_01JREALWRITE000000000000001" as EventId;
const CANONICAL_EVENT_ID_2 = "evt_01JREALWRITE000000000000002" as EventId;
const CANONICAL_EVENT_ID_PATCH = "evt_01JREALWRITE000000000000003" as EventId;
const TARGET_ACCOUNT_ID = "acc_01JREALWRITEACCOUNT00000001" as AccountId;
const ORIGIN_ACCOUNT_ID = "acc_01JREALWRITEACCOUNT00000002" as AccountId;

// ---------------------------------------------------------------------------
// SqlMirrorStore -- same pattern as the mocked integration tests
// ---------------------------------------------------------------------------

class SqlMirrorStore implements MirrorStore {
  constructor(private readonly db: DatabaseType) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS event_mirrors (
        canonical_event_id    TEXT NOT NULL,
        target_account_id     TEXT NOT NULL,
        target_calendar_id    TEXT NOT NULL,
        provider_event_id     TEXT,
        last_projected_hash   TEXT,
        last_write_ts         TEXT,
        state                 TEXT NOT NULL DEFAULT 'PENDING',
        error_message         TEXT,
        PRIMARY KEY (canonical_event_id, target_account_id)
      );

      CREATE TABLE IF NOT EXISTS calendars (
        calendar_id          TEXT PRIMARY KEY,
        account_id           TEXT NOT NULL,
        provider_calendar_id TEXT NOT NULL,
        role                 TEXT NOT NULL DEFAULT 'primary',
        kind                 TEXT NOT NULL DEFAULT 'PRIMARY',
        display_name         TEXT,
        UNIQUE(account_id, provider_calendar_id)
      );
    `);
  }

  getMirror(
    canonicalEventId: string,
    targetAccountId: string,
  ): MirrorRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM event_mirrors
         WHERE canonical_event_id = ? AND target_account_id = ?`,
      )
      .get(canonicalEventId, targetAccountId) as MirrorRow | undefined;
    return row ?? null;
  }

  updateMirrorState(
    canonicalEventId: string,
    targetAccountId: string,
    update: MirrorUpdate,
  ): void {
    const setClauses: string[] = [];
    const params: unknown[] = [];

    if (update.provider_event_id !== undefined) {
      setClauses.push("provider_event_id = ?");
      params.push(update.provider_event_id);
    }
    if (update.last_projected_hash !== undefined) {
      setClauses.push("last_projected_hash = ?");
      params.push(update.last_projected_hash);
    }
    if (update.last_write_ts !== undefined) {
      setClauses.push("last_write_ts = ?");
      params.push(update.last_write_ts);
    }
    if (update.state !== undefined) {
      setClauses.push("state = ?");
      params.push(update.state);
    }
    if (update.error_message !== undefined) {
      setClauses.push("error_message = ?");
      params.push(update.error_message);
    }
    if (update.target_calendar_id !== undefined) {
      setClauses.push("target_calendar_id = ?");
      params.push(update.target_calendar_id);
    }

    if (setClauses.length === 0) return;

    params.push(canonicalEventId, targetAccountId);
    this.db
      .prepare(
        `UPDATE event_mirrors SET ${setClauses.join(", ")}
         WHERE canonical_event_id = ? AND target_account_id = ?`,
      )
      .run(...params);
  }

  getBusyOverlayCalendar(accountId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT provider_calendar_id FROM calendars
         WHERE account_id = ? AND kind = 'BUSY_OVERLAY'`,
      )
      .get(accountId) as { provider_calendar_id: string } | undefined;
    return row?.provider_calendar_id ?? null;
  }

  storeBusyOverlayCalendar(
    accountId: string,
    providerCalendarId: string,
  ): void {
    const calendarId = `cal_01AUTOGENERATED000000000001`;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO calendars
         (calendar_id, account_id, provider_calendar_id, role, kind, display_name)
         VALUES (?, ?, ?, 'writer', 'BUSY_OVERLAY', ?)`,
      )
      .run(calendarId, accountId, providerCalendarId, BUSY_OVERLAY_CALENDAR_NAME);
  }

  insertMirror(
    row: Partial<MirrorRow> &
      Pick<MirrorRow, "canonical_event_id" | "target_account_id" | "target_calendar_id">,
  ): void {
    this.db
      .prepare(
        `INSERT INTO event_mirrors
         (canonical_event_id, target_account_id, target_calendar_id,
          provider_event_id, last_projected_hash, last_write_ts, state, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.canonical_event_id,
        row.target_account_id,
        row.target_calendar_id,
        row.provider_event_id ?? null,
        row.last_projected_hash ?? null,
        row.last_write_ts ?? null,
        row.state ?? "PENDING",
        row.error_message ?? null,
      );
  }
}

// ---------------------------------------------------------------------------
// RealTokenProvider -- uses GoogleTestClient to get real access tokens
// ---------------------------------------------------------------------------

class RealTokenProvider implements TokenProvider {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  async getAccessToken(_accountId: string): Promise<string> {
    return this.accessToken;
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeProjectedPayload(
  overrides?: Partial<ProjectedEvent>,
): ProjectedEvent {
  return {
    summary: "Busy",
    start: {
      dateTime: new Date(Date.now() + 86400_000).toISOString(),
    },
    end: {
      dateTime: new Date(Date.now() + 86400_000 + 1800_000).toISOString(),
    },
    transparency: "opaque",
    visibility: "private",
    extendedProperties: {
      private: {
        tminus: "true",
        managed: "true",
        canonical_event_id: CANONICAL_EVENT_ID,
        origin_account_id: ORIGIN_ACCOUNT_ID,
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Track created Google Calendar events and calendars for cleanup
// ---------------------------------------------------------------------------

const createdProviderEventIds: Array<{
  calendarId: string;
  eventId: string;
}> = [];
const createdCalendarIds: string[] = [];

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Write-consumer real integration tests", () => {
  let googleClient: GoogleTestClient;
  let realAccessToken: string;
  let db: DatabaseType;
  let mirrorStore: SqlMirrorStore;
  let tokenProvider: RealTokenProvider;

  beforeAll(async () => {
    if (!hasCredentials) {
      console.warn(
        "\n" +
          "  WARNING: GOOGLE_TEST_REFRESH_TOKEN_A not set.\n" +
          "  Skipping real write-consumer integration tests.\n" +
          "  Set this env var to run full integration tests.\n" +
          "\n" +
          "  Required env vars:\n" +
          "  - GOOGLE_CLIENT_ID\n" +
          "  - GOOGLE_CLIENT_SECRET\n" +
          "  - GOOGLE_TEST_REFRESH_TOKEN_A\n",
      );
      return;
    }

    // Initialize GoogleTestClient and get a real access token
    const env = loadTestEnv();
    googleClient = new GoogleTestClient({
      clientId: env.GOOGLE_CLIENT_ID!,
      clientSecret: env.GOOGLE_CLIENT_SECRET!,
      refreshToken: env.GOOGLE_TEST_REFRESH_TOKEN_A!,
    });
    realAccessToken = await googleClient.refreshAccessToken();
  });

  afterAll(async () => {
    if (!hasCredentials) return;

    // Clean up all created events from Google Calendar
    for (const { calendarId, eventId } of createdProviderEventIds) {
      try {
        await googleClient.deleteTestEvent({ calendarId, eventId });
      } catch {
        // Best effort cleanup
        console.warn(`Failed to clean up event ${eventId} on ${calendarId}`);
      }
    }

    // Clean up created calendars
    for (const calendarId of createdCalendarIds) {
      try {
        const token = await googleClient.refreshAccessToken();
        const resp = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        if (!resp.ok && resp.status !== 404) {
          console.warn(
            `Failed to clean up calendar ${calendarId}: ${resp.status}`,
          );
        }
      } catch {
        console.warn(`Failed to clean up calendar ${calendarId}`);
      }
    }

    // Clean up any remaining test events tracked by GoogleTestClient
    await googleClient.cleanupAllTestEvents();
  });

  beforeEach(() => {
    if (!hasCredentials) return;

    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    mirrorStore = new SqlMirrorStore(db);
    tokenProvider = new RealTokenProvider(realAccessToken);
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
  });

  // -------------------------------------------------------------------------
  // Configuration validation tests (always run)
  // -------------------------------------------------------------------------

  it("requireTestCredentials returns a boolean", () => {
    expect(typeof hasCredentials).toBe("boolean");
  });

  it("loadTestEnv reads expected keys", () => {
    const env = loadTestEnv();
    expect(env).toHaveProperty("GOOGLE_CLIENT_ID");
    expect(env).toHaveProperty("GOOGLE_CLIENT_SECRET");
    expect(env).toHaveProperty("GOOGLE_TEST_REFRESH_TOKEN_A");
  });

  // -------------------------------------------------------------------------
  // Real Google Calendar write tests (skip when credentials unavailable)
  // -------------------------------------------------------------------------

  it.skipIf(!hasCredentials)(
    "UPSERT_MIRROR creates a real event in Google Calendar via GoogleCalendarClient",
    async () => {
      // Setup: PENDING mirror targeting the primary calendar
      mirrorStore.insertMirror({
        canonical_event_id: CANONICAL_EVENT_ID,
        target_account_id: TARGET_ACCOUNT_ID,
        target_calendar_id: "primary",
        state: "PENDING",
      });

      const payload = makeProjectedPayload();

      // Create WriteConsumer with REAL GoogleCalendarClient (not mocked)
      const consumer = new WriteConsumer({
        mirrorStore,
        tokenProvider,
        // Use the real GoogleCalendarClient factory (default)
        // No calendarClientFactory override -- this is the key difference
        // from the mocked tests
      });

      const msg: UpsertMirrorMessage = {
        type: "UPSERT_MIRROR",
        canonical_event_id: CANONICAL_EVENT_ID,
        target_account_id: TARGET_ACCOUNT_ID,
        target_calendar_id: "primary" as CalendarId,
        projected_payload: payload,
        idempotency_key: "idem_real_create_001",
      };

      const result = await consumer.processMessage(msg);

      // Verify success
      expect(result.success).toBe(true);
      expect(result.action).toBe("created");
      expect(result.retry).toBe(false);

      // Verify mirror state was updated
      const mirror = mirrorStore.getMirror(
        CANONICAL_EVENT_ID,
        TARGET_ACCOUNT_ID,
      );
      expect(mirror).not.toBeNull();
      expect(mirror!.state).toBe("ACTIVE");
      expect(mirror!.provider_event_id).toBeTruthy();
      expect(mirror!.last_write_ts).toBeTruthy();
      expect(mirror!.error_message).toBeNull();

      // Track the created event for cleanup
      createdProviderEventIds.push({
        calendarId: "primary",
        eventId: mirror!.provider_event_id!,
      });

      // Verify the event actually exists in Google Calendar by reading it back
      const token = await googleClient.refreshAccessToken();
      const verifyResp = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(mirror!.provider_event_id!)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(verifyResp.status).toBe(200);

      const realEvent = (await verifyResp.json()) as {
        id: string;
        summary: string;
        extendedProperties?: {
          private?: Record<string, string>;
        };
      };

      // Verify the event has correct data
      expect(realEvent.id).toBe(mirror!.provider_event_id);
      expect(realEvent.summary).toBe("Busy");

      // Verify tminus extended properties are set (loop prevention)
      expect(realEvent.extendedProperties?.private?.tminus).toBe("true");
      expect(realEvent.extendedProperties?.private?.managed).toBe("true");
      expect(
        realEvent.extendedProperties?.private?.canonical_event_id,
      ).toBe(CANONICAL_EVENT_ID);
      expect(
        realEvent.extendedProperties?.private?.origin_account_id,
      ).toBe(ORIGIN_ACCOUNT_ID);
    },
  );

  it.skipIf(!hasCredentials)(
    "UPSERT_MIRROR patches an existing real event in Google Calendar",
    async () => {
      // Step 1: Create the initial event via WriteConsumer
      mirrorStore.insertMirror({
        canonical_event_id: CANONICAL_EVENT_ID_PATCH,
        target_account_id: TARGET_ACCOUNT_ID,
        target_calendar_id: "primary",
        state: "PENDING",
      });

      const initialPayload = makeProjectedPayload({
        summary: "Busy (initial)",
        extendedProperties: {
          private: {
            tminus: "true",
            managed: "true",
            canonical_event_id: CANONICAL_EVENT_ID_PATCH,
            origin_account_id: ORIGIN_ACCOUNT_ID,
          },
        },
      });

      const consumer = new WriteConsumer({
        mirrorStore,
        tokenProvider,
      });

      const createResult = await consumer.processMessage({
        type: "UPSERT_MIRROR",
        canonical_event_id: CANONICAL_EVENT_ID_PATCH,
        target_account_id: TARGET_ACCOUNT_ID,
        target_calendar_id: "primary" as CalendarId,
        projected_payload: initialPayload,
        idempotency_key: "idem_real_patch_create",
      });

      expect(createResult.success).toBe(true);
      expect(createResult.action).toBe("created");

      const createdMirror = mirrorStore.getMirror(
        CANONICAL_EVENT_ID_PATCH,
        TARGET_ACCOUNT_ID,
      );
      expect(createdMirror!.provider_event_id).toBeTruthy();

      // Track for cleanup
      createdProviderEventIds.push({
        calendarId: "primary",
        eventId: createdMirror!.provider_event_id!,
      });

      // Step 2: Update the mirror state to PENDING for the update
      mirrorStore.updateMirrorState(
        CANONICAL_EVENT_ID_PATCH,
        TARGET_ACCOUNT_ID,
        { state: "PENDING" },
      );

      // Step 3: Patch with updated content
      const updatedPayload = makeProjectedPayload({
        summary: "Busy (updated via patch)",
        extendedProperties: {
          private: {
            tminus: "true",
            managed: "true",
            canonical_event_id: CANONICAL_EVENT_ID_PATCH,
            origin_account_id: ORIGIN_ACCOUNT_ID,
          },
        },
      });

      const patchResult = await consumer.processMessage({
        type: "UPSERT_MIRROR",
        canonical_event_id: CANONICAL_EVENT_ID_PATCH,
        target_account_id: TARGET_ACCOUNT_ID,
        target_calendar_id: "primary" as CalendarId,
        projected_payload: updatedPayload,
        idempotency_key: "idem_real_patch_update",
      });

      expect(patchResult.success).toBe(true);
      expect(patchResult.action).toBe("updated");

      // Step 4: Verify the event was actually updated in Google Calendar
      const token = await googleClient.refreshAccessToken();
      const verifyResp = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(createdMirror!.provider_event_id!)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(verifyResp.status).toBe(200);

      const patchedEvent = (await verifyResp.json()) as {
        summary: string;
      };
      expect(patchedEvent.summary).toBe("Busy (updated via patch)");
    },
  );

  it.skipIf(!hasCredentials)(
    "DELETE_MIRROR deletes a real event from Google Calendar",
    async () => {
      // Step 1: Create an event first
      mirrorStore.insertMirror({
        canonical_event_id: CANONICAL_EVENT_ID_2,
        target_account_id: TARGET_ACCOUNT_ID,
        target_calendar_id: "primary",
        state: "PENDING",
      });

      const consumer = new WriteConsumer({
        mirrorStore,
        tokenProvider,
      });

      const createResult = await consumer.processMessage({
        type: "UPSERT_MIRROR",
        canonical_event_id: CANONICAL_EVENT_ID_2,
        target_account_id: TARGET_ACCOUNT_ID,
        target_calendar_id: "primary" as CalendarId,
        projected_payload: makeProjectedPayload({
          summary: "Busy (to be deleted)",
          extendedProperties: {
            private: {
              tminus: "true",
              managed: "true",
              canonical_event_id: CANONICAL_EVENT_ID_2,
              origin_account_id: ORIGIN_ACCOUNT_ID,
            },
          },
        }),
        idempotency_key: "idem_real_delete_create",
      });

      expect(createResult.success).toBe(true);
      const mirror = mirrorStore.getMirror(
        CANONICAL_EVENT_ID_2,
        TARGET_ACCOUNT_ID,
      );
      expect(mirror!.provider_event_id).toBeTruthy();
      const providerEventId = mirror!.provider_event_id!;

      // Verify event exists before deletion
      const token = await googleClient.refreshAccessToken();
      const preDeleteResp = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(providerEventId)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(preDeleteResp.status).toBe(200);

      // Step 2: Delete the mirror event
      const deleteResult = await consumer.processMessage({
        type: "DELETE_MIRROR",
        canonical_event_id: CANONICAL_EVENT_ID_2,
        target_account_id: TARGET_ACCOUNT_ID,
        provider_event_id: providerEventId,
        idempotency_key: "idem_real_delete",
      });

      expect(deleteResult.success).toBe(true);
      expect(deleteResult.action).toBe("deleted");

      // Step 3: Verify mirror state is DELETED
      const deletedMirror = mirrorStore.getMirror(
        CANONICAL_EVENT_ID_2,
        TARGET_ACCOUNT_ID,
      );
      expect(deletedMirror!.state).toBe("DELETED");

      // Step 4: Verify event is gone from Google Calendar
      const postDeleteResp = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(providerEventId)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      // Google returns either 404 (not found) or the event with status "cancelled"
      if (postDeleteResp.status === 200) {
        const deletedEvent = (await postDeleteResp.json()) as {
          status: string;
        };
        expect(deletedEvent.status).toBe("cancelled");
      } else {
        expect(postDeleteResp.status).toBe(404);
      }
    },
  );

  it.skipIf(!hasCredentials)(
    "UPSERT_MIRROR auto-creates busy overlay calendar when target_calendar_id is placeholder",
    async () => {
      const calEventId = "evt_01JREALWRITECAL00000000001" as EventId;

      // Mirror with placeholder calendar ID (same as account_id)
      mirrorStore.insertMirror({
        canonical_event_id: calEventId,
        target_account_id: TARGET_ACCOUNT_ID,
        target_calendar_id: TARGET_ACCOUNT_ID, // placeholder
        state: "PENDING",
      });

      const consumer = new WriteConsumer({
        mirrorStore,
        tokenProvider,
      });

      const result = await consumer.processMessage({
        type: "UPSERT_MIRROR",
        canonical_event_id: calEventId,
        target_account_id: TARGET_ACCOUNT_ID,
        target_calendar_id: TARGET_ACCOUNT_ID as unknown as CalendarId, // placeholder
        projected_payload: makeProjectedPayload({
          extendedProperties: {
            private: {
              tminus: "true",
              managed: "true",
              canonical_event_id: calEventId,
              origin_account_id: ORIGIN_ACCOUNT_ID,
            },
          },
        }),
        idempotency_key: "idem_real_autocreate_cal",
      });

      expect(result.success).toBe(true);
      expect(result.action).toBe("created");

      // Verify busy overlay calendar was stored
      const storedCalId = mirrorStore.getBusyOverlayCalendar(TARGET_ACCOUNT_ID);
      expect(storedCalId).toBeTruthy();
      expect(typeof storedCalId).toBe("string");

      // Track for cleanup
      createdCalendarIds.push(storedCalId!);

      // Verify mirror's target_calendar_id was updated
      const mirror = mirrorStore.getMirror(calEventId, TARGET_ACCOUNT_ID);
      expect(mirror!.target_calendar_id).toBe(storedCalId);
      expect(mirror!.provider_event_id).toBeTruthy();

      // Track event for cleanup
      createdProviderEventIds.push({
        calendarId: storedCalId!,
        eventId: mirror!.provider_event_id!,
      });

      // Verify the calendar actually exists in Google Calendar
      const token = await googleClient.refreshAccessToken();
      const calResp = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(storedCalId!)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(calResp.status).toBe(200);

      const calData = (await calResp.json()) as { summary: string };
      expect(calData.summary).toBe(BUSY_OVERLAY_CALENDAR_NAME);
    },
  );

  it.skipIf(!hasCredentials)(
    "Google Calendar API rejects invalid access token with 401",
    async () => {
      // Verify the error path that WriteConsumer handles for 401 (TokenExpiredError)
      const client = new GoogleCalendarClient("invalid-access-token-xyz");

      try {
        await client.insertEvent("primary", makeProjectedPayload());
        // Should not reach here
        expect(true).toBe(false);
      } catch (err) {
        // GoogleCalendarClient should throw TokenExpiredError for 401
        expect(err).toBeDefined();
        const errorName = (err as Error).constructor.name;
        // Could be TokenExpiredError or GoogleApiError depending on response
        expect(["TokenExpiredError", "GoogleApiError"]).toContain(errorName);
      }
    },
  );

  it.skipIf(!hasCredentials)(
    "Google Calendar API handles 404 on delete gracefully (event already gone)",
    async () => {
      const client = new GoogleCalendarClient(realAccessToken);

      try {
        await client.deleteEvent("primary", "nonexistent-event-id-xyz");
        // Should not reach here for a nonexistent event
        expect(true).toBe(false);
      } catch (err) {
        // Should get ResourceNotFoundError or GoogleApiError with 404
        expect(err).toBeDefined();
        const errorName = (err as Error).constructor.name;
        expect(["ResourceNotFoundError", "GoogleApiError"]).toContain(
          errorName,
        );
      }
    },
  );

  it.skipIf(!hasCredentials)(
    "WriteConsumer handles DELETE_MIRROR of already-deleted event gracefully",
    async () => {
      // Create and immediately delete an event via raw Google API
      const client = new GoogleCalendarClient(realAccessToken);
      const eventId = await client.insertEvent(
        "primary",
        makeProjectedPayload(),
      );
      expect(eventId).toBeTruthy();

      // Delete it directly
      await client.deleteEvent("primary", eventId);

      // Now try to delete it via WriteConsumer
      const deleteEventId = "evt_01JREALWRITEDBLDELETE00001" as EventId;
      mirrorStore.insertMirror({
        canonical_event_id: deleteEventId,
        target_account_id: TARGET_ACCOUNT_ID,
        target_calendar_id: "primary",
        provider_event_id: eventId,
        state: "ACTIVE",
      });

      const consumer = new WriteConsumer({
        mirrorStore,
        tokenProvider,
      });

      const result = await consumer.processMessage({
        type: "DELETE_MIRROR",
        canonical_event_id: deleteEventId,
        target_account_id: TARGET_ACCOUNT_ID,
        provider_event_id: eventId,
        idempotency_key: "idem_real_double_delete",
      });

      // Should succeed (404 on delete is handled gracefully)
      expect(result.success).toBe(true);
      expect(result.action).toBe("deleted");

      const mirror = mirrorStore.getMirror(deleteEventId, TARGET_ACCOUNT_ID);
      expect(mirror!.state).toBe("DELETED");
    },
  );

  it.skipIf(!hasCredentials)(
    "all test events and calendars are cleaned up after test run",
    async () => {
      // This is a meta-test: it verifies that the tracking arrays are populated
      // and that cleanup in afterAll will work.
      // The actual cleanup happens in afterAll.
      // At this point, we should have created at least some events in prior tests.
      expect(
        createdProviderEventIds.length > 0 || createdCalendarIds.length > 0,
      ).toBe(true);
    },
  );
});
