/**
 * tminus-api -- Main REST API worker.
 *
 * Route handlers are organized into domain-specific modules under routes/handlers/.
 * This file contains auth/JWT logic, the request dispatcher, and the main handler.
 */

import {
  checkRateLimit as checkRL,
  selectRateLimitConfig,
  getRateLimitIdentity,
  detectAuthEndpoint,
  extractClientIp,
  buildRateLimitResponse,
  applyRateLimitHeaders,
  addSecurityHeaders,
  addCorsHeaders,
  buildPreflightResponse,
} from "@tminus/shared";
import type { RateLimitKV, RateLimitTier } from "@tminus/shared";
import { createAuthRoutes } from "./routes/auth";
import { handleStripeWebhook } from "./routes/billing";
import type { BillingEnv } from "./routes/billing";
import { isApiKeyFormat, extractPrefix, hashApiKey } from "./api-keys";
import { routeGroups } from "./routes/handlers";

// Import shared types and helpers (used locally AND re-exported for backward compat)
import {
  ErrorCode,
  type ErrorCodeName,
  type ApiEnvelope,
  successEnvelope,
  errorEnvelope,
  type RouteMatch,
  type AuthContext,
  type RouteGroupHandler,
  callDO,
  parseJsonBody,
  matchRoute,
  jsonResponse,
} from "./routes/shared";

// Re-export shared types and helpers for backward compatibility.
// Tests and other packages import these from index.ts.
export {
  ErrorCode,
  type ErrorCodeName,
  type ApiEnvelope,
  successEnvelope,
  errorEnvelope,
  type RouteMatch,
  type AuthContext,
  type RouteGroupHandler,
  callDO,
  parseJsonBody,
  matchRoute,
  jsonResponse,
};

// Re-export proof/commitment functions for tests
export {
  computeProofHash,
  generateProofCsv,
  generateProofDocument,
  generateProofHtml,
  computeProofSignature,
  verifyProofSignature,
} from "./routes/handlers/commitments";

// Re-export constraint validation for tests
export {
  VALID_CONSTRAINT_KINDS,
  validateConstraintKindAndConfig,
} from "./routes/handlers/policies";

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

export const API_VERSION = "0.0.1";

// ---------------------------------------------------------------------------
// Durable Object class re-exports (required by wrangler for DO hosting)
// ---------------------------------------------------------------------------

export { UserGraphDO } from "@tminus/do-user-graph";
export { AccountDO } from "@tminus/do-account";

// ---------------------------------------------------------------------------
// JWT validation (HS256, Phase 1 simple)
// ---------------------------------------------------------------------------

/**
 * Decode and validate a JWT signed with HS256.
 *
 * Returns the payload on success, or null on failure.
 * Phase 1: simple validation -- no audience/issuer checks.
 */
export async function verifyJwt(
  token: string,
  secret: string,
): Promise<{ sub: string; [key: string]: unknown } | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;

    // Decode header and verify algorithm
    const header = JSON.parse(b64UrlDecode(headerB64));
    if (header.alg !== "HS256") return null;

    // Verify signature
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const signatureData = b64UrlToBytes(signatureB64);
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

    const valid = await crypto.subtle.verify("HMAC", key, signatureData, signingInput);
    if (!valid) return null;

    // Decode payload
    const payload = JSON.parse(b64UrlDecode(payloadB64));

    // Check expiration
    if (payload.exp && typeof payload.exp === "number") {
      const now = Math.floor(Date.now() / 1000);
      if (now >= payload.exp) return null;
    }

    // Must have sub claim
    if (!payload.sub || typeof payload.sub !== "string") return null;

    return payload;
  } catch {
    return null;
  }
}

/** Base64URL decode to string. */
function b64UrlDecode(str: string): string {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  const fullPadded = pad ? padded + "=".repeat(4 - pad) : padded;
  return atob(fullPadded);
}

/** Base64URL decode to Uint8Array. */
function b64UrlToBytes(str: string): Uint8Array {
  const decoded = b64UrlDecode(str);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) {
    bytes[i] = decoded.charCodeAt(i);
  }
  return bytes;
}

/**
 * Create a JWT signed with HS256. Used for testing.
 * Exported so test code can create valid tokens.
 */
export async function createJwt(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = b64UrlEncode(JSON.stringify(header));
  const payloadB64 = b64UrlEncode(JSON.stringify(payload));

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = await crypto.subtle.sign("HMAC", key, signingInput);

  const signatureB64 = bytesToB64Url(new Uint8Array(signature));
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

/** Base64URL encode a string. */
function b64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Uint8Array to Base64URL. */
function bytesToB64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

async function extractAuth(
  request: Request,
  jwtSecret: string,
  db?: D1Database,
): Promise<AuthContext | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return null;

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return null;

  const token = parts[1];

  // API key path: if token starts with tmk_, validate as API key
  if (token.startsWith("tmk_")) {
    if (!db) return null;
    if (!isApiKeyFormat(token)) return null;

    const prefix = extractPrefix(token);
    if (!prefix) return null;

    try {
      const row = await db
        .prepare(
          `SELECT k.key_id, k.key_hash, k.user_id
           FROM api_keys k
           WHERE k.prefix = ?1 AND k.revoked_at IS NULL`,
        )
        .bind(prefix)
        .first<{
          key_id: string;
          key_hash: string;
          user_id: string;
        }>();

      if (!row) return null;

      const presentedHash = await hashApiKey(token);
      if (presentedHash !== row.key_hash) return null;

      // Update last_used_at (best-effort, non-blocking)
      db.prepare("UPDATE api_keys SET last_used_at = ?1 WHERE key_id = ?2")
        .bind(new Date().toISOString(), row.key_id)
        .run()
        .catch(() => {});

      return { userId: row.user_id };
    } catch {
      return null;
    }
  }

  // JWT path
  const payload = await verifyJwt(token, jwtSecret);
  if (!payload) return null;

  return { userId: payload.sub };
}

// ---------------------------------------------------------------------------
// Public route handler: deletion certificate (no JWT required)
// ---------------------------------------------------------------------------

async function handleGetDeletionCertificate(
  certificateId: string,
  env: Env,
): Promise<Response> {
  try {
    const row = await env.DB
      .prepare(
        `SELECT cert_id, entity_type, entity_id, deleted_at, proof_hash, signature, deletion_summary
         FROM deletion_certificates
         WHERE cert_id = ?1`,
      )
      .bind(certificateId)
      .first<{
        cert_id: string;
        entity_type: string;
        entity_id: string;
        deleted_at: string;
        proof_hash: string;
        signature: string;
        deletion_summary: string | null;
      }>();

    if (!row) {
      return jsonResponse(
        errorEnvelope("Deletion certificate not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(
      successEnvelope({
        certificate_id: row.cert_id,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        deleted_at: row.deleted_at,
        proof_hash: row.proof_hash,
        signature: row.signature,
        deletion_summary: row.deletion_summary ? JSON.parse(row.deletion_summary) : null,
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to retrieve deletion certificate", err);
    return jsonResponse(
      errorEnvelope("Failed to retrieve deletion certificate", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// Router
// ---------------------------------------------------------------------------

/**
 * Creates the worker handler. Factory pattern allows tests to inject
 * dependencies and validate the full request flow.
 */
export function createHandler() {
  return {
    async fetch(
      request: Request,
      env: Env,
      _ctx: ExecutionContext,
    ): Promise<Response> {
      const url = new URL(request.url);
      const { pathname } = url;
      const method = request.method;
      const origin = request.headers.get("Origin");
      const environment = env.ENVIRONMENT ?? "development";

      // Helper: wrap response with security + CORS headers before returning.
      // Every response from the API goes through this to guarantee coverage.
      const finalize = (response: Response): Response => {
        const secured = addSecurityHeaders(response);
        return addCorsHeaders(secured, origin, environment);
      };

      // CORS preflight -- handled before anything else, including health check.
      // Returns 204 with appropriate CORS + security headers.
      if (method === "OPTIONS") {
        const preflight = buildPreflightResponse(origin, environment);
        return addSecurityHeaders(preflight);
      }

      // Health check -- no auth required
      if (method === "GET" && pathname === "/health") {
        return finalize(new Response(
          JSON.stringify({
            ok: true,
            data: {
              status: "healthy",
              version: API_VERSION,
            },
            error: null,
            meta: {
              timestamp: new Date().toISOString(),
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ));
      }

      // Public route: deletion certificate retrieval (no auth -- certificate ID is the access token)
      const certMatch = matchRoute(pathname, "/v1/account/deletion-certificate/:id");
      if (certMatch && method === "GET") {
        return finalize(await handleGetDeletionCertificate(certMatch.params[0], env));
      }

      // Public route: Stripe webhook (authenticated via Stripe-Signature header, not JWT)
      if (method === "POST" && pathname === "/v1/billing/webhook") {
        if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
          return finalize(jsonResponse(
            errorEnvelope("Billing not configured", "INTERNAL_ERROR"),
            ErrorCode.INTERNAL_ERROR,
          ));
        }
        return finalize(await handleStripeWebhook(request, env as unknown as BillingEnv));
      }

      // All /v1/* routes require auth (except /v1/auth/*)
      if (!pathname.startsWith("/v1/")) {
        return finalize(jsonResponse(
          errorEnvelope("Not Found", "NOT_FOUND"),
          ErrorCode.NOT_FOUND,
        ));
      }

      // Auth routes (/v1/auth/*) do NOT require existing JWT -- they create tokens.
      // Delegate to the Hono auth router.
      if (pathname.startsWith("/v1/auth/")) {
        // Rate limit auth endpoints (register/login have stricter limits)
        if (env.RATE_LIMITS) {
          const authEndpoint = detectAuthEndpoint(pathname);
          if (authEndpoint) {
            const clientIp = extractClientIp(request);
            const identity = getRateLimitIdentity(null, clientIp, authEndpoint);
            const config = selectRateLimitConfig(null, authEndpoint);
            const rlResult = await checkRL(env.RATE_LIMITS as unknown as RateLimitKV, identity, config);
            if (!rlResult.allowed) {
              return finalize(buildRateLimitResponse(rlResult));
            }
          }
        }

        const authRouter = createAuthRoutes();
        // Rewrite path: strip /v1/auth prefix so Hono routes match at /register, /login, etc.
        const rewrittenUrl = new URL(request.url);
        rewrittenUrl.pathname = pathname.slice("/v1/auth".length);
        const rewrittenRequest = new Request(rewrittenUrl.toString(), request);
        const authResponse = await authRouter.fetch(rewrittenRequest, env);
        return finalize(authResponse);
      }

      // Authenticate -- all other /v1/* routes require a valid JWT or API key
      const auth = await extractAuth(request, env.JWT_SECRET, env.DB);
      if (!auth) {
        // Rate limit unauthenticated requests hitting protected endpoints by IP
        if (env.RATE_LIMITS) {
          const clientIp = extractClientIp(request);
          const identity = getRateLimitIdentity(null, clientIp);
          const config = selectRateLimitConfig(null);
          const rlResult = await checkRL(env.RATE_LIMITS as unknown as RateLimitKV, identity, config);
          if (!rlResult.allowed) {
            return finalize(buildRateLimitResponse(rlResult));
          }
        }
        return finalize(jsonResponse(
          errorEnvelope("Authentication required", "AUTH_REQUIRED"),
          ErrorCode.AUTH_REQUIRED,
        ));
      }

      // Rate limit authenticated requests by user_id and tier
      // Default tier to "free" -- future: look up actual tier from auth context
      let rateLimitResult: import("@tminus/shared").RateLimitResult | null = null;
      if (env.RATE_LIMITS) {
        const tier: RateLimitTier = "free"; // TODO: extract from JWT payload when tier system is fully wired
        const identity = getRateLimitIdentity(auth.userId, extractClientIp(request));
        const config = selectRateLimitConfig(tier);
        rateLimitResult = await checkRL(env.RATE_LIMITS as unknown as RateLimitKV, identity, config);
        if (!rateLimitResult.allowed) {
          return finalize(buildRateLimitResponse(rateLimitResult));
        }
      }

      // -- Route to handler and apply rate limit headers ----------------------

      let response = await routeAuthenticatedRequest(request, method, pathname, auth, env);

      // Apply rate limit headers to all authenticated responses
      if (rateLimitResult) {
        response = await applyRateLimitHeaders(response, rateLimitResult);
      }

      return finalize(response);
    },
  };
}

// ---------------------------------------------------------------------------
// Authenticated request dispatcher
// ---------------------------------------------------------------------------

async function routeAuthenticatedRequest(
  request: Request,
  method: string,
  pathname: string,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  for (const group of routeGroups) {
    const response = await group(request, method, pathname, auth, env);
    if (response) return response;
  }

  return jsonResponse(
    errorEnvelope("Not Found", "NOT_FOUND"),
    ErrorCode.NOT_FOUND,
  );
}

// ---------------------------------------------------------------------------
// Default export for Cloudflare Workers runtime
// ---------------------------------------------------------------------------

const handler = createHandler();
export default handler;
