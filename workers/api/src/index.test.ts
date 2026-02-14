import { describe, it, expect } from "vitest";
import { APP_NAME, SCHEMA_VERSION } from "@tminus/shared";

describe("workspace dependency resolution", () => {
  it("imports APP_NAME from @tminus/shared via workspace link", () => {
    expect(APP_NAME).toBe("tminus");
  });

  it("imports SCHEMA_VERSION from @tminus/shared via workspace link", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
});

describe("api worker", () => {
  it("default export has a fetch handler", async () => {
    const mod = await import("./index");
    expect(mod.default).toBeDefined();
    expect(typeof mod.default.fetch).toBe("function");
  });
});
