/**
 * MCP server authentication.
 *
 * Extracts and verifies JWT from the Authorization header using
 * the shared verifyJWT function. Returns a user context object
 * for tool execution, or null on any auth failure.
 */

import { verifyJWT } from "@tminus/shared";
import type { JWTPayload } from "@tminus/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Authenticated user context available to MCP tool handlers. */
export interface McpUserContext {
  /** User ID (usr_ ULID). */
  userId: string;
  /** User email address. */
  email: string;
  /** Subscription tier. */
  tier: string;
}

// ---------------------------------------------------------------------------
// Auth extraction
// ---------------------------------------------------------------------------

/**
 * Extract and verify JWT from the Authorization header.
 *
 * Expects: `Authorization: Bearer <jwt>`
 *
 * @param request - Incoming HTTP request.
 * @param jwtSecret - HMAC secret for JWT verification.
 * @returns User context on success, null on any failure.
 */
export async function extractMcpAuth(
  request: Request,
  jwtSecret: string,
): Promise<McpUserContext | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return null;

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return null;

  const token = parts[1];
  const payload: JWTPayload | null = await verifyJWT(token, jwtSecret);
  if (!payload) return null;

  return {
    userId: payload.sub,
    email: payload.email,
    tier: payload.tier,
  };
}
