/**
 * Vitest configuration for Phase 6D E2E validation tests.
 *
 * Tests the complete domain-wide delegation system end-to-end:
 *   - Admin org registration with service account credential encryption
 *   - Delegation validation and calendar impersonation
 *   - User discovery via Directory API (new, suspended, removed)
 *   - Admin dashboard with org-wide sync health
 *   - Rate limiting under sustained concurrent load (50 users)
 *   - Compliance audit log with hash chain integrity
 *   - Delegation revocation detection and admin surfacing
 *   - Service account key rotation with zero downtime
 *   - Audit log export in CSV and JSON formats
 *
 * Uses real API handler chain (createHandler) with real D1 (better-sqlite3)
 * and mock external APIs (Google Directory, OAuth token exchange).
 *
 * Prerequisites:
 *   - pnpm install (all workspace packages)
 *
 * Run with:
 *   make test-e2e-phase6d
 */

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "e2e-phase6d",
          include: [
            "tests/e2e/phase-6d-domain-wide-delegation.integration.test.ts",
          ],
          // Integration tests run sequentially (shared state per describe)
          pool: "forks",
          poolOptions: {
            forks: {
              singleFork: true,
              execArgv: [],
            },
          },
          // Generous timeout for full journey tests (sustained load test)
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
