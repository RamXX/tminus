/**
 * Tests for the wrangler-dev integration test harness helpers.
 *
 * These test:
 * 1. startWranglerDev() configuration and process lifecycle
 * 2. seedTestD1() migration and seeding
 * 3. Test lifecycle management (cleanup)
 * 4. Graceful skip when credentials unavailable
 *
 * Since we cannot spawn real wrangler dev servers in unit tests
 * (they require Cloudflare toolchain and network), we test:
 * - Configuration building and validation
 * - Command construction logic
 * - Cleanup behavior
 * - Polling logic with a simple HTTP server
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import {
  buildWranglerArgs,
  pollHealthEndpoint,
  type WranglerDevConfig,
  type StartedWorker,
  DEFAULTS,
  buildSeedCommand,
  loadTestEnv,
  requireTestCredentials,
} from "./integration-helpers.js";

// ---------------------------------------------------------------------------
// buildWranglerArgs: command construction
// ---------------------------------------------------------------------------

describe("buildWranglerArgs", () => {
  it("constructs minimal args with wrangler.toml path and port", () => {
    const config: WranglerDevConfig = {
      wranglerToml: "/path/to/wrangler.toml",
      port: 8787,
    };
    const args = buildWranglerArgs(config);
    expect(args).toContain("dev");
    expect(args).toContain("--config");
    expect(args).toContain("/path/to/wrangler.toml");
    expect(args).toContain("--port");
    expect(args).toContain("8787");
  });

  it("includes --persist-to when persistDir is specified", () => {
    const config: WranglerDevConfig = {
      wranglerToml: "/path/to/wrangler.toml",
      port: 8787,
      persistDir: "/tmp/test-persist",
    };
    const args = buildWranglerArgs(config);
    expect(args).toContain("--persist-to");
    expect(args).toContain("/tmp/test-persist");
  });

  it("includes --var flags for each env var", () => {
    const config: WranglerDevConfig = {
      wranglerToml: "/path/to/wrangler.toml",
      port: 8787,
      vars: {
        JWT_SECRET: "test-secret",
        MASTER_KEY: "test-master-key",
      },
    };
    const args = buildWranglerArgs(config);
    expect(args).toContain("--var");
    // Vars are key:value pairs after --var
    const varIndex1 = args.indexOf("JWT_SECRET:test-secret");
    const varIndex2 = args.indexOf("MASTER_KEY:test-master-key");
    expect(varIndex1).toBeGreaterThan(-1);
    expect(varIndex2).toBeGreaterThan(-1);
  });

  it("adds --local flag by default", () => {
    const config: WranglerDevConfig = {
      wranglerToml: "/path/to/wrangler.toml",
      port: 8787,
    };
    const args = buildWranglerArgs(config);
    expect(args).toContain("--local");
  });

  it("omits --persist-to when not specified", () => {
    const config: WranglerDevConfig = {
      wranglerToml: "/path/to/wrangler.toml",
      port: 8787,
    };
    const args = buildWranglerArgs(config);
    expect(args).not.toContain("--persist-to");
  });
});

// ---------------------------------------------------------------------------
// DEFAULTS: sensible defaults
// ---------------------------------------------------------------------------

describe("DEFAULTS", () => {
  it("has a 60-second health poll timeout", () => {
    expect(DEFAULTS.healthTimeoutMs).toBe(60_000);
  });

  it("has a 500ms poll interval", () => {
    expect(DEFAULTS.pollIntervalMs).toBe(500);
  });

  it("has a shared persist directory name", () => {
    expect(DEFAULTS.sharedPersistDir).toBe(".wrangler-test-shared");
  });
});

// ---------------------------------------------------------------------------
// pollHealthEndpoint: polling logic with real HTTP server
// ---------------------------------------------------------------------------

describe("pollHealthEndpoint", () => {
  let server: Server;
  let serverUrl: string;

  afterEach(() => {
    if (server) {
      server.close();
    }
  });

  it("resolves when health endpoint returns 200", async () => {
    server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("OK");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    serverUrl = `http://127.0.0.1:${port}`;

    await expect(
      pollHealthEndpoint(serverUrl, {
        timeoutMs: 5000,
        intervalMs: 100,
        healthPath: "/",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects after timeout when health endpoint never responds 200", async () => {
    server = createServer((_req, res) => {
      res.writeHead(503);
      res.end("Not Ready");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    serverUrl = `http://127.0.0.1:${port}`;

    await expect(
      pollHealthEndpoint(serverUrl, {
        timeoutMs: 1000,
        intervalMs: 100,
        healthPath: "/",
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it("succeeds when server starts returning 200 after initial failures", async () => {
    let requestCount = 0;
    server = createServer((_req, res) => {
      requestCount++;
      if (requestCount >= 3) {
        res.writeHead(200);
        res.end("OK");
      } else {
        res.writeHead(503);
        res.end("Not Ready");
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    serverUrl = `http://127.0.0.1:${port}`;

    await expect(
      pollHealthEndpoint(serverUrl, {
        timeoutMs: 5000,
        intervalMs: 100,
        healthPath: "/",
      }),
    ).resolves.toBeUndefined();
    expect(requestCount).toBeGreaterThanOrEqual(3);
  });

  it("polls the correct health path", async () => {
    let receivedPath = "";
    server = createServer((req, res) => {
      receivedPath = req.url ?? "";
      res.writeHead(200);
      res.end("OK");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    serverUrl = `http://127.0.0.1:${port}`;

    await pollHealthEndpoint(serverUrl, {
      timeoutMs: 5000,
      intervalMs: 100,
      healthPath: "/health",
    });

    expect(receivedPath).toBe("/health");
  });
});

// ---------------------------------------------------------------------------
// buildSeedCommand: D1 migration command construction
// ---------------------------------------------------------------------------

describe("buildSeedCommand", () => {
  it("constructs wrangler d1 execute command with --local and --persist-to", () => {
    const cmd = buildSeedCommand({
      persistDir: "/tmp/test-persist",
      wranglerToml: "/path/to/wrangler.toml",
      databaseName: "tminus-registry",
      sqlFilePath: "/path/to/migration.sql",
    });
    expect(cmd.command).toBe("npx");
    expect(cmd.args).toContain("wrangler");
    expect(cmd.args).toContain("d1");
    expect(cmd.args).toContain("execute");
    expect(cmd.args).toContain("tminus-registry");
    expect(cmd.args).toContain("--local");
    expect(cmd.args).toContain("--persist-to");
    expect(cmd.args).toContain("/tmp/test-persist");
    expect(cmd.args).toContain("--file");
    expect(cmd.args).toContain("/path/to/migration.sql");
    expect(cmd.args).toContain("--config");
    expect(cmd.args).toContain("/path/to/wrangler.toml");
  });
});

// ---------------------------------------------------------------------------
// loadTestEnv: credential loading
// ---------------------------------------------------------------------------

describe("loadTestEnv", () => {
  it("returns env vars from process.env", () => {
    const original = { ...process.env };
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";

    try {
      const env = loadTestEnv();
      expect(env.GOOGLE_CLIENT_ID).toBe("test-client-id");
      expect(env.GOOGLE_CLIENT_SECRET).toBe("test-client-secret");
    } finally {
      // Restore
      process.env = original;
    }
  });

  it("returns undefined for unset refresh tokens", () => {
    const original = { ...process.env };
    delete process.env.GOOGLE_TEST_REFRESH_TOKEN_A;
    delete process.env.GOOGLE_TEST_REFRESH_TOKEN_B;

    try {
      const env = loadTestEnv();
      expect(env.GOOGLE_TEST_REFRESH_TOKEN_A).toBeUndefined();
      expect(env.GOOGLE_TEST_REFRESH_TOKEN_B).toBeUndefined();
    } finally {
      process.env = original;
    }
  });
});

// ---------------------------------------------------------------------------
// requireTestCredentials: graceful skip
// ---------------------------------------------------------------------------

describe("requireTestCredentials", () => {
  it("returns true when refresh token is present", () => {
    const original = { ...process.env };
    process.env.GOOGLE_TEST_REFRESH_TOKEN_A = "some-token";

    try {
      expect(requireTestCredentials()).toBe(true);
    } finally {
      process.env = original;
    }
  });

  it("returns false when refresh token is missing", () => {
    const original = { ...process.env };
    delete process.env.GOOGLE_TEST_REFRESH_TOKEN_A;

    try {
      expect(requireTestCredentials()).toBe(false);
    } finally {
      process.env = original;
    }
  });
});
