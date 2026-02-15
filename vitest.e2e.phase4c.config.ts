/**
 * Vitest configuration for Phase 4C E2E validation tests.
 *
 * Tests the context and communication pipeline end-to-end:
 *   - Pre-meeting briefing assembly from event + relationship data
 *   - Excuse generation with tone control (BR-17: never auto-send)
 *   - Commitment proof export + cryptographic verification
 *
 * Uses real SQLite (better-sqlite3), real UserGraphDO, real pure functions.
 * No HTTP server required.
 *
 * Prerequisites:
 *   - pnpm install (all workspace packages)
 *
 * Run with:
 *   make test-e2e-phase4c
 */

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "e2e-phase4c",
          include: [
            "tests/e2e/phase-4c-context-communication.integration.test.ts",
          ],
          // Integration tests run sequentially (shared state per describe)
          pool: "forks",
          poolOptions: {
            forks: {
              singleFork: true,
              execArgv: [],
            },
          },
          // Generous timeout for crypto operations
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
