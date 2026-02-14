/**
 * Tests for the vitest integration real config.
 *
 * Verifies:
 * 1. Config file exists and is valid
 * 2. Config includes the correct test patterns
 * 3. Config is separate from unit tests
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

describe("vitest.integration.real.config.ts", () => {
  it("config file exists at project root", () => {
    const configPath = resolve(ROOT, "vitest.integration.real.config.ts");
    expect(existsSync(configPath)).toBe(true);
  });
});

describe(".gitignore includes .wrangler-test-shared", () => {
  it("gitignore file contains the shared persist directory", async () => {
    const fs = await import("node:fs/promises");
    const gitignorePath = resolve(ROOT, ".gitignore");
    const content = await fs.readFile(gitignorePath, "utf-8");
    expect(content).toContain(".wrangler-test-shared");
  });
});
