/**
 * Billing routes for the T-Minus API.
 *
 * Provides Stripe Checkout session creation and webhook handling.
 * The checkout endpoint requires authentication; the webhook endpoint
 * is called by Stripe and authenticated via HMAC signature verification.
 *
 * Routes:
 *   POST /v1/billing/checkout  - Create Stripe Checkout session (authed)
 *   POST /v1/billing/webhook   - Handle Stripe webhook events (Stripe-signed)
 *   GET  /v1/billing/status    - Get current subscription status (authed)
 *
 * All responses use the standard envelope format:
 *   { ok, data, error, meta: { request_id, timestamp } }
 */

import { generateId } from "@tminus/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Stripe Checkout session creation response (subset of Stripe API). */
export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  customer: string;
  subscription: string | null;
  metadata: Record<string, string>;
}

/** Stripe webhook event shape (subset). */
export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: {
    object: Record<string, unknown>;
  };
}

/** Stripe subscription object shape (subset). */
export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  current_period_end: number;
  metadata: Record<string, string>;
  items?: {
    data?: Array<{
      price?: {
        id: string;
        lookup_key?: string;
      };
    }>;
  };
}

/** Env bindings required by billing routes. */
export interface BillingEnv {
  DB: D1Database;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STRIPE_API_BASE = "https://api.stripe.com/v1";
const APP_BASE_URL = "https://app.tminus.ink";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a short request ID for tracing. */
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

/** Build a success response envelope. */
export function billingSuccessResponse<T>(data: T, status = 200): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      data,
      meta: makeMeta(),
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

/** Build an error response envelope. */
export function billingErrorResponse(code: string, message: string, status: number): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: { code, message },
      meta: makeMeta(),
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// Stripe API helpers
// ---------------------------------------------------------------------------

/**
 * Create a Stripe Checkout session via the Stripe REST API.
 *
 * Uses fetch (no SDK) because Cloudflare Workers do not support Node.js
 * modules. The Stripe API accepts form-encoded bodies.
 */
export async function createStripeCheckoutSession(
  stripeSecretKey: string,
  params: {
    price_id: string;
    user_id: string;
    customer_email?: string;
    success_url?: string;
    cancel_url?: string;
  },
): Promise<StripeCheckoutSession> {
  const body = new URLSearchParams();
  body.append("mode", "subscription");
  body.append("line_items[0][price]", params.price_id);
  body.append("line_items[0][quantity]", "1");
  body.append("success_url", params.success_url ?? `${APP_BASE_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`);
  body.append("cancel_url", params.cancel_url ?? `${APP_BASE_URL}/billing/cancel`);
  body.append("metadata[user_id]", params.user_id);
  if (params.customer_email) {
    body.append("customer_email", params.customer_email);
  }

  const response = await fetch(`${STRIPE_API_BASE}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`Stripe API error: ${response.status} ${errorData}`);
  }

  return response.json() as Promise<StripeCheckoutSession>;
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

/**
 * Verify the Stripe webhook signature using HMAC-SHA-256.
 *
 * Stripe sends:
 *   Stripe-Signature: t=<timestamp>,v1=<signature>
 *
 * The signed payload is: "<timestamp>.<raw_body>"
 *
 * @returns The parsed event if signature is valid, null otherwise.
 */
export async function verifyStripeWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  webhookSecret: string,
  toleranceSeconds = 300,
): Promise<StripeWebhookEvent | null> {
  try {
    // Parse the Stripe-Signature header
    const elements = signatureHeader.split(",");
    const sigMap = new Map<string, string>();
    for (const element of elements) {
      const [key, value] = element.split("=", 2);
      if (key && value) {
        sigMap.set(key.trim(), value.trim());
      }
    }

    const timestamp = sigMap.get("t");
    const signature = sigMap.get("v1");

    if (!timestamp || !signature) {
      return null;
    }

    // Check timestamp tolerance (prevent replay attacks)
    const timestampNum = parseInt(timestamp, 10);
    if (isNaN(timestampNum)) return null;

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestampNum) > toleranceSeconds) {
      return null;
    }

    // Compute expected signature
    const payload = `${timestamp}.${rawBody}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(webhookSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sigBytes = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(payload),
    );

    // Convert to hex
    const expectedSig = Array.from(new Uint8Array(sigBytes))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Constant-time comparison (via subtle crypto)
    if (expectedSig.length !== signature.length) return null;

    // Use timing-safe comparison: encode both as bytes and use subtle.verify
    // to avoid timing side channels
    let match = true;
    for (let i = 0; i < expectedSig.length; i++) {
      if (expectedSig[i] !== signature[i]) {
        match = false;
      }
    }

    if (!match) return null;

    return JSON.parse(rawBody) as StripeWebhookEvent;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tier resolution
// ---------------------------------------------------------------------------

/**
 * Map a Stripe price ID or lookup key to a subscription tier.
 *
 * In production, this would check the price's lookup_key or metadata.
 * For the walking skeleton, we use a simple mapping.
 */
export function resolveTierFromPrice(priceId: string): "free" | "premium" | "enterprise" {
  // Convention: price IDs or lookup keys containing "enterprise" -> enterprise tier
  // Everything else that's a paid price -> premium tier
  if (priceId.toLowerCase().includes("enterprise")) {
    return "enterprise";
  }
  return "premium";
}

// ---------------------------------------------------------------------------
// D1 operations
// ---------------------------------------------------------------------------

/**
 * Upsert a subscription record in D1.
 *
 * If a subscription already exists for the user + stripe_subscription_id,
 * update it. Otherwise, insert a new one.
 */
export async function upsertSubscription(
  db: D1Database,
  params: {
    user_id: string;
    tier: "free" | "premium" | "enterprise";
    stripe_customer_id: string;
    stripe_subscription_id: string;
    current_period_end: string;
    status: string;
  },
): Promise<void> {
  // Check if subscription already exists by stripe_subscription_id
  const existing = await db
    .prepare("SELECT subscription_id FROM subscriptions WHERE stripe_subscription_id = ?1")
    .bind(params.stripe_subscription_id)
    .first<{ subscription_id: string }>();

  if (existing) {
    // Update existing subscription
    await db
      .prepare(
        `UPDATE subscriptions
         SET tier = ?1, current_period_end = ?2, status = ?3, updated_at = ?4
         WHERE stripe_subscription_id = ?5`,
      )
      .bind(
        params.tier,
        params.current_period_end,
        params.status,
        new Date().toISOString(),
        params.stripe_subscription_id,
      )
      .run();
  } else {
    // Insert new subscription
    const subscriptionId = generateId("user").replace("usr_", "sub_");
    await db
      .prepare(
        `INSERT INTO subscriptions
         (subscription_id, user_id, tier, stripe_customer_id, stripe_subscription_id, current_period_end, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(
        subscriptionId,
        params.user_id,
        params.tier,
        params.stripe_customer_id,
        params.stripe_subscription_id,
        params.current_period_end,
        params.status,
      )
      .run();
  }
}

/**
 * Get the current subscription tier for a user.
 * Returns "free" if no active subscription exists.
 */
export async function getUserTier(
  db: D1Database,
  userId: string,
): Promise<"free" | "premium" | "enterprise"> {
  const row = await db
    .prepare(
      `SELECT tier FROM subscriptions
       WHERE user_id = ?1 AND status IN ('active', 'trialing')
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(userId)
    .first<{ tier: string }>();

  if (!row) return "free";
  return row.tier as "free" | "premium" | "enterprise";
}

// ---------------------------------------------------------------------------
// Webhook event handlers
// ---------------------------------------------------------------------------

/**
 * Handle checkout.session.completed event.
 *
 * Creates/updates the subscription in D1, upgrading the user's tier.
 */
export async function handleCheckoutCompleted(
  db: D1Database,
  session: Record<string, unknown>,
): Promise<{ success: boolean; error?: string }> {
  const metadata = session.metadata as Record<string, string> | undefined;
  const userId = metadata?.user_id;

  if (!userId) {
    return { success: false, error: "Missing user_id in session metadata" };
  }

  const subscriptionId = session.subscription as string | undefined;
  const customerId = session.customer as string | undefined;

  if (!subscriptionId || !customerId) {
    return { success: false, error: "Missing subscription or customer ID" };
  }

  // Default to premium for checkout -- the subscription update webhook will
  // refine the tier if needed based on the price ID.
  await upsertSubscription(db, {
    user_id: userId,
    tier: "premium",
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    status: "active",
  });

  return { success: true };
}

/**
 * Handle customer.subscription.updated event.
 *
 * Updates the subscription status and period end in D1.
 */
export async function handleSubscriptionUpdated(
  db: D1Database,
  subscription: StripeSubscription,
): Promise<{ success: boolean; error?: string }> {
  const userId = subscription.metadata?.user_id;
  if (!userId) {
    return { success: false, error: "Missing user_id in subscription metadata" };
  }

  // Determine tier from subscription items
  let tier: "free" | "premium" | "enterprise" = "premium";
  const priceId = subscription.items?.data?.[0]?.price?.id;
  if (priceId) {
    tier = resolveTierFromPrice(priceId);
  }

  // Map Stripe status to our status
  const statusMap: Record<string, string> = {
    active: "active",
    past_due: "past_due",
    canceled: "cancelled",
    unpaid: "unpaid",
    trialing: "trialing",
  };
  const status = statusMap[subscription.status] ?? "active";

  await upsertSubscription(db, {
    user_id: userId,
    tier: subscription.status === "canceled" ? "free" : tier,
    stripe_customer_id: subscription.customer,
    stripe_subscription_id: subscription.id,
    current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
    status,
  });

  return { success: true };
}

/**
 * Handle customer.subscription.deleted event.
 *
 * Downgrades the user to the free tier.
 */
export async function handleSubscriptionDeleted(
  db: D1Database,
  subscription: StripeSubscription,
): Promise<{ success: boolean; error?: string }> {
  const userId = subscription.metadata?.user_id;
  if (!userId) {
    return { success: false, error: "Missing user_id in subscription metadata" };
  }

  await upsertSubscription(db, {
    user_id: userId,
    tier: "free",
    stripe_customer_id: subscription.customer,
    stripe_subscription_id: subscription.id,
    current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
    status: "cancelled",
  });

  return { success: true };
}

/**
 * Handle invoice.payment_failed event.
 *
 * Marks the subscription as past_due but does not downgrade tier yet
 * (Stripe will retry payment and eventually cancel).
 */
export async function handlePaymentFailed(
  db: D1Database,
  invoice: Record<string, unknown>,
): Promise<{ success: boolean; error?: string }> {
  const subscriptionId = invoice.subscription as string | undefined;
  if (!subscriptionId) {
    return { success: false, error: "Missing subscription ID in invoice" };
  }

  // Update subscription status to past_due
  await db
    .prepare(
      `UPDATE subscriptions SET status = 'past_due', updated_at = ?1
       WHERE stripe_subscription_id = ?2`,
    )
    .bind(new Date().toISOString(), subscriptionId)
    .run();

  return { success: true };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /v1/billing/checkout
 *
 * Create a Stripe Checkout session for the authenticated user.
 * Requires: { price_id: string }
 */
export async function handleCreateCheckoutSession(
  request: Request,
  userId: string,
  env: BillingEnv,
): Promise<Response> {
  let body: { price_id?: string; success_url?: string; cancel_url?: string };
  try {
    body = await request.json() as typeof body;
  } catch {
    return billingErrorResponse("VALIDATION_ERROR", "Request body must be valid JSON", 400);
  }

  if (!body.price_id || typeof body.price_id !== "string") {
    return billingErrorResponse("VALIDATION_ERROR", "price_id is required", 400);
  }

  // Look up user email for Stripe
  const user = await env.DB
    .prepare("SELECT email FROM users WHERE user_id = ?1")
    .bind(userId)
    .first<{ email: string }>();

  try {
    const session = await createStripeCheckoutSession(env.STRIPE_SECRET_KEY, {
      price_id: body.price_id,
      user_id: userId,
      customer_email: user?.email,
      success_url: body.success_url,
      cancel_url: body.cancel_url,
    });

    return billingSuccessResponse({
      session_id: session.id,
      checkout_url: session.url,
    }, 201);
  } catch (err) {
    console.error("Failed to create checkout session", err);
    return billingErrorResponse(
      "STRIPE_ERROR",
      "Failed to create checkout session",
      502,
    );
  }
}

/**
 * POST /v1/billing/webhook
 *
 * Handle incoming Stripe webhook events.
 * Authenticates via Stripe-Signature header (HMAC-SHA-256).
 */
export async function handleStripeWebhook(
  request: Request,
  env: BillingEnv,
): Promise<Response> {
  const signatureHeader = request.headers.get("Stripe-Signature");
  if (!signatureHeader) {
    return billingErrorResponse("VALIDATION_ERROR", "Missing Stripe-Signature header", 400);
  }

  const rawBody = await request.text();
  const event = await verifyStripeWebhookSignature(
    rawBody,
    signatureHeader,
    env.STRIPE_WEBHOOK_SECRET,
  );

  if (!event) {
    return billingErrorResponse("AUTH_FAILED", "Invalid webhook signature", 401);
  }

  let result: { success: boolean; error?: string };

  switch (event.type) {
    case "checkout.session.completed":
      result = await handleCheckoutCompleted(env.DB, event.data.object);
      break;
    case "customer.subscription.updated":
      result = await handleSubscriptionUpdated(env.DB, event.data.object as unknown as StripeSubscription);
      break;
    case "customer.subscription.deleted":
      result = await handleSubscriptionDeleted(env.DB, event.data.object as unknown as StripeSubscription);
      break;
    case "invoice.payment_failed":
      result = await handlePaymentFailed(env.DB, event.data.object);
      break;
    default:
      // Acknowledge unknown events without error (Stripe best practice)
      result = { success: true };
  }

  if (!result.success) {
    console.error(`Webhook handler failed for ${event.type}: ${result.error}`);
    return billingErrorResponse("INTERNAL_ERROR", result.error ?? "Webhook processing failed", 500);
  }

  return billingSuccessResponse({ received: true });
}

/**
 * GET /v1/billing/status
 *
 * Get the current subscription status for the authenticated user.
 */
export async function handleGetBillingStatus(
  userId: string,
  env: BillingEnv,
): Promise<Response> {
  try {
    const row = await env.DB
      .prepare(
        `SELECT subscription_id, tier, stripe_customer_id, stripe_subscription_id,
                current_period_end, status, created_at, updated_at
         FROM subscriptions
         WHERE user_id = ?1
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .bind(userId)
      .first<{
        subscription_id: string;
        tier: string;
        stripe_customer_id: string | null;
        stripe_subscription_id: string | null;
        current_period_end: string | null;
        status: string;
        created_at: string;
        updated_at: string;
      }>();

    if (!row) {
      return billingSuccessResponse({
        tier: "free",
        status: "none",
        subscription: null,
      });
    }

    return billingSuccessResponse({
      tier: row.tier,
      status: row.status,
      subscription: {
        subscription_id: row.subscription_id,
        stripe_customer_id: row.stripe_customer_id,
        stripe_subscription_id: row.stripe_subscription_id,
        current_period_end: row.current_period_end,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
    });
  } catch (err) {
    console.error("Failed to get billing status", err);
    return billingErrorResponse("INTERNAL_ERROR", "Failed to get billing status", 500);
  }
}
