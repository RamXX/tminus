/**
 * Route group: Intelligence (cognitive load, context switches, deep work,
 *              risk scores, availability).
 */

import {
  type RouteGroupHandler,
  type AuthContext,
  callDO,
  parseJsonBody,
  jsonResponse,
  successEnvelope,
  errorEnvelope,
  ErrorCode,
} from "../shared";

// ---------------------------------------------------------------------------
// Intelligence handlers
// ---------------------------------------------------------------------------

async function handleGetCognitiveLoad(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const date = url.searchParams.get("date");
  const range = url.searchParams.get("range") ?? "day";

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return jsonResponse(
      errorEnvelope(
        "date query parameter is required (YYYY-MM-DD format)",
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (range !== "day" && range !== "week") {
    return jsonResponse(
      errorEnvelope(
        "range must be 'day' or 'week'",
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{
      score: number;
      meeting_density: number;
      context_switches: number;
      deep_work_blocks: number;
      fragmentation: number;
    }>(env.USER_GRAPH, auth.userId, "/getCognitiveLoad", { date, range });

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to compute cognitive load", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to compute cognitive load", err);
    return jsonResponse(
      errorEnvelope("Failed to compute cognitive load", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- Probabilistic availability -----------------------------------------------

async function handleGetAvailability(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode");
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  const granularityParam = url.searchParams.get("granularity");

  if (!start || !end) {
    return jsonResponse(
      errorEnvelope(
        "start and end query parameters are required (ISO 8601 datetime)",
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Validate ISO 8601 datetime format (basic check)
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (isNaN(startMs) || isNaN(endMs)) {
    return jsonResponse(
      errorEnvelope(
        "start and end must be valid ISO 8601 datetimes",
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (startMs >= endMs) {
    return jsonResponse(
      errorEnvelope(
        "start must be before end",
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Max 7 days to prevent excessively large responses
  const MAX_RANGE_MS = 7 * 24 * 60 * 60 * 1000;
  if (endMs - startMs > MAX_RANGE_MS) {
    return jsonResponse(
      errorEnvelope(
        "Time range must not exceed 7 days",
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Parse granularity (default 30 minutes)
  let granularity_minutes = 30;
  if (granularityParam) {
    const parsed = parseInt(granularityParam, 10);
    if (isNaN(parsed) || parsed <= 0 || parsed > 120) {
      return jsonResponse(
        errorEnvelope(
          "granularity must be a positive integer (minutes, max 120)",
          "VALIDATION_ERROR",
        ),
        ErrorCode.VALIDATION_ERROR,
      );
    }
    granularity_minutes = parsed;
  }

  if (mode === "probabilistic") {
    try {
      const result = await callDO<{
        slots: Array<{ start: string; end: string; probability: number }>;
      }>(env.USER_GRAPH, auth.userId, "/getProbabilisticAvailability", {
        start,
        end,
        granularity_minutes,
      });

      if (!result.ok) {
        return jsonResponse(
          errorEnvelope("Failed to compute probabilistic availability", "INTERNAL_ERROR"),
          ErrorCode.INTERNAL_ERROR,
        );
      }

      return jsonResponse(successEnvelope(result.data), 200);
    } catch (err) {
      console.error("Failed to compute probabilistic availability", err);
      return jsonResponse(
        errorEnvelope("Failed to compute probabilistic availability", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }
  }

  // Default mode: delegate to existing DO computeAvailability for binary free/busy
  try {
    const result = await callDO<{
      busy_intervals: Array<{ start: string; end: string; account_ids: string[] }>;
      free_intervals: Array<{ start: string; end: string }>;
    }>(env.USER_GRAPH, auth.userId, "/computeAvailability", {
      start,
      end,
    });

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to compute availability", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to compute availability", err);
    return jsonResponse(
      errorEnvelope("Failed to compute availability", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- Context-switch cost estimation -------------------------------------------

async function handleGetContextSwitches(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const date = url.searchParams.get("date");
  const range = url.searchParams.get("range") ?? "day";

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return jsonResponse(
      errorEnvelope(
        "date query parameter is required (YYYY-MM-DD format)",
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (range !== "day" && range !== "week") {
    return jsonResponse(
      errorEnvelope(
        "range must be 'day' or 'week'",
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{
      transitions: unknown[];
      total_cost: number;
      daily_costs: number[];
      suggestions: unknown[];
    }>(env.USER_GRAPH, auth.userId, "/getContextSwitches", { date, range });

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to compute context switches", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to compute context switches", err);
    return jsonResponse(
      errorEnvelope("Failed to compute context switches", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- Deep work window optimization ------------------------------------------------

async function handleGetDeepWork(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const date = url.searchParams.get("date");
  const range = url.searchParams.get("range") ?? "day";

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return jsonResponse(
      errorEnvelope(
        "date query parameter is required (YYYY-MM-DD format)",
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (range !== "day" && range !== "week") {
    return jsonResponse(
      errorEnvelope(
        "range must be 'day' or 'week'",
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Optional min_block_minutes parameter
  const minBlockStr = url.searchParams.get("min_block_minutes");
  const minBlockMinutes = minBlockStr ? parseInt(minBlockStr, 10) : undefined;
  if (minBlockMinutes !== undefined && (isNaN(minBlockMinutes) || minBlockMinutes < 1)) {
    return jsonResponse(
      errorEnvelope(
        "min_block_minutes must be a positive integer",
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const body: Record<string, unknown> = { date, range };
    if (minBlockMinutes !== undefined) body.min_block_minutes = minBlockMinutes;

    const result = await callDO<{
      blocks: unknown[];
      total_deep_hours: number;
      protected_hours_target: number;
      suggestions: unknown[];
    }>(env.USER_GRAPH, auth.userId, "/getDeepWork", body);

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to compute deep work report", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to compute deep work report", err);
    return jsonResponse(
      errorEnvelope("Failed to compute deep work report", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- Temporal risk scoring --------------------------------------------------------

async function handleGetRiskScores(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const weeksStr = url.searchParams.get("weeks") ?? "4";
  const weeks = parseInt(weeksStr, 10);

  if (isNaN(weeks) || weeks < 1 || weeks > 52) {
    return jsonResponse(
      errorEnvelope(
        "weeks must be a positive integer between 1 and 52",
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{
      burnout_risk: number;
      travel_overload: number;
      strategic_drift: number;
      overall_risk: number;
      risk_level: string;
      recommendations: string[];
    }>(env.USER_GRAPH, auth.userId, "/getRiskScores", { weeks });

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to compute risk scores", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to compute risk scores", err);
    return jsonResponse(
      errorEnvelope("Failed to compute risk scores", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ---------------------------------------------------------------------------
// Route group: Intelligence
// ---------------------------------------------------------------------------

export const routeIntelligenceRoutes: RouteGroupHandler = async (request, method, pathname, auth, env) => {
  if (method === "GET" && pathname === "/v1/intelligence/cognitive-load") {
    return handleGetCognitiveLoad(request, auth, env);
  }

  if (method === "GET" && pathname === "/v1/intelligence/context-switches") {
    return handleGetContextSwitches(request, auth, env);
  }

  if (method === "GET" && pathname === "/v1/intelligence/deep-work") {
    return handleGetDeepWork(request, auth, env);
  }

  if (method === "GET" && pathname === "/v1/intelligence/risk-scores") {
    return handleGetRiskScores(request, auth, env);
  }

  if (method === "GET" && pathname === "/v1/availability") {
    return handleGetAvailability(request, auth, env);
  }

  return null;
};

