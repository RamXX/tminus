/**
 * ICS feed import routes for the T-Minus API.
 *
 * Provides the zero-auth onboarding flow: user pastes a public ICS feed URL,
 * T-Minus fetches and parses it, stores events in the canonical store.
 *
 * Routes:
 *   POST /v1/feeds  - Import events from an ICS feed URL
 *   GET  /v1/feeds  - List feed accounts for the current user
 *
 * Design notes:
 * - Feed accounts use type "ics_feed" in D1 (not a provider account)
 * - Events are stored via UserGraphDO.applyProviderDelta with source "ics_feed"
 * - No sync-queue involvement (feeds are pulled, not pushed)
 * - Read-only: feed events cannot be written back
 */

import {
  validateFeedUrl,
  normalizeIcsFeedEvents,
  generateId,
  computeStaleness,
  VALID_REFRESH_INTERVALS,
  DEFAULT_REFRESH_INTERVAL_MS,
  detectProvider,
  planUpgrade,
  planDowngrade,
  type FeedRefreshState,
  type IcsEvent,
  type ProviderEvent,
} from "@tminus/shared";
import { apiSuccessResponse, apiErrorResponse } from "./shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Body shape for POST /v1/feeds */
export interface ImportFeedBody {
  readonly url: string;
}

/** Result of a successful feed import */
export interface FeedImportResult {
  readonly account_id: string;
  readonly feed_url: string;
  readonly events_imported: number;
  readonly date_range: {
    readonly earliest: string | null;
    readonly latest: string | null;
  };
}

// ---------------------------------------------------------------------------
// Handler: POST /v1/feeds
// ---------------------------------------------------------------------------

/**
 * Handle POST /v1/feeds -- import events from an ICS feed URL.
 *
 * Flow:
 * 1. Validate the ICS feed URL (HTTPS required)
 * 2. Fetch the ICS data from the URL
 * 3. Parse and normalize events
 * 4. Create a feed account in D1
 * 5. Store events in UserGraphDO via applyProviderDelta
 * 6. Return import summary
 */
export async function handleImportFeed(
  request: Request,
  auth: { userId: string },
  env: {
    DB: D1Database;
    USER_GRAPH: DurableObjectNamespace;
  },
): Promise<Response> {
  // Parse request body
  let body: ImportFeedBody;
  try {
    body = await request.json() as ImportFeedBody;
  } catch {
    return apiErrorResponse("VALIDATION_ERROR", "Invalid JSON body", 400);
  }

  if (!body.url) {
    return apiErrorResponse("VALIDATION_ERROR", "url is required", 400);
  }

  // Validate URL
  const validation = validateFeedUrl(body.url);
  if (!validation.valid) {
    return apiErrorResponse("VALIDATION_ERROR", validation.error ?? "Invalid feed URL", 400);
  }

  const feedUrl = validation.url!;

  // Fetch ICS data
  let icsText: string;
  try {
    const fetchResp = await fetch(feedUrl, {
      headers: { "Accept": "text/calendar, text/plain" },
    });
    if (!fetchResp.ok) {
      return apiErrorResponse("PROVIDER_ERROR", `Failed to fetch ICS feed: HTTP ${fetchResp.status}`, 502);
    }
    icsText = await fetchResp.text();
  } catch (err) {
    return apiErrorResponse(
      "PROVIDER_ERROR",
      `Failed to fetch ICS feed: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }

  // Generate feed account ID
  const accountId = generateId("account");

  // Parse and normalize events
  const feedEvents = normalizeIcsFeedEvents(icsText, accountId);

  if (feedEvents.length === 0) {
    return apiErrorResponse("VALIDATION_ERROR", "No events found in the ICS feed", 422);
  }

  // Register feed account in D1
  try {
    await env.DB
      .prepare(
        `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(
        accountId,
        auth.userId,
        "ics_feed",
        feedUrl,               // provider_subject stores the feed URL
        feedUrl,               // email stores the feed URL for display
        "active",
      )
      .run();
  } catch (err) {
    // Detect UNIQUE constraint violation on (provider, provider_subject) --
    // this means the feed URL is already imported. Return 409 CONFLICT with a
    // user-friendly message instead of leaking raw SQLITE_CONSTRAINT to the client.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE constraint failed") || message.includes("SQLITE_CONSTRAINT")) {
      return apiErrorResponse(
        "FEED_ALREADY_EXISTS",
        "This feed URL is already imported for your account.",
        409,
      );
    }
    return apiErrorResponse(
      "INTERNAL_ERROR",
      `Failed to register feed account: ${message}`,
      500,
    );
  }

  // Store events in UserGraphDO via applyProviderDelta
  // Convert NormalizedFeedEvents to ProviderDelta format
  const deltas = feedEvents.map((evt) => ({
    type: "created" as const,
    origin_event_id: evt.origin_event_id,
    origin_account_id: evt.origin_account_id,
    event: {
      origin_account_id: evt.origin_account_id,
      origin_event_id: evt.origin_event_id,
      title: evt.title,
      description: evt.description,
      location: evt.location,
      start: evt.start,
      end: evt.end,
      all_day: evt.all_day,
      status: evt.status,
      visibility: evt.visibility,
      transparency: evt.transparency,
      recurrence_rule: evt.recurrence_rule,
    },
  }));

  try {
    const doId = env.USER_GRAPH.idFromName(auth.userId);
    const stub = env.USER_GRAPH.get(doId);

    const doResp = await stub.fetch("https://do.internal/applyProviderDelta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_id: accountId,
        deltas,
      }),
    });

    if (!doResp.ok) {
      // Clean up D1 entry if DO storage fails
      await env.DB.prepare("DELETE FROM accounts WHERE account_id = ?1").bind(accountId).run();
      return apiErrorResponse("INTERNAL_ERROR", "Failed to store feed events", 500);
    }
  } catch (err) {
    // Clean up D1 entry if DO call fails
    try {
      await env.DB.prepare("DELETE FROM accounts WHERE account_id = ?1").bind(accountId).run();
    } catch { /* best effort cleanup */ }
    return apiErrorResponse(
      "INTERNAL_ERROR",
      `Failed to store feed events: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }

  // Compute date range from events
  const timestamps = feedEvents
    .map((e) => e.start.dateTime ?? e.start.date ?? null)
    .filter((t): t is string => t !== null)
    .sort();

  const result: FeedImportResult = {
    account_id: accountId,
    feed_url: feedUrl,
    events_imported: feedEvents.length,
    date_range: {
      earliest: timestamps[0] ?? null,
      latest: timestamps[timestamps.length - 1] ?? null,
    },
  };

  return apiSuccessResponse(result, 201);
}

// ---------------------------------------------------------------------------
// Handler: GET /v1/feeds
// ---------------------------------------------------------------------------

/**
 * Handle GET /v1/feeds -- list feed accounts for the current user.
 */
export async function handleListFeeds(
  _request: Request,
  auth: { userId: string },
  env: { DB: D1Database },
): Promise<Response> {
  try {
    const result = await env.DB
      .prepare(
        `SELECT account_id, user_id, provider, provider_subject as feed_url, status, created_at
         FROM accounts
         WHERE user_id = ?1 AND provider = 'ics_feed'`,
      )
      .bind(auth.userId)
      .all<{
        account_id: string;
        user_id: string;
        provider: string;
        feed_url: string;
        status: string;
        created_at: string;
      }>();

    return apiSuccessResponse(result.results ?? []);
  } catch (err) {
    return apiErrorResponse(
      "INTERNAL_ERROR",
      `Failed to list feeds: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }
}

// ---------------------------------------------------------------------------
// Handler: PATCH /v1/feeds/:id/config
// ---------------------------------------------------------------------------

/** Body shape for PATCH /v1/feeds/:id/config */
export interface UpdateFeedConfigBody {
  /** Refresh interval in milliseconds. Must be a valid interval or omitted. */
  readonly refreshIntervalMs?: number;
}

/**
 * Handle PATCH /v1/feeds/:id/config -- update feed refresh configuration.
 *
 * Per story learning from TM-lfy retro: optional fields use key omission
 * (not false/0). Missing refreshIntervalMs means "use default".
 */
export async function handleUpdateFeedConfig(
  _request: Request,
  auth: { userId: string },
  env: { DB: D1Database },
  feedId: string,
  body: UpdateFeedConfigBody,
): Promise<Response> {
  // Validate the feed belongs to the user and is an ICS feed
  try {
    const row = await env.DB
      .prepare(
        `SELECT account_id, user_id, provider FROM accounts
         WHERE account_id = ?1 AND user_id = ?2 AND provider = 'ics_feed'`,
      )
      .bind(feedId, auth.userId)
      .first<{ account_id: string }>();

    if (!row) {
      return apiErrorResponse("NOT_FOUND", "Feed not found", 404);
    }
  } catch (err) {
    return apiErrorResponse(
      "INTERNAL_ERROR",
      `Failed to verify feed: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }

  // Validate refresh interval if provided
  if (body.refreshIntervalMs !== undefined) {
    if (!VALID_REFRESH_INTERVALS.includes(body.refreshIntervalMs)) {
      return apiErrorResponse(
        "VALIDATION_ERROR",
        `Invalid refresh interval. Valid values: ${VALID_REFRESH_INTERVALS.join(", ")} (milliseconds)`,
        400,
      );
    }
  }

  // Update the feed config
  try {
    const intervalValue = body.refreshIntervalMs ?? null;
    await env.DB
      .prepare(
        `UPDATE accounts SET feed_refresh_interval_ms = ?1 WHERE account_id = ?2`,
      )
      .bind(intervalValue, feedId)
      .run();

    return apiSuccessResponse({
      account_id: feedId,
      refresh_interval_ms: body.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
    });
  } catch (err) {
    return apiErrorResponse(
      "INTERNAL_ERROR",
      `Failed to update feed config: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }
}

// ---------------------------------------------------------------------------
// Handler: GET /v1/feeds/:id/health
// ---------------------------------------------------------------------------

/**
 * Handle GET /v1/feeds/:id/health -- get feed staleness and refresh status.
 *
 * Returns:
 * - staleness: fresh/stale/dead
 * - last_refresh_at: ISO timestamp
 * - consecutive_failures: error count
 * - refresh_interval_ms: configured interval
 */
export async function handleGetFeedHealth(
  _request: Request,
  auth: { userId: string },
  env: { DB: D1Database },
  feedId: string,
): Promise<Response> {
  try {
    const row = await env.DB
      .prepare(
        `SELECT account_id, feed_last_refresh_at, feed_consecutive_failures,
                feed_refresh_interval_ms, feed_last_fetch_at, status
         FROM accounts
         WHERE account_id = ?1 AND user_id = ?2 AND provider = 'ics_feed'`,
      )
      .bind(feedId, auth.userId)
      .first<{
        account_id: string;
        feed_last_refresh_at: string | null;
        feed_consecutive_failures: number;
        feed_refresh_interval_ms: number | null;
        feed_last_fetch_at: string | null;
        status: string;
      }>();

    if (!row) {
      return apiErrorResponse("NOT_FOUND", "Feed not found", 404);
    }

    const intervalMs = row.feed_refresh_interval_ms ?? DEFAULT_REFRESH_INTERVAL_MS;
    const state: FeedRefreshState = {
      lastSuccessfulRefreshAt: row.feed_last_refresh_at,
      refreshIntervalMs: intervalMs,
      consecutiveFailures: row.feed_consecutive_failures,
    };

    const staleness = computeStaleness(state);

    return apiSuccessResponse({
      account_id: row.account_id,
      status: row.status,
      staleness: staleness.status,
      is_dead: staleness.isDead,
      last_refresh_at: row.feed_last_refresh_at,
      last_fetch_at: row.feed_last_fetch_at,
      consecutive_failures: row.feed_consecutive_failures,
      refresh_interval_ms: intervalMs,
      ms_since_last_refresh: staleness.msSinceLastRefresh === Infinity
        ? null
        : staleness.msSinceLastRefresh,
    });
  } catch (err) {
    return apiErrorResponse(
      "INTERNAL_ERROR",
      `Failed to get feed health: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }
}

// ---------------------------------------------------------------------------
// Handler: POST /v1/feeds/:id/upgrade
// ---------------------------------------------------------------------------

/** Body shape for POST /v1/feeds/:id/upgrade */
export interface UpgradeFeedBody {
  /** The OAuth account ID to upgrade to. */
  readonly oauth_account_id: string;
}

/**
 * Handle POST /v1/feeds/:id/upgrade -- upgrade an ICS feed to OAuth sync.
 *
 * TM-d17.5: Seamless upgrade path from ICS-imported feed to fully OAuth-connected
 * account. Existing ICS events are preserved and enriched with provider metadata.
 *
 * Flow:
 * 1. Validate the feed belongs to the user
 * 2. Detect provider from feed URL
 * 3. Fetch current ICS events from UserGraphDO
 * 4. Fetch provider events from the OAuth account
 * 5. Match and merge events (iCalUID primary, composite fallback)
 * 6. Replace ICS feed account with OAuth account
 *
 * Business rules:
 * - BR-1: All existing ICS events are preserved (merged or orphaned)
 * - BR-2: Provider version supersedes ICS version
 * - BR-4: Event matching uses iCalUID primary, composite fallback
 */
export async function handleUpgradeFeed(
  request: Request,
  auth: { userId: string },
  env: {
    DB: D1Database;
    USER_GRAPH: DurableObjectNamespace;
  },
  feedId: string,
): Promise<Response> {
  // Parse request body
  let body: UpgradeFeedBody;
  try {
    body = await request.json() as UpgradeFeedBody;
  } catch {
    return apiErrorResponse("VALIDATION_ERROR", "Invalid JSON body", 400);
  }

  if (!body.oauth_account_id) {
    return apiErrorResponse("VALIDATION_ERROR", "oauth_account_id is required", 400);
  }

  // Validate the ICS feed belongs to the user
  let feedRow: { account_id: string; provider_subject: string } | null;
  try {
    feedRow = await env.DB
      .prepare(
        `SELECT account_id, provider_subject FROM accounts
         WHERE account_id = ?1 AND user_id = ?2 AND provider = 'ics_feed'`,
      )
      .bind(feedId, auth.userId)
      .first<{ account_id: string; provider_subject: string }>();

    if (!feedRow) {
      return apiErrorResponse("NOT_FOUND", "ICS feed not found", 404);
    }
  } catch (err) {
    return apiErrorResponse(
      "INTERNAL_ERROR",
      `Failed to verify feed: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }

  const feedUrl = feedRow.provider_subject;

  // Detect provider
  const detected = detectProvider(feedUrl);

  // Fetch current events from UserGraphDO
  let icsEvents: IcsEvent[];
  let providerEvents: ProviderEvent[];
  try {
    const doId = env.USER_GRAPH.idFromName(auth.userId);
    const stub = env.USER_GRAPH.get(doId);

    // Fetch ICS events for this feed account
    const icsResp = await stub.fetch("https://do.internal/getAccountEvents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: feedId }),
    });

    if (!icsResp.ok) {
      return apiErrorResponse("INTERNAL_ERROR", "Failed to fetch ICS events", 500);
    }

    const icsData = await icsResp.json() as { events: IcsEvent[] };
    icsEvents = icsData.events ?? [];

    // Fetch provider events for the OAuth account
    const providerResp = await stub.fetch("https://do.internal/getAccountEvents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: body.oauth_account_id }),
    });

    if (!providerResp.ok) {
      return apiErrorResponse("INTERNAL_ERROR", "Failed to fetch provider events", 500);
    }

    const providerData = await providerResp.json() as { events: ProviderEvent[] };
    providerEvents = providerData.events ?? [];
  } catch (err) {
    return apiErrorResponse(
      "INTERNAL_ERROR",
      `Failed to fetch events: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }

  // Plan the upgrade
  const plan = planUpgrade({
    icsAccountId: feedId,
    oauthAccountId: body.oauth_account_id,
    feedUrl,
    icsEvents,
    providerEvents,
  });

  // Execute upgrade in UserGraphDO
  try {
    const doId = env.USER_GRAPH.idFromName(auth.userId);
    const stub = env.USER_GRAPH.get(doId);

    const upgradeResp = await stub.fetch("https://do.internal/executeUpgrade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ics_account_id: feedId,
        oauth_account_id: body.oauth_account_id,
        merged_events: plan.mergedEvents,
        new_events: plan.newProviderEvents,
        orphaned_events: plan.orphanedIcsEvents,
      }),
    });

    if (!upgradeResp.ok) {
      return apiErrorResponse("INTERNAL_ERROR", "Failed to execute upgrade in UserGraphDO", 500);
    }
  } catch (err) {
    return apiErrorResponse(
      "INTERNAL_ERROR",
      `Failed to execute upgrade: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }

  // Update D1: mark ICS feed as upgraded
  try {
    await env.DB
      .prepare(`UPDATE accounts SET status = 'upgraded' WHERE account_id = ?1`)
      .bind(feedId)
      .run();
  } catch {
    // Best effort -- the DO is the source of truth
  }

  return apiSuccessResponse({
    detected_provider: detected,
    merged_count: plan.mergedEvents.length,
    new_count: plan.newProviderEvents.length,
    orphaned_count: plan.orphanedIcsEvents.length,
    ics_account_removed: feedId,
    oauth_account_activated: body.oauth_account_id,
  });
}

// ---------------------------------------------------------------------------
// Handler: POST /v1/feeds/:id/downgrade
// ---------------------------------------------------------------------------

/** Body shape for POST /v1/feeds/:id/downgrade */
export interface DowngradeFeedBody {
  /** The OAuth account ID that is being downgraded. */
  readonly oauth_account_id: string;
  /** Provider type for the account being downgraded. */
  readonly provider: string;
  /** Original ICS feed URL (if known). */
  readonly feed_url?: string;
}

/**
 * Handle POST /v1/feeds/:id/downgrade -- downgrade OAuth to ICS feed.
 *
 * TM-d17.5: Automatic fallback when OAuth token is revoked or expired.
 * Re-creates an ICS feed account using the provider's public ICS URL.
 * Events remain visible but become read-only and poll-refreshed.
 *
 * Per BR-3: Downgrade to ICS is automatic if OAuth fails.
 */
export async function handleDowngradeFeed(
  request: Request,
  auth: { userId: string },
  env: {
    DB: D1Database;
    USER_GRAPH: DurableObjectNamespace;
  },
): Promise<Response> {
  // Parse request body
  let body: DowngradeFeedBody;
  try {
    body = await request.json() as DowngradeFeedBody;
  } catch {
    return apiErrorResponse("VALIDATION_ERROR", "Invalid JSON body", 400);
  }

  if (!body.oauth_account_id) {
    return apiErrorResponse("VALIDATION_ERROR", "oauth_account_id is required", 400);
  }

  if (!body.provider) {
    return apiErrorResponse("VALIDATION_ERROR", "provider is required", 400);
  }

  // Fetch current events from the OAuth account
  let currentEvents: ProviderEvent[];
  try {
    const doId = env.USER_GRAPH.idFromName(auth.userId);
    const stub = env.USER_GRAPH.get(doId);

    const resp = await stub.fetch("https://do.internal/getAccountEvents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: body.oauth_account_id }),
    });

    if (!resp.ok) {
      currentEvents = [];
    } else {
      const data = await resp.json() as { events: ProviderEvent[] };
      currentEvents = data.events ?? [];
    }
  } catch {
    currentEvents = [];
  }

  // Plan the downgrade
  const plan = planDowngrade({
    oauthAccountId: body.oauth_account_id,
    provider: body.provider,
    feedUrl: body.feed_url,
    currentEvents,
  });

  // Create new ICS feed account in D1
  if (plan.feedUrl) {
    const newFeedAccountId = generateId("account");

    try {
      // Remove any leftover upgraded ICS feed row to avoid UNIQUE constraint
      // violation on (provider, provider_subject). During upgrade, the old ICS
      // account is marked status='upgraded' but not deleted; we clean it up here
      // so the INSERT below succeeds.
      await env.DB
        .prepare(
          `DELETE FROM accounts WHERE provider = 'ics_feed' AND provider_subject = ?1 AND status = 'upgraded'`,
        )
        .bind(plan.feedUrl)
        .run();

      await env.DB
        .prepare(
          `INSERT INTO accounts (account_id, user_id, provider, provider_subject, email, status)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .bind(
          newFeedAccountId,
          auth.userId,
          "ics_feed",
          plan.feedUrl,
          plan.feedUrl,
          "active",
        )
        .run();
    } catch (err) {
      return apiErrorResponse(
        "INTERNAL_ERROR",
        `Failed to create fallback feed account: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }

    // Mark the OAuth account as downgraded
    try {
      await env.DB
        .prepare(`UPDATE accounts SET status = 'downgraded' WHERE account_id = ?1`)
        .bind(body.oauth_account_id)
        .run();
    } catch {
      // Best effort
    }

    return apiSuccessResponse({
      new_feed_account_id: newFeedAccountId,
      feed_url: plan.feedUrl,
      preserved_event_count: plan.preservedEventCount,
      mode: plan.mode,
      oauth_account_removed: body.oauth_account_id,
    });
  }

  // No feed URL available -- just mark as downgraded
  try {
    await env.DB
      .prepare(`UPDATE accounts SET status = 'downgraded' WHERE account_id = ?1`)
      .bind(body.oauth_account_id)
      .run();
  } catch {
    // Best effort
  }

  return apiSuccessResponse({
    preserved_event_count: plan.preservedEventCount,
    mode: plan.mode,
    oauth_account_removed: body.oauth_account_id,
    warning: "No public ICS feed URL available for this provider. Events preserved but no automatic refresh.",
  });
}

// ---------------------------------------------------------------------------
// Handler: GET /v1/feeds/:id/provider
// ---------------------------------------------------------------------------

/**
 * Handle GET /v1/feeds/:id/provider -- detect the provider for an ICS feed.
 *
 * Returns the detected provider and confidence level based on the feed URL.
 * Useful for the UI to determine which OAuth flow to initiate.
 */
export async function handleDetectFeedProvider(
  _request: Request,
  auth: { userId: string },
  env: { DB: D1Database },
  feedId: string,
): Promise<Response> {
  try {
    const row = await env.DB
      .prepare(
        `SELECT account_id, provider_subject FROM accounts
         WHERE account_id = ?1 AND user_id = ?2 AND provider = 'ics_feed'`,
      )
      .bind(feedId, auth.userId)
      .first<{ account_id: string; provider_subject: string }>();

    if (!row) {
      return apiErrorResponse("NOT_FOUND", "Feed not found", 404);
    }

    const detected = detectProvider(row.provider_subject);

    return apiSuccessResponse({
      account_id: row.account_id,
      feed_url: row.provider_subject,
      detected_provider: detected.provider,
      confidence: detected.confidence,
    });
  } catch (err) {
    return apiErrorResponse(
      "INTERNAL_ERROR",
      `Failed to detect provider: ${err instanceof Error ? err.message : String(err)}`,
      500,
    );
  }
}

// Response helpers are imported from ./shared
