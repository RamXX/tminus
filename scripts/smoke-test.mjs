#!/usr/bin/env node

/**
 * smoke-test.mjs -- Smoke test a deployed T-Minus API instance.
 *
 * Verifies:
 *   1. GET /health returns 200 with correct envelope
 *   2. GET /v1/events without JWT returns 401
 *   3. POST /v1/auth/register creates a user and returns JWT
 *   4. POST /v1/auth/login authenticates and returns JWT
 *   5. GET /v1/events with JWT returns 200
 *
 * Usage:
 *   node scripts/smoke-test.mjs [url]
 *
 * Arguments:
 *   url   Base URL to test (default: https://api.tminus.ink)
 *
 * Options:
 *   --env <name>       Use a predefined URL: "production" or "staging"
 *   --verbose, -v      Show response bodies
 *   --skip-auth-flow   Skip register/login/protected-call tests
 *
 * The auth flow tests (register/login/protected-call) require the API
 * to have a functioning D1 database with the users table. If skipped,
 * only health and auth enforcement are tested.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ENV_URLS = {
  production: "https://api.tminus.ink",
  staging: "https://api-staging.tminus.ink",
};

// ---------------------------------------------------------------------------
// Argument parsing (pure, testable)
// ---------------------------------------------------------------------------

export function parseSmokeArgs(argv) {
  const args = {
    baseUrl: ENV_URLS.production,
    verbose: false,
    skipAuthFlow: false,
  };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--verbose" || argv[i] === "-v") {
      args.verbose = true;
    } else if (argv[i] === "--skip-auth-flow") {
      args.skipAuthFlow = true;
    } else if (argv[i] === "--env" && i + 1 < argv.length) {
      const env = argv[++i];
      if (!ENV_URLS[env]) {
        throw new Error(
          `Unknown environment: ${env}. Expected: ${Object.keys(ENV_URLS).join(", ")}`
        );
      }
      args.baseUrl = ENV_URLS[env];
    } else if (!argv[i].startsWith("-")) {
      args.baseUrl = argv[i];
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, init = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

class SmokeTestRunner {
  constructor(baseUrl, verbose = false) {
    this.baseUrl = baseUrl.replace(/\/$/, ""); // strip trailing slash
    this.verbose = verbose;
    this.passed = 0;
    this.failed = 0;
    this.errors = [];
  }

  log(msg) {
    process.stdout.write(`[smoke] ${msg}\n`);
  }

  async assert(name, fn) {
    try {
      await fn();
      this.passed++;
      this.log(`  PASS: ${name}`);
    } catch (err) {
      this.failed++;
      this.errors.push({ name, error: err.message });
      this.log(`  FAIL: ${name} -- ${err.message}`);
    }
  }

  /**
   * Test 1: Health endpoint
   */
  async testHealth() {
    this.log("Testing health endpoint...");
    await this.assert("GET /health returns 200", async () => {
      const res = await fetchWithTimeout(`${this.baseUrl}/health`);
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
    });

    await this.assert("GET /health returns correct envelope", async () => {
      const res = await fetchWithTimeout(`${this.baseUrl}/health`);
      const body = await res.json();
      if (this.verbose) this.log(`    Body: ${JSON.stringify(body)}`);

      if (body.ok !== true) throw new Error(`Expected ok=true, got ${body.ok}`);
      if (body.data?.status !== "healthy")
        throw new Error(`Expected status=healthy, got ${body.data?.status}`);
      if (typeof body.data?.version !== "string")
        throw new Error(`Expected version string, got ${typeof body.data?.version}`);
      if (!body.meta?.timestamp)
        throw new Error("Missing meta.timestamp");
    });
  }

  /**
   * Test 2: Auth enforcement (no JWT -> 401)
   */
  async testAuthEnforcement() {
    this.log("Testing auth enforcement...");
    await this.assert(
      "GET /v1/events without JWT returns 401",
      async () => {
        const res = await fetchWithTimeout(`${this.baseUrl}/v1/events`);
        if (res.status !== 401)
          throw new Error(`Expected 401, got ${res.status}`);
        const body = await res.json();
        if (this.verbose) this.log(`    Body: ${JSON.stringify(body)}`);
        if (body.ok !== false) throw new Error(`Expected ok=false`);
      }
    );
  }

  /**
   * Test 3: Full auth flow (register -> login -> protected call)
   */
  async testAuthFlow() {
    this.log("Testing auth flow (register -> login -> protected call)...");

    // Generate a unique email to avoid conflicts
    const uniqueId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const email = `smoke-${uniqueId}@test.tminus.ink`;
    const password = `SmokeTest-${uniqueId}!Aa1`;

    let accessToken = null;

    // Register
    await this.assert("POST /v1/auth/register creates user", async () => {
      const res = await fetchWithTimeout(`${this.baseUrl}/v1/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = await res.json();
      if (this.verbose) this.log(`    Body: ${JSON.stringify(body)}`);

      if (res.status !== 201)
        throw new Error(`Expected 201, got ${res.status}: ${JSON.stringify(body)}`);
      if (!body.ok) throw new Error(`Expected ok=true`);
      if (!body.data?.access_token)
        throw new Error("Missing access_token in register response");
      if (!body.data?.user?.id)
        throw new Error("Missing user.id in register response");

      accessToken = body.data.access_token;
    });

    // Login (only if register succeeded)
    if (accessToken) {
      await this.assert("POST /v1/auth/login authenticates", async () => {
        const res = await fetchWithTimeout(`${this.baseUrl}/v1/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const body = await res.json();
        if (this.verbose) this.log(`    Body: ${JSON.stringify(body)}`);

        if (res.status !== 200)
          throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
        if (!body.ok) throw new Error(`Expected ok=true`);
        if (!body.data?.access_token)
          throw new Error("Missing access_token in login response");

        // Use the login token for the next test
        accessToken = body.data.access_token;
      });
    }

    // Protected call with JWT
    if (accessToken) {
      await this.assert(
        "GET /v1/events with JWT returns 200",
        async () => {
          const res = await fetchWithTimeout(`${this.baseUrl}/v1/events`, {
            method: "GET",
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          const body = await res.json();
          if (this.verbose) this.log(`    Body: ${JSON.stringify(body)}`);

          if (res.status !== 200)
            throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
          if (!body.ok) throw new Error(`Expected ok=true`);
        }
      );
    }
  }

  /**
   * Print summary and return exit code.
   */
  summary() {
    this.log("");
    this.log(`Results: ${this.passed} passed, ${this.failed} failed`);
    if (this.errors.length > 0) {
      this.log("Failures:");
      for (const { name, error } of this.errors) {
        this.log(`  - ${name}: ${error}`);
      }
    }
    return this.failed === 0 ? 0 : 1;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseSmokeArgs(process.argv.slice(2));

  process.stdout.write(`[smoke] T-Minus API Smoke Tests\n`);
  process.stdout.write(`[smoke] Target: ${args.baseUrl}\n\n`);

  const runner = new SmokeTestRunner(args.baseUrl, args.verbose);

  await runner.testHealth();
  await runner.testAuthEnforcement();

  if (!args.skipAuthFlow) {
    await runner.testAuthFlow();
  } else {
    runner.log("Skipping auth flow tests (--skip-auth-flow)");
  }

  const exitCode = runner.summary();
  process.exit(exitCode);
}

// Only run main when executed directly
const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("smoke-test.mjs") ||
    process.argv[1].endsWith("smoke-test"));

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`\n[smoke] ERROR: ${err.message}\n`);
    process.exit(1);
  });
}
