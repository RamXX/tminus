/**
 * Vitest configuration for Phase 3A E2E validation tests.
 *
 * Tests the scheduling engine end-to-end using real SQLite (better-sqlite3),
 * real UserGraphDO, and real SchedulingWorkflow -- no HTTP server required.
 *
 * Prerequisites:
 *   - pnpm install (all workspace packages)
 *
 * Run with:
 *   make test-e2e-phase3a
 */

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "e2e-phase3a",
          include: [
            "tests/e2e/phase-3a-scheduling.integration.test.ts",
          ],
          // Scheduling tests run sequentially (shared state per describe)
          pool: "forks",
          poolOptions: {
            forks: {
              singleFork: true,
              execArgv: [],
            },
          },
          // Generous timeout for solver + constraint computation
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
            "@tminus/workflow-scheduling": path.resolve(
              __dirname,
              "workflows/scheduling/src",
            ),
          },
        },
      },
    ],
  },
});
