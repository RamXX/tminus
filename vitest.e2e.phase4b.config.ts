/**
 * Vitest configuration for Phase 4B E2E validation tests.
 *
 * Tests the geo-aware intelligence pipeline end-to-end:
 *   - Relationship creation with city context
 *   - Trip constraint -> reconnection suggestions (geo-aware)
 *   - Milestone CRUD and scheduler avoidance
 *   - Dashboard data assembly
 *
 * Uses real SQLite (better-sqlite3), real UserGraphDO, real SchedulingWorkflow.
 * No HTTP server required.
 *
 * Prerequisites:
 *   - pnpm install (all workspace packages)
 *
 * Run with:
 *   make test-e2e-phase4b
 */

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "e2e-phase4b",
          include: [
            "tests/e2e/phase-4b-geo-intelligence.integration.test.ts",
          ],
          // Integration tests run sequentially (shared state per describe)
          pool: "forks",
          poolOptions: {
            forks: {
              singleFork: true,
              execArgv: [],
            },
          },
          // Generous timeout for geo computation + scheduling
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
