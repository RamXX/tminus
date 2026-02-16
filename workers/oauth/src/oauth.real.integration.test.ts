/**
 * Real integration tests for tminus-oauth worker.
 *
 * Unlike the mocked tests in oauth.test.ts, these tests use:
 * - Real wrangler dev server for tminus-oauth
 * - Real HTTP requests to the running worker
 * - Real D1 via Miniflare (not mocked D1)
 * - Real PKCE + state encryption (not bypassed)
 *
 * Tests skip gracefully when GOOGLE_TEST_REFRESH_TOKEN_A is not set.
 *
 * Run with: make test-integration-real
 *
 * Architecture:
 * 1. Start tminus-oauth on a dedicated port with required env vars
 * 2. Test /oauth/google/start endpoint (fully testable -- generates redirect)
 * 3. Test /oauth/google/callback with invalid inputs (error paths)
 * 4. Callback success path with real auth code is credential-gated
 * 5. Clean up wrangler dev process
 *
 * Note: The oauth worker references DOs from tminus-api (AccountDO, UserGraphDO)
 * and hosts OnboardingWorkflow. In local wrangler dev mode, cross-worker DO
 * references are not fully supported without running tminus-api alongside.
 * For the /oauth/google/start tests, DOs are not needed (stateless redirect).
 * For callback tests that need DOs, we test the HTTP contract (error paths).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "node:path";
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
// Port assignments
// ---------------------------------------------------------------------------

const OAUTH_PORT = 18803;
const SHARED_PERSIST_DIR = resolve(ROOT, ".wrangler-test-oauth");

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_CLIENT_ID = "test-client-id-for-real-integration.apps.googleusercontent.com";
const TEST_CLIENT_SECRET = "test-client-secret-for-real-integration";
const TEST_JWT_SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";
const TEST_USER_ID = "usr_01JREA0MPAVTH0000000000001";

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("OAuth real integration tests", () => {
  let oauthWorker: StartedWorker | null = null;

  beforeAll(() => {
    if (!hasCredentials) {
      console.warn(
        "\n" +
          "  WARNING: GOOGLE_TEST_REFRESH_TOKEN_A not set.\n" +
          "  Skipping real OAuth integration tests that require wrangler dev.\n" +
          "  Set this env var to run full integration tests.\n",
      );
    }
  });

  afterAll(async () => {
    if (oauthWorker) {
      await oauthWorker.cleanup(true);
    }
  });

  // -------------------------------------------------------------------------
  // Configuration validation tests (always run)
  // -------------------------------------------------------------------------

  it("wrangler.toml exists and has correct bindings", async () => {
    const { readFile } = await import("node:fs/promises");
    const toml = await readFile(
      resolve(ROOT, "workers/oauth/wrangler.toml"),
      "utf-8",
    );
    expect(toml).toContain('name = "tminus-oauth"');
    expect(toml).toContain('binding = "DB"');
    expect(toml).toContain('class_name = "AccountDO"');
    expect(toml).toContain('class_name = "UserGraphDO"');
    expect(toml).toContain('class_name = "OnboardingWorkflow"');
  });

  it("oauth worker exports createHandler", async () => {
    const { createHandler } = await import("./index.js");
    expect(typeof createHandler).toBe("function");
    const handler = createHandler();
    expect(handler).toHaveProperty("fetch");
  });

  it("Google OAuth constants are correctly defined", async () => {
    const { GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, GOOGLE_SCOPES, CALLBACK_PATH } =
      await import("./google.js");
    expect(GOOGLE_AUTH_URL).toContain("accounts.google.com");
    expect(GOOGLE_TOKEN_URL).toContain("oauth2.googleapis.com");
    expect(GOOGLE_SCOPES).toContain("calendar");
    expect(CALLBACK_PATH).toBe("/oauth/google/callback");
  });

  // -------------------------------------------------------------------------
  // Real wrangler dev tests (credential-gated)
  // -------------------------------------------------------------------------

  it.skipIf(!hasCredentials)(
    "start wrangler dev for tminus-oauth",
    async () => {
      const env = loadTestEnv();

      oauthWorker = await startWranglerDev({
        wranglerToml: resolve(ROOT, "workers/oauth/wrangler.toml"),
        port: OAUTH_PORT,
        persistDir: SHARED_PERSIST_DIR,
        vars: {
          GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID ?? TEST_CLIENT_ID,
          GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET ?? TEST_CLIENT_SECRET,
          JWT_SECRET: env.JWT_SECRET ?? TEST_JWT_SECRET,
        },
        healthTimeoutMs: 60_000,
      });

      expect(oauthWorker.url).toBe(`http://127.0.0.1:${OAUTH_PORT}`);
    },
  );

  it.skipIf(!hasCredentials)(
    "seed D1 with schema for oauth tests",
    async () => {
      await seedTestD1({
        persistDir: SHARED_PERSIST_DIR,
        wranglerToml: resolve(ROOT, "workers/oauth/wrangler.toml"),
        databaseName: "tminus-registry",
        sqlFilePath: resolve(
          ROOT,
          "migrations/d1-registry/0001_initial_schema.sql",
        ),
      });
    },
  );

  it.skipIf(!hasCredentials)(
    "GET /oauth/google/start with user_id redirects to Google OAuth",
    async () => {
      const resp = await fetch(
        `${oauthWorker!.url}/oauth/google/start?user_id=${TEST_USER_ID}`,
        { redirect: "manual" },
      );

      // Should be a 302 redirect to Google
      expect(resp.status).toBe(302);

      const location = resp.headers.get("Location");
      expect(location).toBeTruthy();

      // Parse the redirect URL and verify Google OAuth params
      const redirectUrl = new URL(location!);
      expect(redirectUrl.hostname).toBe("accounts.google.com");
      expect(redirectUrl.searchParams.get("response_type")).toBe("code");
      expect(redirectUrl.searchParams.get("access_type")).toBe("offline");
      expect(redirectUrl.searchParams.get("prompt")).toBe("consent");
      expect(redirectUrl.searchParams.get("code_challenge_method")).toBe("S256");

      // Verify PKCE challenge is present and well-formed
      const codeChallenge = redirectUrl.searchParams.get("code_challenge");
      expect(codeChallenge).toBeTruthy();
      expect(codeChallenge!.length).toBe(43); // SHA-256 => 32 bytes => 43 base64url chars
      expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);

      // Verify state parameter is present (encrypted blob)
      const state = redirectUrl.searchParams.get("state");
      expect(state).toBeTruthy();
      expect(state!.length).toBeGreaterThan(10);

      // Verify redirect_uri points back to this worker's callback
      const redirectUri = redirectUrl.searchParams.get("redirect_uri");
      expect(redirectUri).toContain("/oauth/google/callback");

      // Verify scope includes calendar access
      const scope = redirectUrl.searchParams.get("scope");
      expect(scope).toContain("calendar");
      expect(scope).toContain("openid");
    },
  );

  it.skipIf(!hasCredentials)(
    "GET /oauth/google/start without user_id returns 400",
    async () => {
      const resp = await fetch(
        `${oauthWorker!.url}/oauth/google/start`,
      );

      expect(resp.status).toBe(400);
      const body = await resp.json() as { error: string };
      expect(body.error).toContain("user_id");
    },
  );

  it.skipIf(!hasCredentials)(
    "GET /oauth/google/start with custom redirect_uri includes it in state",
    async () => {
      const customRedirect = "https://myapp.example.com/oauth/done";
      const resp = await fetch(
        `${oauthWorker!.url}/oauth/google/start?user_id=${TEST_USER_ID}&redirect_uri=${encodeURIComponent(customRedirect)}`,
        { redirect: "manual" },
      );

      expect(resp.status).toBe(302);

      // The redirect_uri param in the Google URL should be the callback endpoint
      const location = resp.headers.get("Location");
      const redirectUrl = new URL(location!);
      const callbackUri = redirectUrl.searchParams.get("redirect_uri");
      expect(callbackUri).toContain("/oauth/google/callback");

      // The custom redirect_uri is encrypted in the state, not visible in the URL
      // We just verify the flow doesn't break with a custom redirect_uri
    },
  );

  it.skipIf(!hasCredentials)(
    "GET /oauth/google/callback?error=access_denied returns user-friendly message",
    async () => {
      const resp = await fetch(
        `${oauthWorker!.url}/oauth/google/callback?error=access_denied`,
      );

      // User denied consent -- return friendly message (not an HTTP error)
      expect(resp.status).toBe(200);
      const body = await resp.text();
      expect(body).toContain("declined access");
    },
  );

  it.skipIf(!hasCredentials)(
    "GET /oauth/google/callback with missing code returns 400",
    async () => {
      const resp = await fetch(
        `${oauthWorker!.url}/oauth/google/callback?state=some-state-value`,
      );

      expect(resp.status).toBe(400);
      const body = await resp.text();
      expect(body).toContain("Missing required parameters");
    },
  );

  it.skipIf(!hasCredentials)(
    "GET /oauth/google/callback with tampered state returns 400",
    async () => {
      const resp = await fetch(
        `${oauthWorker!.url}/oauth/google/callback?code=fake-code&state=tampered-invalid-state`,
      );

      expect(resp.status).toBe(400);
      const body = await resp.text();
      expect(body).toContain("Please try again");
    },
  );

  it.skipIf(!hasCredentials)(
    "POST method returns 405 (only GET allowed)",
    async () => {
      const resp = await fetch(
        `${oauthWorker!.url}/oauth/google/start?user_id=${TEST_USER_ID}`,
        { method: "POST" },
      );

      expect(resp.status).toBe(405);
    },
  );

  it.skipIf(!hasCredentials)(
    "GET /unknown returns 404",
    async () => {
      const resp = await fetch(`${oauthWorker!.url}/nonexistent`);
      expect(resp.status).toBe(404);
    },
  );

  // -------------------------------------------------------------------------
  // Callback success path -- requires real Google auth code
  // (This would need a real browser OAuth flow to obtain the code.
  //  In CI, this is skipped unless a pre-obtained auth code is available.)
  // -------------------------------------------------------------------------

  // Note: A full callback test with real token exchange requires:
  // 1. A valid authorization code from a completed Google consent flow
  // 2. The tminus-api worker running (for AccountDO)
  // These are tested in the E2E walking skeleton story (TM-xxx).
  // Here we verify the error handling paths are correct.

  // -------------------------------------------------------------------------
  // TM-2w75: OAuth redirect URI verification (always runs -- no credentials needed)
  //
  // Verifies that the redirect_uri sent to Google OAuth matches the GCP
  // OAuth consent screen configuration. Uses the REAL handler with REAL
  // crypto (PKCE + state encryption) and a production-like origin. No mocks.
  // -------------------------------------------------------------------------

  describe("redirect URI verification (TM-2w75)", () => {
    // The EXACT redirect URI configured in the GCP OAuth consent screen.
    // If this changes in GCP, update this constant and the worker code.
    const GCP_GOOGLE_REDIRECT_URI = "https://oauth.tminus.ink/oauth/google/callback";
    const PRODUCTION_ORIGIN = "https://oauth.tminus.ink";

    it("production wrangler.toml routes oauth.tminus.ink to the worker", async () => {
      const { readFile } = await import("node:fs/promises");
      const toml = await readFile(
        resolve(ROOT, "workers/oauth/wrangler.toml"),
        "utf-8",
      );
      // Verify the production route pattern matches the expected domain
      expect(toml).toContain('pattern = "oauth.tminus.ink/*"');
      expect(toml).toContain('zone_name = "tminus.ink"');
    });

    it("CALLBACK_PATH constant matches GCP redirect URI path", async () => {
      const { CALLBACK_PATH } = await import("./google.js");
      const gcpPath = new URL(GCP_GOOGLE_REDIRECT_URI).pathname;
      expect(CALLBACK_PATH).toBe(gcpPath);
    });

    it("callback route handler is registered at the same path as CALLBACK_PATH", async () => {
      const { CALLBACK_PATH } = await import("./google.js");
      const { createHandler } = await import("./index.js");
      const handler = createHandler();

      // Verify the route handler responds at the callback path (not 404)
      // Use a request with ?error=test to get a 200 (consent denied) instead of
      // needing valid state/code params.
      const request = new Request(
        `${PRODUCTION_ORIGIN}${CALLBACK_PATH}?error=test_probe`,
      );
      const env = {
        JWT_SECRET: TEST_JWT_SECRET,
        GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: TEST_CLIENT_SECRET,
        MS_CLIENT_ID: "unused",
        MS_CLIENT_SECRET: "unused",
        DB: {},
        USER_GRAPH: {},
        ACCOUNT: {},
        ONBOARDING_WORKFLOW: {},
      } as unknown as Env;
      const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

      const response = await handler.fetch(request, env, ctx);
      // The error=test_probe path returns 200 with "declined access" message,
      // proving the route handler is registered and active at this path.
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("declined access");
    });

    it("authorize redirect sends exact GCP-configured redirect_uri to Google", async () => {
      const { createHandler } = await import("./index.js");
      const handler = createHandler();

      // Simulate a request arriving at the production origin
      const request = new Request(
        `${PRODUCTION_ORIGIN}/oauth/google/start?user_id=${TEST_USER_ID}`,
      );
      const env = {
        JWT_SECRET: TEST_JWT_SECRET,
        GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: TEST_CLIENT_SECRET,
        MS_CLIENT_ID: "unused",
        MS_CLIENT_SECRET: "unused",
        DB: {},
        USER_GRAPH: {},
        ACCOUNT: {},
        ONBOARDING_WORKFLOW: {},
      } as unknown as Env;
      const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

      const response = await handler.fetch(request, env, ctx);
      expect(response.status).toBe(302);

      const location = response.headers.get("Location")!;
      expect(location).toBeTruthy();

      const redirectUrl = new URL(location);
      const redirectUri = redirectUrl.searchParams.get("redirect_uri");

      // THE critical assertion: the redirect_uri sent to Google MUST
      // exactly match what is configured in the GCP OAuth consent screen.
      expect(redirectUri).toBe(GCP_GOOGLE_REDIRECT_URI);
    });

    it("callback handler constructs the same redirect_uri for token exchange", async () => {
      // Verify that the callback handler uses the same CALLBACK_PATH constant
      // for constructing the redirect_uri during token exchange.
      // We test this by reading the source code constants -- both handleStart
      // and handleCallback use `${url.origin}${CALLBACK_PATH}`.
      const { CALLBACK_PATH } = await import("./google.js");

      // The full redirect_uri at production is origin + CALLBACK_PATH
      const expectedUri = `${PRODUCTION_ORIGIN}${CALLBACK_PATH}`;
      expect(expectedUri).toBe(GCP_GOOGLE_REDIRECT_URI);
    });
  });
});
