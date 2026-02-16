/**
 * Route group: Sync status and journal.
 */

import { isValidId } from "@tminus/shared";
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

async function handleAggregateStatus(
  _request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    // Get all accounts for this user
    const accountsResult = await env.DB
      .prepare("SELECT account_id, status FROM accounts WHERE user_id = ?1")
      .bind(auth.userId)
      .all<{ account_id: string; status: string }>();

    const accounts = accountsResult.results ?? [];
    const healthResults: Array<{
      account_id: string;
      status: string;
      health: unknown;
    }> = [];

    // Get health from each account's DO
    for (const account of accounts) {
      try {
        const health = await callDO(
          env.ACCOUNT,
          account.account_id,
          "/getHealth",
        );
        healthResults.push({
          account_id: account.account_id,
          status: account.status,
          health: health.ok ? health.data : null,
        });
      } catch {
        healthResults.push({
          account_id: account.account_id,
          status: account.status,
          health: null,
        });
      }
    }

    // Get UserGraphDO sync health
    const userGraphHealth = await callDO(
      env.USER_GRAPH,
      auth.userId,
      "/getSyncHealth",
    );

    return jsonResponse(
      successEnvelope({
        accounts: healthResults,
        user_graph: userGraphHealth.ok ? userGraphHealth.data : null,
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to get aggregate status", err);
    return jsonResponse(
      errorEnvelope("Failed to get sync status", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleAccountStatus(
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
    // Verify ownership
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

    const health = await callDO(env.ACCOUNT, accountId, "/getHealth");

    return jsonResponse(
      successEnvelope(health.ok ? health.data : null),
      200,
    );
  } catch (err) {
    console.error("Failed to get account status", err);
    return jsonResponse(
      errorEnvelope("Failed to get account status", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleJournal(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const query: Record<string, unknown> = {};

  const eventId = url.searchParams.get("event_id");
  const cursor = url.searchParams.get("cursor");
  const limitStr = url.searchParams.get("limit");

  if (eventId) query.canonical_event_id = eventId;
  if (cursor) query.cursor = cursor;
  if (limitStr) {
    const limit = parseInt(limitStr, 10);
    if (!isNaN(limit) && limit > 0) query.limit = limit;
  }

  try {
    const result = await callDO<{
      items: unknown[];
      cursor: string | null;
      has_more: boolean;
    }>(env.USER_GRAPH, auth.userId, "/queryJournal", query);

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to query journal", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(
      successEnvelope(result.data.items, {
        next_cursor: result.data.cursor ?? undefined,
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to query journal", err);
    return jsonResponse(
      errorEnvelope("Failed to query journal", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}


export const routeSyncRoutes: RouteGroupHandler = async (request, method, pathname, auth, env) => {
  if (method === "GET" && pathname === "/v1/sync/status") {
    return handleAggregateStatus(request, auth, env);
  }

  const match = matchRoute(pathname, "/v1/sync/status/:id");
  if (match && method === "GET") {
    return handleAccountStatus(request, auth, env, match.params[0]);
  }

  if (method === "GET" && pathname === "/v1/sync/journal") {
    return handleJournal(request, auth, env);
  }

  return null;
};

