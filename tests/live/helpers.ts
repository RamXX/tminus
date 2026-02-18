/**
 * Live test HTTP client for the deployed T-Minus stack.
 *
 * Wraps fetch() with:
 * - Base URL management
 * - JWT Authorization headers
 * - JSON request/response helpers
 * - Typed response wrapper
 *
 * Design:
 * - No global state -- each instance is self-contained
 * - Injectable fetch function for testability (default: global fetch)
 * - Methods return raw Response for full control in tests
 * - Convenience methods parse JSON with type parameter
 */

import type { LiveEnv } from "./setup.js";

// ---------------------------------------------------------------------------
// Rate-limit retry helper
// ---------------------------------------------------------------------------

/**
 * Execute a request with automatic retry on 429 (rate limit).
 *
 * Production endpoints have rate limiting. When running the full live test
 * suite in sequence, earlier suites may exhaust the rate-limit window,
 * causing later suites to receive 429 responses. This helper retries with
 * exponential backoff so tests get the actual response they are asserting on.
 *
 * If the rate limit window is too long (> maxWaitMs), it returns the 429
 * response immediately so the test can handle it gracefully rather than
 * timing out.
 */
export async function withRateLimitRetry(
  fn: () => Promise<Response>,
  opts: { maxRetries?: number; maxWaitMs?: number; label?: string } = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 3;
  const maxWaitMs = opts.maxWaitMs ?? 15_000; // max 15s per wait
  const label = opts.label ?? "request";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fn();

    if (resp.status !== 429) return resp;

    if (attempt === maxRetries) {
      console.warn(
        `  [RATE-LIMIT] ${label}: still 429 after ${maxRetries} retries, returning as-is`,
      );
      return resp;
    }

    // Check Retry-After header. If the wait is too long, bail out immediately.
    const retryAfterHeader = resp.headers.get("Retry-After");
    let waitMs: number;
    if (retryAfterHeader) {
      const retryAfterSec = parseInt(retryAfterHeader, 10);
      if (!isNaN(retryAfterSec) && retryAfterSec * 1000 > maxWaitMs) {
        console.warn(
          `  [RATE-LIMIT] ${label}: Retry-After=${retryAfterSec}s exceeds ` +
            `maxWaitMs=${maxWaitMs}ms. Returning 429 immediately.`,
        );
        return resp;
      }
      waitMs = isNaN(retryAfterSec) ? Math.min((attempt + 1) * 3000, maxWaitMs) : retryAfterSec * 1000;
    } else {
      waitMs = Math.min((attempt + 1) * 3000, maxWaitMs);
    }

    // Consume the body to avoid resource leaks
    await resp.text();

    console.log(
      `  [RATE-LIMIT] ${label}: 429 on attempt ${attempt + 1}, ` +
        `waiting ${waitMs}ms before retry...`,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  // TypeScript: unreachable but satisfies compiler
  return fn();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LiveTestClientConfig {
  /** Base URL of the deployed API (e.g., https://api.tminus.ink). */
  baseUrl: string;
  /** JWT token for authenticated requests. Optional for unauthenticated tests. */
  jwtToken?: string | null;
  /** Injectable fetch function. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

export interface RequestOptions {
  /** Additional headers to include. */
  headers?: Record<string, string>;
  /** Request body (will be JSON-serialized if object). */
  body?: unknown;
  /** Override the default Authorization header for this request. */
  auth?: string | null | false;
  /** AbortSignal for request cancellation. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// LiveTestClient
// ---------------------------------------------------------------------------

export class LiveTestClient {
  private readonly baseUrl: string;
  private readonly jwtToken: string | null;
  private readonly fetchFn: typeof fetch;

  constructor(config: LiveTestClientConfig) {
    // Strip trailing slashes from base URL
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.jwtToken = config.jwtToken ?? null;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
  }

  /**
   * Create a LiveTestClient from a LiveEnv configuration.
   */
  static fromEnv(env: LiveEnv): LiveTestClient {
    return new LiveTestClient({
      baseUrl: env.baseUrl,
      jwtToken: env.jwtToken,
    });
  }

  // -------------------------------------------------------------------------
  // Core HTTP methods
  // -------------------------------------------------------------------------

  async get(path: string, options?: RequestOptions): Promise<Response> {
    return this.request("GET", path, options);
  }

  async post(path: string, options?: RequestOptions): Promise<Response> {
    return this.request("POST", path, options);
  }

  async put(path: string, options?: RequestOptions): Promise<Response> {
    return this.request("PUT", path, options);
  }

  async patch(path: string, options?: RequestOptions): Promise<Response> {
    return this.request("PATCH", path, options);
  }

  async delete(path: string, options?: RequestOptions): Promise<Response> {
    return this.request("DELETE", path, options);
  }

  // -------------------------------------------------------------------------
  // JSON convenience methods
  // -------------------------------------------------------------------------

  /**
   * GET a path and parse the response as JSON.
   * Throws if the response is not ok (status >= 400).
   */
  async getJson<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    const resp = await this.get(path, options);
    return resp.json() as Promise<T>;
  }

  /**
   * POST a path with a JSON body and parse the response as JSON.
   */
  async postJson<T = unknown>(
    path: string,
    body: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    const resp = await this.post(path, { ...options, body });
    return resp.json() as Promise<T>;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async request(
    method: string,
    path: string,
    options?: RequestOptions,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;

    const headers: Record<string, string> = {
      ...options?.headers,
    };

    // Add Authorization header unless explicitly disabled
    if (options?.auth === false) {
      // Caller explicitly wants no auth
    } else if (options?.auth) {
      headers["Authorization"] = options.auth;
    } else if (this.jwtToken) {
      headers["Authorization"] = `Bearer ${this.jwtToken}`;
    }

    // Add Content-Type for JSON bodies
    let bodyStr: string | undefined;
    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyStr =
        typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body);
    }

    return this.fetchFn(url, {
      method,
      headers,
      body: bodyStr,
      signal: options?.signal,
    });
  }

  // -------------------------------------------------------------------------
  // Utility
  // -------------------------------------------------------------------------

  /** Return the configured base URL. */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /** Return whether a JWT token is configured. */
  hasAuth(): boolean {
    return this.jwtToken !== null;
  }
}
