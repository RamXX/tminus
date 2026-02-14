import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    name: path.basename(path.resolve()),
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@tminus/shared": path.resolve(__dirname, "../../packages/shared/src"),
    },
  },
});
