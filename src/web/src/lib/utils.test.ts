/**
 * Unit tests for the cn() utility function.
 */
import { describe, it, expect } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("merges simple class strings", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("handles conditional classes via clsx", () => {
    expect(cn("base", false && "hidden", "active")).toBe("base active");
  });

  it("deduplicates conflicting Tailwind utilities (last wins)", () => {
    const result = cn("px-4", "px-8");
    expect(result).toBe("px-8");
  });

  it("handles undefined and null inputs", () => {
    expect(cn("foo", undefined, null, "bar")).toBe("foo bar");
  });

  it("handles empty call", () => {
    expect(cn()).toBe("");
  });

  it("handles object syntax from clsx", () => {
    expect(cn("base", { hidden: true, flex: false })).toBe("base hidden");
  });

  it("handles array syntax from clsx", () => {
    expect(cn(["a", "b"], "c")).toBe("a b c");
  });
});
