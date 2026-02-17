/**
 * Provider-parity live tests: Microsoft Calendar (Graph API).
 *
 * Story: TM-zf91.3
 *
 * Validates Microsoft provider pipeline at the API layer:
 * 1. Token exchange -- MS refresh token -> access token
 * 2. Event CRUD -- create/update/delete via Microsoft Graph API
 * 3. Cleanup -- deterministic removal of all test artifacts
 * 4. Latency recording -- each operation timed and asserted
 *
 * These tests make REAL calls to Microsoft Graph API.
 * No mocks. Credential-gated: skips when MS_* vars are absent.
 *
 * Run with: make test-live
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadLiveEnv, hasMicrosoftCredentials } from "./setup.js";
import type { LiveEnv } from "./setup.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MS_TOKEN_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MS_GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/** Unique marker to identify test events. Includes timestamp for isolation. */
const TEST_EVENT_MARKER = `[tminus-live-parity] MS-${Date.now()}`;

/** Maximum acceptable latency for direct provider API operations (30s). */
const PROVIDER_API_LATENCY_TARGET_MS = 30_000;

// ---------------------------------------------------------------------------
// Microsoft Graph helpers
// ---------------------------------------------------------------------------

/**
 * Exchange a Microsoft refresh token for an access token.
 */
async function getMsAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ accessToken: string; latencyMs: number }> {
  const start = Date.now();

  const resp = await fetch(MS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      scope: "Calendars.ReadWrite User.Read offline_access",
    }),
  });

  const latencyMs = Date.now() - start;

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`MS token refresh failed (${resp.status}): ${body}`);
  }

  const data = (await resp.json()) as { access_token: string };
  return { accessToken: data.access_token, latencyMs };
}

/**
 * Get the default calendar ID for the authenticated user.
 */
async function getDefaultCalendarId(accessToken: string): Promise<string> {
  const resp = await fetch(
    `${MS_GRAPH_BASE}/me/calendars?$filter=isDefaultCalendar eq true`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`List calendars failed (${resp.status}): ${body}`);
  }

  const data = (await resp.json()) as {
    value?: Array<{ id: string; name: string; isDefaultCalendar?: boolean }>;
  };
  const defaultCal = data.value?.find((c) => c.isDefaultCalendar);
  if (!defaultCal) {
    throw new Error("No default calendar found in Microsoft account");
  }
  return defaultCal.id;
}

interface MsEventResult {
  id: string;
  subject?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  isCancelled?: boolean;
  [key: string]: unknown;
}

/**
 * Create an event in Microsoft Calendar.
 */
async function createMsEvent(
  accessToken: string,
  calendarId: string,
  summary: string,
  startTime: string,
  endTime: string,
): Promise<{ event: MsEventResult; latencyMs: number }> {
  const start = Date.now();

  const resp = await fetch(
    `${MS_GRAPH_BASE}/me/calendars/${calendarId}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subject: summary,
        body: {
          contentType: "text",
          content: `Automated live test event. Marker: ${TEST_EVENT_MARKER}. Safe to delete if orphaned.`,
        },
        start: { dateTime: startTime, timeZone: "UTC" },
        end: { dateTime: endTime, timeZone: "UTC" },
        showAs: "busy",
      }),
    },
  );

  const latencyMs = Date.now() - start;

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`MS create event failed (${resp.status}): ${body}`);
  }

  const event = (await resp.json()) as MsEventResult;
  return { event, latencyMs };
}

/**
 * Update an event in Microsoft Calendar.
 */
async function updateMsEvent(
  accessToken: string,
  eventId: string,
  patch: Record<string, unknown>,
): Promise<{ latencyMs: number }> {
  const start = Date.now();

  const resp = await fetch(`${MS_GRAPH_BASE}/me/events/${eventId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  });

  const latencyMs = Date.now() - start;

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`MS update event failed (${resp.status}): ${body}`);
  }

  return { latencyMs };
}

/**
 * Delete an event from Microsoft Calendar.
 */
async function deleteMsEvent(
  accessToken: string,
  eventId: string,
): Promise<{ latencyMs: number }> {
  const start = Date.now();

  const resp = await fetch(`${MS_GRAPH_BASE}/me/events/${eventId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const latencyMs = Date.now() - start;

  // 204 = success, 404 = already gone (both acceptable)
  if (!resp.ok && resp.status !== 204 && resp.status !== 404) {
    const body = await resp.text();
    throw new Error(`MS delete event failed (${resp.status}): ${body}`);
  }

  return { latencyMs };
}

/**
 * Read a specific event from Microsoft Calendar.
 */
async function getMsEvent(
  accessToken: string,
  eventId: string,
): Promise<MsEventResult | null> {
  const resp = await fetch(`${MS_GRAPH_BASE}/me/events/${eventId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (resp.status === 404) return null;

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`MS get event failed (${resp.status}): ${body}`);
  }

  return (await resp.json()) as MsEventResult;
}

// ===========================================================================
// Test suite: Microsoft provider parity
// ===========================================================================

describe("Live: Microsoft Calendar provider parity (TM-zf91.3)", () => {
  const canRun = hasMicrosoftCredentials();

  let env: LiveEnv;
  let msAccessToken: string;
  let defaultCalendarId: string;

  // Track event IDs for cleanup
  let createdEventId: string | null = null;

  // Latency metrics
  const latencies: Record<string, number> = {};

  beforeAll(async () => {
    if (!canRun) {
      console.warn(
        "\n" +
          "  [MICROSOFT] SKIPPED: Microsoft provider parity tests require:\n" +
          "    LIVE_BASE_URL\n" +
          "    MS_CLIENT_ID\n" +
          "    MS_CLIENT_SECRET\n" +
          "    MS_TEST_REFRESH_TOKEN_B\n" +
          "    JWT_SECRET\n" +
          "  Set these in .env and re-run with: make test-live\n",
      );
      return;
    }

    const loaded = loadLiveEnv();
    if (!loaded) return;
    env = loaded;
  });

  afterAll(async () => {
    // Deterministic cleanup: delete any test event that was created
    if (canRun && createdEventId && msAccessToken) {
      try {
        await deleteMsEvent(msAccessToken, createdEventId);
        console.log(`  [CLEANUP] Deleted Microsoft test event: ${createdEventId}`);
      } catch {
        console.log("  [CLEANUP] Microsoft test event already removed or inaccessible");
      }
    }

    // Log latency summary
    if (Object.keys(latencies).length > 0) {
      console.log("\n  === Microsoft Provider Latency Summary ===");
      for (const [op, ms] of Object.entries(latencies)) {
        const secs = (ms / 1000).toFixed(1);
        const status = ms < PROVIDER_API_LATENCY_TARGET_MS ? "PASS" : "SLOW";
        console.log(`  ${op}: ${ms}ms (${secs}s) -- ${status} (target < ${PROVIDER_API_LATENCY_TARGET_MS / 1000}s)`);
      }
    }
  });

  // -------------------------------------------------------------------------
  // MS-1: Token exchange (refresh token -> access token)
  // -------------------------------------------------------------------------

  it.skipIf(!canRun)(
    "MS-1: Microsoft token exchange succeeds and returns valid access token",
    async () => {
      const result = await getMsAccessToken(
        env.msClientId!,
        env.msClientSecret!,
        env.msTestRefreshToken!,
      );

      expect(result.accessToken).toBeTruthy();
      expect(result.accessToken.length).toBeGreaterThan(100);
      latencies["TOKEN_EXCHANGE"] = result.latencyMs;

      msAccessToken = result.accessToken;

      console.log(
        `  [MS-1] Token exchange PASS: access token obtained in ${result.latencyMs}ms`,
      );

      // Resolve default calendar for subsequent tests
      defaultCalendarId = await getDefaultCalendarId(msAccessToken);
      expect(defaultCalendarId).toBeTruthy();

      console.log(
        `  [MS-1] Default calendar resolved: ${defaultCalendarId.slice(0, 30)}...`,
      );
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // MS-2: Create event in Microsoft Calendar
  // -------------------------------------------------------------------------

  it.skipIf(!canRun)(
    "MS-2: Create event in Microsoft Calendar returns valid event ID",
    async () => {
      expect(msAccessToken).toBeTruthy();
      expect(defaultCalendarId).toBeTruthy();

      const now = Date.now();
      const startTime = new Date(now + 2 * 3600_000).toISOString();
      const endTime = new Date(now + 3 * 3600_000).toISOString();

      const result = await createMsEvent(
        msAccessToken,
        defaultCalendarId,
        `${TEST_EVENT_MARKER} - Original Title`,
        startTime,
        endTime,
      );

      expect(result.event.id).toBeTruthy();
      expect(result.event.subject).toContain(TEST_EVENT_MARKER);
      latencies["CREATE"] = result.latencyMs;

      createdEventId = result.event.id;

      console.log(
        `  [MS-2] Create PASS: eventId=${createdEventId!.slice(0, 40)}... in ${result.latencyMs}ms`,
      );

      // Verify the event is readable
      const readBack = await getMsEvent(msAccessToken, createdEventId!);
      expect(readBack).not.toBeNull();
      expect(readBack!.subject).toContain(TEST_EVENT_MARKER);

      console.log("  [MS-2] Read-back PASS: event persisted and readable");
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // MS-3: Update event in Microsoft Calendar
  // -------------------------------------------------------------------------

  it.skipIf(!canRun)(
    "MS-3: Update event title propagates in Microsoft Calendar",
    async () => {
      expect(createdEventId).toBeTruthy();
      expect(msAccessToken).toBeTruthy();

      const modifiedSubject = `${TEST_EVENT_MARKER} - MODIFIED Title`;
      const result = await updateMsEvent(msAccessToken, createdEventId!, {
        subject: modifiedSubject,
      });

      latencies["UPDATE"] = result.latencyMs;

      // Verify the update persisted
      const readBack = await getMsEvent(msAccessToken, createdEventId!);
      expect(readBack).not.toBeNull();
      expect(readBack!.subject).toBe(modifiedSubject);

      console.log(
        `  [MS-3] Update PASS: title changed to "${modifiedSubject}" in ${result.latencyMs}ms`,
      );
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // MS-4: Delete event from Microsoft Calendar
  // -------------------------------------------------------------------------

  it.skipIf(!canRun)(
    "MS-4: Delete event removes it from Microsoft Calendar",
    async () => {
      expect(createdEventId).toBeTruthy();
      expect(msAccessToken).toBeTruthy();

      const result = await deleteMsEvent(msAccessToken, createdEventId!);
      latencies["DELETE"] = result.latencyMs;

      // Verify deletion
      const readBack = await getMsEvent(msAccessToken, createdEventId!);
      expect(readBack).toBeNull();

      console.log(
        `  [MS-4] Delete PASS: event removed in ${result.latencyMs}ms`,
      );

      // Clear so afterAll cleanup skips it
      createdEventId = null;

      console.log("  [MS-4] Delete verified: GET returns 404");
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // MS-5: Latency thresholds assertion
  // -------------------------------------------------------------------------

  it.skipIf(!canRun)(
    "MS-5: All Microsoft operations complete within latency targets",
    () => {
      expect(Object.keys(latencies).length).toBeGreaterThanOrEqual(1);

      console.log("\n  === MS-5: Latency Threshold Report ===");
      for (const [op, ms] of Object.entries(latencies)) {
        const secs = (ms / 1000).toFixed(1);
        const status = ms < PROVIDER_API_LATENCY_TARGET_MS ? "PASS" : "FAIL";
        console.log(
          `  ${op}: ${ms}ms (${secs}s) -- ${status} (target < ${PROVIDER_API_LATENCY_TARGET_MS / 1000}s)`,
        );
        expect(ms).toBeLessThan(PROVIDER_API_LATENCY_TARGET_MS);
      }
    },
  );

  // -------------------------------------------------------------------------
  // MS-NEG: Negative test -- invalid token returns clear error
  // -------------------------------------------------------------------------

  it.skipIf(!canRun)(
    "MS-NEG: Invalid Microsoft refresh token returns clear error",
    async () => {
      const badToken = "invalid-refresh-token-for-testing";

      try {
        await getMsAccessToken(env.msClientId!, env.msClientSecret!, badToken);
        // Should not reach here
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain("MS token refresh failed");
        console.log(
          `  [MS-NEG] Invalid token PASS: "${(err as Error).message.slice(0, 80)}..."`,
        );
      }
    },
    15_000,
  );
});
