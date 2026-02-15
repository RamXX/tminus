/**
 * Enterprise billing tier integration for the T-Minus API.
 *
 * Story: TM-nt8 -- Enterprise Billing Tier Integration
 *
 * Provides:
 *   - Per-seat pricing via Stripe quantity-based subscription
 *   - Seat limit enforcement on member addition
 *   - Seat count update API (POST /v1/orgs/:id/billing/seats)
 *   - Stripe webhook handling for seat quantity changes
 *   - Enterprise tier gate for org creation
 *
 * Design:
 *   - organizations table extended with seat_limit and stripe_subscription_id
 *   - seat_limit tracks max seats (updated via API or webhook)
 *   - Stripe subscription quantity represents total seats purchased
 *   - Default included seats: 5 (enterprise base price includes 5 seats)
 *   - Additional seats are per-seat overage via Stripe quantity update
 *
 * All responses use the standard envelope format:
 *   { ok, data, error, meta: { request_id, timestamp } }
 */

import { logBillingEvent } from "./billing";
import type { BillingEnv } from "./billing";
import { checkOrgAdmin } from "./orgs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of seats included in the enterprise base price. */
export const DEFAULT_INCLUDED_SEATS = 5;

/** Stripe API base URL. */
const STRIPE_API_BASE = "https://api.stripe.com/v1";

/** Base URL for seat management / billing upgrade. */
const BILLING_SEATS_URL = "https://app.tminus.ink/billing/seats";

// ---------------------------------------------------------------------------
// D1 Migration (re-exported for convenience; canonical source is d1-registry)
// ---------------------------------------------------------------------------

export { MIGRATION_0018_ORG_SEAT_BILLING } from "@tminus/d1-registry";

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function generateRequestId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `req_${ts}_${rand}`;
}

function makeMeta(): { request_id: string; timestamp: string } {
  return {
    request_id: generateRequestId(),
    timestamp: new Date().toISOString(),
  };
}

function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate seat count input for the seat update API.
 *
 * @param body - Parsed request body.
 * @returns Error message string or null if valid.
 */
export function validateSeatInput(body: Record<string, unknown>): string | null {
  if (!("seat_count" in body) || body.seat_count === undefined) {
    return "seat_count is required";
  }
  if (
    typeof body.seat_count !== "number" ||
    !Number.isInteger(body.seat_count) ||
    body.seat_count < 1
  ) {
    return "seat_count must be a positive integer";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Seat limit check
// ---------------------------------------------------------------------------

export interface SeatLimitResult {
  allowed: boolean;
  currentCount: number;
  seatLimit: number;
  orgNotFound?: boolean;
}

/**
 * Check if an organization can add another member based on seat limit.
 *
 * Queries D1 for the org's seat_limit and current member count.
 * Returns allowed=false if at or over the limit.
 *
 * @param orgId - The organization ID.
 * @param db - D1 database binding.
 * @returns SeatLimitResult with allowed flag and current counts.
 */
export async function checkSeatLimit(
  orgId: string,
  db: D1Database,
): Promise<SeatLimitResult> {
  // Get org seat_limit
  const org = await db
    .prepare("SELECT org_id, seat_limit FROM organizations WHERE org_id = ?1")
    .bind(orgId)
    .first<{ org_id: string; seat_limit: number | null }>();

  if (!org) {
    return { allowed: false, currentCount: 0, seatLimit: 0, orgNotFound: true };
  }

  // Use default if seat_limit is 0 or null
  const seatLimit = org.seat_limit && org.seat_limit > 0
    ? org.seat_limit
    : DEFAULT_INCLUDED_SEATS;

  // Count current members
  const row = await db
    .prepare("SELECT COUNT(*) as count FROM org_members WHERE org_id = ?1")
    .bind(orgId)
    .first<{ count: number }>();

  const currentCount = row?.count ?? 0;

  return {
    allowed: currentCount < seatLimit,
    currentCount,
    seatLimit,
  };
}

// ---------------------------------------------------------------------------
// Seat limit enforcement response
// ---------------------------------------------------------------------------

/**
 * Build a 403 SEAT_LIMIT response when org is at seat capacity.
 *
 * Includes upgrade prompt with billing URL so the client can direct
 * the user to purchase additional seats.
 *
 * @param currentSeats - Current number of members in the org.
 * @param seatLimit - Maximum seats allowed.
 * @returns 403 Response with SEAT_LIMIT error.
 */
export function seatLimitResponse(
  currentSeats: number,
  seatLimit: number,
): Response {
  return jsonResponse(
    {
      ok: false,
      error: {
        code: "SEAT_LIMIT",
        message: `Seat limit reached. Your organization has ${currentSeats}/${seatLimit} seats. Please add more seats to invite additional members.`,
      },
      current_seats: currentSeats,
      seat_limit: seatLimit,
      upgrade_url: BILLING_SEATS_URL,
      meta: makeMeta(),
    },
    403,
  );
}

/**
 * Enforce seat limit for an org. Returns null if allowed, or a 403
 * SEAT_LIMIT Response if at capacity.
 *
 * Callers use:
 *   const limited = await enforceSeatLimit(orgId, db);
 *   if (limited) return limited;
 *
 * @param orgId - The organization ID.
 * @param db - D1 database binding.
 * @returns null if allowed, or 403 Response if at seat limit.
 */
export async function enforceSeatLimit(
  orgId: string,
  db: D1Database,
): Promise<Response | null> {
  const result = await checkSeatLimit(orgId, db);

  if (result.orgNotFound) {
    // Org not found -- let the caller handle this (will return 404 or 400)
    return null;
  }

  if (result.allowed) return null;

  return seatLimitResponse(result.currentCount, result.seatLimit);
}

// ---------------------------------------------------------------------------
// Stripe API helpers
// ---------------------------------------------------------------------------

/**
 * Build URL-encoded form body for updating Stripe subscription item quantity.
 *
 * @param subscriptionItemId - The Stripe subscription item ID (si_xxx).
 * @param quantity - New seat quantity.
 * @returns URL-encoded string for the Stripe API.
 */
export function buildStripeQuantityUpdateBody(
  subscriptionItemId: string,
  quantity: number,
): string {
  const body = new URLSearchParams();
  body.append("items[0][id]", subscriptionItemId);
  body.append("items[0][quantity]", String(quantity));
  return body.toString();
}

/**
 * Update a Stripe subscription's seat quantity via the Stripe REST API.
 *
 * Uses fetch (no SDK) for Cloudflare Workers compatibility.
 * Flow:
 *   1. GET subscription to find the subscription item ID
 *   2. POST subscription update with new quantity
 *
 * @param stripeSecretKey - Stripe secret key.
 * @param subscriptionId - Stripe subscription ID (sub_xxx).
 * @param newQuantity - New seat count.
 * @returns Updated subscription data or error.
 */
export async function updateStripeSubscriptionQuantity(
  stripeSecretKey: string,
  subscriptionId: string,
  newQuantity: number,
): Promise<{ success: boolean; error?: string }> {
  // Step 1: Retrieve subscription to get the item ID
  const getResp = await fetch(`${STRIPE_API_BASE}/subscriptions/${subscriptionId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
    },
  });

  if (!getResp.ok) {
    const errText = await getResp.text();
    return { success: false, error: `Stripe GET subscription failed: ${getResp.status} ${errText}` };
  }

  const subscription = await getResp.json() as {
    items: { data: Array<{ id: string; quantity: number }> };
  };

  const item = subscription.items?.data?.[0];
  if (!item) {
    return { success: false, error: "No subscription item found on Stripe subscription" };
  }

  // Step 2: Update subscription with new quantity
  const updateBody = buildStripeQuantityUpdateBody(item.id, newQuantity);
  const updateResp = await fetch(`${STRIPE_API_BASE}/subscriptions/${subscriptionId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: updateBody,
  });

  if (!updateResp.ok) {
    const errText = await updateResp.text();
    return { success: false, error: `Stripe update subscription failed: ${updateResp.status} ${errText}` };
  }

  return { success: true };
}

// ---------------------------------------------------------------------------
// Webhook handler: seat quantity updated
// ---------------------------------------------------------------------------

/**
 * Handle seat quantity update from Stripe webhook.
 *
 * When a Stripe subscription quantity changes (via the Stripe dashboard,
 * API, or our own seat update endpoint), update the org's seat_limit in D1.
 *
 * @param db - D1 database binding.
 * @param params - Webhook parameters.
 * @returns Success/error result.
 */
export async function handleSeatQuantityUpdated(
  db: D1Database,
  params: {
    stripe_subscription_id: string;
    new_quantity: number;
    org_id: string;
  },
): Promise<{ success: boolean; error?: string }> {
  // Find the org by org_id
  const org = await db
    .prepare("SELECT org_id FROM organizations WHERE org_id = ?1")
    .bind(params.org_id)
    .first<{ org_id: string }>();

  if (!org) {
    return { success: false, error: `Organization not found: ${params.org_id}` };
  }

  // Update seat_limit
  await db
    .prepare("UPDATE organizations SET seat_limit = ?1 WHERE org_id = ?2")
    .bind(params.new_quantity, params.org_id)
    .run();

  return { success: true };
}

// ---------------------------------------------------------------------------
// Route handler: POST /v1/orgs/:id/billing/seats
// ---------------------------------------------------------------------------

/**
 * POST /v1/orgs/:id/billing/seats
 *
 * Update the org's seat count. Admin only.
 * Triggers a Stripe subscription quantity update.
 *
 * Body: { seat_count: number }
 *
 * Flow:
 *   1. Validate input
 *   2. Check admin role
 *   3. Update Stripe subscription quantity
 *   4. Update org seat_limit in D1
 *   5. Log billing event
 *
 * @param request - Incoming request.
 * @param userId - Authenticated user ID.
 * @param db - D1 database binding.
 * @param orgId - Organization ID from URL path.
 * @param stripeSecretKey - Stripe secret key from env.
 * @returns Response with updated seat info.
 */
export async function handleUpdateSeats(
  request: Request,
  userId: string,
  db: D1Database,
  orgId: string,
  stripeSecretKey: string,
): Promise<Response> {
  // Admin check
  const denied = await checkOrgAdmin(userId, orgId, db);
  if (denied) return denied;

  // Parse and validate body
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return jsonResponse(
      { ok: false, error: { code: "VALIDATION_ERROR", message: "Request body must be valid JSON" }, meta: makeMeta() },
      400,
    );
  }

  const inputError = validateSeatInput(body);
  if (inputError) {
    return jsonResponse(
      { ok: false, error: { code: "VALIDATION_ERROR", message: inputError }, meta: makeMeta() },
      400,
    );
  }

  const newSeatCount = body.seat_count as number;

  // Get org details (need stripe_subscription_id)
  const org = await db
    .prepare("SELECT org_id, seat_limit, stripe_subscription_id FROM organizations WHERE org_id = ?1")
    .bind(orgId)
    .first<{ org_id: string; seat_limit: number; stripe_subscription_id: string | null }>();

  if (!org) {
    return jsonResponse(
      { ok: false, error: { code: "NOT_FOUND", message: "Organization not found" }, meta: makeMeta() },
      404,
    );
  }

  const oldSeatLimit = org.seat_limit;
  let stripeUpdated = false;

  // Update Stripe subscription quantity if linked
  if (org.stripe_subscription_id) {
    const stripeResult = await updateStripeSubscriptionQuantity(
      stripeSecretKey,
      org.stripe_subscription_id,
      newSeatCount,
    );

    if (!stripeResult.success) {
      console.error("Failed to update Stripe subscription quantity:", stripeResult.error);
      return jsonResponse(
        {
          ok: false,
          error: { code: "STRIPE_ERROR", message: "Failed to update Stripe subscription" },
          meta: makeMeta(),
        },
        502,
      );
    }

    stripeUpdated = true;
  }

  // Update D1
  await db
    .prepare("UPDATE organizations SET seat_limit = ?1 WHERE org_id = ?2")
    .bind(newSeatCount, orgId)
    .run();

  // Log billing event
  await logBillingEvent(db, {
    user_id: userId,
    event_type: "seat_count_updated",
    metadata: {
      org_id: orgId,
      old_seat_limit: oldSeatLimit,
      new_seat_limit: newSeatCount,
      stripe_updated: stripeUpdated,
    },
  });

  return jsonResponse(
    {
      ok: true,
      data: {
        org_id: orgId,
        seat_limit: newSeatCount,
        stripe_updated: stripeUpdated,
      },
      meta: makeMeta(),
    },
    200,
  );
}
