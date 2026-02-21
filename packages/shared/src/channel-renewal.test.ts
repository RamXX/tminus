/**
 * @tminus/shared -- Unit tests for the shared webhook channel renewal function.
 *
 * Tests cover the 5-step renewal flow:
 * 1. Get access token from AccountDO
 * 2. Stop old channel (best-effort)
 * 3. Register new channel with Google for a specific calendar
 * 4. Store new channel in AccountDO
 * 5. Update D1 with new channel info including channel_calendar_id
 *
 * Per-scope renewal tests (TM-8gfd.4):
 * - calendarId parameter controls which calendar the channel watches
 * - Defaults to "primary" when calendarId is omitted
 * - channel_calendar_id is stored in D1 (6 bind params instead of 5)
 * - calendar_id is included in the result
 *
 * All external dependencies (AccountDO, Google Calendar API, D1) are mocked
 * since these are unit tests. Integration tests live in the worker packages.
 *
 * See: TM-1s05
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  renewWebhookChannel,
  type RenewWebhookChannelParams,
  type AccountDOStub,
  type ChannelRenewalDB,
} from "./channel-renewal";

// ---------------------------------------------------------------------------
// Mock the Google Calendar client and ID generator
// ---------------------------------------------------------------------------

const MOCK_WATCH_RESPONSE = {
  channelId: "new-channel-from-google",
  resourceId: "new-resource-from-google",
  expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
};

const mockStopChannel = vi.fn();
const mockWatchEvents = vi.fn();

vi.mock("./google-api", () => ({
  GoogleCalendarClient: vi.fn().mockImplementation(() => ({
    stopChannel: mockStopChannel,
    watchEvents: mockWatchEvents,
  })),
}));

vi.mock("./id", () => ({
  generateId: vi.fn((prefix: string) => `${prefix}_mock_id`),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock AccountDO stub that records fetch calls. */
function createMockDOStub(
  overrides?: Map<string, { status: number; body: unknown }>,
): AccountDOStub & { calls: Array<{ path: string; method: string; body?: unknown }> } {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];

  return {
    calls,
    async fetch(input: Request): Promise<Response> {
      const url = new URL(input.url);
      let parsedBody: unknown;
      try {
        parsedBody = await input.clone().json();
      } catch {
        // no body
      }
      calls.push({ path: url.pathname, method: input.method, body: parsedBody });

      const customResp = overrides?.get(url.pathname);
      if (customResp) {
        return new Response(JSON.stringify(customResp.body), {
          status: customResp.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Default responses for known endpoints
      if (url.pathname === "/getAccessToken") {
        return new Response(
          JSON.stringify({ access_token: "mock-google-token" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname === "/storeWatchChannel") {
        return new Response(
          JSON.stringify({ ok: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    },
  };
}

/** Create a mock D1 database that records run() calls. */
function createMockDB(): ChannelRenewalDB & {
  runLog: Array<{ sql: string; params: unknown[] }>;
} {
  const runLog: Array<{ sql: string; params: unknown[] }> = [];
  return {
    runLog,
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async run() {
              runLog.push({ sql, params });
              return { success: true };
            },
          };
        },
      };
    },
  };
}

/** Build default params for renewWebhookChannel. */
function buildParams(overrides?: Partial<RenewWebhookChannelParams>): RenewWebhookChannelParams {
  const stub = createMockDOStub();
  const db = createMockDB();
  return {
    accountId: "acc_01HXYZ0000000000000000TEST",
    oldChannelId: "old-channel-123",
    oldResourceId: "old-resource-456",
    accountDOStub: overrides?.accountDOStub ?? stub,
    db: overrides?.db ?? db,
    webhookUrl: "https://webhooks.tminus.ink/webhook/google",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("renewWebhookChannel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStopChannel.mockResolvedValue(undefined);
    mockWatchEvents.mockResolvedValue(MOCK_WATCH_RESPONSE);
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it("completes the full 5-step renewal flow and returns result with calendar_id", async () => {
    const stub = createMockDOStub();
    const db = createMockDB();
    const params = buildParams({ accountDOStub: stub, db });

    const result = await renewWebhookChannel(params);

    // Verify result
    expect(result.account_id).toBe("acc_01HXYZ0000000000000000TEST");
    expect(result.channel_id).toBe("new-channel-from-google");
    expect(result.resource_id).toBe("new-resource-from-google");
    expect(result.expiry).toBeTruthy();
    expect(result.previous_channel_id).toBe("old-channel-123");
    expect(result.calendar_id).toBe("primary"); // default

    // Verify Step 1: getAccessToken was called
    expect(stub.calls[0].path).toBe("/getAccessToken");
    expect(stub.calls[0].method).toBe("POST");

    // Verify Step 2: stopChannel was called with old channel info
    expect(mockStopChannel).toHaveBeenCalledWith("old-channel-123", "old-resource-456");

    // Verify Step 3: watchEvents was called with "primary" calendar
    expect(mockWatchEvents).toHaveBeenCalledWith(
      "primary",
      "https://webhooks.tminus.ink/webhook/google",
      "calendar_mock_id",
      "calendar_mock_id",
    );

    // Verify Step 4: storeWatchChannel was called with calendar_id
    expect(stub.calls[1].path).toBe("/storeWatchChannel");
    expect(stub.calls[1].method).toBe("POST");
    expect(stub.calls[1].body).toEqual({
      channel_id: "new-channel-from-google",
      resource_id: "new-resource-from-google",
      expiration: MOCK_WATCH_RESPONSE.expiration,
      calendar_id: "primary",
    });

    // Verify Step 5: D1 update was called with 6 params (includes channel_calendar_id)
    expect(db.runLog.length).toBe(1);
    expect(db.runLog[0].sql).toContain("UPDATE accounts");
    expect(db.runLog[0].params[0]).toBe("new-channel-from-google"); // channel_id
    expect(db.runLog[0].params[3]).toBe("new-resource-from-google"); // resource_id
    expect(db.runLog[0].params[4]).toBe("primary"); // channel_calendar_id
    expect(db.runLog[0].params[5]).toBe("acc_01HXYZ0000000000000000TEST"); // account_id
  });

  it("uses custom calendarId for per-scope renewal (AC 3)", async () => {
    const stub = createMockDOStub();
    const db = createMockDB();
    const params = buildParams({
      accountDOStub: stub,
      db,
      calendarId: "work-calendar-xyz",
    });

    const result = await renewWebhookChannel(params);

    // Result includes the custom calendar_id
    expect(result.calendar_id).toBe("work-calendar-xyz");

    // watchEvents called with custom calendar
    expect(mockWatchEvents).toHaveBeenCalledWith(
      "work-calendar-xyz",
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );

    // storeWatchChannel called with custom calendar_id
    expect(stub.calls[1].body).toEqual(
      expect.objectContaining({ calendar_id: "work-calendar-xyz" }),
    );

    // D1 update stores custom calendar_id
    expect(db.runLog[0].params[4]).toBe("work-calendar-xyz");
  });

  it("defaults calendarId to 'primary' when not specified", async () => {
    const params = buildParams({ calendarId: undefined });

    const result = await renewWebhookChannel(params);

    expect(result.calendar_id).toBe("primary");
    expect(mockWatchEvents).toHaveBeenCalledWith(
      "primary",
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });

  it("correctly converts expiration from Unix milliseconds to ISO timestamp", async () => {
    const expMs = 1800000000000; // 2027-01-15T08:00:00.000Z
    mockWatchEvents.mockResolvedValue({
      channelId: "ch-1",
      resourceId: "res-1",
      expiration: String(expMs),
    });

    const params = buildParams();
    const result = await renewWebhookChannel(params);

    const expectedIso = new Date(expMs).toISOString();
    expect(result.expiry).toBe(expectedIso);
  });

  // -------------------------------------------------------------------------
  // Step 1 failures: getAccessToken
  // -------------------------------------------------------------------------

  it("throws when AccountDO fails to provide access token", async () => {
    const stub = createMockDOStub(
      new Map([["/getAccessToken", { status: 500, body: { error: "token_expired" } }]]),
    );
    const params = buildParams({ accountDOStub: stub });

    await expect(renewWebhookChannel(params)).rejects.toThrow(
      /Failed to get access token.*acc_01HXYZ0000000000000000TEST.*500/,
    );
  });

  it("throws when AccountDO returns 401 for access token", async () => {
    const stub = createMockDOStub(
      new Map([["/getAccessToken", { status: 401, body: { error: "unauthorized" } }]]),
    );
    const params = buildParams({ accountDOStub: stub });

    await expect(renewWebhookChannel(params)).rejects.toThrow("Failed to get access token");
  });

  // -------------------------------------------------------------------------
  // Step 2: stopChannel (best-effort)
  // -------------------------------------------------------------------------

  it("continues when stopChannel fails (best-effort)", async () => {
    mockStopChannel.mockRejectedValueOnce(new Error("Channel not found"));

    const stub = createMockDOStub();
    const db = createMockDB();
    const params = buildParams({ accountDOStub: stub, db });

    // Should NOT throw -- stopChannel is best-effort
    const result = await renewWebhookChannel(params);

    // Should still complete the rest of the flow
    expect(result.channel_id).toBe("new-channel-from-google");
    expect(mockWatchEvents).toHaveBeenCalled();
    expect(stub.calls.length).toBe(2); // getAccessToken + storeWatchChannel
    expect(db.runLog.length).toBe(1);
  });

  it("skips stopChannel when oldChannelId is null", async () => {
    const params = buildParams({ oldChannelId: null });

    await renewWebhookChannel(params);

    expect(mockStopChannel).not.toHaveBeenCalled();
  });

  it("skips stopChannel when oldResourceId is null", async () => {
    const params = buildParams({ oldResourceId: null });

    await renewWebhookChannel(params);

    expect(mockStopChannel).not.toHaveBeenCalled();
  });

  it("skips stopChannel when both oldChannelId and oldResourceId are null", async () => {
    const params = buildParams({ oldChannelId: null, oldResourceId: null });

    await renewWebhookChannel(params);

    expect(mockStopChannel).not.toHaveBeenCalled();
    // But watchEvents should still be called
    expect(mockWatchEvents).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Step 3 failures: watchEvents
  // -------------------------------------------------------------------------

  it("throws when Google watchEvents fails", async () => {
    mockWatchEvents.mockRejectedValueOnce(new Error("Google API error: 403"));

    const params = buildParams();

    await expect(renewWebhookChannel(params)).rejects.toThrow("Google API error: 403");
  });

  it("does not call storeWatchChannel or update D1 when watchEvents fails", async () => {
    mockWatchEvents.mockRejectedValueOnce(new Error("Rate limited"));

    const stub = createMockDOStub();
    const db = createMockDB();
    const params = buildParams({ accountDOStub: stub, db });

    await expect(renewWebhookChannel(params)).rejects.toThrow("Rate limited");

    // Only getAccessToken should have been called, not storeWatchChannel
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0].path).toBe("/getAccessToken");
    expect(db.runLog.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Step 4 failures: storeWatchChannel
  // -------------------------------------------------------------------------

  it("throws when AccountDO fails to store new channel", async () => {
    const stub = createMockDOStub(
      new Map([["/storeWatchChannel", { status: 500, body: { error: "storage_failed" } }]]),
    );
    const params = buildParams({ accountDOStub: stub });

    await expect(renewWebhookChannel(params)).rejects.toThrow(
      /Failed to store new channel.*acc_01HXYZ0000000000000000TEST.*500/,
    );
  });

  it("does not update D1 when storeWatchChannel fails", async () => {
    const stub = createMockDOStub(
      new Map([["/storeWatchChannel", { status: 500, body: { error: "storage_failed" } }]]),
    );
    const db = createMockDB();
    const params = buildParams({ accountDOStub: stub, db });

    await expect(renewWebhookChannel(params)).rejects.toThrow();

    // D1 should NOT have been updated
    expect(db.runLog.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it("works with a fresh account (no previous channel)", async () => {
    const stub = createMockDOStub();
    const db = createMockDB();
    const params = buildParams({
      accountDOStub: stub,
      db,
      oldChannelId: null,
      oldResourceId: null,
    });

    const result = await renewWebhookChannel(params);

    expect(result.previous_channel_id).toBeNull();
    expect(result.channel_id).toBe("new-channel-from-google");
    expect(result.calendar_id).toBe("primary");
    expect(mockStopChannel).not.toHaveBeenCalled();
    expect(mockWatchEvents).toHaveBeenCalled();
    expect(db.runLog.length).toBe(1);
  });

  it("uses the provided webhookUrl in the watch request", async () => {
    const customUrl = "https://custom.webhook.endpoint/callback";
    const params = buildParams({ webhookUrl: customUrl });

    await renewWebhookChannel(params);

    expect(mockWatchEvents).toHaveBeenCalledWith(
      "primary",
      customUrl,
      expect.any(String),
      expect.any(String),
    );
  });

  it("writes correct D1 SQL with all six bind parameters", async () => {
    const db = createMockDB();
    const params = buildParams({ db, calendarId: "work-cal" });

    await renewWebhookChannel(params);

    expect(db.runLog.length).toBe(1);
    const { sql, params: bindParams } = db.runLog[0];

    // SQL should update channel_id, channel_token, channel_expiry_ts, resource_id, channel_calendar_id
    expect(sql).toContain("channel_id = ?1");
    expect(sql).toContain("channel_token = ?2");
    expect(sql).toContain("channel_expiry_ts = ?3");
    expect(sql).toContain("resource_id = ?4");
    expect(sql).toContain("channel_calendar_id = ?5");
    expect(sql).toContain("account_id = ?6");

    // Bind params: [channel_id, token, expiry, resource_id, calendar_id, account_id]
    expect(bindParams.length).toBe(6);
    expect(bindParams[0]).toBe("new-channel-from-google");
    expect(bindParams[1]).toBe("calendar_mock_id"); // newToken from generateId
    expect(typeof bindParams[2]).toBe("string"); // ISO timestamp
    expect(bindParams[3]).toBe("new-resource-from-google");
    expect(bindParams[4]).toBe("work-cal"); // channel_calendar_id
    expect(bindParams[5]).toBe("acc_01HXYZ0000000000000000TEST");
  });
});
