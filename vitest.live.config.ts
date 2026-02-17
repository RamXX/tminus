/**
 * Vitest configuration for live integration tests against deployed stack.
 *
 * These tests make real HTTP requests against the deployed T-Minus
 * production or staging environment. No mocks, no local servers.
 *
 * Prerequisites:
 *   - LIVE_BASE_URL set to target (e.g., https://api.tminus.ink)
 *   - LIVE_JWT_TOKEN set to a valid JWT for an authenticated user
 *
 * Tests skip gracefully when LIVE_BASE_URL is not set.
 *
 * Run with:
 *   make test-live          (production: https://api.tminus.ink)
 *   make test-live-staging  (staging: https://api-staging.tminus.ink)
 */

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "live",
          include: ["tests/live/**/*.live.test.ts"],
          // Real API calls over the network -- generous timeout
          testTimeout: 120_000,
          // Run serially to avoid race conditions against shared state
          pool: "forks",
          poolOptions: {
            forks: {
              singleFork: true,
            },
          },
          // Pass environment variables to forked processes
          env: {
            LIVE_BASE_URL: process.env.LIVE_BASE_URL || "",
            LIVE_JWT_TOKEN: process.env.LIVE_JWT_TOKEN || "",
            GOOGLE_TEST_REFRESH_TOKEN_A:
              process.env.GOOGLE_TEST_REFRESH_TOKEN_A || "",
            GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || "",
            GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || "",
            JWT_SECRET: process.env.JWT_SECRET || "",
          },
          // Run tests in file order, not shuffled
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
