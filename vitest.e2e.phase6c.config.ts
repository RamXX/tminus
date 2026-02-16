/**
 * Vitest configuration for Phase 6C E2E validation tests.
 *
 * Tests the complete progressive onboarding experience end-to-end:
 *   - Zero-auth ICS feed import (3 feeds, unified view)
 *   - Feed refresh cycle (change detection, staleness)
 *   - Smart upgrade prompt triggers (conflict, write-intent, engagement)
 *   - OAuth upgrade flow (ICS -> OAuth with event merge)
 *   - Downgrade resilience (OAuth revocation -> ICS fallback)
 *   - Mixed view (ICS + OAuth accounts together)
 *
 * Uses real API handler chain (createHandler) with real D1 (better-sqlite3)
 * and mock DO stubs. External ICS feeds are mocked via globalThis.fetch.
 *
 * Prerequisites:
 *   - pnpm install (all workspace packages)
 *
 * Run with:
 *   make test-e2e-phase6c
 */

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "e2e-phase6c",
          include: [
            "tests/e2e/phase-6c-progressive-onboarding.integration.test.ts",
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
          testTimeout: 120_000,
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
          },
        },
      },
    ],
  },
});
