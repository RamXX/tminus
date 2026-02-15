/**
 * Tests for deploy-production.mjs -- pure configuration and planning functions.
 *
 * These tests require NO Cloudflare credentials or network access.
 * They verify CLI argument parsing, deploy planning, and configuration.
 */

import { describe, it, expect } from "vitest";
import {
  parseDeployArgs,
  buildProductionDeployPlan,
  DEPLOY_CONFIG,
  REQUIRED_SECRETS,
} from "./deploy-production.mjs";

// ---------------------------------------------------------------------------
// parseDeployArgs
// ---------------------------------------------------------------------------

describe("parseDeployArgs", () => {
  it("returns defaults when no args", () => {
    expect(parseDeployArgs([])).toEqual({
      dryRun: false,
      skipDns: false,
      skipSmoke: false,
      skipSecrets: false,
      verbose: false,
      environment: "production",
    });
  });

  it("detects --dry-run", () => {
    expect(parseDeployArgs(["--dry-run"]).dryRun).toBe(true);
  });

  it("detects --skip-dns", () => {
    expect(parseDeployArgs(["--skip-dns"]).skipDns).toBe(true);
  });

  it("detects --skip-smoke", () => {
    expect(parseDeployArgs(["--skip-smoke"]).skipSmoke).toBe(true);
  });

  it("detects --skip-secrets", () => {
    expect(parseDeployArgs(["--skip-secrets"]).skipSecrets).toBe(true);
  });

  it("detects --verbose and -v", () => {
    expect(parseDeployArgs(["--verbose"]).verbose).toBe(true);
    expect(parseDeployArgs(["-v"]).verbose).toBe(true);
  });

  it("detects --env production", () => {
    expect(parseDeployArgs(["--env", "production"]).environment).toBe(
      "production"
    );
  });

  it("detects --env staging", () => {
    expect(parseDeployArgs(["--env", "staging"]).environment).toBe("staging");
  });

  it("handles multiple flags", () => {
    const result = parseDeployArgs([
      "--dry-run",
      "--verbose",
      "--skip-dns",
      "--env",
      "staging",
    ]);
    expect(result).toEqual({
      dryRun: true,
      skipDns: true,
      skipSmoke: false,
      skipSecrets: false,
      verbose: true,
      environment: "staging",
    });
  });
});

// ---------------------------------------------------------------------------
// buildProductionDeployPlan
// ---------------------------------------------------------------------------

describe("buildProductionDeployPlan", () => {
  it("includes all steps for production with defaults", () => {
    const steps = buildProductionDeployPlan({
      environment: "production",
      skipDns: false,
      skipSmoke: false,
      skipSecrets: false,
    });

    expect(steps[0]).toContain("Verify wrangler authentication");
    expect(steps.some((s) => s.includes("DNS"))).toBe(true);
    expect(steps.some((s) => s.includes("Deploy tminus-api"))).toBe(true);
    expect(steps.some((s) => s.includes("JWT_SECRET"))).toBe(true);
    expect(steps.some((s) => s.includes("MASTER_KEY"))).toBe(true);
    expect(steps.some((s) => s.includes("smoke tests"))).toBe(true);
  });

  it("includes api.tminus.ink URL for production", () => {
    const steps = buildProductionDeployPlan({
      environment: "production",
      skipDns: false,
      skipSmoke: false,
      skipSecrets: false,
    });
    expect(steps.some((s) => s.includes("api.tminus.ink"))).toBe(true);
  });

  it("includes staging URL for staging", () => {
    const steps = buildProductionDeployPlan({
      environment: "staging",
      skipDns: false,
      skipSmoke: false,
      skipSecrets: false,
    });
    expect(steps.some((s) => s.includes("api-staging.tminus.ink"))).toBe(true);
  });

  it("skips DNS step when skipDns is true", () => {
    const steps = buildProductionDeployPlan({
      environment: "production",
      skipDns: true,
      skipSmoke: false,
      skipSecrets: false,
    });
    expect(steps.some((s) => s.includes("DNS"))).toBe(false);
  });

  it("skips smoke step when skipSmoke is true", () => {
    const steps = buildProductionDeployPlan({
      environment: "production",
      skipDns: false,
      skipSmoke: true,
      skipSecrets: false,
    });
    expect(steps.some((s) => s.includes("smoke"))).toBe(false);
  });

  it("skips secret steps when skipSecrets is true", () => {
    const steps = buildProductionDeployPlan({
      environment: "production",
      skipDns: false,
      skipSmoke: false,
      skipSecrets: true,
    });
    expect(steps.some((s) => s.includes("JWT_SECRET"))).toBe(false);
    expect(steps.some((s) => s.includes("MASTER_KEY"))).toBe(false);
  });

  it("throws for unknown environment", () => {
    expect(() =>
      buildProductionDeployPlan({
        environment: "nonexistent",
        skipDns: false,
        skipSmoke: false,
        skipSecrets: false,
      })
    ).toThrow("Unknown environment");
  });
});

// ---------------------------------------------------------------------------
// Constants validation
// ---------------------------------------------------------------------------

describe("DEPLOY_CONFIG", () => {
  it("has production and staging environments", () => {
    expect(DEPLOY_CONFIG).toHaveProperty("production");
    expect(DEPLOY_CONFIG).toHaveProperty("staging");
  });

  it("production routes to api.tminus.ink", () => {
    expect(DEPLOY_CONFIG.production.apiUrl).toBe("https://api.tminus.ink");
  });

  it("staging routes to api-staging.tminus.ink", () => {
    expect(DEPLOY_CONFIG.staging.apiUrl).toBe(
      "https://api-staging.tminus.ink"
    );
  });

  it("production uses 'production' wrangler env", () => {
    expect(DEPLOY_CONFIG.production.workerEnv).toBe("production");
  });

  it("staging uses 'staging' wrangler env", () => {
    expect(DEPLOY_CONFIG.staging.workerEnv).toBe("staging");
  });
});

describe("REQUIRED_SECRETS", () => {
  it("includes JWT_SECRET and MASTER_KEY", () => {
    expect(REQUIRED_SECRETS).toContain("JWT_SECRET");
    expect(REQUIRED_SECRETS).toContain("MASTER_KEY");
  });

  it("has exactly 2 required secrets", () => {
    expect(REQUIRED_SECRETS).toHaveLength(2);
  });
});
