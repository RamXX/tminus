/**
 * Vitest configuration for Phase 6A E2E validation tests.
 *
 * Tests the complete multi-provider onboarding journey end-to-end:
 *   - Full 3-provider onboarding (Google + Microsoft + Apple/CalDAV)
 *   - 5-account stress test (no race conditions, no duplicates)
 *   - Session resilience (browser close and resume)
 *   - Error recovery (OAuth denial, invalid credentials, network timeout)
 *   - Account management (disconnect, reconnect, no orphaned data)
 *
 * Uses BOTH:
 *   1. Real API handler chain (createHandler) with stateful DO stub
 *      -- proves the full HTTP route -> DO RPC -> state persistence flow
 *   2. Real UserGraphDO with real SQLite (better-sqlite3)
 *      -- proves DO-level onboarding session management with real persistence
 *
 * No mocks of internal modules, no test fixtures.
 *
 * Prerequisites:
 *   - pnpm install (all workspace packages)
 *
 * Run with:
 *   make test-e2e-phase6a
 */

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "e2e-phase6a",
          include: [
            "tests/e2e/phase-6a-onboarding.integration.test.ts",
          ],
          // Integration tests run sequentially (shared state per describe)
          pool: "forks",
          poolOptions: {
            forks: {
              singleFork: true,
              execArgv: [],
            },
          },
          // Generous timeout for full journey tests
          testTimeout: 60_000,
          // Run tests in file order
          sequence: {
            shuffle: false,
          },
        },
        resolve: {
          alias: {
            "@tminus/shared": path.resolve(__dirname, "packages/shared/src"),
            "@tminus/d1-registry": path.resolve(
              __dirname,
              "packages/d1-registry/src",
            ),
            "@tminus/do-user-graph": path.resolve(
              __dirname,
              "durable-objects/user-graph/src",
            ),
          },
        },
      },
    ],
  },
});
