/**
 * Auth routes for the T-Minus API.
 *
 * Provides registration, login, token refresh, and logout endpoints.
 * Uses JWT utilities and password hashing from @tminus/shared.
 * Refresh tokens are stored in Cloudflare KV with SHA-256 hashed keys.
 *
 * Routes (mounted at /v1/auth):
 *   POST /register  - Create user, return JWT + refresh token
 *   POST /login     - Authenticate, return JWT + refresh token
 *   POST /refresh   - Exchange refresh token for new JWT + rotated refresh token
 *   POST /logout    - Invalidate refresh token in KV
 *
 * All responses use the standard API envelope from shared.ts:
 *   { ok, data, error, error_code, meta: { request_id, timestamp } }
 */

import { Hono } from "hono";
import {
  generateJWT,
  verifyJWT,
  generateRefreshToken,
  hashPassword,
  verifyPassword,
  generateId,
  REFRESH_TOKEN_EXPIRY_SECONDS,
} from "@tminus/shared";
import type { JWTPayload, SubscriptionTier } from "@tminus/shared";
import { apiSuccessResponse, apiErrorResponse } from "./shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Env bindings required by auth routes. */
interface AuthEnv {
  DB: D1Database;
  SESSIONS: KVNamespace;
  JWT_SECRET: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** KV TTL for refresh token sessions (7 days in seconds). */
const REFRESH_TOKEN_KV_TTL = REFRESH_TOKEN_EXPIRY_SECONDS; // 604800

/** Minimum password length. */
const MIN_PASSWORD_LENGTH = 8;

/** Maximum password length (prevent DoS via huge PBKDF2 input). */
const MAX_PASSWORD_LENGTH = 128;

// ---------------------------------------------------------------------------
// Account Lockout Constants & Logic (TM-as6.4)
// ---------------------------------------------------------------------------

/**
 * Progressive lockout thresholds.
 *
 * After N cumulative failed login attempts, the account is locked for the
 * specified duration (in seconds). Thresholds are evaluated from highest
 * to lowest so the longest applicable lock duration wins.
 *
 * - 20+ fails -> 24 hours
 * - 10+ fails ->  1 hour
 * -  5+ fails -> 15 minutes
 */
const LOCKOUT_THRESHOLDS: ReadonlyArray<{ attempts: number; durationSeconds: number }> = [
  { attempts: 20, durationSeconds: 24 * 60 * 60 },  // 24 hours = 86400s
  { attempts: 10, durationSeconds: 60 * 60 },         //  1 hour  = 3600s
  { attempts: 5,  durationSeconds: 15 * 60 },         // 15 min   = 900s
];

/**
 * Compute the lockout duration (in seconds) for the given number of failed
 * login attempts. Returns 0 if no lockout threshold is met.
 */
function getLockoutDurationSeconds(failedAttempts: number): number {
  for (const threshold of LOCKOUT_THRESHOLDS) {
    if (failedAttempts >= threshold.attempts) {
      return threshold.durationSeconds;
    }
  }
  return 0;
}

/**
 * Compute the ISO-8601 `locked_until` timestamp for a given number of failed
 * attempts (evaluated at `now`). Returns null if no lockout applies.
 */
function computeLockedUntil(failedAttempts: number, now: Date = new Date()): string | null {
  const duration = getLockoutDurationSeconds(failedAttempts);
  if (duration === 0) return null;
  return new Date(now.getTime() + duration * 1000).toISOString();
}

/**
 * Check whether an account is currently locked. Returns the number of
 * seconds remaining until the lock expires, or 0 if not locked.
 */
function getRetryAfterSeconds(lockedUntil: string | null, now: Date = new Date()): number {
  if (!lockedUntil) return 0;
  const lockedUntilMs = new Date(lockedUntil).getTime();
  const remainingMs = lockedUntilMs - now.getTime();
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / 1000);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate email format (basic but sufficient). */
function isValidEmail(email: string): boolean {
  if (!email || typeof email !== "string") return false;
  // Basic RFC-ish validation: has @, non-empty local part, non-empty domain with dot
  const atIndex = email.indexOf("@");
  if (atIndex < 1) return false;
  const domain = email.slice(atIndex + 1);
  if (!domain || domain.indexOf(".") < 1) return false;
  // No spaces
  if (/\s/.test(email)) return false;
  return email.length <= 254; // RFC 5321 max
}

/** Validate password strength. */
function validatePassword(password: string): string | null {
  if (!password || typeof password !== "string") {
    return "Password is required";
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  }
  return null;
}

/**
 * SHA-256 hash of a string, returned as hex.
 * Used to hash refresh tokens before storing in KV
 * (we never store the raw token as the KV key).
 */
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  const hexParts: string[] = [];
  for (const byte of hashArray) {
    hexParts.push(byte.toString(16).padStart(2, "0"));
  }
  return hexParts.join("");
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Create the auth router.
 *
 * Exported as a factory so the main API worker can mount it:
 *   app.route("/v1/auth", createAuthRoutes());
 */
export function createAuthRoutes(): Hono<{ Bindings: AuthEnv }> {
  const auth = new Hono<{ Bindings: AuthEnv }>();

  // =========================================================================
  // POST /register
  // =========================================================================
  auth.post("/register", async (c) => {
    const env = c.env;

    // Parse body
    let body: { email?: string; password?: string };
    try {
      body = await c.req.json();
    } catch {
      return apiErrorResponse("VALIDATION_ERROR", "Request body must be valid JSON", 400);
    }

    const email = (body.email ?? "").trim().toLowerCase();
    const password = body.password ?? "";

    // Validate email
    if (!isValidEmail(email)) {
      return apiErrorResponse("VALIDATION_ERROR", "Invalid email format", 400);
    }

    // Validate password
    const pwError = validatePassword(password);
    if (pwError) {
      return apiErrorResponse("VALIDATION_ERROR", pwError, 400);
    }

    // Check email uniqueness in D1
    const existing = await env.DB
      .prepare("SELECT user_id FROM users WHERE email = ?1")
      .bind(email)
      .first<{ user_id: string }>();

    if (existing) {
      return apiErrorResponse("CONFLICT", "Email already registered", 409);
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Generate user ID (usr_ ULID)
    const userId = generateId("user");

    // Create a personal org for this user
    const orgId = generateId("user").replace("usr_", "org_");

    // Insert org and user in sequence
    await env.DB
      .prepare("INSERT INTO orgs (org_id, name) VALUES (?1, ?2)")
      .bind(orgId, `${email}'s org`)
      .run();

    await env.DB
      .prepare(
        `INSERT INTO users (user_id, org_id, email, password_hash, password_version)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(userId, orgId, email, passwordHash, 1)
      .run();

    // Generate JWT
    const jwt = await generateJWT(
      { sub: userId, email, tier: "free" as SubscriptionTier, pwd_ver: 1 },
      env.JWT_SECRET,
    );

    // Generate refresh token and store in KV
    const refreshToken = generateRefreshToken();
    const tokenHash = await sha256Hex(refreshToken);
    const sessionData = JSON.stringify({
      user_id: userId,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + REFRESH_TOKEN_KV_TTL * 1000).toISOString(),
    });

    await env.SESSIONS.put(`refresh_${tokenHash}`, sessionData, {
      expirationTtl: REFRESH_TOKEN_KV_TTL,
    });

    return apiSuccessResponse({
      user: { id: userId, email, tier: "free" },
      access_token: jwt,
      refresh_token: refreshToken,
    }, 201);
  });

  // =========================================================================
  // POST /login
  // =========================================================================
  auth.post("/login", async (c) => {
    const env = c.env;

    // Parse body
    let body: { email?: string; password?: string };
    try {
      body = await c.req.json();
    } catch {
      return apiErrorResponse("VALIDATION_ERROR", "Request body must be valid JSON", 400);
    }

    const email = (body.email ?? "").trim().toLowerCase();
    const password = body.password ?? "";

    if (!email || !password) {
      return apiErrorResponse("VALIDATION_ERROR", "Email and password are required", 400);
    }

    // Lookup user by email
    const user = await env.DB
      .prepare(
        `SELECT user_id, email, password_hash, password_version,
                failed_login_attempts, locked_until
         FROM users WHERE email = ?1`,
      )
      .bind(email)
      .first<{
        user_id: string;
        email: string;
        password_hash: string | null;
        password_version: number;
        failed_login_attempts: number;
        locked_until: string | null;
      }>();

    if (!user || !user.password_hash) {
      return apiErrorResponse("AUTH_FAILED", "Invalid email or password", 401);
    }

    // -----------------------------------------------------------------------
    // Account lockout check (TM-as6.4)
    //
    // If the account is currently locked, reject immediately with 403 and
    // a retryAfter hint so the client knows when to try again.
    // -----------------------------------------------------------------------
    const now = new Date();
    const retryAfter = getRetryAfterSeconds(user.locked_until, now);
    if (retryAfter > 0) {
      return apiErrorResponse(
        "ERR_ACCOUNT_LOCKED",
        "Account is temporarily locked due to too many failed login attempts",
        403,
        { retryAfter },
      );
    }

    // Verify password
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      // -----------------------------------------------------------------------
      // Failed login -- increment counter and potentially lock (TM-as6.4)
      //
      // We compute the new attempt count here (rather than using SQL +1)
      // because we need the value to determine the lockout duration.
      //
      // If the lockout had expired (retryAfter was 0 but locked_until was
      // set in the past), we still count from the existing total because
      // progressive lockout escalates: 5 -> 15min, 10 -> 1hr, 20 -> 24hr.
      // -----------------------------------------------------------------------
      const newAttempts = (user.failed_login_attempts || 0) + 1;
      const lockedUntil = computeLockedUntil(newAttempts, now);

      await env.DB
        .prepare(
          "UPDATE users SET failed_login_attempts = ?1, locked_until = ?2 WHERE user_id = ?3",
        )
        .bind(newAttempts, lockedUntil, user.user_id)
        .run();

      return apiErrorResponse("AUTH_FAILED", "Invalid email or password", 401);
    }

    // Successful login -- reset failed attempts and clear lockout
    await env.DB
      .prepare("UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE user_id = ?1")
      .bind(user.user_id)
      .run();

    // Generate JWT
    const jwt = await generateJWT(
      {
        sub: user.user_id,
        email: user.email,
        tier: "free" as SubscriptionTier,
        pwd_ver: user.password_version,
      },
      env.JWT_SECRET,
    );

    // Generate refresh token and store in KV
    const refreshToken = generateRefreshToken();
    const tokenHash = await sha256Hex(refreshToken);
    const sessionData = JSON.stringify({
      user_id: user.user_id,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + REFRESH_TOKEN_KV_TTL * 1000).toISOString(),
    });

    await env.SESSIONS.put(`refresh_${tokenHash}`, sessionData, {
      expirationTtl: REFRESH_TOKEN_KV_TTL,
    });

    return apiSuccessResponse({
      user: { id: user.user_id, email: user.email, tier: "free" },
      access_token: jwt,
      refresh_token: refreshToken,
    });
  });

  // =========================================================================
  // POST /refresh
  // =========================================================================
  auth.post("/refresh", async (c) => {
    const env = c.env;

    // Parse body
    let body: { refresh_token?: string };
    try {
      body = await c.req.json();
    } catch {
      return apiErrorResponse("VALIDATION_ERROR", "Request body must be valid JSON", 400);
    }

    const refreshToken = body.refresh_token;
    if (!refreshToken || typeof refreshToken !== "string") {
      return apiErrorResponse("VALIDATION_ERROR", "refresh_token is required", 400);
    }

    // Look up hashed token in KV
    const tokenHash = await sha256Hex(refreshToken);
    const sessionDataStr = await env.SESSIONS.get(`refresh_${tokenHash}`);

    if (!sessionDataStr) {
      return apiErrorResponse("AUTH_FAILED", "Invalid or expired refresh token", 401);
    }

    const sessionData = JSON.parse(sessionDataStr) as {
      user_id: string;
      created_at: string;
      expires_at: string;
    };

    // Look up user to get current state for JWT payload
    const user = await env.DB
      .prepare("SELECT user_id, email, password_version FROM users WHERE user_id = ?1")
      .bind(sessionData.user_id)
      .first<{
        user_id: string;
        email: string;
        password_version: number;
      }>();

    if (!user) {
      // User was deleted; clean up the old token
      await env.SESSIONS.delete(`refresh_${tokenHash}`);
      return apiErrorResponse("AUTH_FAILED", "User not found", 401);
    }

    // Generate new JWT
    const jwt = await generateJWT(
      {
        sub: user.user_id,
        email: user.email,
        tier: "free" as SubscriptionTier,
        pwd_ver: user.password_version,
      },
      env.JWT_SECRET,
    );

    // Rotate refresh token: delete old, create new
    await env.SESSIONS.delete(`refresh_${tokenHash}`);

    const newRefreshToken = generateRefreshToken();
    const newTokenHash = await sha256Hex(newRefreshToken);
    const newSessionData = JSON.stringify({
      user_id: user.user_id,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + REFRESH_TOKEN_KV_TTL * 1000).toISOString(),
    });

    await env.SESSIONS.put(`refresh_${newTokenHash}`, newSessionData, {
      expirationTtl: REFRESH_TOKEN_KV_TTL,
    });

    return apiSuccessResponse({
      access_token: jwt,
      refresh_token: newRefreshToken,
    });
  });

  // =========================================================================
  // POST /logout
  // =========================================================================
  auth.post("/logout", async (c) => {
    const env = c.env;

    // Parse body
    let body: { refresh_token?: string };
    try {
      body = await c.req.json();
    } catch {
      return apiErrorResponse("VALIDATION_ERROR", "Request body must be valid JSON", 400);
    }

    const refreshToken = body.refresh_token;
    if (!refreshToken || typeof refreshToken !== "string") {
      return apiErrorResponse("VALIDATION_ERROR", "refresh_token is required", 400);
    }

    // Delete the hashed token from KV (idempotent - no error if not found)
    const tokenHash = await sha256Hex(refreshToken);
    await env.SESSIONS.delete(`refresh_${tokenHash}`);

    return apiSuccessResponse({ logged_out: true });
  });

  return auth;
}

// Re-export helpers for testing
export {
  sha256Hex,
  isValidEmail,
  validatePassword,
  // Lockout helpers (TM-as6.4)
  getLockoutDurationSeconds,
  computeLockedUntil,
  getRetryAfterSeconds,
  LOCKOUT_THRESHOLDS,
};
