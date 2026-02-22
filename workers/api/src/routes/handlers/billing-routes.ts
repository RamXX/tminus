/**
 * Route group: Billing (Stripe checkout, status, portal, events).
 *
 * Handler implementations are in routes/billing.ts.
 */

import {
  handleCreateCheckoutSession,
  handleGetBillingStatus,
  handleCreatePortalSession,
  handleGetBillingEvents,
} from "../billing";
import type { BillingEnv } from "../billing";
import {
  type RouteGroupHandler,
  jsonResponse,
  errorEnvelope,
  ErrorCode,
} from "../shared";

// ---------------------------------------------------------------------------
// Route group: Billing
//
// NOTE: The webhook endpoint (POST /v1/billing/webhook) is intentionally NOT
// in this route group. It lives in index.ts as a public route because it
// bypasses JWT auth -- Stripe authenticates via Stripe-Signature (HMAC).
// ---------------------------------------------------------------------------

export const routeBillingRoutes: RouteGroupHandler = async (request, method, pathname, auth, env) => {
  if (method === "POST" && pathname === "/v1/billing/checkout") {
    if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
      return jsonResponse(
        errorEnvelope("Billing not configured", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }
    return handleCreateCheckoutSession(request, auth.userId, env as unknown as BillingEnv);
  }

  if (method === "GET" && pathname === "/v1/billing/status") {
    return handleGetBillingStatus(auth.userId, env as unknown as BillingEnv);
  }

  if (method === "POST" && pathname === "/v1/billing/portal") {
    if (!env.STRIPE_SECRET_KEY) {
      return jsonResponse(
        errorEnvelope("Billing not configured", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }
    return handleCreatePortalSession(auth.userId, env as unknown as BillingEnv);
  }

  if (method === "GET" && pathname === "/v1/billing/events") {
    return handleGetBillingEvents(auth.userId, env as unknown as BillingEnv);
  }

  return null;
};

