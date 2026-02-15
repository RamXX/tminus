import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.integration.test.ts"],
  },
  resolve: {
    alias: {
      "@tminus/shared": path.resolve(__dirname, "../../packages/shared/src"),
      "@tminus/d1-registry": path.resolve(__dirname, "../../packages/d1-registry/src"),
    },
  },
});
