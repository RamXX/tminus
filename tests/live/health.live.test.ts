/**
 * Canary live test: GET /health against the deployed stack.
 *
 * Proves the live test harness works end-to-end:
 * - vitest.live.config.ts picks up this file
 * - loadLiveEnv() reads environment correctly
 * - LiveTestClient makes real HTTP calls to the deployed API
 * - Health endpoint returns the expected envelope structure
 *
 * Credential-gated: skips gracefully when LIVE_BASE_URL is not set.
 *
 * Run with: make test-live
 */

import { describe, it, expect, beforeAll } from "vitest";
import { loadLiveEnv, hasLiveCredentials } from "./setup.js";
import { LiveTestClient } from "./helpers.js";
import type { LiveEnv } from "./setup.js";

// ---------------------------------------------------------------------------
// Types matching the health response envelope
// ---------------------------------------------------------------------------

interface HealthBinding {
  name: string;
  available: boolean;
  type?: string;
}

interface HealthResponse {
  ok: boolean;
  data: {
    status: "healthy" | "degraded";
    version: string;
    environment: string;
    worker: string;
    bindings: HealthBinding[];
  };
  error: null;
  meta: {
    timestamp: string;
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Live canary: GET /health", () => {
  const canRun = hasLiveCredentials();

  let client: LiveTestClient;
  let env: LiveEnv;

  beforeAll(() => {
    if (!canRun) {
      console.warn(
        "\n" +
          "  WARNING: Live tests require LIVE_BASE_URL to be set.\n" +
          "  Skipping live canary tests.\n" +
          "  Run with: LIVE_BASE_URL=https://api.tminus.ink make test-live\n",
      );
      return;
    }

    const loaded = loadLiveEnv();
    if (!loaded) {
      // Should not happen since canRun checks the same condition,
      // but guard defensively.
      return;
    }
    env = loaded;
    client = LiveTestClient.fromEnv(env);
  });

  // -------------------------------------------------------------------------
  // Positive test: health endpoint returns 200 with expected structure
  // -------------------------------------------------------------------------

  it.skipIf(!canRun)(
    "returns 200 with healthy status and expected envelope structure",
    async () => {
      const resp = await client.get("/health");

      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toContain("application/json");

      const body: HealthResponse = await resp.json();

      // Envelope shape
      expect(body.ok).toBe(true);
      expect(body.error).toBeNull();
      expect(body.meta).toBeDefined();
      expect(body.meta.timestamp).toBeTruthy();

      // Data payload
      expect(body.data).toBeDefined();
      expect(body.data.status).toBe("healthy");
      expect(body.data.worker).toBe("tminus-api");
      expect(body.data.version).toBeTruthy();
      expect(body.data.environment).toBeTruthy();

      // Bindings are present and all available
      expect(body.data.bindings).toBeInstanceOf(Array);
      expect(body.data.bindings.length).toBeGreaterThan(0);

      for (const binding of body.data.bindings) {
        expect(binding.name).toBeTruthy();
        expect(binding.available).toBe(true);
      }

      // Specific expected bindings (from the API worker)
      const bindingNames = body.data.bindings.map((b) => b.name);
      expect(bindingNames).toContain("DB");
      expect(bindingNames).toContain("USER_GRAPH");
      expect(bindingNames).toContain("ACCOUNT");

      console.log(
        `  [LIVE] Health check PASS: ${body.data.worker} v${body.data.version} ` +
          `(${body.data.environment}) -- ${body.data.bindings.length} bindings OK`,
      );
    },
  );

  // -------------------------------------------------------------------------
  // Negative test: non-existent route returns 404
  // -------------------------------------------------------------------------

  it.skipIf(!canRun)(
    "returns 404 for non-existent route",
    async () => {
      const resp = await client.get("/nonexistent-route-12345");

      expect(resp.status).toBe(404);
      const body = await resp.json() as { ok: boolean };
      expect(body.ok).toBe(false);
    },
  );

  // -------------------------------------------------------------------------
  // Auth enforcement test: protected route without JWT returns 401
  // -------------------------------------------------------------------------

  it.skipIf(!canRun)(
    "returns 401 for protected route without authentication",
    async () => {
      const resp = await client.get("/v1/events", { auth: false });

      expect(resp.status).toBe(401);
      const body = await resp.json() as { ok: boolean };
      expect(body.ok).toBe(false);
    },
  );
});
