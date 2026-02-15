/**
 * Unit tests for the external constraint solver integration (TM-82s.2).
 *
 * Tests the pluggable solver architecture:
 * - Solver interface contract (both GreedySolver and ExternalSolver satisfy it)
 * - Solver selection logic (participants > 3 OR constraints > 5 -> external)
 * - ExternalSolver: HTTP call with 30s timeout
 * - Fallback to greedy when external solver is unavailable or fails
 * - Configurable endpoint via SOLVER_ENDPOINT env var
 * - Request/response format validation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SolverInput, ScoredCandidate, SolverConstraint } from "./solver";
import {
  GreedySolverAdapter,
  ExternalSolver,
  selectSolver,
  createSolverFromEnv,
  EXTERNAL_SOLVER_TIMEOUT_MS,
} from "./external-solver";
import type { Solver, SolverResult } from "./external-solver";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<SolverInput> = {}): SolverInput {
  return {
    windowStart: "2026-03-02T08:00:00Z",
    windowEnd: "2026-03-06T18:00:00Z",
    durationMinutes: 60,
    busyIntervals: [],
    requiredAccountIds: ["acc_001"],
    ...overrides,
  };
}

function makeManyConstraints(count: number): SolverConstraint[] {
  const constraints: SolverConstraint[] = [];
  for (let i = 0; i < count; i++) {
    constraints.push({
      kind: "buffer",
      config: {
        type: "prep",
        minutes: 15 + i,
        applies_to: "all",
      },
    });
  }
  return constraints;
}

function makeManyParticipants(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `hash_${i}`);
}

// ---------------------------------------------------------------------------
// Solver interface contract tests
// ---------------------------------------------------------------------------

describe("Solver interface", () => {
  describe("GreedySolverAdapter", () => {
    it("satisfies the Solver interface", () => {
      const solver = new GreedySolverAdapter();
      expect(typeof solver.solve).toBe("function");
    });

    it("returns candidates from greedy solver", async () => {
      const solver = new GreedySolverAdapter();
      const input = makeInput();
      const result = await solver.solve(input, 5);

      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates.length).toBeLessThanOrEqual(5);
      expect(result.solverUsed).toBe("greedy");
      expect(typeof result.solverTimeMs).toBe("number");
      expect(result.solverTimeMs).toBeGreaterThanOrEqual(0);
    });

    it("returns correctly scored candidates", async () => {
      const solver = new GreedySolverAdapter();
      const input = makeInput();
      const result = await solver.solve(input, 5);

      // Candidates sorted by score descending
      for (let i = 1; i < result.candidates.length; i++) {
        expect(result.candidates[i - 1].score).toBeGreaterThanOrEqual(
          result.candidates[i].score,
        );
      }

      // Each candidate has required fields
      for (const c of result.candidates) {
        expect(c.start).toBeTruthy();
        expect(c.end).toBeTruthy();
        expect(typeof c.score).toBe("number");
        expect(typeof c.explanation).toBe("string");
      }
    });

    it("returns 0 candidates when window is fully busy", async () => {
      const solver = new GreedySolverAdapter();
      const input = makeInput({
        busyIntervals: [
          {
            start: "2026-03-02T00:00:00Z",
            end: "2026-03-07T00:00:00Z",
            account_ids: ["acc_001"],
          },
        ],
      });
      const result = await solver.solve(input, 5);
      expect(result.candidates.length).toBe(0);
      expect(result.solverUsed).toBe("greedy");
    });
  });

  describe("ExternalSolver", () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("satisfies the Solver interface", () => {
      const solver = new ExternalSolver("https://solver.example.com/solve");
      expect(typeof solver.solve).toBe("function");
    });

    it("calls external endpoint with correct request format", async () => {
      const mockCandidates: ScoredCandidate[] = [
        {
          start: "2026-03-02T09:00:00Z",
          end: "2026-03-02T10:00:00Z",
          score: 95,
          explanation: "optimal slot from external solver",
        },
      ];

      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({
            candidates: mockCandidates,
            solver_time_ms: 150,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const solver = new ExternalSolver("https://solver.example.com/solve");
      const input = makeInput({
        constraints: [
          {
            kind: "working_hours",
            config: {
              days: [1, 2, 3, 4, 5],
              start_time: "09:00",
              end_time: "17:00",
              timezone: "UTC",
            },
          },
        ],
      });
      const result = await solver.solve(input, 5);

      // Verify fetch was called correctly
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://solver.example.com/solve");
      expect(options.method).toBe("POST");
      expect(options.headers["Content-Type"]).toBe("application/json");

      // Verify request body
      const body = JSON.parse(options.body);
      expect(body.input).toBeDefined();
      expect(body.input.windowStart).toBe("2026-03-02T08:00:00Z");
      expect(body.input.windowEnd).toBe("2026-03-06T18:00:00Z");
      expect(body.input.durationMinutes).toBe(60);
      expect(body.maxCandidates).toBe(5);

      // Verify result
      expect(result.candidates.length).toBe(1);
      expect(result.candidates[0].score).toBe(95);
      expect(result.solverUsed).toBe("external");
      expect(result.solverTimeMs).toBe(150);
    });

    it("enforces 30s timeout via AbortController", async () => {
      // Simulate a timeout by rejecting with AbortError
      fetchSpy.mockRejectedValue(new DOMException("The operation was aborted", "AbortError"));

      const solver = new ExternalSolver("https://solver.example.com/solve");
      const input = makeInput();

      // ExternalSolver should throw on timeout (fallback is handled by caller)
      await expect(solver.solve(input, 5)).rejects.toThrow();

      // Verify AbortController signal was passed
      const [, options] = fetchSpy.mock.calls[0];
      expect(options.signal).toBeDefined();
    });

    it("timeout constant is 30 seconds", () => {
      expect(EXTERNAL_SOLVER_TIMEOUT_MS).toBe(30_000);
    });

    it("throws on non-200 HTTP response", async () => {
      fetchSpy.mockResolvedValue(
        new Response("Internal Server Error", { status: 500 }),
      );

      const solver = new ExternalSolver("https://solver.example.com/solve");
      const input = makeInput();

      await expect(solver.solve(input, 5)).rejects.toThrow(
        /External solver returned HTTP 500/,
      );
    });

    it("throws on invalid JSON response", async () => {
      fetchSpy.mockResolvedValue(
        new Response("not json", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
      );

      const solver = new ExternalSolver("https://solver.example.com/solve");
      const input = makeInput();

      await expect(solver.solve(input, 5)).rejects.toThrow();
    });

    it("throws on response missing candidates array", async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ solver_time_ms: 100 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const solver = new ExternalSolver("https://solver.example.com/solve");
      const input = makeInput();

      await expect(solver.solve(input, 5)).rejects.toThrow(
        /missing candidates array/,
      );
    });

    it("handles empty candidates array from external solver", async () => {
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify({ candidates: [], solver_time_ms: 50 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      const solver = new ExternalSolver("https://solver.example.com/solve");
      const input = makeInput();
      const result = await solver.solve(input, 5);

      expect(result.candidates.length).toBe(0);
      expect(result.solverUsed).toBe("external");
    });
  });
});

// ---------------------------------------------------------------------------
// Solver selection logic tests
// ---------------------------------------------------------------------------

describe("selectSolver", () => {
  it("returns 'greedy' for simple cases (few participants, few constraints)", () => {
    const input = makeInput({
      participantHashes: makeManyParticipants(2),
      constraints: makeManyConstraints(3),
    });
    expect(selectSolver(input)).toBe("greedy");
  });

  it("returns 'external' when participants > 3", () => {
    const input = makeInput({
      participantHashes: makeManyParticipants(4),
      constraints: makeManyConstraints(2),
    });
    expect(selectSolver(input)).toBe("external");
  });

  it("returns 'external' when constraints > 5", () => {
    const input = makeInput({
      participantHashes: makeManyParticipants(2),
      constraints: makeManyConstraints(6),
    });
    expect(selectSolver(input)).toBe("external");
  });

  it("returns 'external' when both thresholds exceeded", () => {
    const input = makeInput({
      participantHashes: makeManyParticipants(5),
      constraints: makeManyConstraints(8),
    });
    expect(selectSolver(input)).toBe("external");
  });

  it("returns 'greedy' at exact boundary (3 participants)", () => {
    const input = makeInput({
      participantHashes: makeManyParticipants(3),
      constraints: makeManyConstraints(5),
    });
    expect(selectSolver(input)).toBe("greedy");
  });

  it("returns 'greedy' at exact boundary (5 constraints)", () => {
    const input = makeInput({
      participantHashes: makeManyParticipants(2),
      constraints: makeManyConstraints(5),
    });
    expect(selectSolver(input)).toBe("greedy");
  });

  it("returns 'greedy' when no participants and few constraints", () => {
    const input = makeInput({
      // No participantHashes field at all
      constraints: makeManyConstraints(3),
    });
    expect(selectSolver(input)).toBe("greedy");
  });

  it("returns 'greedy' when no constraints and few participants", () => {
    const input = makeInput({
      participantHashes: makeManyParticipants(2),
      // No constraints
    });
    expect(selectSolver(input)).toBe("greedy");
  });

  it("returns 'greedy' when input has no optional fields", () => {
    const input = makeInput();
    expect(selectSolver(input)).toBe("greedy");
  });
});

// ---------------------------------------------------------------------------
// createSolverFromEnv factory tests
// ---------------------------------------------------------------------------

describe("createSolverFromEnv", () => {
  it("returns GreedySolverAdapter when no SOLVER_ENDPOINT configured", () => {
    const solver = createSolverFromEnv(undefined);
    expect(solver).toBeInstanceOf(GreedySolverAdapter);
  });

  it("returns GreedySolverAdapter when SOLVER_ENDPOINT is empty string", () => {
    const solver = createSolverFromEnv("");
    expect(solver).toBeInstanceOf(GreedySolverAdapter);
  });

  it("returns ExternalSolver when SOLVER_ENDPOINT is configured", () => {
    const solver = createSolverFromEnv("https://solver.example.com/solve");
    expect(solver).toBeInstanceOf(ExternalSolver);
  });
});

// ---------------------------------------------------------------------------
// Fallback behavior tests (solver with fallback wrapper)
// ---------------------------------------------------------------------------

describe("ExternalSolver with fallback", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ExternalSolver throws on failure (caller handles fallback)", async () => {
    fetchSpy.mockRejectedValue(new Error("Connection refused"));

    const solver = new ExternalSolver("https://solver.example.com/solve");
    const input = makeInput();

    await expect(solver.solve(input, 5)).rejects.toThrow("Connection refused");
  });

  it("ExternalSolver throws on HTTP 503 (caller handles fallback)", async () => {
    fetchSpy.mockResolvedValue(
      new Response("Service Unavailable", { status: 503 }),
    );

    const solver = new ExternalSolver("https://solver.example.com/solve");
    const input = makeInput();

    await expect(solver.solve(input, 5)).rejects.toThrow(
      /External solver returned HTTP 503/,
    );
  });
});

// ---------------------------------------------------------------------------
// SolverResult type tests
// ---------------------------------------------------------------------------

describe("SolverResult", () => {
  it("GreedySolverAdapter result has expected shape", async () => {
    const solver = new GreedySolverAdapter();
    const input = makeInput();
    const result: SolverResult = await solver.solve(input, 5);

    expect(result).toHaveProperty("candidates");
    expect(result).toHaveProperty("solverUsed");
    expect(result).toHaveProperty("solverTimeMs");
    expect(Array.isArray(result.candidates)).toBe(true);
    expect(["greedy", "external"]).toContain(result.solverUsed);
  });
});
