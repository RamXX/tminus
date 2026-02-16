/**
 * Route group: API keys.
 */

import { generateId, isValidId } from "@tminus/shared";
import { generateApiKey, hashApiKey, isApiKeyFormat, extractPrefix } from "../../api-keys";
import {
  type RouteGroupHandler,
  type AuthContext,
  matchRoute,
  callDO,
  parseJsonBody,
  jsonResponse,
  successEnvelope,
  errorEnvelope,
  ErrorCode,
} from "../shared";

// ---------------------------------------------------------------------------
// API key handlers
// ---------------------------------------------------------------------------

async function handleCreateApiKey(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const body = await parseJsonBody<{ name?: string }>(request);
  if (!body || !body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
    return jsonResponse(
      errorEnvelope("API key must have a name", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const keyId = generateId("apikey");
    const { rawKey, prefix, keyHash } = await generateApiKey();

    await env.DB
      .prepare(
        `INSERT INTO api_keys (key_id, user_id, name, prefix, key_hash)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(keyId, auth.userId, body.name.trim(), prefix, keyHash)
      .run();

    // Return the full raw key ONLY at creation time
    return jsonResponse(
      successEnvelope({
        key_id: keyId,
        name: body.name.trim(),
        prefix,
        key: rawKey,
        created_at: new Date().toISOString(),
      }),
      201,
    );
  } catch (err) {
    console.error("Failed to create API key", err);
    return jsonResponse(
      errorEnvelope("Failed to create API key", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleListApiKeys(
  _request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    const result = await env.DB
      .prepare(
        `SELECT key_id, name, prefix, created_at, last_used_at, revoked_at
         FROM api_keys
         WHERE user_id = ?1
         ORDER BY created_at DESC`,
      )
      .bind(auth.userId)
      .all<{
        key_id: string;
        name: string;
        prefix: string;
        created_at: string;
        last_used_at: string | null;
        revoked_at: string | null;
      }>();

    const keys = result.results ?? [];
    return jsonResponse(successEnvelope(keys), 200);
  } catch (err) {
    console.error("Failed to list API keys", err);
    return jsonResponse(
      errorEnvelope("Failed to list API keys", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleRevokeApiKey(
  _request: Request,
  auth: AuthContext,
  env: Env,
  keyId: string,
): Promise<Response> {
  if (!isValidId(keyId, "apikey")) {
    return jsonResponse(
      errorEnvelope("Invalid API key ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    // Verify ownership and that key exists
    const row = await env.DB
      .prepare(
        "SELECT key_id, revoked_at FROM api_keys WHERE key_id = ?1 AND user_id = ?2",
      )
      .bind(keyId, auth.userId)
      .first<{ key_id: string; revoked_at: string | null }>();

    if (!row) {
      return jsonResponse(
        errorEnvelope("API key not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    if (row.revoked_at) {
      return jsonResponse(
        errorEnvelope("API key already revoked", "CONFLICT"),
        ErrorCode.CONFLICT,
      );
    }

    await env.DB
      .prepare("UPDATE api_keys SET revoked_at = ?1 WHERE key_id = ?2")
      .bind(new Date().toISOString(), keyId)
      .run();

    return jsonResponse(successEnvelope({ revoked: true }), 200);
  } catch (err) {
    console.error("Failed to revoke API key", err);
    return jsonResponse(
      errorEnvelope("Failed to revoke API key", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ---------------------------------------------------------------------------
// Route group: API keys
// ---------------------------------------------------------------------------

export const routeApiKeyRoutes: RouteGroupHandler = async (request, method, pathname, auth, env) => {
  if (method === "POST" && pathname === "/v1/api-keys") {
    return handleCreateApiKey(request, auth, env);
  }

  if (method === "GET" && pathname === "/v1/api-keys") {
    return handleListApiKeys(request, auth, env);
  }

  const match = matchRoute(pathname, "/v1/api-keys/:id");
  if (match && method === "DELETE") {
    return handleRevokeApiKey(request, auth, env, match.params[0]);
  }

  return null;
};

