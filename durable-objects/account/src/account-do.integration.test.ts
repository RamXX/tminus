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
  // Provider-aware token refresh (Microsoft support)
  // -------------------------------------------------------------------------

  describe("provider-aware token refresh", () => {
    it("sends refresh request to Microsoft token endpoint when provider is microsoft", async () => {
      let capturedUrl: string | undefined;
      let capturedBody: string | undefined;
      const spyFetch: FetchFn = async (input, init) => {
        capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        capturedBody = init?.body as string;
        return new Response(
          JSON.stringify({
            access_token: "EwB0A8l6_refreshed_ms_token",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, spyFetch, "microsoft");
      await acct.initialize(EXPIRED_TOKENS, TEST_SCOPES);
      const token = await acct.getAccessToken();

      expect(token).toBe("EwB0A8l6_refreshed_ms_token");
      expect(capturedUrl).toContain("login.microsoftonline.com");
      expect(capturedUrl).toContain("oauth2/v2.0/token");
      expect(capturedBody).toBeDefined();
      const params = new URLSearchParams(capturedBody!);
      expect(params.get("grant_type")).toBe("refresh_token");
      expect(params.get("refresh_token")).toBe(EXPIRED_TOKENS.refresh_token);
    });

    it("sends refresh request to Google token endpoint when provider is google", async () => {
      let capturedUrl: string | undefined;
      const spyFetch: FetchFn = async (input, _init) => {
        capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        return new Response(
          JSON.stringify({
            access_token: "ya29.google-refreshed",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, spyFetch, "google");
      await acct.initialize(EXPIRED_TOKENS, TEST_SCOPES);
      await acct.getAccessToken();

      expect(capturedUrl).toContain("oauth2.googleapis.com");
    });

    it("stores provider column in auth table", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch, "microsoft");

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      const authRow = db
        .prepare("SELECT provider FROM auth WHERE account_id = 'self'")
        .get() as { provider: string };
      expect(authRow.provider).toBe("microsoft");
    });

    it("handles non-JSON error response from Microsoft token endpoint gracefully", async () => {
      const spyFetch: FetchFn = async () => {
        return new Response("<html>Service Unavailable</html>", {
          status: 503,
          headers: { "Content-Type": "text/html" },
        });
      };

      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, spyFetch, "microsoft");
      await acct.initialize(EXPIRED_TOKENS, TEST_SCOPES);

      await expect(acct.getAccessToken()).rejects.toThrow(
        /Token refresh failed \(503\)/,
      );
    });

    it("revokeTokens does not call Google revoke when provider is microsoft", async () => {
      const fetchCalls: string[] = [];
      const spyFetch: FetchFn = async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        fetchCalls.push(url);
        return new Response(null, { status: 200 });
      };

      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, spyFetch, "microsoft");
      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      const result = await acct.revokeTokens();

      // Microsoft doesn't have a token revoke endpoint -- local deletion only
      expect(fetchCalls).toHaveLength(0);
      expect(result).toEqual({ revoked: true });

      // Auth data should be deleted
      const row = db
        .prepare("SELECT COUNT(*) as cnt FROM auth")
        .get() as { cnt: number };
      expect(row.cnt).toBe(0);
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
    it("calls Google OAuth revoke endpoint with the refresh token", async () => {
      let capturedUrl = "";
      let capturedBody = "";
      let capturedContentType = "";
      const spyFetch: FetchFn = async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        capturedUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        capturedBody = (init?.body as string) ?? "";
        capturedContentType =
          (init?.headers as Record<string, string>)?.["Content-Type"] ?? "";
        return new Response(null, { status: 200 });
      };

      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, spyFetch);
      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      await acct.revokeTokens();

      // Verify correct endpoint was called
      expect(capturedUrl).toBe("https://oauth2.googleapis.com/revoke");
      // Verify correct content type
      expect(capturedContentType).toBe("application/x-www-form-urlencoded");
      // Verify refresh token was sent
      const params = new URLSearchParams(capturedBody);
      expect(params.get("token")).toBe(TEST_TOKENS.refresh_token);
    });

    it("returns { revoked: true } when Google accepts the revocation", async () => {
      const mockFetch: FetchFn = async () => {
        return new Response(null, { status: 200 });
      };

      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);
      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      const result = await acct.revokeTokens();

      expect(result).toEqual({ revoked: true });
    });

    it("deletes auth data after successful server-side revocation", async () => {
      const mockFetch: FetchFn = async () => {
        return new Response(null, { status: 200 });
      };

      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);
      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      await acct.revokeTokens();

      const row = db
        .prepare("SELECT COUNT(*) as cnt FROM auth")
        .get() as { cnt: number };
      expect(row.cnt).toBe(0);
    });

    it("deletes auth data even when Google revoke endpoint returns 400", async () => {
      const mockFetch: FetchFn = async () => {
        return new Response('{"error": "invalid_token"}', { status: 400 });
      };

      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);
      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      const result = await acct.revokeTokens();

      // Local deletion must happen regardless
      const row = db
        .prepare("SELECT COUNT(*) as cnt FROM auth")
        .get() as { cnt: number };
      expect(row.cnt).toBe(0);
      // But revoked flag indicates server-side failure
      expect(result).toEqual({ revoked: false });
    });

    it("deletes auth data even when Google revoke endpoint returns 500", async () => {
      const mockFetch: FetchFn = async () => {
        return new Response("Internal Server Error", { status: 500 });
      };

      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);
      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      const result = await acct.revokeTokens();

      const row = db
        .prepare("SELECT COUNT(*) as cnt FROM auth")
        .get() as { cnt: number };
      expect(row.cnt).toBe(0);
      expect(result).toEqual({ revoked: false });
    });

    it("deletes auth data even when fetch throws a network error", async () => {
      const mockFetch: FetchFn = async () => {
        throw new Error("Network error: connection refused");
      };

      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);
      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      const result = await acct.revokeTokens();

      const row = db
        .prepare("SELECT COUNT(*) as cnt FROM auth")
        .get() as { cnt: number };
      expect(row.cnt).toBe(0);
      expect(result).toEqual({ revoked: false });
    });

    it("getAccessToken fails after revocation", async () => {
      const mockFetch: FetchFn = async () => {
        return new Response(null, { status: 200 });
      };

      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch);
      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      await acct.revokeTokens();

      await expect(acct.getAccessToken()).rejects.toThrow(/no tokens stored/);
    });

    it("returns { revoked: false } when no tokens exist (nothing to revoke remotely)", async () => {
      const fetchCalls: string[] = [];
      const spyFetch: FetchFn = async (input) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        fetchCalls.push(url);
        return new Response(null, { status: 200 });
      };

      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, spyFetch);
      // Trigger migration without initializing tokens
      await acct.getSyncToken();

      const result = await acct.revokeTokens();

      // Should NOT call Google API when no tokens exist
      expect(fetchCalls).toHaveLength(0);
      // Should return revoked: false since there was nothing to revoke
      expect(result).toEqual({ revoked: false });
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
        "ms_subscriptions",
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

  // -------------------------------------------------------------------------
  // Microsoft subscription lifecycle (AC 4)
  // -------------------------------------------------------------------------

  describe("Microsoft subscription lifecycle", () => {
    it("createMsSubscription stores subscription data in DO SQLite (AC 4)", async () => {
      let capturedUrl = "";
      let capturedBody = "";
      const mockFetch: FetchFn = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        capturedUrl = url;
        capturedBody = (init?.body as string) ?? "";

        if (url.includes("/subscriptions")) {
          return new Response(
            JSON.stringify({
              id: "ms-sub-created-123",
              resource: "/me/calendars/cal-1/events",
              expirationDateTime: "2026-02-17T12:00:00Z",
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        // Token refresh (won't be needed since tokens are fresh)
        return new Response(
          JSON.stringify({ access_token: TEST_TOKENS.access_token, expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch, "microsoft");
      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      const result = await acct.createMsSubscription(
        "https://webhook.tminus.dev/webhook/microsoft",
        "cal-1",
        "test-client-state-secret",
      );

      // Verify return values
      expect(result.subscriptionId).toBe("ms-sub-created-123");
      expect(result.resource).toBe("/me/calendars/cal-1/events");
      expect(result.expiration).toBe("2026-02-17T12:00:00Z");

      // Verify stored in DB
      const row = db
        .prepare("SELECT * FROM ms_subscriptions WHERE subscription_id = ?")
        .get("ms-sub-created-123") as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.resource).toBe("/me/calendars/cal-1/events");
      expect(row.client_state).toBe("test-client-state-secret");
      expect(row.expiration).toBe("2026-02-17T12:00:00Z");

      // Verify correct API call
      expect(capturedUrl).toContain("graph.microsoft.com/v1.0/subscriptions");
      const reqBody = JSON.parse(capturedBody);
      expect(reqBody.changeType).toBe("created,updated,deleted");
      expect(reqBody.notificationUrl).toBe("https://webhook.tminus.dev/webhook/microsoft");
      expect(reqBody.clientState).toBe("test-client-state-secret");
    });

    it("renewMsSubscription updates expiration (AC 5)", async () => {
      let patchUrl = "";
      const mockFetch: FetchFn = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const method = init?.method ?? "GET";

        if (method === "PATCH" && url.includes("/subscriptions/")) {
          patchUrl = url;
          return new Response(
            JSON.stringify({
              id: "ms-sub-to-renew",
              expirationDateTime: "2026-02-20T12:00:00Z",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // Token (not expired, won't be refreshed -- return directly)
        return new Response(
          JSON.stringify({ access_token: TEST_TOKENS.access_token, expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch, "microsoft");
      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      // Manually insert a subscription to renew
      db.prepare(
        `INSERT INTO ms_subscriptions (subscription_id, resource, client_state, expiration, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      ).run("ms-sub-to-renew", "/me/calendars/cal-1/events", "secret", "2026-02-16T12:00:00Z");

      const result = await acct.renewMsSubscription("ms-sub-to-renew");

      expect(result.subscriptionId).toBe("ms-sub-to-renew");
      // Expiration should be updated (3 days from now, roughly)
      expect(new Date(result.expiration).getTime()).toBeGreaterThan(Date.now());

      // Verify local DB updated
      const row = db
        .prepare("SELECT expiration FROM ms_subscriptions WHERE subscription_id = ?")
        .get("ms-sub-to-renew") as { expiration: string };
      expect(row.expiration).toBe(result.expiration);

      // Verify correct API call
      expect(patchUrl).toContain("subscriptions/ms-sub-to-renew");
    });

    it("renewMsSubscription throws for non-existent subscription", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch, "microsoft");
      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      await expect(
        acct.renewMsSubscription("ms-sub-nonexistent"),
      ).rejects.toThrow(/Microsoft subscription not found/);
    });

    it("deleteMsSubscription removes from local storage even if API fails", async () => {
      const mockFetch: FetchFn = async () => {
        throw new Error("Network error");
      };

      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch, "microsoft");
      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      // Insert subscription
      db.prepare(
        `INSERT INTO ms_subscriptions (subscription_id, resource, client_state, expiration, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      ).run("ms-sub-delete-me", "/me/calendars/cal-1/events", "secret", "2026-02-16T12:00:00Z");

      // Should not throw even though API fails
      await acct.deleteMsSubscription("ms-sub-delete-me");

      // Verify removed from local DB
      const row = db
        .prepare("SELECT COUNT(*) as cnt FROM ms_subscriptions WHERE subscription_id = ?")
        .get("ms-sub-delete-me") as { cnt: number };
      expect(row.cnt).toBe(0);
    });

    it("getMsSubscriptions returns all stored subscriptions", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch, "microsoft");
      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      // Insert two subscriptions
      db.prepare(
        `INSERT INTO ms_subscriptions (subscription_id, resource, client_state, expiration, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      ).run("sub-1", "/me/calendars/cal-1/events", "secret-1", "2026-02-17T00:00:00Z");
      db.prepare(
        `INSERT INTO ms_subscriptions (subscription_id, resource, client_state, expiration, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      ).run("sub-2", "/me/calendars/cal-2/events", "secret-2", "2026-02-18T00:00:00Z");

      const subs = await acct.getMsSubscriptions();

      expect(subs).toHaveLength(2);
      expect(subs[0].subscriptionId).toBe("sub-1");
      expect(subs[0].resource).toBe("/me/calendars/cal-1/events");
      expect(subs[0].clientState).toBe("secret-1");
      expect(subs[1].subscriptionId).toBe("sub-2");
    });

    it("getMsSubscriptions returns empty array when none exist", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch, "microsoft");
      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      const subs = await acct.getMsSubscriptions();
      expect(subs).toEqual([]);
    });

    it("validateMsClientState returns true for matching state", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch, "microsoft");
      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      db.prepare(
        `INSERT INTO ms_subscriptions (subscription_id, resource, client_state, expiration, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      ).run("sub-validate", "/me/calendars/cal-1/events", "correct-secret", "2026-02-17T00:00:00Z");

      const valid = await acct.validateMsClientState("sub-validate", "correct-secret");
      expect(valid).toBe(true);
    });

    it("validateMsClientState returns false for wrong state", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch, "microsoft");
      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      db.prepare(
        `INSERT INTO ms_subscriptions (subscription_id, resource, client_state, expiration, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      ).run("sub-validate", "/me/calendars/cal-1/events", "correct-secret", "2026-02-17T00:00:00Z");

      const valid = await acct.validateMsClientState("sub-validate", "wrong-secret");
      expect(valid).toBe(false);
    });

    it("validateMsClientState returns false for unknown subscription", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch, "microsoft");
      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      const valid = await acct.validateMsClientState("sub-nonexistent", "any-secret");
      expect(valid).toBe(false);
    });

    it("ms_subscriptions table exists after migration V3", async () => {
      const mockFetch = createMockFetch();
      const acct = new AccountDO(sql, TEST_MASTER_KEY_HEX, mockFetch, "microsoft");
      // Trigger migration
      await acct.getSyncToken();

      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name = 'ms_subscriptions'",
        )
        .all() as Array<{ name: string }>;
      expect(tables).toHaveLength(1);
      expect(tables[0].name).toBe("ms_subscriptions");
    });
  });
});
