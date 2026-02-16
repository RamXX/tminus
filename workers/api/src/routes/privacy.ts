/**
 * Privacy route handlers for the T-Minus API (GDPR Article 17 - Right to Erasure).
 *
 * Provides account deletion request management with a 72-hour grace period:
 *   POST   /v1/account/delete-request  - Request account deletion (re-auth required)
 *   GET    /v1/account/delete-request  - Check deletion request status
 *   DELETE /v1/account/delete-request  - Cancel pending deletion (within grace period)
 *
 * All responses use the standard API envelope format.
 *
 * Design:
 * - Re-authentication (password) required for deletion request creation
 * - 72-hour grace period before execution (GDPR allows up to 30 days)
 * - Only one active (pending/processing) deletion request per user
 * - Cancellation only allowed during pending status within grace period
 * - Actual cascading deletion is handled by DeletionWorkflow (separate story)
 */

import { verifyPassword, generateId } from "@tminus/shared";
import {
  type AuthContext,
  type ApiEnvelope,
  successEnvelope,
  errorEnvelope,
  jsonResponse,
  parseJsonBody,
} from "./shared";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Grace period before deletion executes: 72 hours in milliseconds. */
export const DELETION_GRACE_PERIOD_MS = 72 * 60 * 60 * 1000;

/** Grace period in hours (for display in API responses). */
export const DELETION_GRACE_PERIOD_HOURS = 72;

// ---------------------------------------------------------------------------
// Pure logic helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Compute the scheduled deletion time: now + 72 hours.
 */
export function computeScheduledAt(now: Date = new Date()): string {
  return new Date(now.getTime() + DELETION_GRACE_PERIOD_MS).toISOString();
}

/**
 * Check if a deletion request is still within the grace period
 * (i.e., the scheduled_at time has not yet passed).
 */
export function isWithinGracePeriod(scheduledAt: string, now: Date = new Date()): boolean {
  return now.getTime() < new Date(scheduledAt).getTime();
}

// Types and response helpers imported from ./shared

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /v1/account/delete-request
 *
 * Creates a pending deletion request with a 72-hour grace period.
 * Requires re-authentication via password in the request body.
 * Only one active (pending/processing) request per user.
 */
export async function handleCreateDeletionRequest(
  request: Request,
  auth: AuthContext,
  env: { DB: D1Database },
): Promise<Response> {
  // Parse body -- requires password for re-authentication
  const body = await parseJsonBody<{ password?: string }>(request);
  if (!body) {
    return jsonResponse(
      errorEnvelope("Request body must be valid JSON"),
      400,
    );
  }

  const password = body.password ?? "";
  if (!password) {
    return jsonResponse(
      errorEnvelope("Password is required for account deletion"),
      400,
    );
  }

  // Look up user to verify password
  const user = await env.DB
    .prepare("SELECT user_id, password_hash FROM users WHERE user_id = ?1")
    .bind(auth.userId)
    .first<{ user_id: string; password_hash: string | null }>();

  if (!user || !user.password_hash) {
    return jsonResponse(
      errorEnvelope("Unable to verify identity"),
      401,
    );
  }

  // Re-authenticate: verify password
  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return jsonResponse(
      errorEnvelope("Invalid password"),
      401,
    );
  }

  // Check for existing active (pending or processing) deletion request
  const existing = await env.DB
    .prepare(
      `SELECT request_id, status, scheduled_at
       FROM deletion_requests
       WHERE user_id = ?1 AND status IN ('pending', 'processing')
       ORDER BY requested_at DESC LIMIT 1`,
    )
    .bind(auth.userId)
    .first<{ request_id: string; status: string; scheduled_at: string }>();

  if (existing) {
    return jsonResponse(
      errorEnvelope(`A deletion request is already ${existing.status}`),
      409,
    );
  }

  // Create the deletion request
  const requestId = generateId("user").replace("usr_", "delreq_");
  const now = new Date();
  const requestedAt = now.toISOString();
  const scheduledAt = computeScheduledAt(now);

  await env.DB
    .prepare(
      `INSERT INTO deletion_requests (request_id, user_id, status, requested_at, scheduled_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(requestId, auth.userId, "pending", requestedAt, scheduledAt)
    .run();

  return jsonResponse(
    successEnvelope({
      request_id: requestId,
      status: "pending",
      requested_at: requestedAt,
      scheduled_at: scheduledAt,
      grace_period_hours: DELETION_GRACE_PERIOD_HOURS,
      message: `Account deletion scheduled. You have ${DELETION_GRACE_PERIOD_HOURS} hours to cancel.`,
    }),
    201,
  );
}

/**
 * GET /v1/account/delete-request
 *
 * Returns the most recent deletion request for the authenticated user.
 * If no request exists, returns { has_pending_request: false }.
 */
export async function handleGetDeletionRequest(
  _request: Request,
  auth: AuthContext,
  env: { DB: D1Database },
): Promise<Response> {
  // Get the most recent deletion request for this user
  const row = await env.DB
    .prepare(
      `SELECT request_id, user_id, status, requested_at, scheduled_at, completed_at, cancelled_at
       FROM deletion_requests
       WHERE user_id = ?1
       ORDER BY requested_at DESC LIMIT 1`,
    )
    .bind(auth.userId)
    .first<{
      request_id: string;
      user_id: string;
      status: string;
      requested_at: string;
      scheduled_at: string;
      completed_at: string | null;
      cancelled_at: string | null;
    }>();

  if (!row) {
    return jsonResponse(
      successEnvelope({
        has_pending_request: false,
        message: "No deletion request found",
      }),
      200,
    );
  }

  return jsonResponse(
    successEnvelope({
      has_pending_request: row.status === "pending",
      request_id: row.request_id,
      status: row.status,
      requested_at: row.requested_at,
      scheduled_at: row.scheduled_at,
      completed_at: row.completed_at,
      cancelled_at: row.cancelled_at,
      can_cancel: row.status === "pending" && isWithinGracePeriod(row.scheduled_at),
    }),
    200,
  );
}

/**
 * DELETE /v1/account/delete-request
 *
 * Cancels a pending deletion request. Only allowed when:
 * - A pending request exists for this user
 * - The grace period has not expired (scheduled_at is in the future)
 */
export async function handleCancelDeletionRequest(
  _request: Request,
  auth: AuthContext,
  env: { DB: D1Database },
): Promise<Response> {
  // Find the active pending deletion request
  const row = await env.DB
    .prepare(
      `SELECT request_id, status, scheduled_at
       FROM deletion_requests
       WHERE user_id = ?1 AND status = 'pending'
       ORDER BY requested_at DESC LIMIT 1`,
    )
    .bind(auth.userId)
    .first<{ request_id: string; status: string; scheduled_at: string }>();

  if (!row) {
    return jsonResponse(
      errorEnvelope("No pending deletion request found"),
      404,
    );
  }

  // Check if still within grace period
  if (!isWithinGracePeriod(row.scheduled_at)) {
    return jsonResponse(
      errorEnvelope("Grace period has expired. Deletion is being processed."),
      403,
    );
  }

  // Cancel the deletion request
  const cancelledAt = new Date().toISOString();
  await env.DB
    .prepare(
      "UPDATE deletion_requests SET status = 'cancelled', cancelled_at = ?1 WHERE request_id = ?2",
    )
    .bind(cancelledAt, row.request_id)
    .run();

  return jsonResponse(
    successEnvelope({
      request_id: row.request_id,
      status: "cancelled",
      cancelled_at: cancelledAt,
      message: "Deletion request has been cancelled",
    }),
    200,
  );
}
