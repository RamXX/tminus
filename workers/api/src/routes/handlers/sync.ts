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

interface ErrorMirrorRow {
  canonical_event_id: string;
  target_account_id: string;
  target_calendar_id: string;
  provider_event_id: string | null;
  last_write_ts: string | null;
  error_message: string | null;
  title: string | null;
  start_ts: string | null;
  end_ts: string | null;
}

interface ErrorMirrorResponseItem extends ErrorMirrorRow {
  mirror_id: string;
  target_account_email: string;
  error_ts: string;
  event_summary: string;
}

const MIRROR_ID_DELIMITER = "|";

function encodeMirrorId(canonicalEventId: string, targetAccountId: string): string {
  return btoa(`${canonicalEventId}${MIRROR_ID_DELIMITER}${targetAccountId}`)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeMirrorId(mirrorId: string): {
  canonicalEventId: string;
  targetAccountId: string;
} | null {
  try {
    const padded = mirrorId
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(mirrorId.length / 4) * 4, "=");
    const decoded = atob(padded);
    const [canonicalEventId, targetAccountId, ...rest] = decoded.split(MIRROR_ID_DELIMITER);
    if (!canonicalEventId || !targetAccountId || rest.length > 0) {
      return null;
    }
    return { canonicalEventId, targetAccountId };
  } catch {
    return null;
  }
}

async function listUiErrorMirrors(
  auth: AuthContext,
  env: Env,
  limit: number,
): Promise<ErrorMirrorResponseItem[]> {
  const result = await callDO<{ items: ErrorMirrorRow[] }>(
    env.USER_GRAPH,
    auth.userId,
    "/listErrorMirrors",
    { limit },
  );

  if (!result.ok) {
    throw new Error("Failed to list error mirrors");
  }

  const rows = result.data.items ?? [];
  const accountIds = [...new Set(rows.map((row) => row.target_account_id))];
  const accountEmailById = new Map<string, string>();

  if (accountIds.length > 0) {
    const placeholders = accountIds.map((_, idx) => `?${idx + 2}`).join(", ");
    const query = await env.DB
      .prepare(
        `SELECT account_id, email
         FROM accounts
         WHERE user_id = ?1
           AND account_id IN (${placeholders})`,
      )
      .bind(auth.userId, ...accountIds)
      .all<{ account_id: string; email: string }>();

    for (const row of query.results ?? []) {
      accountEmailById.set(row.account_id, row.email);
    }
  }

  return rows.map((row) => ({
    ...row,
    mirror_id: encodeMirrorId(row.canonical_event_id, row.target_account_id),
    target_account_email:
      accountEmailById.get(row.target_account_id) ?? row.target_account_id,
    error_ts: row.last_write_ts ?? row.start_ts ?? new Date(0).toISOString(),
    event_summary: row.title ?? row.canonical_event_id,
  }));
}

export function computeChannelStatus(
  account: Pick<AccountStatusRow, "provider" | "status" | "channel_expiry_ts">,
): string {
  if (account.status === "revoked") return "revoked";
  if (account.status === "error") return "error";
  if (account.status !== "active") return "unknown";
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
           WHERE user_id = ?1
             AND status != 'revoked'`,
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
           WHERE user_id = ?1
             AND status != 'revoked'`,
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
  const changeType = (url.searchParams.get("change_type") ?? "").toLowerCase();
  const limit = limitStr ? parseInt(limitStr, 10) : null;

  if (eventId) query.canonical_event_id = eventId;
  if (cursor) query.cursor = cursor;
  if (limit !== null) {
    if (!isNaN(limit) && limit > 0) query.limit = limit;
  }

  try {
    // Compatibility path for the Error Recovery UI, which queries
    // /v1/sync/journal?change_type=error.
    if (changeType === "error") {
      const safeLimit = Number.isFinite(limit ?? NaN) && (limit ?? 0) > 0
        ? (limit as number)
        : 100;
      const items = await listUiErrorMirrors(auth, env, safeLimit);
      return jsonResponse(successEnvelope(items), 200);
    }

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

async function handleErrorMirrors(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 100;

  try {
    const items = await listUiErrorMirrors(
      auth,
      env,
      Number.isFinite(limit) ? limit : 100,
    );
    return jsonResponse(successEnvelope(items), 200);
  } catch (err) {
    console.error("Failed to list error mirrors", err);
    return jsonResponse(
      errorEnvelope("Failed to list error mirrors", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleRetryMirror(
  _request: Request,
  auth: AuthContext,
  env: Env,
  mirrorId: string,
): Promise<Response> {
  const decoded = decodeMirrorId(mirrorId);
  if (!decoded) {
    return jsonResponse(
      errorEnvelope("Invalid mirror ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (
    !isValidId(decoded.canonicalEventId, "event") ||
    !isValidId(decoded.targetAccountId, "account")
  ) {
    return jsonResponse(
      errorEnvelope("Invalid mirror ID format", "VALIDATION_ERROR"),
      ErrorCode.VALIDATION_ERROR,
    );
  }

  try {
    const result = await callDO<{
      retried: boolean;
      enqueued: number;
      reason?: string;
    }>(
      env.USER_GRAPH,
      auth.userId,
      "/retryErrorMirror",
      {
        canonical_event_id: decoded.canonicalEventId,
        target_account_id: decoded.targetAccountId,
      },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to retry mirror", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    if (!result.data.retried) {
      return jsonResponse(
        errorEnvelope(
          result.data.reason === "not_found"
            ? "Mirror not found"
            : "Mirror could not be retried",
          result.data.reason === "not_found" ? "NOT_FOUND" : "CONFLICT",
        ),
        result.data.reason === "not_found"
          ? ErrorCode.NOT_FOUND
          : ErrorCode.CONFLICT,
      );
    }

    return jsonResponse(
      successEnvelope({
        mirror_id: mirrorId,
        success: true,
        enqueued: result.data.enqueued,
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to retry mirror", err);
    return jsonResponse(
      errorEnvelope("Failed to retry mirror", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleDiagnostics(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const sampleLimitRaw = url.searchParams.get("sample_limit");
  const sampleLimit = sampleLimitRaw ? Number.parseInt(sampleLimitRaw, 10) : 25;

  try {
    const result = await callDO(
      env.USER_GRAPH,
      auth.userId,
      "/getMirrorDiagnostics",
      {
        sample_limit: Number.isFinite(sampleLimit) ? sampleLimit : 25,
      },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to get sync diagnostics", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to get sync diagnostics", err);
    return jsonResponse(
      errorEnvelope("Failed to get sync diagnostics", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleReplayPending(
  _request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    const result = await callDO<{ enqueued: number }>(
      env.USER_GRAPH,
      auth.userId,
      "/recomputeProjections",
      { force_requeue_pending: true },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to replay pending mirrors", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope({
      enqueued: result.data.enqueued ?? 0,
    }), 200);
  } catch (err) {
    console.error("Failed to replay pending mirrors", err);
    return jsonResponse(
      errorEnvelope("Failed to replay pending mirrors", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleRequeuePending(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 200;

  try {
    const result = await callDO<{
      canonical_events: number;
      enqueued: number;
      limit: number;
    }>(
      env.USER_GRAPH,
      auth.userId,
      "/requeuePendingMirrors",
      { limit: Number.isFinite(limit) ? limit : 200 },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to requeue pending mirrors", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to requeue pending mirrors", err);
    return jsonResponse(
      errorEnvelope("Failed to requeue pending mirrors", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleRequeueDeleting(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const limitRaw = url.searchParams.get("limit");
  const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : 1;
  const limit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(1, parsedLimit))
    : 1;

  try {
    const id = env.USER_GRAPH.idFromName(auth.userId);
    const stub = env.USER_GRAPH.get(id);
    const response = await stub.fetch(
      new Request("https://do.internal/requeueDeletingMirrors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit }),
      }),
    );

    if (response.status === 404 || response.status === 405) {
      // During rolling deploys, some hot DO instances may not yet expose
      // the replay route. Treat as a no-op and let periodic retries converge.
      return jsonResponse(
        successEnvelope({ mirrors: 0, enqueued: 0, limit }),
        200,
      );
    }

    if (!response.ok) {
      return jsonResponse(
        errorEnvelope("Failed to requeue deleting mirrors", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    const data = (await response.json()) as {
      mirrors: number;
      enqueued: number;
      limit: number;
    };
    return jsonResponse(successEnvelope(data), 200);
  } catch (err) {
    console.error("Failed to requeue deleting mirrors", err);
    return jsonResponse(
      errorEnvelope("Failed to requeue deleting mirrors", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleSettleHistorical(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const cutoffDaysRaw = url.searchParams.get("cutoff_days");
  let cutoffDays = cutoffDaysRaw ? Number.parseInt(cutoffDaysRaw, 10) : 30;

  if (!Number.isFinite(cutoffDays)) {
    cutoffDays = 30;
  }

  try {
    const result = await callDO<{ settled: number; cutoff_days: number }>(
      env.USER_GRAPH,
      auth.userId,
      "/settleHistoricalPending",
      { cutoff_days: cutoffDays },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to settle historical pending mirrors", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to settle historical pending mirrors", err);
    return jsonResponse(
      errorEnvelope("Failed to settle historical pending mirrors", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleSettleOutOfWindow(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const pastDaysRaw = url.searchParams.get("past_days");
  const futureDaysRaw = url.searchParams.get("future_days");
  let pastDays = pastDaysRaw ? Number.parseInt(pastDaysRaw, 10) : 30;
  let futureDays = futureDaysRaw ? Number.parseInt(futureDaysRaw, 10) : 365;

  if (!Number.isFinite(pastDays)) {
    pastDays = 30;
  }
  if (!Number.isFinite(futureDays)) {
    futureDays = 365;
  }

  try {
    const result = await callDO<{
      settled: number;
      settled_past: number;
      settled_far_future: number;
      past_days: number;
      future_days: number;
    }>(
      env.USER_GRAPH,
      auth.userId,
      "/settleOutOfWindowPending",
      {
        past_days: pastDays,
        future_days: futureDays,
      },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to settle out-of-window pending mirrors", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to settle out-of-window pending mirrors", err);
    return jsonResponse(
      errorEnvelope("Failed to settle out-of-window pending mirrors", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

async function handleSettleStuckPending(
  request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const minAgeRaw = url.searchParams.get("min_age_minutes");
  let minAgeMinutes = minAgeRaw ? Number.parseInt(minAgeRaw, 10) : 120;

  if (!Number.isFinite(minAgeMinutes)) {
    minAgeMinutes = 120;
  }

  try {
    const result = await callDO<{
      settled: number;
      min_age_minutes: number;
    }>(
      env.USER_GRAPH,
      auth.userId,
      "/settleStuckPending",
      { min_age_minutes: minAgeMinutes },
    );

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to settle stuck pending mirrors", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    return jsonResponse(successEnvelope(result.data), 200);
  } catch (err) {
    console.error("Failed to settle stuck pending mirrors", err);
    return jsonResponse(
      errorEnvelope("Failed to settle stuck pending mirrors", "INTERNAL_ERROR"),
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

  if (method === "GET" && pathname === "/v1/sync/errors") {
    return handleErrorMirrors(request, auth, env);
  }

  const retryMatch = matchRoute(pathname, "/v1/sync/retry/:id");
  if (retryMatch && method === "POST") {
    return handleRetryMirror(request, auth, env, retryMatch.params[0]);
  }

  if (method === "GET" && pathname === "/v1/sync/diagnostics") {
    return handleDiagnostics(request, auth, env);
  }

  if (method === "POST" && pathname === "/v1/sync/replay-pending") {
    return handleReplayPending(request, auth, env);
  }

  if (method === "POST" && pathname === "/v1/sync/requeue-pending") {
    return handleRequeuePending(request, auth, env);
  }

  if (method === "POST" && pathname === "/v1/sync/requeue-deleting") {
    return handleRequeueDeleting(request, auth, env);
  }

  if (method === "POST" && pathname === "/v1/sync/settle-historical") {
    return handleSettleHistorical(request, auth, env);
  }

  if (method === "POST" && pathname === "/v1/sync/settle-out-of-window") {
    return handleSettleOutOfWindow(request, auth, env);
  }

  if (method === "POST" && pathname === "/v1/sync/settle-stuck-pending") {
    return handleSettleStuckPending(request, auth, env);
  }

  return null;
};
