/**
 * Vitest configuration for Phase 5A E2E validation tests.
 *
 * Tests the platform extensions pipeline end-to-end:
 *   - CalDAV feed generation (iCalendar RFC 5545 output)
 *   - Org policy CRUD + merge engine (working hours, VIP, account limits, detail)
 *   - What-if simulation engine (add commitment, recurring event, working hours)
 *   - Temporal Graph API (relationships, reputation, timeline, drift)
 *
 * Uses real SQLite (better-sqlite3), real UserGraphDO, real pure functions.
 * No HTTP server required.
 *
 * Prerequisites:
 *   - pnpm install (all workspace packages)
 *
 * Run with:
 *   make test-e2e-phase5a
 */

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "e2e-phase5a",
          include: [
            "tests/e2e/phase-5a-platform-extensions.integration.test.ts",
          ],
          // Integration tests run sequentially (shared state per describe)
          pool: "forks",
          poolOptions: {
            forks: {
              singleFork: true,
              execArgv: [],
            },
          },
          // Generous timeout for simulation computations
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
