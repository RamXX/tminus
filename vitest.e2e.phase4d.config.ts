/**
 * Vitest configuration for Phase 4D E2E validation tests.
 *
 * Tests the advanced scheduling pipeline end-to-end:
 *   - Multi-user group scheduling session creation
 *   - Availability intersection across users
 *   - Fairness scoring integration
 *   - Hold lifecycle (create, extend, expire)
 *   - External solver fallback
 *   - MCP tools functional verification
 *
 * Uses real SQLite (better-sqlite3), real UserGraphDO, real GroupScheduleDO,
 * real SchedulingWorkflow, real pure functions. No HTTP server required.
 *
 * Prerequisites:
 *   - pnpm install (all workspace packages)
 *
 * Run with:
 *   make test-e2e-phase4d
 */

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "e2e-phase4d",
          include: [
            "tests/e2e/phase-4d-advanced-scheduling.integration.test.ts",
          ],
          // Integration tests run sequentially (shared state per describe)
          pool: "forks",
          poolOptions: {
            forks: {
              singleFork: true,
              execArgv: [],
            },
          },
          // Generous timeout for multi-user scheduling operations
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
            "@tminus/do-group-schedule": path.resolve(
              __dirname,
              "durable-objects/group-schedule/src",
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
