import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/*/vitest.config.ts",
  "workers/*/vitest.config.ts",
  "durable-objects/*/vitest.config.ts",
  "workflows/*/vitest.config.ts",
]);
