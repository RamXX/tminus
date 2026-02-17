/**
 * Vitest configuration for E2E (walking skeleton) tests.
 *
 * These tests require:
 * - Network access to Google Calendar API
 * - Pre-authorized Google OAuth refresh tokens for BOTH test accounts
 * - wrangler CLI available in PATH
 *
 * Run with: make test-e2e
 *
 * Tests skip gracefully when credentials are not set.
 *
 * Separate from vitest.integration.real.config.ts because E2E tests
 * are heavier (full pipeline) and may need different timeouts.
 */

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "e2e",
          include: [
            "tests/e2e/**/*.integration.test.ts",
          ],
          // E2E tests are slow -- very generous timeout
          testTimeout: 180_000,
          // Run serially to avoid port conflicts and shared state issues
          pool: "forks",
          poolOptions: {
            forks: {
              singleFork: true,
            },
          },
        },
        resolve: {
          alias: {
            // --- Workspace packages (source aliases) ---
            "@tminus/shared": path.resolve(__dirname, "packages/shared/src"),
            "@tminus/d1-registry": path.resolve(
              __dirname,
              "packages/d1-registry/src",
            ),
            // --- Durable Objects ---
            "@tminus/do-user-graph": path.resolve(
              __dirname,
              "durable-objects/user-graph/src",
            ),
            "@tminus/do-group-schedule": path.resolve(
              __dirname,
              "durable-objects/group-schedule/src",
            ),
            // --- Workflows ---
            "@tminus/workflow-scheduling": path.resolve(
              __dirname,
              "workflows/scheduling/src",
            ),
            // --- Cloudflare runtime stubs ---
            // The "cloudflare:workers" scheme is a Cloudflare Workers built-in
            // module unavailable in Node/vitest. Several E2E test files
            // transitively import it (e.g. walking-skeleton-oauth imports
            // workers/oauth/src/index which re-exports workflow-wrapper.ts
            // which imports WorkflowEntrypoint from cloudflare:workers).
            // This stub provides minimal WorkflowEntrypoint and DurableObject
            // classes so the import resolves without error.
            "cloudflare:workers": path.resolve(
              __dirname,
              "workers/oauth/src/__stubs__/cloudflare-workers.ts",
            ),
          },
        },
      },
    ],
  },
});
