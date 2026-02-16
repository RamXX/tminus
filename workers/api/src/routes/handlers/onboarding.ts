/**
 * Route group: Onboarding sessions.
 */

import { generateId } from "@tminus/shared";
import {
  type RouteGroupHandler,
  type AuthContext,
  callDO,
  parseJsonBody,
  jsonResponse,
  successEnvelope,
  errorEnvelope,
  ErrorCode,
} from "../shared";

async function handleCreateOnboardingSession(
  _request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    const sessionId = generateId("onboardSession");
    // Generate a random session token for httpOnly cookie
    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const sessionToken = Array.from(tokenBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const result = await callDO<{
      session_id: string;
      user_id: string;
      step: string;
      accounts_json: string;
      session_token: string;
      created_at: string;
      updated_at: string;
      completed_at: string | null;
    }>(
      env.USER_GRAPH,
      auth.userId,
      "/createOnboardingSession",
      {
        session_id: sessionId,
        user_id: auth.userId,
        session_token: sessionToken,
      },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to create onboarding session", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    const session = {
      session_id: result.data.session_id,
      user_id: result.data.user_id,
      step: result.data.step,
      accounts: JSON.parse(result.data.accounts_json),
      session_token: result.data.session_token,
      created_at: result.data.created_at,
      updated_at: result.data.updated_at,
      ...(result.data.completed_at ? { completed_at: result.data.completed_at } : {}),
    };

    return jsonResponse(successEnvelope(session), 201);
  } catch (err) {
    console.error("Failed to create onboarding session", err);
    return jsonResponse(
      errorEnvelope("Failed to create onboarding session", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleGetOnboardingSession(
  _request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    const result = await callDO<{
      session_id: string;
      user_id: string;
      step: string;
      accounts_json: string;
      session_token: string;
      created_at: string;
      updated_at: string;
      completed_at: string | null;
    } | null>(
      env.USER_GRAPH,
      auth.userId,
      "/getOnboardingSession",
      { user_id: auth.userId },
    );

    if (!result.ok || !result.data) {
      return jsonResponse(successEnvelope(null), 200);
    }

    const session = {
      session_id: result.data.session_id,
      user_id: result.data.user_id,
      step: result.data.step,
      accounts: JSON.parse(result.data.accounts_json),
      session_token: result.data.session_token,
      created_at: result.data.created_at,
      updated_at: result.data.updated_at,
      ...(result.data.completed_at ? { completed_at: result.data.completed_at } : {}),
    };

    return jsonResponse(successEnvelope(session), 200);
  } catch (err) {
    console.error("Failed to get onboarding session", err);
    return jsonResponse(
      errorEnvelope("Failed to get onboarding session", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

/**
 * GET /v1/onboarding/status -- lightweight status endpoint for cross-tab polling.
 * AC 5: Cross-tab polling reflects account additions from any tab within 5 seconds.
 */
async function handleGetOnboardingStatus(
  _request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    const result = await callDO<{
      session_id: string;
      user_id: string;
      step: string;
      accounts_json: string;
      session_token: string;
      created_at: string;
      updated_at: string;
      completed_at: string | null;
    } | null>(
      env.USER_GRAPH,
      auth.userId,
      "/getOnboardingSession",
      { user_id: auth.userId },
    );

    if (!result.ok || !result.data) {
      return jsonResponse(successEnvelope({ active: false }), 200);
    }

    // Return a lightweight status for polling
    const accounts = JSON.parse(result.data.accounts_json);
    return jsonResponse(
      successEnvelope({
        active: true,
        session_id: result.data.session_id,
        step: result.data.step,
        account_count: accounts.length,
        accounts,
        updated_at: result.data.updated_at,
        ...(result.data.completed_at ? { completed_at: result.data.completed_at } : {}),
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to get onboarding status", err);
    return jsonResponse(
      errorEnvelope("Failed to get onboarding status", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleAddOnboardingAccount(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    const body = await parseJsonBody<{
      account_id: string;
      provider: string;
      email: string;
      status?: string;
      calendar_count?: number;
    }>(request);

    if (!body || !body.account_id || !body.provider || !body.email) {
      return jsonResponse(
        errorEnvelope("Missing required fields: account_id, provider, email", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const result = await callDO<{
      session_id: string;
      user_id: string;
      step: string;
      accounts_json: string;
      session_token: string;
      created_at: string;
      updated_at: string;
      completed_at: string | null;
    } | null>(
      env.USER_GRAPH,
      auth.userId,
      "/addOnboardingAccount",
      {
        user_id: auth.userId,
        account: {
          account_id: body.account_id,
          provider: body.provider,
          email: body.email,
          status: body.status ?? "connected",
          ...(body.calendar_count !== undefined ? { calendar_count: body.calendar_count } : {}),
          connected_at: new Date().toISOString(),
        },
      },
    );

    if (!result.ok || !result.data) {
      return jsonResponse(
        errorEnvelope("No active onboarding session found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    const session = {
      session_id: result.data.session_id,
      user_id: result.data.user_id,
      step: result.data.step,
      accounts: JSON.parse(result.data.accounts_json),
      created_at: result.data.created_at,
      updated_at: result.data.updated_at,
      ...(result.data.completed_at ? { completed_at: result.data.completed_at } : {}),
    };

    return jsonResponse(successEnvelope(session), 200);
  } catch (err) {
    console.error("Failed to add onboarding account", err);
    return jsonResponse(
      errorEnvelope("Failed to add onboarding account", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleUpdateOnboardingAccountStatus(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    const body = await parseJsonBody<{
      account_id: string;
      status: string;
      calendar_count?: number;
    }>(request);

    if (!body || !body.account_id || !body.status) {
      return jsonResponse(
        errorEnvelope("Missing required fields: account_id, status", "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const result = await callDO<{
      session_id: string;
      step: string;
      accounts_json: string;
      updated_at: string;
      completed_at: string | null;
    } | null>(
      env.USER_GRAPH,
      auth.userId,
      "/updateOnboardingAccountStatus",
      {
        user_id: auth.userId,
        account_id: body.account_id,
        status: body.status,
        ...(body.calendar_count !== undefined ? { calendar_count: body.calendar_count } : {}),
      },
    );

    if (!result.ok || !result.data) {
      return jsonResponse(
        errorEnvelope("No active onboarding session found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    return jsonResponse(successEnvelope({ ok: true }), 200);
  } catch (err) {
    console.error("Failed to update onboarding account status", err);
    return jsonResponse(
      errorEnvelope("Failed to update onboarding account status", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleCompleteOnboardingSession(
  _request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    const result = await callDO<{
      session_id: string;
      step: string;
      accounts_json: string;
      updated_at: string;
      completed_at: string | null;
    } | null>(
      env.USER_GRAPH,
      auth.userId,
      "/completeOnboardingSession",
      { user_id: auth.userId },
    );

    if (!result.ok || !result.data) {
      return jsonResponse(
        errorEnvelope("No active onboarding session found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    const session = {
      session_id: result.data.session_id,
      step: result.data.step,
      accounts: JSON.parse(result.data.accounts_json),
      updated_at: result.data.updated_at,
      ...(result.data.completed_at ? { completed_at: result.data.completed_at } : {}),
    };

    return jsonResponse(successEnvelope(session), 200);
  } catch (err) {
    console.error("Failed to complete onboarding session", err);
    return jsonResponse(
      errorEnvelope("Failed to complete onboarding session", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}


export const routeOnboardingRoutes: RouteGroupHandler = async (request, method, pathname, auth, env) => {
  if (method === "POST" && pathname === "/v1/onboarding/session") {
    return handleCreateOnboardingSession(request, auth, env);
  }

  if (method === "GET" && pathname === "/v1/onboarding/session") {
    return handleGetOnboardingSession(request, auth, env);
  }

  if (method === "GET" && pathname === "/v1/onboarding/status") {
    return handleGetOnboardingStatus(request, auth, env);
  }

  if (method === "POST" && pathname === "/v1/onboarding/session/account") {
    return handleAddOnboardingAccount(request, auth, env);
  }

  if (method === "PATCH" && pathname === "/v1/onboarding/session/account") {
    return handleUpdateOnboardingAccountStatus(request, auth, env);
  }

  if (method === "POST" && pathname === "/v1/onboarding/session/complete") {
    return handleCompleteOnboardingSession(request, auth, env);
  }

  return null;
};

