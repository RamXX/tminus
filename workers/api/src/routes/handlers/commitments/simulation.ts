/**
 * What-if simulation handler for commitment impact analysis.
 *
 * Extracted from commitments.ts for single-responsibility decomposition.
 */

import type { SimulationScenario, ImpactReport } from "@tminus/shared";
import {
  type AuthContext,
  callDO,
  parseJsonBody,
  jsonResponse,
  successEnvelope,
  errorEnvelope,
  ErrorCode,
} from "../../shared";

// ---------------------------------------------------------------------------
// Simulation handler
// ---------------------------------------------------------------------------

export async function handleSimulation(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const body = await parseJsonBody<{
    scenario?: {
      type?: string;
      client_id?: string;
      hours_per_week?: number;
      title?: string;
      day_of_week?: number;
      start_time?: number;
      end_time?: number;
      duration_weeks?: number;
      start_hour?: number;
      end_hour?: number;
    };
  }>(request);

  if (!body || !body.scenario) {
    return jsonResponse(
      errorEnvelope("Request body must include a scenario object", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const { scenario } = body;

  if (!scenario.type) {
    return jsonResponse(
      errorEnvelope("scenario.type is required", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const validTypes = ["add_commitment", "add_recurring_event", "change_working_hours"];
  if (!validTypes.includes(scenario.type)) {
    return jsonResponse(
      errorEnvelope(
        `Invalid scenario.type: ${scenario.type}. Must be one of: ${validTypes.join(", ")}`,
        "VALIDATION_ERROR",
      ),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Type-specific validation
  if (scenario.type === "add_commitment") {
    if (!scenario.client_id || typeof scenario.client_id !== "string") {
      return jsonResponse(
        errorEnvelope("scenario.client_id is required for add_commitment", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (scenario.hours_per_week === undefined || typeof scenario.hours_per_week !== "number" || scenario.hours_per_week < 0) {
      return jsonResponse(
        errorEnvelope("scenario.hours_per_week is required and must be a non-negative number", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  if (scenario.type === "add_recurring_event") {
    if (!scenario.title || typeof scenario.title !== "string") {
      return jsonResponse(
        errorEnvelope("scenario.title is required for add_recurring_event", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (scenario.day_of_week === undefined || typeof scenario.day_of_week !== "number" || scenario.day_of_week < 0 || scenario.day_of_week > 6) {
      return jsonResponse(
        errorEnvelope("scenario.day_of_week must be 0-6 (Monday-Sunday)", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (scenario.start_time === undefined || typeof scenario.start_time !== "number") {
      return jsonResponse(
        errorEnvelope("scenario.start_time is required (decimal hour, e.g. 14 for 2pm)", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (scenario.end_time === undefined || typeof scenario.end_time !== "number") {
      return jsonResponse(
        errorEnvelope("scenario.end_time is required (decimal hour)", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (scenario.duration_weeks === undefined || typeof scenario.duration_weeks !== "number" || scenario.duration_weeks < 1) {
      return jsonResponse(
        errorEnvelope("scenario.duration_weeks must be a positive integer", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  if (scenario.type === "change_working_hours") {
    if (scenario.start_hour === undefined || typeof scenario.start_hour !== "number") {
      return jsonResponse(
        errorEnvelope("scenario.start_hour is required for change_working_hours", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (scenario.end_hour === undefined || typeof scenario.end_hour !== "number") {
      return jsonResponse(
        errorEnvelope("scenario.end_hour is required for change_working_hours", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (scenario.start_hour >= scenario.end_hour) {
      return jsonResponse(
        errorEnvelope("scenario.start_hour must be less than scenario.end_hour", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  try {
    const result = await callDO<ImpactReport>(
      env.USER_GRAPH,
      auth.userId,
      "/simulate",
      { scenario: scenario as SimulationScenario },
    );

    if (!result.ok) {
      const errorData = result.data as unknown as { error?: string };
      return jsonResponse(
        errorEnvelope(errorData.error ?? "Simulation failed", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Simulation failed", err);
    return jsonResponse(
      errorEnvelope("Simulation failed", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}
