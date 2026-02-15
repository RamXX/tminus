/**
 * Vitest configuration for integration tests (non-real).
 *
 * These tests use mocked external APIs but real internal logic
 * (real SQLite, real DO logic classes, real queue message shapes).
 *
 * Run with: make test-integration
 *
 * Separate from vitest.workspace.ts because workspace project configs
 * explicitly exclude *.integration.test.ts files.
 */

import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "integration",
          include: [
            "packages/*/src/**/*.integration.test.ts",
            "workers/*/src/**/*.integration.test.ts",
            "durable-objects/*/src/**/*.integration.test.ts",
            "workflows/*/src/**/*.integration.test.ts",
          ],
          exclude: [
            "**/*.real.integration.test.ts",
          ],
          testTimeout: 30_000,
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
