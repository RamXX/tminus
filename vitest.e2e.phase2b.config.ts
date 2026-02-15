/**
 * Vitest configuration for Phase 2B E2E validation tests.
 *
 * These tests make real HTTP requests against a running MCP worker.
 * No miniflare, no pool workers -- just standard vitest with fetch.
 *
 * Prerequisites:
 *   - MCP worker running (wrangler dev or deployed)
 *   - Set MCP_BASE_URL env var to target (default: http://localhost:8976)
 *   - D1 database seeded with test accounts
 *
 * Run with:
 *   make test-e2e-phase2b            (localhost)
 *   make test-e2e-phase2b-staging    (staging)
 *   make test-e2e-phase2b-production (production)
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Use projects to override the workspace file -- only run our E2E test
    projects: [
      {
        test: {
          name: "e2e-phase2b",
          include: ["tests/e2e/phase-2b.test.ts"],
          // E2E tests run sequentially -- order matters (create before query, etc.)
          pool: "forks",
          poolOptions: {
            forks: {
              singleFork: true,
              execArgv: [],
            },
          },
          // Pass env vars to forked processes
          env: {
            MCP_BASE_URL:
              process.env.MCP_BASE_URL || "http://localhost:8976",
          },
          // Generous timeout for real HTTP calls + rate limit testing
          testTimeout: 60_000,
          // Run tests in file order, not shuffled
          sequence: {
            shuffle: false,
          },
        },
      },
    ],
  },
});
