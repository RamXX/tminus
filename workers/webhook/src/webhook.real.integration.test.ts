/**
 * Real integration tests for tminus-webhook worker.
 *
 * Unlike the mocked tests in webhook.test.ts and webhook.integration.test.ts,
 * these tests use:
 * - Real wrangler dev server (tminus-webhook with local D1 + queue)
 * - Real HTTP requests to the running worker
 * - Real D1 via Miniflare (not better-sqlite3)
 *
 * Tests skip gracefully when GOOGLE_TEST_REFRESH_TOKEN_A is not set
 * (following the credential-gated skip pattern).
 *
 * Run with: make test-integration-real
 *
 * Architecture:
 * 1. Start tminus-webhook on a dedicated port
 * 2. Seed D1 with test org/user/account rows via wrangler d1 execute
 * 3. Send real HTTP requests and verify responses
 * 4. Clean up wrangler dev process
 *
 * Note: Queue message verification is not possible via HTTP in local mode.
 * We verify the worker's HTTP contract: correct status codes and routing.
 * The mocked tests in webhook.integration.test.ts verify queue message content.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  requireTestCredentials,
  loadTestEnv,
  startWranglerDev,
  seedTestD1,
  DEFAULTS,
} from "../../../scripts/test/integration-helpers.js";
import type { StartedWorker } from "../../../scripts/test/integration-helpers.js";

const ROOT = resolve(import.meta.dirname, "../../..");
const hasCredentials = requireTestCredentials();

// ---------------------------------------------------------------------------
// Port assignments (must not conflict with other integration tests)
// ---------------------------------------------------------------------------

const WEBHOOK_PORT = 18801;
const SHARED_PERSIST_DIR = resolve(ROOT, ".wrangler-test-webhook");

// ---------------------------------------------------------------------------
// Test fixture IDs
// ---------------------------------------------------------------------------

const TEST_ORG = {
  org_id: "org_01JREALWEBHK0000000000001",
  name: "Real Webhook Test Org",
} as const;

const TEST_USER = {
  user_id: "usr_01JREALWEBHK0000000000001",
  email: "real-webhook-test@example.com",
} as const;

const ACCOUNT_A = {
  account_id: "acc_01JREALWEBHKACCOUNTA0001",
  provider: "google",
  provider_subject: "google-sub-real-webhook-a",
  email: "realwebhooktest@gmail.com",
  channel_token: "real-test-channel-token-alpha",
} as const;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Webhook real integration tests", () => {
  let webhookWorker: StartedWorker | null = null;

  beforeAll(() => {
    if (!hasCredentials) {
      console.warn(
        "\n" +
          "  WARNING: GOOGLE_TEST_REFRESH_TOKEN_A not set.\n" +
          "  Skipping real webhook integration tests that require wrangler dev.\n" +
          "  Set this env var to run full integration tests.\n",
      );
    }
  });

  afterAll(async () => {
    if (webhookWorker) {
      await webhookWorker.cleanup(true);
    }
  });

  // -------------------------------------------------------------------------
  // Configuration validation tests (always run, no wrangler dev needed)
  // -------------------------------------------------------------------------

  it("wrangler.toml exists and has correct bindings", async () => {
    const { readFile } = await import("node:fs/promises");
    const toml = await readFile(
      resolve(ROOT, "workers/webhook/wrangler.toml"),
      "utf-8",
    );
    expect(toml).toContain('name = "tminus-webhook"');
    expect(toml).toContain('binding = "DB"');
    expect(toml).toContain('binding = "SYNC_QUEUE"');
    expect(toml).toContain("tminus-sync-queue");
  });

  it("webhook worker exports createHandler", async () => {
    const { createHandler } = await import("./index.js");
    expect(typeof createHandler).toBe("function");
    const handler = createHandler();
    expect(handler).toHaveProperty("fetch");
  });

  // -------------------------------------------------------------------------
  // Real wrangler dev tests (credential-gated)
  // -------------------------------------------------------------------------

  it.skipIf(!hasCredentials)(
    "start wrangler dev for tminus-webhook",
    async () => {
      webhookWorker = await startWranglerDev({
        wranglerToml: resolve(ROOT, "workers/webhook/wrangler.toml"),
        port: WEBHOOK_PORT,
        persistDir: SHARED_PERSIST_DIR,
        healthPath: "/health",
        healthTimeoutMs: 60_000,
      });

      expect(webhookWorker.url).toBe(`http://127.0.0.1:${WEBHOOK_PORT}`);

      // Verify health endpoint via real HTTP
      const resp = await fetch(`${webhookWorker.url}/health`);
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe("OK");
    },
  );

  it.skipIf(!hasCredentials)(
    "seed D1 with test org/user/account for webhook tests",
    async () => {
      // First run the migration
      await seedTestD1({
        persistDir: SHARED_PERSIST_DIR,
        wranglerToml: resolve(ROOT, "workers/webhook/wrangler.toml"),
        databaseName: "tminus-registry",
        sqlFilePath: resolve(
          ROOT,
          "migrations/d1-registry/0001_initial_schema.sql",
        ),
      });

      // Then seed test data
      const tmpDir = await mkdtemp(resolve(tmpdir(), "tminus-webhook-seed-"));
      const seedSqlPath = resolve(tmpDir, "seed.sql");

      const seedSql = `
INSERT OR IGNORE INTO orgs (org_id, name) VALUES ('${TEST_ORG.org_id}', '${TEST_ORG.name}');
INSERT OR IGNORE INTO users (user_id, org_id, email) VALUES ('${TEST_USER.user_id}', '${TEST_ORG.org_id}', '${TEST_USER.email}');
INSERT OR IGNORE INTO accounts (account_id, user_id, provider, provider_subject, email, channel_token, status)
  VALUES ('${ACCOUNT_A.account_id}', '${TEST_USER.user_id}', '${ACCOUNT_A.provider}', '${ACCOUNT_A.provider_subject}', '${ACCOUNT_A.email}', '${ACCOUNT_A.channel_token}', 'active');
      `.trim();

      await writeFile(seedSqlPath, seedSql, "utf-8");

      await seedTestD1({
        persistDir: SHARED_PERSIST_DIR,
        wranglerToml: resolve(ROOT, "workers/webhook/wrangler.toml"),
        databaseName: "tminus-registry",
        sqlFilePath: seedSqlPath,
      });
    },
  );

  it.skipIf(!hasCredentials)(
    "POST /webhook/google with valid channel_token returns 200",
    async () => {
      const resp = await fetch(
        `${webhookWorker!.url}/webhook/google`,
        {
          method: "POST",
          headers: {
            "X-Goog-Channel-ID": "test-channel-uuid-real-001",
            "X-Goog-Resource-ID": "test-resource-id-real-001",
            "X-Goog-Resource-State": "exists",
            "X-Goog-Channel-Token": ACCOUNT_A.channel_token,
          },
        },
      );

      // Webhook always returns 200 to Google
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe("OK");
    },
  );

  it.skipIf(!hasCredentials)(
    "POST /webhook/google with unknown channel_token returns 200 (never errors to Google)",
    async () => {
      const resp = await fetch(
        `${webhookWorker!.url}/webhook/google`,
        {
          method: "POST",
          headers: {
            "X-Goog-Channel-ID": "test-channel-uuid-unknown",
            "X-Goog-Resource-ID": "test-resource-id-unknown",
            "X-Goog-Resource-State": "exists",
            "X-Goog-Channel-Token": "completely-unknown-token-xyz",
          },
        },
      );

      // Always 200 -- no error surfaced to Google
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe("OK");
    },
  );

  it.skipIf(!hasCredentials)(
    "POST /webhook/google with missing headers returns 200 (graceful handling)",
    async () => {
      // Send bare POST with no Google headers
      const resp = await fetch(
        `${webhookWorker!.url}/webhook/google`,
        {
          method: "POST",
        },
      );

      // Always 200 -- missing headers are logged but not errored
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe("OK");
    },
  );

  it.skipIf(!hasCredentials)(
    "POST /webhook/google with sync resource_state returns 200 (no enqueue)",
    async () => {
      const resp = await fetch(
        `${webhookWorker!.url}/webhook/google`,
        {
          method: "POST",
          headers: {
            "X-Goog-Channel-ID": "test-channel-uuid-sync",
            "X-Goog-Resource-ID": "test-resource-id-sync",
            "X-Goog-Resource-State": "sync",
            "X-Goog-Channel-Token": ACCOUNT_A.channel_token,
          },
        },
      );

      // Sync ping acknowledged with 200
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe("OK");
    },
  );

  it.skipIf(!hasCredentials)(
    "GET /health returns 200 OK via real HTTP",
    async () => {
      const resp = await fetch(`${webhookWorker!.url}/health`);
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe("OK");
    },
  );

  it.skipIf(!hasCredentials)(
    "GET /unknown returns 404 via real HTTP",
    async () => {
      const resp = await fetch(`${webhookWorker!.url}/unknown`);
      expect(resp.status).toBe(404);
    },
  );

  it.skipIf(!hasCredentials)(
    "GET /webhook/google returns 404 (only POST accepted)",
    async () => {
      const resp = await fetch(`${webhookWorker!.url}/webhook/google`);
      expect(resp.status).toBe(404);
    },
  );

  it.skipIf(!hasCredentials)(
    "POST /webhook/google with not_exists resource_state returns 200",
    async () => {
      const resp = await fetch(
        `${webhookWorker!.url}/webhook/google`,
        {
          method: "POST",
          headers: {
            "X-Goog-Channel-ID": "test-channel-uuid-not-exists",
            "X-Goog-Resource-ID": "test-resource-id-not-exists",
            "X-Goog-Resource-State": "not_exists",
            "X-Goog-Channel-Token": ACCOUNT_A.channel_token,
          },
        },
      );

      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe("OK");
    },
  );
});
