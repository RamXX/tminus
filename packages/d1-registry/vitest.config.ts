import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    name: "d1-registry",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@tminus/shared": path.resolve(__dirname, "../shared/src"),
    },
  },
});
