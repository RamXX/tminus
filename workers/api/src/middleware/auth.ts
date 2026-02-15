/**
 * Auth middleware for the T-Minus API worker.
 *
 * Supports TWO authentication methods:
 * 1. JWT Bearer tokens: "Authorization: Bearer <jwt>"
 * 2. API key Bearer tokens: "Authorization: Bearer tmk_live_<prefix><random>"
 *
 * Detection: If the Bearer token starts with "tmk_", it is treated as an
 * API key and validated against D1 (prefix lookup + SHA-256 hash comparison).
 * Otherwise it is verified as a JWT using the shared jwt.ts utilities.
 *
 * On success, attaches user context (user_id, email, tier) to the Hono context.
 *
 * On failure, returns a 401 JSON response with the envelope format:
 *   { ok: false, error: { code: "AUTH_REQUIRED", message: "..." } }
 */

import type { Context, Next, MiddlewareHandler } from "hono";
import { verifyJWT } from "@tminus/shared";
import type { JWTPayload } from "@tminus/shared";
import { isApiKeyFormat, extractPrefix, hashApiKey } from "../api-keys";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** User context attached to requests after successful auth. */
export interface AuthUser {
  /** User ID (usr_ ULID). */
  user_id: string;
  /** User email address. */
  email: string;
  /** Subscription tier. */
  tier: "free" | "premium" | "enterprise";
}

/**
 * Hono environment type extension for auth middleware.
 * Consumers declare their Hono app with this to get typed access
 * to c.get("user").
 */
export interface AuthEnv {
  Variables: {
    user: AuthUser;
  };
}

/**
 * Interface for the D1-like database binding needed by API key validation.
 * Kept minimal so tests can provide a lightweight mock.
 */
export interface AuthDB {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      first<T>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

// ---------------------------------------------------------------------------
// Error response helper
// ---------------------------------------------------------------------------

/**
 * Build a 401 error response in the T-Minus envelope format.
 */
function authErrorResponse(c: Context, message: string): Response {
  return c.json(
    {
      ok: false,
      error: {
        code: "AUTH_REQUIRED",
        message,
      },
    },
    401,
  );
}

// ---------------------------------------------------------------------------
// API key validation
// ---------------------------------------------------------------------------

/**
 * Validate an API key against the D1 database.
 *
 * Steps:
 * 1. Extract the 8-char prefix from the key
 * 2. Look up non-revoked keys matching that prefix
 * 3. Hash the raw key and compare against stored hash
 * 4. If valid, return user context; update last_used_at asynchronously
 *
 * @returns AuthUser on success, null on failure.
 */
async function validateApiKey(
  rawKey: string,
  db: AuthDB,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<AuthUser | null> {
  const prefix = extractPrefix(rawKey);
  if (!prefix) return null;

  try {
    // Look up by prefix (non-revoked keys only).
    // Join with users table to get email and tier.
    const row = await db
      .prepare(
        `SELECT k.key_id, k.key_hash, k.user_id, u.email
         FROM api_keys k
         JOIN users u ON k.user_id = u.user_id
         WHERE k.prefix = ?1 AND k.revoked_at IS NULL`,
      )
      .bind(prefix)
      .first<{
        key_id: string;
        key_hash: string;
        user_id: string;
        email: string;
      }>();

    if (!row) return null;

    // Compute hash of the presented key and compare
    const presentedHash = await hashApiKey(rawKey);
    if (presentedHash !== row.key_hash) return null;

    // Update last_used_at asynchronously (non-blocking, best-effort)
    const updatePromise = db
      .prepare("UPDATE api_keys SET last_used_at = ?1 WHERE key_id = ?2")
      .bind(new Date().toISOString(), row.key_id)
      .run()
      .then(() => {})
      .catch(() => {
        // Ignore errors -- last_used_at is not critical
      });

    if (waitUntil) {
      waitUntil(updatePromise);
    }

    return {
      user_id: row.user_id,
      email: row.email,
      // API keys default to "free" tier -- future: store tier in api_keys or look up from users
      tier: "free",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Create an auth middleware that verifies JWT Bearer tokens AND API keys.
 *
 * @param getSecret - A function that returns the JWT secret from the context's env.
 * @param getDB     - Optional function that returns the D1 database for API key validation.
 *                    If not provided, API key auth is disabled (JWT-only mode).
 * @param getWaitUntil - Optional function to get waitUntil for async operations.
 * @returns A Hono middleware handler.
 *
 * Usage:
 * ```ts
 * const app = new Hono<{ Bindings: Env } & AuthEnv>();
 * app.use("/v1/*", authMiddleware(
 *   (c) => c.env.JWT_SECRET,
 *   (c) => c.env.DB,
 * ));
 * ```
 */
export function authMiddleware(
  getSecret: (c: Context) => string,
  getDB?: (c: Context) => AuthDB,
  getWaitUntil?: (c: Context) => ((promise: Promise<unknown>) => void) | undefined,
): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader) {
      return authErrorResponse(c, "Missing Authorization header");
    }

    // Must be "Bearer <token>"
    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return authErrorResponse(c, "Invalid Authorization header format");
    }

    const token = parts[1];

    // Route to API key validation if the token looks like tmk_*
    if (token.startsWith("tmk_")) {
      if (!getDB) {
        return authErrorResponse(c, "API key authentication not configured");
      }

      if (!isApiKeyFormat(token)) {
        return authErrorResponse(c, "Invalid API key format");
      }

      const db = getDB(c);
      const waitUntil = getWaitUntil ? getWaitUntil(c) : undefined;
      const user = await validateApiKey(token, db, waitUntil);

      if (!user) {
        return authErrorResponse(c, "Invalid or revoked API key");
      }

      c.set("user", user);
      await next();
      return;
    }

    // JWT path
    const secret = getSecret(c);

    let payload: JWTPayload | null;
    try {
      payload = await verifyJWT(token, secret);
    } catch {
      return authErrorResponse(c, "Token verification failed");
    }

    if (!payload) {
      return authErrorResponse(c, "Invalid or expired token");
    }

    // Attach user context for downstream handlers
    const user: AuthUser = {
      user_id: payload.sub,
      email: payload.email,
      tier: payload.tier,
    };

    c.set("user", user);
    await next();
  };
}
