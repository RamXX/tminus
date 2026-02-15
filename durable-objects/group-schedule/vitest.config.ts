import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    name: "tminus-group-schedule-do",
    root: __dirname,
    include: ["src/**/*.test.ts"],
    exclude: [
      "**/*.integration.test.ts",
      "**/*.real.integration.test.ts",
    ],
  },
  resolve: {
    alias: {
      "@tminus/shared": path.resolve(__dirname, "../../packages/shared/src"),
      "@tminus/workflow-scheduling": path.resolve(__dirname, "../../workflows/scheduling/src"),
    },
  },
});
