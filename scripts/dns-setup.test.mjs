/**
 * Tests for dns-setup.mjs -- pure configuration and argument parsing.
 *
 * These tests require NO Cloudflare credentials or network access.
 * They verify DNS record configuration and CLI argument parsing.
 */

import { describe, it, expect } from "vitest";
import { parseDnsArgs, DNS_RECORDS } from "./dns-setup.mjs";

// ---------------------------------------------------------------------------
// parseDnsArgs
// ---------------------------------------------------------------------------

describe("parseDnsArgs", () => {
  it("returns defaults when no args", () => {
    expect(parseDnsArgs([])).toEqual({
      dryRun: false,
      verbose: false,
      environment: "production",
    });
  });

  it("detects --dry-run", () => {
    expect(parseDnsArgs(["--dry-run"]).dryRun).toBe(true);
  });

  it("detects --verbose and -v", () => {
    expect(parseDnsArgs(["--verbose"]).verbose).toBe(true);
    expect(parseDnsArgs(["-v"]).verbose).toBe(true);
  });

  it("detects --env production", () => {
    expect(parseDnsArgs(["--env", "production"]).environment).toBe(
      "production"
    );
  });

  it("detects --env staging", () => {
    expect(parseDnsArgs(["--env", "staging"]).environment).toBe("staging");
  });

  it("handles multiple flags", () => {
    const result = parseDnsArgs(["--dry-run", "-v", "--env", "staging"]);
    expect(result).toEqual({
      dryRun: true,
      verbose: true,
      environment: "staging",
    });
  });
});

// ---------------------------------------------------------------------------
// DNS_RECORDS configuration
// ---------------------------------------------------------------------------

describe("DNS_RECORDS", () => {
  it("has production and staging environments", () => {
    expect(DNS_RECORDS).toHaveProperty("production");
    expect(DNS_RECORDS).toHaveProperty("staging");
  });

  it("production includes api.tminus.ink", () => {
    expect(DNS_RECORDS.production).toContain("api.tminus.ink");
  });

  it("staging includes api-staging.tminus.ink", () => {
    expect(DNS_RECORDS.staging).toContain("api-staging.tminus.ink");
  });

  it("production hostnames are under tminus.ink", () => {
    for (const hostname of DNS_RECORDS.production) {
      expect(hostname.endsWith(".tminus.ink")).toBe(true);
    }
  });

  it("staging hostnames are under tminus.ink", () => {
    for (const hostname of DNS_RECORDS.staging) {
      expect(hostname.endsWith(".tminus.ink")).toBe(true);
    }
  });

  it("production and staging have no overlapping hostnames", () => {
    const prodSet = new Set(DNS_RECORDS.production);
    for (const hostname of DNS_RECORDS.staging) {
      expect(prodSet.has(hostname)).toBe(false);
    }
  });
});
