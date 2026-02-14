import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    name: "d1-registry",
    root: __dirname,
    include: ["src/**/*.test.ts"],
    exclude: [
      "**/*.integration.test.ts",
      "**/*.real.integration.test.ts",
    ],
  },
  resolve: {
    alias: {
      "@tminus/shared": path.resolve(__dirname, "../shared/src"),
    },
  },
});
