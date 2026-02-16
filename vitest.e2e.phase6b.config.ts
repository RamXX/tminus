/**
 * Vitest configuration for Phase 6B E2E validation tests.
 *
 * Tests the complete Google Workspace Marketplace integration lifecycle:
 *   - Individual install flow: Marketplace -> onboarding -> sync
 *   - Organization install flow: Admin install -> org user activation
 *   - Uninstall flows: Individual and organization-level cleanup
 *   - Edge cases: individual+org overlap, re-install after uninstall
 *
 * Uses real OAuth worker handler chain (createHandler) with injectable fetch.
 * External Google APIs are mocked, but internal routing/D1/DO logic is real.
 *
 * Prerequisites:
 *   - pnpm install (all workspace packages)
 *
 * Run with:
 *   make test-e2e-phase6b
 */

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "e2e-phase6b",
          include: [
            "tests/e2e/phase-6b-marketplace-lifecycle.integration.test.ts",
          ],
          // Integration tests run sequentially (shared state per describe)
          pool: "forks",
          poolOptions: {
            forks: {
              singleFork: true,
              execArgv: [],
            },
          },
          // Generous timeout for full lifecycle tests
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
          },
        },
      },
    ],
  },
});
