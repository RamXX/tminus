/**
 * Vitest configuration for Phase 2A E2E validation tests.
 *
 * These tests make real HTTP requests against a running API worker.
 * No miniflare, no pool workers -- just standard vitest with fetch.
 *
 * Prerequisites:
 *   - API worker running (wrangler dev or deployed)
 *   - Set BASE_URL env var to target (default: http://localhost:8787)
 *
 * Run with:
 *   make test-e2e-phase2a            (localhost)
 *   make test-e2e-phase2a-staging    (staging)
 *   make test-e2e-phase2a-production (production)
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Use projects to override the workspace file -- only run our E2E test
    projects: [
      {
        test: {
          name: "e2e-phase2a",
          include: ["tests/e2e/phase-2a.test.ts"],
          // E2E tests run sequentially -- order matters (register before login, etc.)
          pool: "forks",
          poolOptions: {
            forks: {
              singleFork: true,
              execArgv: [],
            },
          },
          // Pass BASE_URL env var to forked processes
          env: {
            BASE_URL: process.env.BASE_URL || "http://localhost:8787",
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
