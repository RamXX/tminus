/**
 * Unit tests for the shared health check response builder.
 *
 * Tests:
 * - Response format matches canonical envelope pattern
 * - Status is "healthy" when all bindings available
 * - Status is "degraded" when any binding unavailable
 * - All fields populated correctly
 * - Edge case: empty bindings array
 */

import { describe, it, expect } from "vitest";
import { buildHealthResponse } from "./health";
import type { BindingStatus, HealthCheckResponse } from "./health";

describe("buildHealthResponse", () => {
  it("returns healthy status when all bindings are available", () => {
    const bindings: BindingStatus[] = [
      { name: "DB", type: "d1", available: true },
      { name: "KV", type: "kv", available: true },
    ];

    const result = buildHealthResponse("tminus-api", "0.0.1", "production", bindings);

    expect(result.ok).toBe(true);
    expect(result.data.status).toBe("healthy");
    expect(result.data.version).toBe("0.0.1");
    expect(result.data.environment).toBe("production");
    expect(result.data.worker).toBe("tminus-api");
    expect(result.data.bindings).toEqual(bindings);
    expect(result.error).toBeNull();
    expect(result.meta.timestamp).toBeTruthy();
  });

  it("returns degraded status when any binding is unavailable", () => {
    const bindings: BindingStatus[] = [
      { name: "DB", type: "d1", available: true },
      { name: "QUEUE", type: "queue", available: false },
    ];

    const result = buildHealthResponse("tminus-webhook", "0.0.1", "staging", bindings);

    expect(result.data.status).toBe("degraded");
  });

  it("returns degraded when all bindings are unavailable", () => {
    const bindings: BindingStatus[] = [
      { name: "DB", type: "d1", available: false },
      { name: "KV", type: "kv", available: false },
    ];

    const result = buildHealthResponse("tminus-api", "0.0.1", "development", bindings);

    expect(result.data.status).toBe("degraded");
  });

  it("returns healthy with empty bindings array", () => {
    const result = buildHealthResponse("tminus-test", "1.0.0", "development", []);

    expect(result.data.status).toBe("healthy");
    expect(result.data.bindings).toEqual([]);
  });

  it("includes valid ISO timestamp in meta", () => {
    const result = buildHealthResponse("tminus-api", "0.0.1", "production", []);

    const parsed = new Date(result.meta.timestamp);
    expect(parsed.getTime()).not.toBeNaN();
  });

  it("always sets ok to true (health endpoint always responds)", () => {
    // Even when degraded, the endpoint itself is reachable -> ok: true
    const result = buildHealthResponse("tminus-api", "0.0.1", "production", [
      { name: "DB", type: "d1", available: false },
    ]);

    expect(result.ok).toBe(true);
  });

  it("preserves binding type field when provided", () => {
    const bindings: BindingStatus[] = [
      { name: "DB", type: "d1", available: true },
      { name: "USER_GRAPH", type: "do", available: true },
      { name: "SYNC_QUEUE", type: "queue", available: true },
      { name: "SESSIONS", type: "kv", available: true },
      { name: "PROOF_BUCKET", type: "r2", available: true },
      { name: "API", type: "service", available: true },
    ];

    const result = buildHealthResponse("tminus-api", "0.0.1", "production", bindings);

    expect(result.data.bindings).toHaveLength(6);
    expect(result.data.bindings[0].type).toBe("d1");
    expect(result.data.bindings[1].type).toBe("do");
    expect(result.data.bindings[2].type).toBe("queue");
    expect(result.data.bindings[3].type).toBe("kv");
    expect(result.data.bindings[4].type).toBe("r2");
    expect(result.data.bindings[5].type).toBe("service");
  });

  it("works without type field on bindings", () => {
    const bindings: BindingStatus[] = [
      { name: "CUSTOM", available: true },
    ];

    const result = buildHealthResponse("tminus-test", "0.0.1", "development", bindings);

    expect(result.data.status).toBe("healthy");
    expect(result.data.bindings[0].type).toBeUndefined();
  });

  it("conforms to HealthCheckResponse type shape", () => {
    const result: HealthCheckResponse = buildHealthResponse(
      "tminus-api",
      "0.0.1",
      "production",
      [{ name: "DB", type: "d1", available: true }],
    );

    // Verify the type is assignable (compile-time check + runtime shape check)
    expect(result).toHaveProperty("ok");
    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("error");
    expect(result).toHaveProperty("meta");
    expect(result.data).toHaveProperty("status");
    expect(result.data).toHaveProperty("version");
    expect(result.data).toHaveProperty("environment");
    expect(result.data).toHaveProperty("worker");
    expect(result.data).toHaveProperty("bindings");
    expect(result.meta).toHaveProperty("timestamp");
  });
});
