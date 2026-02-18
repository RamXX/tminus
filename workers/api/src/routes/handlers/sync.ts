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

interface AccountHealthShape {
  lastSyncTs?: string | null;
  pendingWrites?: number;
}

interface AccountStatusRow {
  account_id: string;
  email: string;
  provider: string;
  status: string;
  channel_expiry_ts: string | null;
  error_count: number;
}

function computeChannelStatus(
  account: Pick<AccountStatusRow, "provider" | "status" | "channel_expiry_ts">,
): string {
  if (account.status !== "active") return "revoked";
  if (account.provider !== "google") return "active";
  if (!account.channel_expiry_ts) return "missing";

  const expiryMs = Date.parse(account.channel_expiry_ts);
  if (Number.isNaN(expiryMs)) return "unknown";
  return expiryMs <= Date.now() ? "expired" : "active";
}

async function handleAggregateStatus(
  _request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    // Get all accounts for this user.
    // Fallback query handles older schemas where `error_count` does not exist.
    let accounts: AccountStatusRow[] = [];
    try {
      const withErrorCount = await env.DB
        .prepare(
          `SELECT account_id, email, provider, status, channel_expiry_ts, error_count
           FROM accounts
           WHERE user_id = ?1`,
        )
        .bind(auth.userId)
        .all<AccountStatusRow>();
      accounts = withErrorCount.results ?? [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("no such column: error_count")) {
        throw err;
      }
      const withoutErrorCount = await env.DB
        .prepare(
          `SELECT account_id, email, provider, status, channel_expiry_ts
           FROM accounts
           WHERE user_id = ?1`,
        )
        .bind(auth.userId)
        .all<Omit<AccountStatusRow, "error_count">>();
      accounts = (withoutErrorCount.results ?? []).map((row) => ({
        ...row,
        error_count: 0,
      }));
    }

    const healthResults: Array<{
      account_id: string;
      email: string;
      provider: string;
      status: string;
      last_sync_ts: string | null;
      channel_status: string;
      pending_writes: number;
      error_count: number;
      health: unknown;
    }> = [];

    // Get health from each account's DO and enrich with legacy fields
    // expected by the Sync Status UI.
    for (const account of accounts) {
      try {
        const health = await callDO<AccountHealthShape>(
          env.ACCOUNT,
          account.account_id,
          "/getHealth",
        );

        const healthData = health.ok ? health.data : null;
        healthResults.push({
          account_id: account.account_id,
          email: account.email,
          provider: account.provider,
          status: account.status,
          last_sync_ts: healthData?.lastSyncTs ?? null,
          channel_status: computeChannelStatus(account),
          pending_writes: healthData?.pendingWrites ?? 0,
          error_count: account.error_count ?? 0,
          health: healthData,
        });
      } catch {
        healthResults.push({
          account_id: account.account_id,
          email: account.email,
          provider: account.provider,
          status: account.status,
          last_sync_ts: null,
          channel_status: computeChannelStatus(account),
          pending_writes: 0,
          error_count: account.error_count ?? 0,
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
