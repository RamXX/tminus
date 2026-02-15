/**
 * Tests for setup-secrets.mjs -- dedicated secrets management script.
 *
 * Tests the pure, testable functions exported from setup-secrets.mjs:
 * - Secret requirement definitions (SECRETS_REGISTRY)
 * - Argument parsing (parseSecretsArgs)
 * - Secret plan generation per environment (buildEnvironmentSecretPlan)
 * - Wrangler command generation (buildWranglerCommands)
 * - Validation (validateSecretValues)
 *
 * No Cloudflare credentials or network access required.
 */

import { describe, it, expect } from "vitest";
import {
  SECRETS_REGISTRY,
  SUPPORTED_ENVIRONMENTS,
  parseSecretsArgs,
  buildEnvironmentSecretPlan,
  buildWranglerCommands,
  validateSecretValues,
  getWorkerEnvName,
} from "./setup-secrets.mjs";

// ---------------------------------------------------------------------------
// SECRETS_REGISTRY -- the source of truth for all secrets
// ---------------------------------------------------------------------------

describe("SECRETS_REGISTRY", () => {
  it("is an array of secret requirement objects", () => {
    expect(Array.isArray(SECRETS_REGISTRY)).toBe(true);
    expect(SECRETS_REGISTRY.length).toBeGreaterThan(0);
  });

  it("each entry has envVar, secretName, workers, and description", () => {
    for (const entry of SECRETS_REGISTRY) {
      expect(entry).toHaveProperty("envVar");
      expect(entry).toHaveProperty("secretName");
      expect(entry).toHaveProperty("workers");
      expect(entry).toHaveProperty("description");
      expect(typeof entry.envVar).toBe("string");
      expect(typeof entry.secretName).toBe("string");
      expect(Array.isArray(entry.workers)).toBe(true);
      expect(entry.workers.length).toBeGreaterThan(0);
      expect(typeof entry.description).toBe("string");
    }
  });

  it("includes JWT_SECRET for api worker", () => {
    const jwtEntry = SECRETS_REGISTRY.find((s) => s.secretName === "JWT_SECRET");
    expect(jwtEntry).toBeDefined();
    expect(jwtEntry.workers).toContain("api");
  });

  it("includes MASTER_KEY for api worker (AccountDO encryption)", () => {
    const mkEntry = SECRETS_REGISTRY.find((s) => s.secretName === "MASTER_KEY");
    expect(mkEntry).toBeDefined();
    expect(mkEntry.workers).toContain("api");
  });

  it("includes Google OAuth secrets for oauth worker", () => {
    const gcid = SECRETS_REGISTRY.find(
      (s) => s.secretName === "GOOGLE_CLIENT_ID"
    );
    const gcs = SECRETS_REGISTRY.find(
      (s) => s.secretName === "GOOGLE_CLIENT_SECRET"
    );
    expect(gcid).toBeDefined();
    expect(gcid.workers).toContain("oauth");
    expect(gcs).toBeDefined();
    expect(gcs.workers).toContain("oauth");
  });

  it("includes Microsoft OAuth secrets for oauth worker", () => {
    const msid = SECRETS_REGISTRY.find(
      (s) => s.secretName === "MS_CLIENT_ID"
    );
    const mss = SECRETS_REGISTRY.find(
      (s) => s.secretName === "MS_CLIENT_SECRET"
    );
    expect(msid).toBeDefined();
    expect(msid.workers).toContain("oauth");
    expect(mss).toBeDefined();
    expect(mss.workers).toContain("oauth");
  });

  it("includes OAuth secrets for api worker (AccountDO token refresh)", () => {
    const gcid = SECRETS_REGISTRY.find(
      (s) => s.secretName === "GOOGLE_CLIENT_ID"
    );
    const gcs = SECRETS_REGISTRY.find(
      (s) => s.secretName === "GOOGLE_CLIENT_SECRET"
    );
    const msid = SECRETS_REGISTRY.find(
      (s) => s.secretName === "MS_CLIENT_ID"
    );
    const mss = SECRETS_REGISTRY.find(
      (s) => s.secretName === "MS_CLIENT_SECRET"
    );
    expect(gcid.workers).toContain("api");
    expect(gcs.workers).toContain("api");
    expect(msid.workers).toContain("api");
    expect(mss.workers).toContain("api");
  });

  it("includes MASTER_KEY for oauth worker (shared encryption)", () => {
    const mk = SECRETS_REGISTRY.find((s) => s.secretName === "MASTER_KEY");
    expect(mk.workers).toContain("oauth");
  });

  it("includes JWT_SECRET for oauth worker (shared auth)", () => {
    const jwt = SECRETS_REGISTRY.find((s) => s.secretName === "JWT_SECRET");
    expect(jwt.workers).toContain("oauth");
  });
});

// ---------------------------------------------------------------------------
// SUPPORTED_ENVIRONMENTS
// ---------------------------------------------------------------------------

describe("SUPPORTED_ENVIRONMENTS", () => {
  it("includes staging and production", () => {
    expect(SUPPORTED_ENVIRONMENTS).toContain("staging");
    expect(SUPPORTED_ENVIRONMENTS).toContain("production");
  });

  it("has exactly 2 environments", () => {
    expect(SUPPORTED_ENVIRONMENTS).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// parseSecretsArgs
// ---------------------------------------------------------------------------

describe("parseSecretsArgs", () => {
  it("returns defaults when no args", () => {
    expect(parseSecretsArgs([])).toEqual({
      dryRun: false,
      verbose: false,
      environment: null,
      worker: null,
    });
  });

  it("detects --dry-run", () => {
    expect(parseSecretsArgs(["--dry-run"]).dryRun).toBe(true);
  });

  it("detects --verbose and -v", () => {
    expect(parseSecretsArgs(["--verbose"]).verbose).toBe(true);
    expect(parseSecretsArgs(["-v"]).verbose).toBe(true);
  });

  it("detects --env staging", () => {
    expect(parseSecretsArgs(["--env", "staging"]).environment).toBe("staging");
  });

  it("detects --env production", () => {
    expect(parseSecretsArgs(["--env", "production"]).environment).toBe(
      "production"
    );
  });

  it("detects --worker filter", () => {
    expect(parseSecretsArgs(["--worker", "api"]).worker).toBe("api");
  });

  it("handles multiple flags together", () => {
    const result = parseSecretsArgs([
      "--dry-run",
      "--verbose",
      "--env",
      "staging",
      "--worker",
      "oauth",
    ]);
    expect(result).toEqual({
      dryRun: true,
      verbose: true,
      environment: "staging",
      worker: "oauth",
    });
  });

  it("defaults environment to null (meaning all environments)", () => {
    expect(parseSecretsArgs([]).environment).toBeNull();
  });

  it("defaults worker to null (meaning all workers)", () => {
    expect(parseSecretsArgs([]).worker).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getWorkerEnvName
// ---------------------------------------------------------------------------

describe("getWorkerEnvName", () => {
  it("returns tminus-<worker>-<env> for named environments", () => {
    expect(getWorkerEnvName("api", "production")).toBe(
      "tminus-api-production"
    );
    expect(getWorkerEnvName("oauth", "staging")).toBe(
      "tminus-oauth-staging"
    );
  });

  it("handles various worker names", () => {
    expect(getWorkerEnvName("sync-consumer", "production")).toBe(
      "tminus-sync-consumer-production"
    );
  });
});

// ---------------------------------------------------------------------------
// buildEnvironmentSecretPlan
// ---------------------------------------------------------------------------

describe("buildEnvironmentSecretPlan", () => {
  const fullEnvVars = {
    JWT_SECRET: "test-jwt-secret",
    MASTER_KEY: "test-master-key",
    GOOGLE_CLIENT_ID: "test-gcid",
    GOOGLE_CLIENT_SECRET: "test-gcs",
    MS_CLIENT_ID: "test-msid",
    MS_CLIENT_SECRET: "test-mss",
  };

  it("generates plan entries for a single environment", () => {
    const plan = buildEnvironmentSecretPlan(fullEnvVars, "production");
    expect(plan.length).toBeGreaterThan(0);
    for (const entry of plan) {
      expect(entry).toHaveProperty("secretName");
      expect(entry).toHaveProperty("workerName");
      expect(entry).toHaveProperty("environment");
      expect(entry).toHaveProperty("value");
      expect(entry.environment).toBe("production");
    }
  });

  it("includes JWT_SECRET on tminus-api for production", () => {
    const plan = buildEnvironmentSecretPlan(fullEnvVars, "production");
    const match = plan.find(
      (p) => p.secretName === "JWT_SECRET" && p.workerName === "tminus-api"
    );
    expect(match).toBeDefined();
    expect(match.value).toBe("test-jwt-secret");
    expect(match.environment).toBe("production");
  });

  it("includes MASTER_KEY on tminus-api for staging", () => {
    const plan = buildEnvironmentSecretPlan(fullEnvVars, "staging");
    const match = plan.find(
      (p) => p.secretName === "MASTER_KEY" && p.workerName === "tminus-api"
    );
    expect(match).toBeDefined();
    expect(match.value).toBe("test-master-key");
    expect(match.environment).toBe("staging");
  });

  it("includes Google OAuth secrets on tminus-oauth", () => {
    const plan = buildEnvironmentSecretPlan(fullEnvVars, "production");
    const gcid = plan.find(
      (p) =>
        p.secretName === "GOOGLE_CLIENT_ID" && p.workerName === "tminus-oauth"
    );
    const gcs = plan.find(
      (p) =>
        p.secretName === "GOOGLE_CLIENT_SECRET" &&
        p.workerName === "tminus-oauth"
    );
    expect(gcid).toBeDefined();
    expect(gcs).toBeDefined();
  });

  it("includes OAuth secrets on tminus-api for AccountDO", () => {
    const plan = buildEnvironmentSecretPlan(fullEnvVars, "production");
    const gcid = plan.find(
      (p) =>
        p.secretName === "GOOGLE_CLIENT_ID" && p.workerName === "tminus-api"
    );
    expect(gcid).toBeDefined();
  });

  it("skips secrets not present in env vars", () => {
    const partialEnv = { JWT_SECRET: "only-jwt" };
    const plan = buildEnvironmentSecretPlan(partialEnv, "production");
    expect(plan.every((p) => p.secretName === "JWT_SECRET")).toBe(true);
  });

  it("returns empty plan when no matching env vars", () => {
    const plan = buildEnvironmentSecretPlan(
      { UNRELATED: "value" },
      "production"
    );
    expect(plan).toEqual([]);
  });

  it("filters by worker when workerFilter is provided", () => {
    const plan = buildEnvironmentSecretPlan(fullEnvVars, "production", "oauth");
    expect(plan.length).toBeGreaterThan(0);
    for (const entry of plan) {
      expect(entry.workerName).toBe("tminus-oauth");
    }
  });

  it("returns empty plan for unknown worker filter", () => {
    const plan = buildEnvironmentSecretPlan(
      fullEnvVars,
      "production",
      "nonexistent"
    );
    expect(plan).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildWranglerCommands
// ---------------------------------------------------------------------------

describe("buildWranglerCommands", () => {
  it("generates correct wrangler secret put commands", () => {
    const plan = [
      {
        secretName: "JWT_SECRET",
        workerName: "tminus-api",
        environment: "production",
        value: "my-secret",
      },
    ];
    const commands = buildWranglerCommands(plan);
    expect(commands).toHaveLength(1);
    expect(commands[0].command).toBe(
      "npx wrangler secret put JWT_SECRET --name tminus-api --env production"
    );
    expect(commands[0].value).toBe("my-secret");
    expect(commands[0].label).toBe("JWT_SECRET -> tminus-api (production)");
  });

  it("generates multiple commands for multiple plan entries", () => {
    const plan = [
      {
        secretName: "JWT_SECRET",
        workerName: "tminus-api",
        environment: "production",
        value: "jwt-val",
      },
      {
        secretName: "MASTER_KEY",
        workerName: "tminus-api",
        environment: "production",
        value: "mk-val",
      },
      {
        secretName: "JWT_SECRET",
        workerName: "tminus-api",
        environment: "staging",
        value: "jwt-val",
      },
    ];
    const commands = buildWranglerCommands(plan);
    expect(commands).toHaveLength(3);
    expect(commands[0].command).toContain("--env production");
    expect(commands[2].command).toContain("--env staging");
  });

  it("never includes the secret value in the command string", () => {
    const plan = [
      {
        secretName: "JWT_SECRET",
        workerName: "tminus-api",
        environment: "production",
        value: "super-secret-value",
      },
    ];
    const commands = buildWranglerCommands(plan);
    expect(commands[0].command).not.toContain("super-secret-value");
  });

  it("returns empty array for empty plan", () => {
    expect(buildWranglerCommands([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validateSecretValues
// ---------------------------------------------------------------------------

describe("validateSecretValues", () => {
  it("returns no errors when all required secrets are present", () => {
    const envVars = {
      JWT_SECRET: "val",
      MASTER_KEY: "val",
      GOOGLE_CLIENT_ID: "val",
      GOOGLE_CLIENT_SECRET: "val",
      MS_CLIENT_ID: "val",
      MS_CLIENT_SECRET: "val",
    };
    const result = validateSecretValues(envVars);
    expect(result.missing).toEqual([]);
    expect(result.present).toHaveLength(6);
    expect(result.valid).toBe(true);
  });

  it("reports missing secrets", () => {
    const envVars = { JWT_SECRET: "val" };
    const result = validateSecretValues(envVars);
    expect(result.missing.length).toBeGreaterThan(0);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("MASTER_KEY");
  });

  it("reports all present secrets", () => {
    const envVars = {
      JWT_SECRET: "val",
      MASTER_KEY: "val",
    };
    const result = validateSecretValues(envVars);
    expect(result.present).toContain("JWT_SECRET");
    expect(result.present).toContain("MASTER_KEY");
  });

  it("handles empty env vars", () => {
    const result = validateSecretValues({});
    expect(result.valid).toBe(false);
    expect(result.missing.length).toBe(6);
  });

  it("ignores empty string values as missing", () => {
    const envVars = { JWT_SECRET: "", MASTER_KEY: "val" };
    const result = validateSecretValues(envVars);
    expect(result.missing).toContain("JWT_SECRET");
    expect(result.present).toContain("MASTER_KEY");
  });
});

// ---------------------------------------------------------------------------
// Integration-style: dry-run generates correct wrangler commands
// ---------------------------------------------------------------------------

describe("integration: full plan generation", () => {
  const fullEnvVars = {
    JWT_SECRET: "test-jwt",
    MASTER_KEY: "test-mk",
    GOOGLE_CLIENT_ID: "test-gcid",
    GOOGLE_CLIENT_SECRET: "test-gcs",
    MS_CLIENT_ID: "test-msid",
    MS_CLIENT_SECRET: "test-mss",
  };

  it("generates plans for both envs with all secrets when no filter", () => {
    const stagingPlan = buildEnvironmentSecretPlan(fullEnvVars, "staging");
    const prodPlan = buildEnvironmentSecretPlan(fullEnvVars, "production");
    const allCommands = buildWranglerCommands([...stagingPlan, ...prodPlan]);

    // Each secret goes to its workers in each env
    // JWT_SECRET: api+oauth x 2 envs = 4
    // MASTER_KEY: api+oauth x 2 envs = 4
    // GOOGLE_CLIENT_ID: api+oauth x 2 envs = 4
    // GOOGLE_CLIENT_SECRET: api+oauth x 2 envs = 4
    // MS_CLIENT_ID: api+oauth x 2 envs = 4
    // MS_CLIENT_SECRET: api+oauth x 2 envs = 4
    // Total: 24
    expect(allCommands.length).toBe(24);
  });

  it("each command targets the correct wrangler secret put format", () => {
    const plan = buildEnvironmentSecretPlan(fullEnvVars, "production");
    const commands = buildWranglerCommands(plan);

    for (const cmd of commands) {
      expect(cmd.command).toMatch(
        /^npx wrangler secret put \w+ --name tminus-\w+ --env production$/
      );
    }
  });

  it("staging commands use --env staging", () => {
    const plan = buildEnvironmentSecretPlan(fullEnvVars, "staging");
    const commands = buildWranglerCommands(plan);

    for (const cmd of commands) {
      expect(cmd.command).toContain("--env staging");
    }
  });

  it("values are piped via stdin, never on command line", () => {
    const plan = buildEnvironmentSecretPlan(fullEnvVars, "production");
    const commands = buildWranglerCommands(plan);

    for (const cmd of commands) {
      // The value field is separate from command - for piping via stdin
      expect(cmd).toHaveProperty("value");
      expect(cmd.command).not.toContain(cmd.value);
    }
  });

  it("filtering by worker reduces commands to only that worker", () => {
    const plan = buildEnvironmentSecretPlan(
      fullEnvVars,
      "production",
      "api"
    );
    const commands = buildWranglerCommands(plan);

    for (const cmd of commands) {
      expect(cmd.command).toContain("tminus-api");
    }

    // api gets: JWT_SECRET, MASTER_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, MS_CLIENT_ID, MS_CLIENT_SECRET = 6
    expect(commands).toHaveLength(6);
  });

  it("idempotent: running twice generates identical plans", () => {
    const plan1 = buildEnvironmentSecretPlan(fullEnvVars, "production");
    const plan2 = buildEnvironmentSecretPlan(fullEnvVars, "production");
    expect(plan1).toEqual(plan2);
  });
});
