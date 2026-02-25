/**
 * Route group: User Settings (per-user KV preferences).
 *
 * GET  /v1/settings/:key -- read a setting (returns null if unset)
 * PUT  /v1/settings/:key -- write a setting (body: { value: string })
 */

import {
  type RouteGroupHandler,
  type AuthContext,
  matchRoute,
  callDO,
  jsonResponse,
  successEnvelope,
  errorEnvelope,
  ErrorCode,
} from "../shared";

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleGetSetting(
  _request: Request,
  auth: AuthContext,
  env: Env,
  key: string,
): Promise<Response> {
  const result = await callDO<{ key: string; value: string | null }>(
    env.USER_GRAPH,
    auth.userId,
    "/getUserSetting",
    { key },
  );
  if (!result.ok) {
    return jsonResponse(
      errorEnvelope("Failed to read setting", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
  return jsonResponse(successEnvelope(result.data), 200);
}

async function handleSetSetting(
  request: Request,
  auth: AuthContext,
  env: Env,
  key: string,
): Promise<Response> {
  const body = await request.json() as { value: string };
  if (typeof body?.value !== "string") {
    return jsonResponse(
      errorEnvelope("Missing or invalid 'value' field", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const result = await callDO<{ key: string; value: string }>(
    env.USER_GRAPH,
    auth.userId,
    "/setUserSetting",
    { key, value: body.value },
  );
  if (!result.ok) {
    return jsonResponse(
      errorEnvelope("Failed to write setting", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
  return jsonResponse(successEnvelope(result.data), 200);
}

// ---------------------------------------------------------------------------
// Route group
// ---------------------------------------------------------------------------

export const routeSettingsRoutes: RouteGroupHandler = async (request, method, pathname, auth, env) => {
  const match = matchRoute(pathname, "/v1/settings/:key");
  if (!match) return null;

  const key = match.params[0];
  if (method === "GET") return handleGetSetting(request, auth, env, key);
  if (method === "PUT") return handleSetSetting(request, auth, env, key);

  return null;
};
