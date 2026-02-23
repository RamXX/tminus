/**
 * Route group: Account management.
 *
 * Includes calendar scope management endpoints (TM-8gfd.2) for listing
 * and updating which calendars are in-scope for synchronization per account.
 */

import { isValidId } from "@tminus/shared";
import { enforceAccountLimit, ACCOUNT_LIMITS } from "../../middleware/feature-gate";
import type { FeatureTier } from "../../middleware/feature-gate";
import { getUserTier } from "../billing";
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

const ACCOUNT_DO_STEP_TIMEOUT_MS = 3_000;
const USER_GRAPH_UNLINK_TIMEOUT_MS = 120_000;

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

    // Step 2+: Best-effort cleanup (parallel, bounded latency).
    // Each sub-step is independently timeboxed and non-fatal.
    const cleanupTasks = [
      withTimeout(
        callDO(env.ACCOUNT, accountId, "/revokeTokens", {}),
        ACCOUNT_DO_STEP_TIMEOUT_MS,
        "AccountDO.revokeTokens",
      ).catch(() => undefined),
      withTimeout(
        callDO(env.ACCOUNT, accountId, "/stopWatchChannels", {}),
        ACCOUNT_DO_STEP_TIMEOUT_MS,
        "AccountDO.stopWatchChannels",
      ).catch(() => undefined),
      withTimeout(
        callDO(env.USER_GRAPH, auth.userId, "/unlinkAccount", {
          account_id: accountId,
        }),
        USER_GRAPH_UNLINK_TIMEOUT_MS,
        "UserGraphDO.unlinkAccount",
      ).catch((err) => {
        console.warn("Account unlink cleanup did not complete within timeout", {
          account_id: accountId,
          user_id: auth.userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    ];

    await Promise.all(cleanupTasks);

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


// ---------------------------------------------------------------------------
// Aggregated health endpoint for Provider Health dashboard (TM-qyjm)
// ---------------------------------------------------------------------------

/** Shape returned by AccountDO /getHealth. */
interface AccountDOHealth {
  lastSyncTs: string | null;
  lastSuccessTs: string | null;
  fullSyncNeeded: boolean;
}

/**
 * GET /v1/accounts/health
 *
 * Returns enriched account health data for the Provider Health dashboard.
 * Joins accounts with calendar scopes (from AccountDO), sync health (from
 * AccountDO /getHealth), sync history (from UserGraphDO /getSyncHistory),
 * and subscription tier (from D1 subscriptions table).
 *
 * The response shape matches AccountsHealthResponse expected by the frontend.
 */
async function handleGetAccountsHealth(
  _request: Request,
  auth: AuthContext,
  env: Env,
): Promise<Response> {
  try {
    // 1. Get all non-revoked accounts for this user
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

    // 2. Get subscription tier and derive tier_limit
    const tier = await getUserTier(env.DB, auth.userId);
    const tierLimit = ACCOUNT_LIMITS[tier as FeatureTier] ?? ACCOUNT_LIMITS.free;

    // 3. Enrich each account with health data from DOs
    const enrichedAccounts = await Promise.all(
      accounts.map(async (account) => {
        // Get health from AccountDO
        let lastSuccessfulSync: string | null = null;
        let isSyncing = false;
        let errorMessage: string | null = null;
        let tokenExpiresAt: string | null = null;
        let hasTokens: boolean | null = null;

        try {
          const health = await callDO<AccountDOHealth>(
            env.ACCOUNT,
            account.account_id,
            "/getHealth",
          );
          if (health.ok && health.data) {
            lastSuccessfulSync = health.data.lastSuccessTs ?? null;
          }
        } catch {
          // AccountDO health call failed -- continue with defaults
        }

        // Get sync history from UserGraphDO for error/syncing status
        try {
          const syncResult = await callDO<{
            events: Array<{
              id: string;
              timestamp: string;
              event_count: number;
              status: string;
              error_message?: string;
            }>;
          }>(env.USER_GRAPH, auth.userId, "/getSyncHistory", {
            account_id: account.account_id,
            limit: 1,
          });

          if (syncResult.ok && syncResult.data.events?.length > 0) {
            const lastEvent = syncResult.data.events[0];
            if (lastEvent.status === "error" && lastEvent.error_message) {
              errorMessage = lastEvent.error_message;
            }
            // Consider "in_progress" status or very recent sync as syncing
            if (lastEvent.status === "in_progress") {
              isSyncing = true;
            }
          }
        } catch {
          // Sync history unavailable -- continue with defaults
        }

        // Get calendar scopes from AccountDO
        let calendarCount = 0;
        let calendarNames: string[] = [];

        try {
          const scopeResult = await callDO<{ scopes: DOScopeEntry[] }>(
            env.ACCOUNT,
            account.account_id,
            "/listCalendarScopes",
          );
          if (scopeResult.ok && scopeResult.data.scopes) {
            const enabledScopes = scopeResult.data.scopes.filter((s) => s.enabled);
            calendarCount = enabledScopes.length;
            calendarNames = enabledScopes
              .map((s) => s.displayName ?? s.providerCalendarId)
              .filter(Boolean);
          }
        } catch {
          // Scopes unavailable -- continue with 0/empty
        }

        // Get token expiry from AccountDO
        try {
          const tokenResult = await callDO<{
            expiresAt: string | null;
            hasTokens?: boolean;
          }>(env.ACCOUNT, account.account_id, "/getTokenInfo");
          if (tokenResult.ok && tokenResult.data) {
            tokenExpiresAt = tokenResult.data.expiresAt ?? null;
            if (typeof tokenResult.data.hasTokens === "boolean") {
              hasTokens = tokenResult.data.hasTokens;
            }
          }
        } catch {
          // Token info unavailable -- continue with null
        }

        if (account.status === "active" && hasTokens === false) {
          errorMessage = errorMessage ?? "No OAuth tokens found. Reconnect required.";
        }

        return {
          account_id: account.account_id,
          email: account.email,
          provider: account.provider,
          status: account.status,
          calendar_count: calendarCount,
          calendar_names: calendarNames,
          last_successful_sync: lastSuccessfulSync,
          is_syncing: isSyncing,
          error_message: errorMessage,
          token_expires_at: tokenExpiresAt,
          created_at: account.created_at,
        };
      }),
    );

    return jsonResponse(
      successEnvelope({
        accounts: enrichedAccounts,
        account_count: enrichedAccounts.length,
        tier_limit: tierLimit,
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to get accounts health", err);
    return jsonResponse(
      errorEnvelope("Failed to get accounts health", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ---------------------------------------------------------------------------
// Calendar scope management (TM-8gfd.2)
// ---------------------------------------------------------------------------

/**
 * Calendar capability derived from the calendar_role field.
 *
 * Mapping:
 *   owner    -> read, write (full control including sharing)
 *   editor   -> read, write (can modify events)
 *   readonly -> read only (cannot create or modify events)
 *   primary  -> treated as owner (backward compat for legacy single-calendar)
 *   secondary -> treated as editor
 *   freeBusyReader -> read only (free/busy visibility)
 */
export type CalendarCapability = "read" | "write";

export type CalendarAccessLevel =
  | "owner"
  | "editor"
  | "readonly"
  | "freeBusyReader";

/**
 * Derive capabilities and access level from the raw calendar_role string
 * stored in AccountDO.
 */
export function deriveCapabilities(calendarRole: string): {
  access_level: CalendarAccessLevel;
  capabilities: CalendarCapability[];
} {
  switch (calendarRole) {
    case "owner":
    case "primary":
      return { access_level: "owner", capabilities: ["read", "write"] };
    case "editor":
    case "secondary":
    case "writer":
      return { access_level: "editor", capabilities: ["read", "write"] };
    case "freeBusyReader":
      return { access_level: "freeBusyReader", capabilities: ["read"] };
    case "reader":
    case "readonly":
    default:
      return { access_level: "readonly", capabilities: ["read"] };
  }
}

/**
 * Validate that a scope update request is well-formed.
 *
 * Rules:
 * - scopes array must be non-empty
 * - each scope must have a provider_calendar_id string
 * - enabled must be a boolean if present
 * - sync_enabled must be a boolean if present
 */
export interface ScopeUpdateItem {
  provider_calendar_id: string;
  enabled?: boolean;
  sync_enabled?: boolean;
}

export function validateScopeUpdate(
  body: unknown,
): { valid: true; scopes: ScopeUpdateItem[] } | { valid: false; error: string } {
  if (!body || typeof body !== "object") {
    return { valid: false, error: "Request body must be a JSON object" };
  }

  const payload = body as { scopes?: unknown };

  if (!Array.isArray(payload.scopes)) {
    return { valid: false, error: "scopes must be an array" };
  }

  if (payload.scopes.length === 0) {
    return { valid: false, error: "scopes array must not be empty" };
  }

  const validated: ScopeUpdateItem[] = [];

  for (let i = 0; i < payload.scopes.length; i++) {
    const item = payload.scopes[i];
    if (!item || typeof item !== "object") {
      return { valid: false, error: `scopes[${i}] must be an object` };
    }

    const s = item as Record<string, unknown>;

    if (typeof s.provider_calendar_id !== "string" || s.provider_calendar_id.length === 0) {
      return {
        valid: false,
        error: `scopes[${i}].provider_calendar_id must be a non-empty string`,
      };
    }

    if (s.enabled !== undefined && typeof s.enabled !== "boolean") {
      return { valid: false, error: `scopes[${i}].enabled must be a boolean` };
    }

    if (s.sync_enabled !== undefined && typeof s.sync_enabled !== "boolean") {
      return { valid: false, error: `scopes[${i}].sync_enabled must be a boolean` };
    }

    validated.push({
      provider_calendar_id: s.provider_calendar_id,
      enabled: typeof s.enabled === "boolean" ? s.enabled : undefined,
      sync_enabled: typeof s.sync_enabled === "boolean" ? s.sync_enabled : undefined,
    });
  }

  return { valid: true, scopes: validated };
}

/**
 * Check if a scope update would disable sync for a calendar that does not
 * have write capability. This prevents the user from enabling sync on a
 * read-only calendar (sync requires write to push mirror events).
 */
export function validateScopeCapabilities(
  updates: ScopeUpdateItem[],
  existingScopes: Array<{ provider_calendar_id: string; calendar_role: string }>,
): { valid: true } | { valid: false; error: string } {
  for (const update of updates) {
    // Only check sync_enabled=true requests: enabling sync requires write capability
    if (update.sync_enabled !== true) continue;

    const existing = existingScopes.find(
      (s) => s.provider_calendar_id === update.provider_calendar_id,
    );

    if (!existing) {
      // New calendar not yet known to the account -- allow, AccountDO will create it
      continue;
    }

    const { capabilities } = deriveCapabilities(existing.calendar_role);
    if (!capabilities.includes("write")) {
      return {
        valid: false,
        error: `Calendar "${update.provider_calendar_id}" has ${existing.calendar_role} access and cannot be sync-enabled (requires write capability)`,
      };
    }
  }

  return { valid: true };
}

/** Shape returned by AccountDO /listCalendarScopes. */
interface DOScopeEntry {
  scopeId: string;
  providerCalendarId: string;
  displayName: string | null;
  calendarRole: string;
  enabled: boolean;
  syncEnabled: boolean;
}

/**
 * Determine whether a scope is "recommended" for the UI.
 *
 * Recommended: primary or owner calendars with write capability.
 * Advanced: read-only, freeBusyReader, or secondary calendars.
 */
function isRecommended(calendarRole: string): boolean {
  return calendarRole === "owner" || calendarRole === "primary";
}

/**
 * GET /v1/accounts/:id/scopes
 *
 * Returns the list of calendar scopes for the account with capability metadata.
 */
async function handleListScopes(
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

    // Get scopes from AccountDO
    const result = await callDO<{ scopes: DOScopeEntry[] }>(
      env.ACCOUNT,
      accountId,
      "/listCalendarScopes",
    );

    if (!result.ok) {
      return jsonResponse(
        successEnvelope({
          account_id: accountId,
          provider: row.provider,
          scopes: [],
        }),
        200,
      );
    }

    const scopes = (result.data.scopes ?? []).map((s) => {
      const { access_level, capabilities } = deriveCapabilities(s.calendarRole);
      return {
        scope_id: s.scopeId,
        provider_calendar_id: s.providerCalendarId,
        display_name: s.displayName,
        calendar_role: s.calendarRole,
        access_level,
        capabilities,
        enabled: s.enabled,
        sync_enabled: s.syncEnabled,
        recommended: isRecommended(s.calendarRole),
      };
    });

    return jsonResponse(
      successEnvelope({
        account_id: accountId,
        provider: row.provider,
        scopes,
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to list calendar scopes", err);
    return jsonResponse(
      errorEnvelope("Failed to list calendar scopes", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

/**
 * PUT /v1/accounts/:id/scopes
 *
 * Update scoped calendars for an account. Validates capabilities and
 * emits an audit event on scope change.
 *
 * Body: { scopes: [{ provider_calendar_id, enabled?, sync_enabled? }] }
 */
async function handleUpdateScopes(
  request: Request,
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

    // Parse and validate request body
    const body = await parseJsonBody<unknown>(request);
    const validation = validateScopeUpdate(body);
    if (!validation.valid) {
      return jsonResponse(
        errorEnvelope(validation.error, "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }

    // Fetch existing scopes for capability validation
    const existingResult = await callDO<{ scopes: DOScopeEntry[] }>(
      env.ACCOUNT,
      accountId,
      "/listCalendarScopes",
    );

    const existingScopes = (existingResult.ok && existingResult.data.scopes)
      ? existingResult.data.scopes.map((s) => ({
          provider_calendar_id: s.providerCalendarId,
          calendar_role: s.calendarRole,
        }))
      : [];

    // Validate capabilities
    const capValidation = validateScopeCapabilities(validation.scopes, existingScopes);
    if (!capValidation.valid) {
      return jsonResponse(
        errorEnvelope(capValidation.error, "VALIDATION_ERROR"),
        ErrorCode.VALIDATION_ERROR,
      );
    }

    // Apply each scope update via AccountDO
    for (const scope of validation.scopes) {
      await callDO(env.ACCOUNT, accountId, "/upsertCalendarScope", {
        provider_calendar_id: scope.provider_calendar_id,
        enabled: scope.enabled,
        sync_enabled: scope.sync_enabled,
      });
    }

    // Emit audit event (best-effort, non-blocking)
    emitScopeChangeAudit(auth.userId, accountId, validation.scopes, env).catch(
      (err) => console.warn("Scope change audit emission failed", err),
    );

    // Fetch updated scopes
    const updatedResult = await callDO<{ scopes: DOScopeEntry[] }>(
      env.ACCOUNT,
      accountId,
      "/listCalendarScopes",
    );

    const scopes = (updatedResult.ok && updatedResult.data.scopes)
      ? updatedResult.data.scopes.map((s) => {
          const { access_level, capabilities } = deriveCapabilities(s.calendarRole);
          return {
            scope_id: s.scopeId,
            provider_calendar_id: s.providerCalendarId,
            display_name: s.displayName,
            calendar_role: s.calendarRole,
            access_level,
            capabilities,
            enabled: s.enabled,
            sync_enabled: s.syncEnabled,
            recommended: isRecommended(s.calendarRole),
          };
        })
      : [];

    return jsonResponse(
      successEnvelope({
        account_id: accountId,
        provider: row.provider,
        scopes,
      }),
      200,
    );
  } catch (err) {
    console.error("Failed to update calendar scopes", err);
    return jsonResponse(
      errorEnvelope("Failed to update calendar scopes", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

/**
 * Emit an audit event recording a scope change.
 *
 * Writes a row to the scope_change_audit table in D1 so changes are
 * traceable (who changed what, when).
 */
async function emitScopeChangeAudit(
  userId: string,
  accountId: string,
  changes: ScopeUpdateItem[],
  env: Env,
): Promise<void> {
  try {
    // Best-effort: if the table doesn't exist, create it lazily
    await env.DB
      .prepare(
        `CREATE TABLE IF NOT EXISTS scope_change_audit (
           audit_id    TEXT PRIMARY KEY,
           user_id     TEXT NOT NULL,
           account_id  TEXT NOT NULL,
           changes     TEXT NOT NULL,
           created_at  TEXT NOT NULL DEFAULT (datetime('now'))
         )`,
      )
      .run();

    const auditId = `sca_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await env.DB
      .prepare(
        `INSERT INTO scope_change_audit (audit_id, user_id, account_id, changes, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(
        auditId,
        userId,
        accountId,
        JSON.stringify(changes),
        new Date().toISOString(),
      )
      .run();
  } catch (err) {
    // Audit is best-effort -- log but do not propagate
    console.warn("scope_change_audit write failed", err);
  }
}


export const routeAccountRoutes: RouteGroupHandler = async (request, method, pathname, auth, env) => {
  if (method === "POST" && pathname === "/v1/accounts/link") {
    // Enforce account limit before allowing new account linking
    const accountLimited = await enforceAccountLimit(auth.userId, env.DB);
    if (accountLimited) return accountLimited;
    return handleAccountLink(request, auth, env);
  }

  if (method === "GET" && pathname === "/v1/accounts/health") {
    return handleGetAccountsHealth(request, auth, env);
  }

  if (method === "GET" && pathname === "/v1/accounts") {
    return handleListAccounts(request, auth, env);
  }

  // Account sub-routes (reconnect, sync-history, scopes) must match before generic :id
  let match = matchRoute(pathname, "/v1/accounts/:id/reconnect");
  if (match && method === "POST") {
    return handleReconnectAccount(request, auth, env, match.params[0]);
  }

  match = matchRoute(pathname, "/v1/accounts/:id/sync-history");
  if (match && method === "GET") {
    return handleGetSyncHistory(request, auth, env, match.params[0]);
  }

  match = matchRoute(pathname, "/v1/accounts/:id/scopes");
  if (match) {
    if (method === "GET") {
      return handleListScopes(request, auth, env, match.params[0]);
    }
    if (method === "PUT") {
      return handleUpdateScopes(request, auth, env, match.params[0]);
    }
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
