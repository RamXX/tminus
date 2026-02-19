/**
 * Route group: Account management.
 */

import { isValidId } from "@tminus/shared";
import { enforceAccountLimit } from "../../middleware/feature-gate";
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

const ACCOUNT_DO_STEP_TIMEOUT_MS = 10_000;
const USER_GRAPH_UNLINK_TIMEOUT_MS = 25_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, step: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${step} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function handleAccountLink(
  _request: Request,
  _auth: AuthContext,
  _env: Env,
): Promise<Response> {
  // Phase 1: redirect to oauth-worker URL
  // In production, this would construct the OAuth URL. For now, return the
  // redirect information in the envelope.
  const envelope = successEnvelope({
    redirect_url: "/oauth/google/authorize",
    message: "Redirect to OAuth flow to link a new account",
  });
  return jsonResponse(envelope, 200);
}

async function handleListAccounts(
  _request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    const result = await env.DB
      .prepare(
        `SELECT account_id, user_id, provider, email, status, created_at
         FROM accounts
         WHERE user_id = ?1
           AND status != 'revoked'`,
      )
      .bind(auth.userId)
      .all<{
        account_id: string;
        user_id: string;
        provider: string;
        email: string;
        status: string;
        created_at: string;
      }>();

    const accounts = result.results ?? [];
    return jsonResponse(successEnvelope(accounts), 200);
  } catch (err) {
    console.error("Failed to list accounts", err);
    return jsonResponse(
      errorEnvelope("Failed to list accounts", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleGetAccount(
  _request: Request,
  auth: AuthContext,
  env: Env,
  accountId: string,
): Promise<Response> {
  if (!isValidId(accountId, "account")) {
    return jsonResponse(
      errorEnvelope("Invalid account ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    // Get account from D1
    const row = await env.DB
      .prepare(
        "SELECT account_id, user_id, provider, email, status, created_at FROM accounts WHERE account_id = ?1 AND user_id = ?2",
      )
      .bind(accountId, auth.userId)
      .first<{
        account_id: string;
        user_id: string;
        provider: string;
        email: string;
        status: string;
        created_at: string;
      }>();

    if (!row) {
      return jsonResponse(
        errorEnvelope("Account not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    // Get health from AccountDO
    const health = await callDO<{
      lastSyncTs: string | null;
      lastSuccessTs: string | null;
      fullSyncNeeded: boolean;
    }>(env.ACCOUNT, accountId, "/getHealth");

    return jsonResponse(
      successEnvelope({
        ...row,
        health: health.ok ? health.data : null,
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to get account", err);
    return jsonResponse(
      errorEnvelope("Failed to get account details", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleDeleteAccount(
  _request: Request,
  auth: AuthContext,
  env: Env,
  accountId: string,
): Promise<Response> {
  if (!isValidId(accountId, "account")) {
    return jsonResponse(
      errorEnvelope("Invalid account ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    // Verify ownership in D1
    const row = await env.DB
      .prepare(
        "SELECT account_id FROM accounts WHERE account_id = ?1 AND user_id = ?2",
      )
      .bind(accountId, auth.userId)
      .first<{ account_id: string }>();

    if (!row) {
      return jsonResponse(
        errorEnvelope("Account not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    // Step 1: Mark revoked in D1 first so UI/API state converges immediately.
    // Cleanup below is best-effort and can finish after this state transition.
    await env.DB
      .prepare("UPDATE accounts SET status = 'revoked' WHERE account_id = ?1")
      .bind(accountId)
      .run();

    // Step 2: Revoke OAuth tokens (AccountDO)
    // Errors/timeouts are non-fatal -- tokens may already be revoked.
    try {
      await withTimeout(
        callDO(env.ACCOUNT, accountId, "/revokeTokens", {}),
        ACCOUNT_DO_STEP_TIMEOUT_MS,
        "AccountDO.revokeTokens",
      );
    } catch {
      // Proceed anyway -- provider state cleanup is best-effort.
    }

    // Step 3: Stop watch channels (AccountDO)
    try {
      await withTimeout(
        callDO(env.ACCOUNT, accountId, "/stopWatchChannels", {}),
        ACCOUNT_DO_STEP_TIMEOUT_MS,
        "AccountDO.stopWatchChannels",
      );
    } catch {
      // Proceed anyway -- channels may already be expired.
    }

    // Steps 4-9: Cascade cleanup in UserGraphDO
    // (mirrors, events, policies, calendars, journal)
    try {
      await withTimeout(
        callDO(env.USER_GRAPH, auth.userId, "/unlinkAccount", {
          account_id: accountId,
        }),
        USER_GRAPH_UNLINK_TIMEOUT_MS,
        "UserGraphDO.unlinkAccount",
      );
    } catch (err) {
      console.warn("Account unlink cleanup did not complete within timeout", {
        account_id: accountId,
        user_id: auth.userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return jsonResponse(successEnvelope({ deleted: true }), 200);
  } catch (err) {
    console.error("Failed to delete account", err);
    return jsonResponse(
      errorEnvelope("Failed to delete account", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// -- Account health & reconnect -------------------------------------------

/**
 * POST /v1/accounts/:id/reconnect
 *
 * Triggers provider-specific re-authentication flow.
 * Returns the OAuth start URL for the account's provider.
 */
async function handleReconnectAccount(
  _request: Request,
  auth: AuthContext,
  env: Env,
  accountId: string,
): Promise<Response> {
  if (!isValidId(accountId, "account")) {
    return jsonResponse(
      errorEnvelope("Invalid account ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    // Verify ownership in D1
    const row = await env.DB
      .prepare(
        "SELECT account_id, provider FROM accounts WHERE account_id = ?1 AND user_id = ?2",
      )
      .bind(accountId, auth.userId)
      .first<{ account_id: string; provider: string }>();

    if (!row) {
      return jsonResponse(
        errorEnvelope("Account not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    // Return the OAuth start URL for re-authentication
    const oauthUrl = `/oauth/${row.provider}/start`;
    return jsonResponse(
      successEnvelope({
        account_id: accountId,
        provider: row.provider,
        redirect_url: oauthUrl,
        message: `Re-authenticate with ${row.provider} to restore access`,
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to initiate account reconnect", err);
    return jsonResponse(
      errorEnvelope("Failed to initiate reconnect", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

/**
 * GET /v1/accounts/:id/sync-history
 *
 * Returns the last 10 sync events for an account from the journal.
 * Each event includes timestamp, event count, and success/error status.
 */
async function handleGetSyncHistory(
  _request: Request,
  auth: AuthContext,
  env: Env,
  accountId: string,
): Promise<Response> {
  if (!isValidId(accountId, "account")) {
    return jsonResponse(
      errorEnvelope("Invalid account ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    // Verify ownership in D1
    const row = await env.DB
      .prepare(
        "SELECT account_id FROM accounts WHERE account_id = ?1 AND user_id = ?2",
      )
      .bind(accountId, auth.userId)
      .first<{ account_id: string }>();

    if (!row) {
      return jsonResponse(
        errorEnvelope("Account not found", "NOT_FOUND"),
        ErrorCode.NOT_FOUND,
      );
    }

    // Get sync history from UserGraphDO journal
    const result = await callDO<{
      events: Array<{
        id: string;
        timestamp: string;
        event_count: number;
        status: string;
        error_message?: string;
      }>;
    }>(env.USER_GRAPH, auth.userId, "/getSyncHistory", {
      account_id: accountId,
      limit: 10,
    });

    if (!result.ok) {
      // If DO doesn't support this yet, return empty history
      return jsonResponse(
        successEnvelope({
          account_id: accountId,
          events: [],
        }),
        200,
      );
    }

    return jsonResponse(
      successEnvelope({
        account_id: accountId,
        events: result.data.events ?? [],
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to get sync history", err);
    return jsonResponse(
      errorEnvelope("Failed to get sync history", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}


export const routeAccountRoutes: RouteGroupHandler = async (request, method, pathname, auth, env) => {
  if (method === "POST" && pathname === "/v1/accounts/link") {
    // Enforce account limit before allowing new account linking
    const accountLimited = await enforceAccountLimit(auth.userId, env.DB);
    if (accountLimited) return accountLimited;
    return handleAccountLink(request, auth, env);
  }

  if (method === "GET" && pathname === "/v1/accounts") {
    return handleListAccounts(request, auth, env);
  }

  // Account sub-routes (reconnect, sync-history) must match before generic :id
  let match = matchRoute(pathname, "/v1/accounts/:id/reconnect");
  if (match && method === "POST") {
    return handleReconnectAccount(request, auth, env, match.params[0]);
  }

  match = matchRoute(pathname, "/v1/accounts/:id/sync-history");
  if (match && method === "GET") {
    return handleGetSyncHistory(request, auth, env, match.params[0]);
  }

  match = matchRoute(pathname, "/v1/accounts/:id");
  if (match) {
    if (method === "GET") {
      return handleGetAccount(request, auth, env, match.params[0]);
    }
    if (method === "DELETE") {
      return handleDeleteAccount(request, auth, env, match.params[0]);
    }
  }

  return null;
};
