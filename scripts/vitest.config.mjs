import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    name: "scripts",
    root: resolve(__dirname),
    include: ["**/*.test.mjs", "**/*.test.ts"],
    exclude: ["**/*.integration.test.ts"],
  },
});
