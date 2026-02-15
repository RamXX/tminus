/**
 * Vitest configuration for Phase 5B E2E validation tests.
 *
 * Tests the advanced intelligence pipeline end-to-end:
 *   - Cognitive load scoring (meeting density, switches, fragmentation)
 *   - Context switch cost estimation and clustering suggestions
 *   - Deep work window detection, protection, and optimization
 *   - Temporal risk scoring (burnout, travel, drift)
 *   - Probabilistic availability modeling (tentative, confirmed, cancelled)
 *
 * Uses real SQLite (better-sqlite3), real UserGraphDO, real pure functions.
 * No HTTP server required.
 *
 * Prerequisites:
 *   - pnpm install (all workspace packages)
 *
 * Run with:
 *   make test-e2e-phase5b
 */

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "e2e-phase5b",
          include: [
            "tests/e2e/phase-5b-advanced-intelligence.integration.test.ts",
          ],
          // Integration tests run sequentially (shared state per describe)
          pool: "forks",
          poolOptions: {
            forks: {
              singleFork: true,
              execArgv: [],
            },
          },
          // Generous timeout for intelligence computations
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
