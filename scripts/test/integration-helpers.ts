/**
 * Integration test harness helpers for wrangler dev.
 *
 * Provides utilities for:
 * - Starting wrangler dev servers as child processes
 * - Polling health endpoints until ready
 * - Running D1 migrations against local Miniflare
 * - Loading test environment variables
 * - Graceful skip when credentials unavailable
 *
 * Design:
 * - Each helper is a pure function or clearly scoped class
 * - No global state -- callers manage lifecycle
 * - Injectable dependencies where possible (fetch, spawn)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WranglerDevConfig {
  /** Path to the wrangler.toml for this worker. */
  wranglerToml: string;
  /** Port for the dev server. */
  port: number;
  /** Shared persist directory for D1/KV state. Optional. */
  persistDir?: string;
  /** Environment variables to pass via --var KEY:VALUE. */
  vars?: Record<string, string>;
  /** Health endpoint path (default: /health). */
  healthPath?: string;
  /** How long to wait for health endpoint (default: 60s). */
  healthTimeoutMs?: number;
  /** How often to poll health (default: 500ms). */
  pollIntervalMs?: number;
}

export interface StartedWorker {
  /** The child process running wrangler dev. */
  process: ChildProcess;
  /** Base URL of the running worker (e.g., http://127.0.0.1:8787). */
  url: string;
  /** Cleanup function: kills process and optionally removes persist dir. */
  cleanup: (removePersist?: boolean) => Promise<void>;
}

export interface SeedConfig {
  /** Persist directory path. */
  persistDir: string;
  /** Path to wrangler.toml. */
  wranglerToml: string;
  /** D1 database name. */
  databaseName: string;
  /** Path to SQL file to execute. */
  sqlFilePath: string;
}

export interface SeedCommand {
  command: string;
  args: string[];
}

export interface PollOptions {
  timeoutMs: number;
  intervalMs: number;
  healthPath: string;
}

export interface TestEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_TEST_REFRESH_TOKEN_A?: string;
  GOOGLE_TEST_REFRESH_TOKEN_B?: string;
  MS_CLIENT_ID?: string;
  MS_CLIENT_SECRET?: string;
  MS_TEST_REFRESH_TOKEN_B?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  MASTER_KEY?: string;
  JWT_SECRET?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULTS = {
  healthTimeoutMs: 60_000,
  pollIntervalMs: 500,
  sharedPersistDir: ".wrangler-test-shared",
  healthPath: "/health",
} as const;

// ---------------------------------------------------------------------------
// buildWranglerArgs: construct the argument array for wrangler dev
// ---------------------------------------------------------------------------

export function buildWranglerArgs(config: WranglerDevConfig): string[] {
  const args: string[] = [
    "dev",
    "--config",
    config.wranglerToml,
    "--port",
    String(config.port),
    "--local",
  ];

  if (config.persistDir) {
    args.push("--persist-to", config.persistDir);
  }

  if (config.vars) {
    for (const [key, value] of Object.entries(config.vars)) {
      args.push("--var", `${key}:${value}`);
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// pollHealthEndpoint: wait for a server to become healthy
// ---------------------------------------------------------------------------

export async function pollHealthEndpoint(
  baseUrl: string,
  options: PollOptions,
): Promise<void> {
  const { timeoutMs, intervalMs, healthPath } = options;
  const deadline = Date.now() + timeoutMs;
  const url = `${baseUrl}${healthPath}`;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Server not ready yet, keep polling
    }
    await sleep(intervalMs);
  }

  throw new Error(
    `Health check timed out after ${timeoutMs}ms waiting for ${url}`,
  );
}

// ---------------------------------------------------------------------------
// startWranglerDev: spawn wrangler dev and wait for health
// ---------------------------------------------------------------------------

export async function startWranglerDev(
  config: WranglerDevConfig,
): Promise<StartedWorker> {
  const args = buildWranglerArgs(config);
  const healthPath = config.healthPath ?? DEFAULTS.healthPath;
  const healthTimeoutMs = config.healthTimeoutMs ?? DEFAULTS.healthTimeoutMs;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULTS.pollIntervalMs;

  const child = spawn("npx", ["wrangler", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  const url = `http://127.0.0.1:${config.port}`;

  // Collect stderr for diagnostics on failure
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  // Wait for process to not exit immediately (give it a moment)
  const earlyExit = new Promise<never>((_, reject) => {
    child.on("exit", (code) => {
      reject(new Error(`wrangler dev exited early with code ${code}. stderr: ${stderr}`));
    });
  });

  try {
    // Race: health poll vs early exit
    await Promise.race([
      pollHealthEndpoint(url, {
        timeoutMs: healthTimeoutMs,
        intervalMs: pollIntervalMs,
        healthPath,
      }),
      earlyExit,
    ]);
  } catch (err) {
    // Kill process if health check fails
    child.kill("SIGTERM");
    throw err;
  }

  const cleanup = async (removePersist = false): Promise<void> => {
    if (!child.killed) {
      child.kill("SIGTERM");
      // Wait for process to actually exit
      await new Promise<void>((resolve) => {
        child.on("exit", () => resolve());
        // Safety timeout -- force kill after 5s
        setTimeout(() => {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
          resolve();
        }, 5000);
      });
    }

    if (removePersist && config.persistDir) {
      await rm(config.persistDir, { recursive: true, force: true });
    }
  };

  return { process: child, url, cleanup };
}

// ---------------------------------------------------------------------------
// buildSeedCommand: construct D1 seed/migration command
// ---------------------------------------------------------------------------

export function buildSeedCommand(config: SeedConfig): SeedCommand {
  return {
    command: "npx",
    args: [
      "wrangler",
      "d1",
      "execute",
      config.databaseName,
      "--local",
      "--persist-to",
      config.persistDir,
      "--file",
      config.sqlFilePath,
      "--config",
      config.wranglerToml,
    ],
  };
}

// ---------------------------------------------------------------------------
// seedTestD1: run migrations and seed data
// ---------------------------------------------------------------------------

export async function seedTestD1(config: SeedConfig): Promise<void> {
  const { command, args } = buildSeedCommand(config);

  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  return new Promise<void>((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `D1 seed failed with code ${code}. stderr: ${stderr}`,
          ),
        );
      }
    });

    child.on("error", (err) => {
      reject(new Error(`D1 seed spawn error: ${err.message}`));
    });
  });
}

// ---------------------------------------------------------------------------
// loadTestEnv: read test-relevant env vars
// ---------------------------------------------------------------------------

export function loadTestEnv(): TestEnv {
  return {
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_TEST_REFRESH_TOKEN_A: process.env.GOOGLE_TEST_REFRESH_TOKEN_A,
    GOOGLE_TEST_REFRESH_TOKEN_B: process.env.GOOGLE_TEST_REFRESH_TOKEN_B,
    MS_CLIENT_ID: process.env.MS_CLIENT_ID,
    MS_CLIENT_SECRET: process.env.MS_CLIENT_SECRET,
    MS_TEST_REFRESH_TOKEN_B: process.env.MS_TEST_REFRESH_TOKEN_B,
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    MASTER_KEY: process.env.MASTER_KEY,
    JWT_SECRET: process.env.JWT_SECRET,
  };
}

// ---------------------------------------------------------------------------
// requireTestCredentials: check if real integration credentials exist
// ---------------------------------------------------------------------------

export function requireTestCredentials(): boolean {
  return !!process.env.GOOGLE_TEST_REFRESH_TOKEN_A;
}

// ---------------------------------------------------------------------------
// sleep utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
