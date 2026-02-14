/**
 * Vitest configuration for real integration tests.
 *
 * These tests require:
 * - Network access to Google Calendar API
 * - Pre-authorized Google OAuth refresh tokens
 * - wrangler CLI available in PATH
 *
 * Run with: make test-integration-real
 *
 * Tests skip gracefully when GOOGLE_TEST_REFRESH_TOKEN_A is not set.
 *
 * Uses test.projects to define a single project, which overrides
 * vitest.workspace.ts discovery and avoids name collisions.
 *
 * Includes:
 * - scripts/test/ harness smoke tests
 * - workers/sync-consumer real integration tests
 * - workers/write-consumer real integration tests
 */

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "integration-real",
          include: [
            "scripts/test/**/*.integration.test.ts",
            "workers/*/src/**/*.real.integration.test.ts",
          ],
          // Real integration tests are slow -- generous timeout
          testTimeout: 120_000,
          // Run serially to avoid port conflicts
          pool: "forks",
          poolOptions: {
            forks: {
              singleFork: true,
            },
          },
        },
        resolve: {
          alias: {
            "@tminus/shared": path.resolve(__dirname, "packages/shared/src"),
            "@tminus/d1-registry": path.resolve(
              __dirname,
              "packages/d1-registry/src",
            ),
          },
        },
      },
    ],
  },
});
