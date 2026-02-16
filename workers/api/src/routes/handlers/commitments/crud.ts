/**
 * Commitment CRUD handlers: create, list, get status, delete.
 *
 * Extracted from commitments.ts for single-responsibility decomposition.
 */

import { isValidId, generateId } from "@tminus/shared";
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
// Create commitment
// ---------------------------------------------------------------------------

export async function handleCreateCommitment(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const body = await parseJsonBody<{
    client_id?: string;
    target_hours?: number;
    window_type?: string;
    client_name?: string;
    rolling_window_weeks?: number;
    hard_minimum?: boolean;
    proof_required?: boolean;
  }>(request);

  if (!body) {
    return jsonResponse(
      errorEnvelope("Request body must be valid JSON", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (!body.client_id || typeof body.client_id !== "string") {
    return jsonResponse(
      errorEnvelope("client_id is required", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (body.target_hours === undefined || typeof body.target_hours !== "number" || body.target_hours <= 0) {
    return jsonResponse(
      errorEnvelope("target_hours is required and must be a positive number", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (body.window_type !== undefined) {
    const validWindowTypes = ["WEEKLY", "MONTHLY"];
    if (!validWindowTypes.includes(body.window_type)) {
      return jsonResponse(
        errorEnvelope(
          `Invalid window_type: ${body.window_type}. Must be one of: ${validWindowTypes.join(", ")}`,
          "VALIDATION_ERROR",
        ),
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  if (body.rolling_window_weeks !== undefined) {
    if (typeof body.rolling_window_weeks !== "number" || body.rolling_window_weeks < 1 || !Number.isInteger(body.rolling_window_weeks)) {
      return jsonResponse(
        errorEnvelope("rolling_window_weeks must be a positive integer", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  try {
    const commitmentId = generateId("commitment");
    const result = await callDO<{
      commitment_id: string;
      client_id: string;
      client_name: string | null;
      window_type: string;
      target_hours: number;
      rolling_window_weeks: number;
      hard_minimum: boolean;
      proof_required: boolean;
      created_at: string;
    }>(env.USER_GRAPH, auth.userId, "/createCommitment", {
      commitment_id: commitmentId,
      client_id: body.client_id,
      target_hours: body.target_hours,
      window_type: body.window_type ?? "WEEKLY",
      client_name: body.client_name ?? null,
      rolling_window_weeks: body.rolling_window_weeks ?? 4,
      hard_minimum: body.hard_minimum ?? false,
      proof_required: body.proof_required ?? false,
    });

    if (!result.ok) {
      const errorData = result.data as { error?: string };
      const errorMsg = errorData.error ?? "Failed to create commitment";
      if (errorMsg.includes("already exists")) {
        return jsonResponse(
          errorEnvelope(errorMsg, "CONFLICT"),
          ErrorCode.CONFLICT,
        );
      }
      return jsonResponse(
        errorEnvelope(errorMsg, "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 201);
  } catch (err) {
    console.error("Failed to create commitment", err);
    return jsonResponse(
      errorEnvelope("Failed to create commitment", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ---------------------------------------------------------------------------
// List commitments
// ---------------------------------------------------------------------------

export async function handleListCommitments(
  _request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    const result = await callDO<{ items: unknown[] }>(
      env.USER_GRAPH,
      auth.userId,
      "/listCommitments",
      {},
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to list commitments", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data.items), 200);
  } catch (err) {
    console.error("Failed to list commitments", err);
    return jsonResponse(
      errorEnvelope("Failed to list commitments", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ---------------------------------------------------------------------------
// Get commitment status
// ---------------------------------------------------------------------------

export async function handleGetCommitmentStatus(
  _request: Request,
  auth: AuthContext,
  env: Env,
  commitmentId: string,
): Promise<Response> {
  if (!isValidId(commitmentId, "commitment")) {
    return jsonResponse(
      errorEnvelope("Invalid commitment ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{
      commitment_id: string;
      client_id: string;
      client_name: string | null;
      window_type: string;
      target_hours: number;
      actual_hours: number;
      status: string;
      window_start: string;
      window_end: string;
      rolling_window_weeks: number;
    } | null>(env.USER_GRAPH, auth.userId, "/getCommitmentStatus", {
      commitment_id: commitmentId,
    });

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to get commitment status", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    if (result.data === null) {
      return jsonResponse(
        errorEnvelope("Commitment not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to get commitment status", err);
    return jsonResponse(
      errorEnvelope("Failed to get commitment status", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ---------------------------------------------------------------------------
// Delete commitment
// ---------------------------------------------------------------------------

export async function handleDeleteCommitment(
  _request: Request,
  auth: AuthContext,
  env: Env,
  commitmentId: string,
): Promise<Response> {
  if (!isValidId(commitmentId, "commitment")) {
    return jsonResponse(
      errorEnvelope("Invalid commitment ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{ deleted: boolean }>(
      env.USER_GRAPH,
      auth.userId,
      "/deleteCommitment",
      { commitment_id: commitmentId },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to delete commitment", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    if (!result.data.deleted) {
      return jsonResponse(
        errorEnvelope("Commitment not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope({ deleted: true }), 200);
  } catch (err) {
    console.error("Failed to delete commitment", err);
    return jsonResponse(
      errorEnvelope("Failed to delete commitment", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}
