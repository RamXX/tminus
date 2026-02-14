/**
 * Integration tests for AccountDO.
 *
 * Uses real SQLite (better-sqlite3) and real crypto (Node.js crypto.subtle).
 * Only the Google token refresh fetch call is mocked.
 *
 * Tests prove:
 * - Token encryption round-trip through DB storage
 * - Token refresh flow with mocked Google API
 * - Sync cursor CRUD
 * - Watch channel lifecycle
 * - Health tracking
 * - Security invariant BR-8 (refresh token never exposed)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import type { SqlStorageLike, SqlStorageCursorLike } from "@tminus/shared";
import { AccountDO } from "./index";
import type { FetchFn } from "./index";
import { encryptTokens, importMasterKey, decryptTokens } from "./crypto";
import type { EncryptedEnvelope } from "./crypto";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_MASTER_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const TEST_TOKENS = {
  access_token: "ya29.test-access-token",
  refresh_token: "1//test-refresh-token",
  expiry: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour from now
};

const EXPIRED_TOKENS = {
  access_token: "ya29.expired-access-token",
  refresh_token: "1//test-refresh-token-for-expired",
  expiry: new Date(Date.now() - 60 * 1000).toISOString(), // 1 minute ago
};

const TEST_SCOPES = "https://www.googleapis.com/auth/calendar";

// ---------------------------------------------------------------------------
// SqlStorage adapter (same pattern as shared package tests)
// ---------------------------------------------------------------------------

function createSqlStorageAdapter(db: DatabaseType): SqlStorageLike {
  return {
    exec<T extends Record<string, unknown>>(
      query: string,
      ...bindings: unknown[]
    ): SqlStorageCursorLike<T> {
      const trimmed = query.trim().toUpperCase();
      const isSelect =
        trimmed.startsWith("SELECT") ||
        trimmed.startsWith("PRAGMA") ||
        trimmed.startsWith("EXPLAIN");

      if (isSelect) {
        const stmt = db.prepare(query);
        const rows = stmt.all(...bindings) as T[];
        return {
          toArray(): T[] {
            return rows;
          },
          one(): T {
            if (rows.length === 0) {
              throw new Error("Expected at least one row, got none");
            }
            return rows[0];
          },
        };
      }

      if (bindings.length === 0) {
        db.exec(query);
      } else {
        db.prepare(query).run(...bindings);
      }

      return {
        toArray(): T[] {
          return [];
        },
        one(): T {
          throw new Error("No rows returned from non-SELECT statement");
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Mock fetch factory for Google token refresh
// ---------------------------------------------------------------------------

function createMockFetch(opts?: {
  accessToken?: string;
  expiresIn?: number;
  statusCode?: number;
  errorBody?: string;
}): FetchFn {
  const {
    accessToken = "ya29.refreshed-access-token",
    expiresIn = 3600,
    statusCode = 200,
    errorBody = "Bad Request",
  } = opts ?? {};

  return async (_input: string | URL | Request, _init?: RequestInit) => {
    if (statusCode !== 200) {
      return new Response(errorBody, { status: statusCode });
    }
    return new Response(
      JSON.stringify({
        access_token: accessToken,
        expires_in: expiresIn,
        token_type: "Bearer",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("AccountDO integration", () => {
  let db: DatabaseType;
  let sql: SqlStorageLike;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    sql = createSqlStorageAdapter(db);
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // Initialization and token encryption
  // -------------------------------------------------------------------------

  describe("initialize()", () => {
    it("stores encrypted tokens and creates sync state", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      // Verify auth row exists
      const authRow = db
        .prepare("SELECT * FROM auth WHERE account_id = 'self'")
        .get() as Record<string, unknown>;
      expect(authRow).toBeDefined();
      expect(authRow.scopes).toBe(TEST_SCOPES);

      // Verify encrypted_tokens is JSON with envelope fields
      const envelope: EncryptedEnvelope = JSON.parse(
        authRow.encrypted_tokens as string,
      );
      expect(envelope.iv).toBeDefined();
      expect(envelope.ciphertext).toBeDefined();
      expect(envelope.encryptedDek).toBeDefined();
      expect(envelope.dekIv).toBeDefined();

      // Verify tokens are NOT stored in plaintext
      const raw = authRow.encrypted_tokens as string;
      expect(raw).not.toContain(TEST_TOKENS.access_token);
      expect(raw).not.toContain(TEST_TOKENS.refresh_token);

      // Verify sync state was initialized
      const syncRow = db
        .prepare("SELECT * FROM sync_state WHERE account_id = 'self'")
        .get() as Record<string, unknown>;
      expect(syncRow).toBeDefined();
      expect(syncRow.full_sync_needed).toBe(1);
    });

    it("can decrypt stored tokens with master key (proves round-trip)", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      // Manually verify we can decrypt what was stored
      const authRow = db
        .prepare("SELECT encrypted_tokens FROM auth WHERE account_id = 'self'")
        .get() as { encrypted_tokens: string };

      const envelope: EncryptedEnvelope = JSON.parse(authRow.encrypted_tokens);
      const masterKey = await importMasterKey(TEST_MASTER_KEY_HEX);
      const decrypted = await decryptTokens(masterKey, envelope);

      expect(decrypted.access_token).toBe(TEST_TOKENS.access_token);
      expect(decrypted.refresh_token).toBe(TEST_TOKENS.refresh_token);
      expect(decrypted.expiry).toBe(TEST_TOKENS.expiry);
    });

    it("is idempotent (re-initialize replaces tokens)", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      const newTokens = {
        access_token: "ya29.new-token",
        refresh_token: "1//new-refresh",
        expiry: TEST_TOKENS.expiry,
      };
      await acct.initialize(newTokens, "calendar.events");

      // Should have exactly one row
      const rows = db
        .prepare("SELECT COUNT(*) as cnt FROM auth")
        .get() as { cnt: number };
      expect(rows.cnt).toBe(1);

      // Scopes should be updated
      const authRow = db
        .prepare("SELECT scopes FROM auth WHERE account_id = 'self'")
        .get() as { scopes: string };
      expect(authRow.scopes).toBe("calendar.events");
    });
  });

  // -------------------------------------------------------------------------
  // getAccessToken -- the critical RPC method
  // -------------------------------------------------------------------------

  describe("getAccessToken()", () => {
    it("returns access token when not expired", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      const token = await acct.getAccessToken();

      expect(token).toBe(TEST_TOKENS.access_token);
    });

    it("refreshes and returns new token when expired", async () => {
      const mockFetch = createMockFetch({
        accessToken: "ya29.brand-new-token",
      });
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(EXPIRED_TOKENS, TEST_SCOPES);
      const token = await acct.getAccessToken();

      expect(token).toBe("ya29.brand-new-token");
    });

    it("refreshes when token expires within 5 minutes", async () => {
      const almostExpired = {
        ...TEST_TOKENS,
        expiry: new Date(Date.now() + 2 * 60 * 1000).toISOString(), // 2 min from now
      };

      const mockFetch = createMockFetch({
        accessToken: "ya29.refreshed-before-expiry",
      });
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(almostExpired, TEST_SCOPES);
      const token = await acct.getAccessToken();

      expect(token).toBe("ya29.refreshed-before-expiry");
    });

    it("stores refreshed tokens in DB (subsequent calls use new token)", async () => {
      let callCount = 0;
      const mockFetch: FetchFn = async () => {
        callCount++;
        return new Response(
          JSON.stringify({
            access_token: "ya29.refreshed-token",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);
      await acct.initialize(EXPIRED_TOKENS, TEST_SCOPES);

      // First call triggers refresh
      const token1 = await acct.getAccessToken();
      expect(token1).toBe("ya29.refreshed-token");
      expect(callCount).toBe(1);

      // Second call should use cached refreshed token (not refresh again)
      const token2 = await acct.getAccessToken();
      expect(token2).toBe("ya29.refreshed-token");
      expect(callCount).toBe(1); // No additional fetch
    });

    it("throws when Google API returns error on refresh", async () => {
      const mockFetch = createMockFetch({
        statusCode: 401,
        errorBody: '{"error": "invalid_grant"}',
      });
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(EXPIRED_TOKENS, TEST_SCOPES);

      await expect(acct.getAccessToken()).rejects.toThrow(
        /Token refresh failed \(401\)/,
      );
    });

    it("throws when no tokens are stored", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      // Force migration without initializing tokens
      await acct.getSyncToken(); // triggers ensureMigrated()

      await expect(acct.getAccessToken()).rejects.toThrow(
        /no tokens stored/,
      );
    });

    it("sends correct grant_type and refresh_token to Google API", async () => {
      let capturedBody: string | undefined;
      const spyFetch: FetchFn = async (_input, init) => {
        capturedBody = init?.body as string;
        return new Response(
          JSON.stringify({
            access_token: "ya29.new",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, spyFetch);
      await acct.initialize(EXPIRED_TOKENS, TEST_SCOPES);
      await acct.getAccessToken();

      expect(capturedBody).toBeDefined();
      const params = new URLSearchParams(capturedBody!);
      expect(params.get("grant_type")).toBe("refresh_token");
      expect(params.get("refresh_token")).toBe(
        EXPIRED_TOKENS.refresh_token,
      );
    });
  });

  // -------------------------------------------------------------------------
  // BR-8: Refresh token never leaves AccountDO boundary
  // -------------------------------------------------------------------------

  describe("BR-8: refresh token isolation", () => {
    it("getAccessToken returns only access_token, never refresh_token", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      const result = await acct.getAccessToken();

      // Result is a string (the access token), not an object containing refresh_token
      expect(typeof result).toBe("string");
      expect(result).not.toContain(TEST_TOKENS.refresh_token);
    });
  });

  // -------------------------------------------------------------------------
  // revokeTokens
  // -------------------------------------------------------------------------

  describe("revokeTokens()", () => {
    it("deletes auth data", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      await acct.revokeTokens();

      const row = db
        .prepare("SELECT COUNT(*) as cnt FROM auth")
        .get() as { cnt: number };
      expect(row.cnt).toBe(0);
    });

    it("getAccessToken fails after revocation", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      await acct.revokeTokens();

      await expect(acct.getAccessToken()).rejects.toThrow(/no tokens stored/);
    });
  });

  // -------------------------------------------------------------------------
  // Sync cursor management
  // -------------------------------------------------------------------------

  describe("getSyncToken / setSyncToken", () => {
    it("returns null when no sync token set", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      const token = await acct.getSyncToken();
      expect(token).toBeNull();
    });

    it("stores and retrieves a sync token", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      await acct.setSyncToken("next_sync_token_abc123");

      const token = await acct.getSyncToken();
      expect(token).toBe("next_sync_token_abc123");
    });

    it("updates an existing sync token", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      await acct.setSyncToken("token_v1");
      await acct.setSyncToken("token_v2");

      const token = await acct.getSyncToken();
      expect(token).toBe("token_v2");
    });

    it("setSyncToken clears full_sync_needed", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      // Initially full_sync_needed = 1
      const healthBefore = await acct.getHealth();
      expect(healthBefore.fullSyncNeeded).toBe(true);

      await acct.setSyncToken("first_token");

      // After setting sync token, full_sync_needed should be 0
      const healthAfter = await acct.getHealth();
      expect(healthAfter.fullSyncNeeded).toBe(false);
    });

    it("returns null when sync_state not yet created", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      // Only trigger migration, don't initialize
      const token = await acct.getSyncToken();
      expect(token).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Watch channel lifecycle
  // -------------------------------------------------------------------------

  describe("registerChannel / renewChannel / getChannelStatus", () => {
    it("registers a new channel with auto-generated ID", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      const result = await acct.registerChannel("primary");

      expect(result.channelId).toBeDefined();
      expect(result.channelId.startsWith("cal_")).toBe(true);
      expect(result.expiry).toBeDefined();

      // Expiry should be roughly 7 days from now
      const expiryMs = new Date(result.expiry).getTime();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      expect(expiryMs).toBeGreaterThan(Date.now() + sevenDays - 5000);
      expect(expiryMs).toBeLessThan(Date.now() + sevenDays + 5000);
    });

    it("registerChannel stores channel in DB", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      const result = await acct.registerChannel("work@gmail.com");

      const row = db
        .prepare("SELECT * FROM watch_channels WHERE channel_id = ?")
        .get(result.channelId) as Record<string, unknown>;

      expect(row).toBeDefined();
      expect(row.calendar_id).toBe("work@gmail.com");
      expect(row.status).toBe("active");
      expect(row.account_id).toBe("self");
    });

    it("registers multiple channels for different calendars", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      const ch1 = await acct.registerChannel("primary");
      const ch2 = await acct.registerChannel("work@gmail.com");

      expect(ch1.channelId).not.toBe(ch2.channelId);

      const status = await acct.getChannelStatus();
      expect(status.channels).toHaveLength(2);
    });

    it("renewChannel extends expiry of existing channel", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      const original = await acct.registerChannel("primary");

      // Wait a tiny bit so expiry is different
      const renewed = await acct.renewChannel(original.channelId);

      expect(renewed.channelId).toBe(original.channelId);
      // New expiry should be at or after original expiry
      expect(new Date(renewed.expiry).getTime()).toBeGreaterThanOrEqual(
        new Date(original.expiry).getTime(),
      );
    });

    it("renewChannel throws for non-existent channel", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      await expect(
        acct.renewChannel("cal_nonexistent0000000000000000"),
      ).rejects.toThrow(/Watch channel not found/);
    });

    it("getChannelStatus returns all channels with correct info", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      const ch1 = await acct.registerChannel("primary");
      const ch2 = await acct.registerChannel("secondary");

      const status = await acct.getChannelStatus();

      expect(status.channels).toHaveLength(2);
      expect(status.channels[0].channelId).toBe(ch1.channelId);
      expect(status.channels[0].calendarId).toBe("primary");
      expect(status.channels[0].status).toBe("active");
      expect(status.channels[0].expiryTs).toBe(ch1.expiry);

      expect(status.channels[1].channelId).toBe(ch2.channelId);
      expect(status.channels[1].calendarId).toBe("secondary");
    });

    it("getChannelStatus returns empty array when no channels", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      const status = await acct.getChannelStatus();

      expect(status.channels).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Health tracking
  // -------------------------------------------------------------------------

  describe("getHealth / markSyncSuccess / markSyncFailure", () => {
    it("getHealth returns defaults after initialization", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      const health = await acct.getHealth();

      expect(health.lastSyncTs).toBeNull();
      expect(health.lastSuccessTs).toBeNull();
      expect(health.fullSyncNeeded).toBe(true);
    });

    it("markSyncSuccess updates both timestamps", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      const ts = "2026-02-14T12:00:00Z";
      await acct.markSyncSuccess(ts);

      const health = await acct.getHealth();
      expect(health.lastSyncTs).toBe(ts);
      expect(health.lastSuccessTs).toBe(ts);
    });

    it("markSyncFailure updates lastSyncTs but not lastSuccessTs", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      // First, mark a success
      await acct.markSyncSuccess("2026-02-14T12:00:00Z");

      // Then mark a failure
      await acct.markSyncFailure("Connection timeout");

      const health = await acct.getHealth();
      // lastSyncTs should be updated to a recent timestamp
      expect(health.lastSyncTs).not.toBe("2026-02-14T12:00:00Z");
      // lastSuccessTs should still be the original success time
      expect(health.lastSuccessTs).toBe("2026-02-14T12:00:00Z");
    });

    it("markSyncFailure creates sync_state if not exists", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      // Don't initialize, just trigger migration
      await acct.getSyncToken();

      await acct.markSyncFailure("First failure");

      const health = await acct.getHealth();
      expect(health.lastSyncTs).toBeDefined();
      expect(health.lastSuccessTs).toBeNull();
      expect(health.fullSyncNeeded).toBe(true);
    });

    it("multiple success marks update timestamps correctly", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      await acct.markSyncSuccess("2026-02-14T10:00:00Z");
      await acct.markSyncSuccess("2026-02-14T11:00:00Z");

      const health = await acct.getHealth();
      expect(health.lastSyncTs).toBe("2026-02-14T11:00:00Z");
      expect(health.lastSuccessTs).toBe("2026-02-14T11:00:00Z");
    });

    it("getHealth returns defaults when no sync_state exists", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      // Only trigger migration, no initialize
      const health = await acct.getHealth();

      expect(health.lastSyncTs).toBeNull();
      expect(health.lastSuccessTs).toBeNull();
      expect(health.fullSyncNeeded).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Schema migration
  // -------------------------------------------------------------------------

  describe("schema migration", () => {
    it("auto-applies migration on first operation", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      // Before any operation, tables should not exist
      const tablesBefore = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_schema%' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      expect(tablesBefore).toHaveLength(0);

      // Any operation triggers migration
      await acct.getSyncToken();

      const tablesAfter = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_schema%' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      expect(tablesAfter.map((t) => t.name)).toEqual([
        "auth",
        "sync_state",
        "watch_channels",
      ]);
    });

    it("migration is idempotent (multiple AccountDO instances share same DB)", async () => {
      const mockFetch = createMockFetch();

      // Create first instance and initialize
      const acct1 = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);
      await acct1.initialize(TEST_TOKENS, TEST_SCOPES);

      // Create second instance (simulates DO wake-up)
      const acct2 = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      // Should not throw (migration is idempotent)
      const token = await acct2.getAccessToken();
      expect(token).toBe(TEST_TOKENS.access_token);
    });
  });

  // -------------------------------------------------------------------------
  // stopWatchChannels
  // -------------------------------------------------------------------------

  describe("stopWatchChannels()", () => {
    it("stops all active channels and removes them from DB", async () => {
      const fetchCalls: Array<{ url: string; body: string }> = [];
      const mockFetch: FetchFn = async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        fetchCalls.push({ url, body: init?.body as string ?? "" });
        return new Response(null, { status: 204 });
      };

      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);
      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      // Register channels with resource_id (simulating a real channel)
      await acct.registerChannel("primary");
      await acct.registerChannel("work@example.com");

      // Manually set resource_id since registerChannel doesn't set it
      db.prepare("UPDATE watch_channels SET resource_id = 'res_1' WHERE calendar_id = 'primary'").run();
      db.prepare("UPDATE watch_channels SET resource_id = 'res_2' WHERE calendar_id = 'work@example.com'").run();

      const result = await acct.stopWatchChannels();

      expect(result.stopped).toBe(2);
      expect(result.errors).toBe(0);

      // Verify channels.stop was called for each
      const stopCalls = fetchCalls.filter((c) =>
        c.url.includes("channels/stop"),
      );
      expect(stopCalls).toHaveLength(2);

      // All channel rows should be deleted
      const channels = await acct.getChannelStatus();
      expect(channels.channels).toHaveLength(0);
    });

    it("continues when Google channels.stop fails", async () => {
      const mockFetch: FetchFn = async () => {
        throw new Error("Network error");
      };

      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);
      await acct.initialize(
        { ...TEST_TOKENS, access_token: "token" },
        TEST_SCOPES,
      );

      await acct.registerChannel("primary");
      db.prepare("UPDATE watch_channels SET resource_id = 'res_1'").run();

      const result = await acct.stopWatchChannels();

      expect(result.stopped).toBe(0);
      expect(result.errors).toBe(1);

      // Channel rows should STILL be deleted even on failure
      const channels = await acct.getChannelStatus();
      expect(channels.channels).toHaveLength(0);
    });

    it("returns zero counts when no channels exist", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);
      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      const result = await acct.stopWatchChannels();
      expect(result.stopped).toBe(0);
      expect(result.errors).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles concurrent-like operations (sequential in DO)", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      // Multiple operations in sequence
      await acct.setSyncToken("token1");
      await acct.registerChannel("primary");
      await acct.markSyncSuccess("2026-02-14T12:00:00Z");
      const token = await acct.getAccessToken();
      const health = await acct.getHealth();
      const channels = await acct.getChannelStatus();
      const sync = await acct.getSyncToken();

      expect(token).toBe(TEST_TOKENS.access_token);
      expect(health.lastSuccessTs).toBe("2026-02-14T12:00:00Z");
      expect(channels.channels).toHaveLength(1);
      expect(sync).toBe("token1");
    });
  });
});
