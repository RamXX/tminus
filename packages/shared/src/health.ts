/**
 * Shared health check response builder.
 *
 * Provides a consistent health check response format across all workers.
 * Each worker calls buildHealthResponse() with its specific binding status,
 * and gets back a standard envelope response body.
 *
 * Response format follows the canonical API envelope:
 *   { ok: true, data: { status, version, environment, worker, bindings }, error: null, meta: { timestamp } }
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Status of a single binding (D1, KV, DO, Queue, etc.). */
export interface BindingStatus {
  /** Name of the binding as declared in wrangler.toml. */
  name: string;
  /** Whether the binding is available (non-null/non-undefined in env). */
  available: boolean;
  /** Optional type label for clarity (e.g., "d1", "kv", "do", "queue", "r2", "service", "workflow"). */
  type?: string;
}

/** The data payload returned by the health endpoint. */
export interface HealthCheckData {
  status: "healthy" | "degraded";
  version: string;
  environment: string;
  worker: string;
  bindings: BindingStatus[];
}

/** Full health response body (matches API envelope pattern). */
export interface HealthCheckResponse {
  ok: boolean;
  data: HealthCheckData;
  error: null;
  meta: {
    timestamp: string;
  };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build a health check response body.
 *
 * Status is "healthy" if all bindings are available, "degraded" if any
 * binding is unavailable. The caller is responsible for wrapping this
 * in a Response object with appropriate headers.
 *
 * @param worker  - Worker name (e.g., "tminus-api", "tminus-oauth").
 * @param version - Worker version string.
 * @param environment - Deployment environment ("production", "staging", "development").
 * @param bindings - Array of binding availability checks.
 * @returns HealthCheckResponse body object.
 */
export function buildHealthResponse(
  worker: string,
  version: string,
  environment: string,
  bindings: BindingStatus[],
): HealthCheckResponse {
  const allAvailable = bindings.every((b) => b.available);
  return {
    ok: true,
    data: {
      status: allAvailable ? "healthy" : "degraded",
      version,
      environment,
      worker,
      bindings,
    },
    error: null,
    meta: {
      timestamp: new Date().toISOString(),
    },
  };
}
