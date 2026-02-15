/**
 * Auth middleware for the T-Minus API worker.
 *
 * Extracts Bearer JWT from the Authorization header, verifies it
 * using the shared jwt.ts utilities, and attaches user context
 * (user_id, email, tier) to the Hono context.
 *
 * On failure, returns a 401 JSON response with the envelope format:
 *   { ok: false, error: { code: "AUTH_REQUIRED", message: "..." } }
 *
 * Scope: Library + middleware only. Wiring to routes is handled by
 * TM-as6.1b (auth routes story).
 */

import type { Context, Next, MiddlewareHandler } from "hono";
import { verifyJWT } from "@tminus/shared";
import type { JWTPayload } from "@tminus/shared";

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
// Middleware
// ---------------------------------------------------------------------------

/**
 * Create an auth middleware that verifies JWT Bearer tokens.
 *
 * @param getSecret - A function that returns the JWT secret from the context's env.
 *                    This avoids coupling the middleware to a specific env shape.
 * @returns A Hono middleware handler.
 *
 * Usage:
 * ```ts
 * const app = new Hono<{ Bindings: Env } & AuthEnv>();
 * app.use("/v1/*", authMiddleware((c) => c.env.JWT_SECRET));
 * ```
 */
export function authMiddleware(
  getSecret: (c: Context) => string,
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
