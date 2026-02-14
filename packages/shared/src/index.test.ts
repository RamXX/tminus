import { describe, it, expect } from "vitest";
import { APP_NAME, SCHEMA_VERSION } from "./index";

describe("@tminus/shared", () => {
  it("exports APP_NAME as tminus", () => {
    expect(APP_NAME).toBe("tminus");
  });

  it("exports SCHEMA_VERSION as a positive integer", () => {
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
  });
});
