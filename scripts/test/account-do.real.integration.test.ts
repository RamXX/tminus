/**
 * Real integration tests for AccountDO.
 *
 * Runs against a real wrangler dev server with Miniflare-backed DO SQLite.
 * No better-sqlite3. No mocks for the DO layer -- real DurableObject instances
 * with real SQLite storage, accessed via HTTP through the test worker's RPC proxy.
 *
 * What this proves that the better-sqlite3 tests do NOT:
 * - The DO class works when instantiated by the Cloudflare runtime
 * - Real DO SQLite storage (not better-sqlite3) handles all queries correctly
 * - The handleFetch() routing works end-to-end via HTTP
 * - Envelope encryption works with real Web Crypto in the Workers runtime
 * - Token lifecycle works with real DO persistence across requests
 *
 * The Google token refresh fetch is real (goes to Google's servers) but we
 * don't test it here because we'd need valid credentials. We test the
 * paths that don't require real Google API calls.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { startWranglerDev, DEFAULTS } from "./integration-helpers.js";
import type { StartedWorker } from "./integration-helpers.js";
import { DoRpcClient } from "./do-rpc-client.js";

const ROOT = resolve(import.meta.dirname, "../..");
const TEST_PORT = 18799;
const MASTER_KEY_HEX =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

let worker: StartedWorker;
let client: DoRpcClient;

beforeAll(async () => {
  worker = await startWranglerDev({
    wranglerToml: resolve(ROOT, "scripts/test/wrangler-test.toml"),
    port: TEST_PORT,
    vars: {
      MASTER_KEY: MASTER_KEY_HEX,
    },
    healthTimeoutMs: 60_000,
  });

  client = new DoRpcClient({ baseUrl: worker.url });
}, 90_000);

afterAll(async () => {
  if (worker) {
    await worker.cleanup(true);
  }
}, 15_000);

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_TOKENS = {
  access_token: "ya29.test-access-token-for-real-integration",
  refresh_token: "1//test-refresh-token-for-real-integration",
  expiry: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour from now
};

const TEST_SCOPES = "https://www.googleapis.com/auth/calendar";

// Each test uses a unique DO name to avoid state leaking between tests.
// DOs are addressed by name, and each name gets its own SQLite database.
let testCounter = 0;
function uniqueDoName(): string {
  return `account-test-${Date.now()}-${++testCounter}`;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("AccountDO real integration (wrangler dev)", () => {
  // -------------------------------------------------------------------------
  // Initialize and basic token operations
  // -------------------------------------------------------------------------

  describe("initialize()", () => {
    it("initializes tokens and creates sync state via HTTP fetch", async () => {
      const name = uniqueDoName();
      const acct = client.account(name);

      const result = await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      expect(result.ok).toBe(true);

      // Verify health reflects initialized state
      const health = await acct.getHealth();
      expect(health.lastSyncTs).toBeNull();
      expect(health.lastSuccessTs).toBeNull();
      expect(health.fullSyncNeeded).toBe(true);
    });

    it("is idempotent (re-initialize replaces tokens)", async () => {
      const name = uniqueDoName();
      const acct = client.account(name);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      // Re-initialize with different tokens
      const newTokens = {
        access_token: "ya29.new-token",
        refresh_token: "1//new-refresh",
        expiry: TEST_TOKENS.expiry,
      };
      const result = await acct.initialize(newTokens, "calendar.events");
      expect(result.ok).toBe(true);

      // Should still work (getAccessToken returns the new token)
      const tokenResult = await acct.getAccessToken();
      expect(tokenResult.access_token).toBe("ya29.new-token");
    });
  });

  // -------------------------------------------------------------------------
  // getAccessToken
  // -------------------------------------------------------------------------

  describe("getAccessToken()", () => {
    it("returns access token when not expired", async () => {
      const name = uniqueDoName();
      const acct = client.account(name);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      const result = await acct.getAccessToken();

      expect(result.access_token).toBe(TEST_TOKENS.access_token);
    });

    it("returns only access_token, never refresh_token (BR-8)", async () => {
      const name = uniqueDoName();
      const acct = client.account(name);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      const result = await acct.getAccessToken();

      // Result should contain access_token only
      expect(result.access_token).toBeDefined();
      const resultStr = JSON.stringify(result);
      expect(resultStr).not.toContain(TEST_TOKENS.refresh_token);
    });

    it("returns error when no tokens stored", async () => {
      const name = uniqueDoName();
      const acct = client.account(name);

      // Don't initialize -- directly call getAccessToken
      const result = await acct.raw<{ error: string }>("/getAccessToken");
      expect(result.status).toBe(500);
      expect(result.data.error).toMatch(/no tokens stored/);
    });
  });

  // -------------------------------------------------------------------------
  // Token persistence across requests (proves real DO SQLite)
  // -------------------------------------------------------------------------

  describe("token persistence", () => {
    it("tokens survive across multiple HTTP requests to same DO", async () => {
      const name = uniqueDoName();
      const acct = client.account(name);

      // Request 1: initialize
      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      // Request 2: get token (different HTTP request, same DO instance)
      const result1 = await acct.getAccessToken();
      expect(result1.access_token).toBe(TEST_TOKENS.access_token);

      // Request 3: get token again (verifies consistency)
      const result2 = await acct.getAccessToken();
      expect(result2.access_token).toBe(TEST_TOKENS.access_token);
    });

    it("different DO names have isolated storage", async () => {
      const name1 = uniqueDoName();
      const name2 = uniqueDoName();
      const acct1 = client.account(name1);
      const acct2 = client.account(name2);

      // Initialize only acct1
      await acct1.initialize(TEST_TOKENS, TEST_SCOPES);

      // acct1 should have tokens
      const result1 = await acct1.getAccessToken();
      expect(result1.access_token).toBe(TEST_TOKENS.access_token);

      // acct2 should NOT have tokens
      const result2 = await acct2.raw<{ error: string }>("/getAccessToken");
      expect(result2.status).toBe(500);
      expect(result2.data.error).toMatch(/no tokens stored/);
    });
  });

  // -------------------------------------------------------------------------
  // revokeTokens
  // -------------------------------------------------------------------------

  describe("revokeTokens()", () => {
    it("deletes local auth data (remote revocation may fail without real creds)", async () => {
      const name = uniqueDoName();
      const acct = client.account(name);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      // Verify tokens exist
      const before = await acct.getAccessToken();
      expect(before.access_token).toBe(TEST_TOKENS.access_token);

      // Revoke (Google API call will likely fail since we have fake tokens,
      // but local deletion should still happen)
      const result = await acct.revokeTokens();
      expect(result.ok).toBe(true);
      // revoked may be false since Google won't accept fake tokens
      expect(typeof result.revoked).toBe("boolean");

      // After revocation, getAccessToken should fail
      const after = await acct.raw<{ error: string }>("/getAccessToken");
      expect(after.status).toBe(500);
      expect(after.data.error).toMatch(/no tokens stored/);
    });

    it("returns revoked:false when no tokens exist", async () => {
      const name = uniqueDoName();
      const acct = client.account(name);

      // Force migration via getHealth, but don't initialize tokens
      await acct.getHealth();

      const result = await acct.revokeTokens();
      expect(result.ok).toBe(true);
      expect(result.revoked).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Sync cursor management
  // -------------------------------------------------------------------------

  describe("getSyncToken / setSyncToken", () => {
    it("returns null when no sync token set", async () => {
      const name = uniqueDoName();
      const acct = client.account(name);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      const result = await acct.getSyncToken();
      expect(result.sync_token).toBeNull();
    });

    it("stores and retrieves a sync token", async () => {
      const name = uniqueDoName();
      const acct = client.account(name);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      await acct.setSyncToken("next_sync_token_abc123");

      const result = await acct.getSyncToken();
      expect(result.sync_token).toBe("next_sync_token_abc123");
    });

    it("updates an existing sync token", async () => {
      const name = uniqueDoName();
      const acct = client.account(name);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      await acct.setSyncToken("token_v1");
      await acct.setSyncToken("token_v2");

      const result = await acct.getSyncToken();
      expect(result.sync_token).toBe("token_v2");
    });

    it("setSyncToken clears fullSyncNeeded", async () => {
      const name = uniqueDoName();
      const acct = client.account(name);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      // Initially fullSyncNeeded = true
      const healthBefore = await acct.getHealth();
      expect(healthBefore.fullSyncNeeded).toBe(true);

      await acct.setSyncToken("first_token");

      // After setting sync token, fullSyncNeeded should be false
      const healthAfter = await acct.getHealth();
      expect(healthAfter.fullSyncNeeded).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Watch channel lifecycle
  // -------------------------------------------------------------------------

  describe("registerChannel / getChannelStatus", () => {
    it("registers a new channel", async () => {
      const name = uniqueDoName();
      const acct = client.account(name);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      const result = await acct.registerChannel("primary");

      expect(result.channelId).toBeDefined();
      expect(result.channelId.startsWith("cal_")).toBe(true);
      expect(result.expiry).toBeDefined();

      // Expiry should be roughly 7 days from now
      const expiryMs = new Date(result.expiry).getTime();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      expect(expiryMs).toBeGreaterThan(Date.now() + sevenDays - 10_000);
      expect(expiryMs).toBeLessThan(Date.now() + sevenDays + 10_000);
    });

    it("registers multiple channels and lists them", async () => {
      const name = uniqueDoName();
      const acct = client.account(name);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      const ch1 = await acct.registerChannel("primary");
      const ch2 = await acct.registerChannel("work@gmail.com");

      expect(ch1.channelId).not.toBe(ch2.channelId);

      const status = await acct.getChannelStatus();
      expect(status.channels).toHaveLength(2);
      expect(status.channels[0].channelId).toBe(ch1.channelId);
      expect(status.channels[0].calendarId).toBe("primary");
      expect(status.channels[0].status).toBe("active");
      expect(status.channels[1].channelId).toBe(ch2.channelId);
      expect(status.channels[1].calendarId).toBe("work@gmail.com");
    });

    it("returns empty array when no channels", async () => {
      const name = uniqueDoName();
      const acct = client.account(name);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      const status = await acct.getChannelStatus();
      expect(status.channels).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Health tracking
  // -------------------------------------------------------------------------

  describe("getHealth / markSyncSuccess / markSyncFailure", () => {
    it("returns defaults after initialization", async () => {
      const name = uniqueDoName();
      const acct = client.account(name);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      const health = await acct.getHealth();

      expect(health.lastSyncTs).toBeNull();
      expect(health.lastSuccessTs).toBeNull();
      expect(health.fullSyncNeeded).toBe(true);
    });

    it("markSyncSuccess updates both timestamps", async () => {
      const name = uniqueDoName();
      const acct = client.account(name);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);
      const ts = "2026-02-14T12:00:00Z";
      await acct.markSyncSuccess(ts);

      const health = await acct.getHealth();
      expect(health.lastSyncTs).toBe(ts);
      expect(health.lastSuccessTs).toBe(ts);
    });

    it("markSyncFailure updates lastSyncTs but not lastSuccessTs", async () => {
      const name = uniqueDoName();
      const acct = client.account(name);

      await acct.initialize(TEST_TOKENS, TEST_SCOPES);

      // First mark a success
      await acct.markSyncSuccess("2026-02-14T12:00:00Z");

      // Then mark a failure
      await acct.markSyncFailure("Connection timeout");

      const health = await acct.getHealth();
      // lastSyncTs should be updated to a recent timestamp
      expect(health.lastSyncTs).not.toBe("2026-02-14T12:00:00Z");
      // lastSuccessTs should still be the original success time
      expect(health.lastSuccessTs).toBe("2026-02-14T12:00:00Z");
    });
  });

  // -------------------------------------------------------------------------
  // handleFetch routing (proves HTTP routing works)
  // -------------------------------------------------------------------------

  describe("handleFetch routing", () => {
    it("returns 404 for unknown action", async () => {
      const name = uniqueDoName();
      const acct = client.account(name);

      const result = await acct.raw<string>("/nonexistent", {});
      expect(result.status).toBe(404);
    });

    it("returns 500 with error message for business logic errors", async () => {
      const name = uniqueDoName();
      const acct = client.account(name);

      // Try to get access token without initializing
      const result = await acct.raw<{ error: string }>("/getAccessToken");
      expect(result.status).toBe(500);
      expect(result.data.error).toBeDefined();
    });
  });
});
