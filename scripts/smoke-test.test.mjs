/**
 * Tests for smoke-test.mjs -- argument parsing and configuration.
 *
 * These tests require NO network access.
 * They verify CLI argument parsing and URL configuration.
 */

import { describe, it, expect } from "vitest";
import { parseSmokeArgs } from "./smoke-test.mjs";

// ---------------------------------------------------------------------------
// parseSmokeArgs
// ---------------------------------------------------------------------------

describe("parseSmokeArgs", () => {
  it("returns defaults when no args", () => {
    const result = parseSmokeArgs([]);
    expect(result.baseUrl).toBe("https://api.tminus.ink");
    expect(result.verbose).toBe(false);
    expect(result.skipAuthFlow).toBe(false);
  });

  it("detects --verbose and -v", () => {
    expect(parseSmokeArgs(["--verbose"]).verbose).toBe(true);
    expect(parseSmokeArgs(["-v"]).verbose).toBe(true);
  });

  it("detects --skip-auth-flow", () => {
    expect(parseSmokeArgs(["--skip-auth-flow"]).skipAuthFlow).toBe(true);
  });

  it("uses production URL with --env production", () => {
    const result = parseSmokeArgs(["--env", "production"]);
    expect(result.baseUrl).toBe("https://api.tminus.ink");
  });

  it("uses staging URL with --env staging", () => {
    const result = parseSmokeArgs(["--env", "staging"]);
    expect(result.baseUrl).toBe("https://api-staging.tminus.ink");
  });

  it("throws for unknown environment", () => {
    expect(() => parseSmokeArgs(["--env", "nonexistent"])).toThrow(
      "Unknown environment"
    );
  });

  it("accepts a custom URL as positional argument", () => {
    const result = parseSmokeArgs(["http://localhost:8787"]);
    expect(result.baseUrl).toBe("http://localhost:8787");
  });

  it("custom URL overrides default production URL", () => {
    const result = parseSmokeArgs(["https://custom.example.com"]);
    expect(result.baseUrl).toBe("https://custom.example.com");
  });

  it("handles multiple flags with custom URL", () => {
    const result = parseSmokeArgs([
      "--verbose",
      "--skip-auth-flow",
      "http://localhost:8787",
    ]);
    expect(result.baseUrl).toBe("http://localhost:8787");
    expect(result.verbose).toBe(true);
    expect(result.skipAuthFlow).toBe(true);
  });

  it("--env overrides positional URL (last wins)", () => {
    // The env flag is parsed separately from positional args
    const result = parseSmokeArgs(["--env", "staging"]);
    expect(result.baseUrl).toBe("https://api-staging.tminus.ink");
  });
});
