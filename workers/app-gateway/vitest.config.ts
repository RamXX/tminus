import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "tminus-app-gateway",
    root: __dirname,
    include: ["src/**/*.test.ts"],
    exclude: [
      "**/*.integration.test.ts",
      "**/*.real.integration.test.ts",
    ],
  },
});
