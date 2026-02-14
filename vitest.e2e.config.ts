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
