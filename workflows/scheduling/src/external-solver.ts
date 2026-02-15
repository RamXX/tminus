/**
 * External constraint solver integration for T-Minus (TM-82s.2, AD-3).
 *
 * Provides a pluggable solver architecture so SchedulingWorkflow can use
 * either the built-in greedy solver or an external constraint solver
 * (Z3, OR-Tools) running as an HTTP service.
 *
 * Architecture:
 * - Solver interface: common contract for all solvers
 * - GreedySolverAdapter: wraps the existing greedySolver pure function
 * - ExternalSolver: calls external HTTP endpoint with 30s timeout
 * - selectSolver(): decides which solver to use based on problem complexity
 * - createSolverFromEnv(): factory that reads SOLVER_ENDPOINT env var
 *
 * Fallback strategy: callers should catch ExternalSolver errors and fall
 * back to GreedySolverAdapter. The ExternalSolver itself throws on failure
 * (separation of concerns -- the workflow handles fallback policy).
 *
 * Per AD-3: Z3 cannot run inside Workers (128 MB limit). External solver
 * is a separate service (Cloudflare Container, AWS Lambda, etc.).
 */

import { greedySolver } from "./solver";
import type { SolverInput, ScoredCandidate } from "./solver";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timeout for external solver HTTP calls, per Workflow step limit. */
export const EXTERNAL_SOLVER_TIMEOUT_MS = 30_000;

/** Participant count threshold: > this uses external solver. */
const PARTICIPANT_THRESHOLD = 3;

/** Constraint count threshold: > this uses external solver. */
const CONSTRAINT_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Solver interface
// ---------------------------------------------------------------------------

/** Result from any solver implementation. */
export interface SolverResult {
  /** Scored candidate time slots, sorted by score descending. */
  readonly candidates: ScoredCandidate[];
  /** Which solver produced these results. */
  readonly solverUsed: "greedy" | "external";
  /** Wall-clock time the solver took in milliseconds. */
  readonly solverTimeMs: number;
}

/**
 * Pluggable solver interface.
 *
 * Both GreedySolverAdapter and ExternalSolver implement this contract.
 * The SchedulingWorkflow calls solve() without knowing which implementation
 * is being used.
 */
export interface Solver {
  solve(input: SolverInput, maxCandidates: number): Promise<SolverResult>;
}

// ---------------------------------------------------------------------------
// GreedySolverAdapter
// ---------------------------------------------------------------------------

/**
 * Wraps the existing greedySolver pure function as a Solver.
 *
 * This is the default solver for simple scheduling problems (few
 * participants, few constraints). It runs entirely in-process with
 * no external dependencies.
 */
export class GreedySolverAdapter implements Solver {
  async solve(input: SolverInput, maxCandidates: number): Promise<SolverResult> {
    const start = performance.now();
    const candidates = greedySolver(input, maxCandidates);
    const elapsed = performance.now() - start;

    return {
      candidates,
      solverUsed: "greedy",
      solverTimeMs: Math.round(elapsed),
    };
  }
}

// ---------------------------------------------------------------------------
// ExternalSolver
// ---------------------------------------------------------------------------

/**
 * Expected response from the external solver HTTP endpoint.
 *
 * The external service (Z3, OR-Tools, etc.) must return this shape.
 */
interface ExternalSolverResponse {
  candidates: ScoredCandidate[];
  solver_time_ms: number;
}

/**
 * Calls an external constraint solver service via HTTP.
 *
 * The external service runs Z3, OR-Tools, or similar constraint solver
 * that cannot run inside Workers (128 MB memory limit per AD-3).
 *
 * Request format:
 *   POST <endpoint>
 *   { input: SolverInput, maxCandidates: number }
 *
 * Response format:
 *   { candidates: ScoredCandidate[], solver_time_ms: number }
 *
 * Timeout: 30 seconds (enforced via AbortController).
 *
 * On failure (timeout, HTTP error, invalid response), this class THROWS.
 * The caller (SchedulingWorkflow) is responsible for fallback to greedy.
 */
export class ExternalSolver implements Solver {
  private readonly endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  async solve(input: SolverInput, maxCandidates: number): Promise<SolverResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      EXTERNAL_SOLVER_TIMEOUT_MS,
    );

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input, maxCandidates }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `External solver returned HTTP ${response.status}: ${await response.text()}`,
        );
      }

      const data = (await response.json()) as ExternalSolverResponse;

      if (!data || !Array.isArray(data.candidates)) {
        throw new Error(
          "External solver response missing candidates array",
        );
      }

      return {
        candidates: data.candidates,
        solverUsed: "external",
        solverTimeMs: data.solver_time_ms ?? 0,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ---------------------------------------------------------------------------
// Solver selection logic
// ---------------------------------------------------------------------------

/**
 * Determine which solver to use based on problem complexity.
 *
 * Uses external solver when the problem is complex enough to benefit
 * from constraint optimization (many participants or many constraints).
 *
 * Thresholds (from story spec):
 * - participants > 3 -> external
 * - constraints > 5 -> external
 *
 * Returns the solver type string, not the solver instance. The caller
 * uses this to decide whether to invoke ExternalSolver.
 */
export function selectSolver(input: SolverInput): "greedy" | "external" {
  const participantCount = input.participantHashes?.length ?? 0;
  const constraintCount = input.constraints?.length ?? 0;

  if (participantCount > PARTICIPANT_THRESHOLD) return "external";
  if (constraintCount > CONSTRAINT_THRESHOLD) return "external";

  return "greedy";
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Solver based on the SOLVER_ENDPOINT environment variable.
 *
 * When the endpoint is configured, returns an ExternalSolver.
 * When absent or empty, returns a GreedySolverAdapter (default).
 *
 * Note: this factory creates the solver instance. The actual decision
 * to use external vs greedy for a specific request is made by
 * selectSolver() at call time. If SOLVER_ENDPOINT is not configured,
 * the greedy solver is ALWAYS used regardless of selectSolver().
 */
export function createSolverFromEnv(
  solverEndpoint: string | undefined,
): Solver {
  if (solverEndpoint && solverEndpoint.trim().length > 0) {
    return new ExternalSolver(solverEndpoint.trim());
  }
  return new GreedySolverAdapter();
}
