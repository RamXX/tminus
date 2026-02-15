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
  type FeedRefreshState,
} from "@tminus/shared";

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
    return jsonResp({ ok: false, error: "Invalid JSON body" }, 400);
  }

  if (!body.url) {
    return jsonResp({ ok: false, error: "url is required" }, 400);
  }

  // Validate URL
  const validation = validateFeedUrl(body.url);
  if (!validation.valid) {
    return jsonResp({ ok: false, error: validation.error }, 400);
  }

  const feedUrl = validation.url!;

  // Fetch ICS data
  let icsText: string;
  try {
    const fetchResp = await fetch(feedUrl, {
      headers: { "Accept": "text/calendar, text/plain" },
    });
    if (!fetchResp.ok) {
      return jsonResp(
        { ok: false, error: `Failed to fetch ICS feed: HTTP ${fetchResp.status}` },
        502,
      );
    }
    icsText = await fetchResp.text();
  } catch (err) {
    return jsonResp(
      { ok: false, error: `Failed to fetch ICS feed: ${err instanceof Error ? err.message : String(err)}` },
      502,
    );
  }

  // Generate feed account ID
  const accountId = generateId("account");

  // Parse and normalize events
  const feedEvents = normalizeIcsFeedEvents(icsText, accountId);

  if (feedEvents.length === 0) {
    return jsonResp(
      { ok: false, error: "No events found in the ICS feed" },
      422,
    );
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
    return jsonResp(
      { ok: false, error: `Failed to register feed account: ${err instanceof Error ? err.message : String(err)}` },
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
      return jsonResp({ ok: false, error: "Failed to store feed events" }, 500);
    }
  } catch (err) {
    // Clean up D1 entry if DO call fails
    try {
      await env.DB.prepare("DELETE FROM accounts WHERE account_id = ?1").bind(accountId).run();
    } catch { /* best effort cleanup */ }
    return jsonResp(
      { ok: false, error: `Failed to store feed events: ${err instanceof Error ? err.message : String(err)}` },
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

  return jsonResp({ ok: true, data: result }, 201);
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

    return jsonResp({ ok: true, data: result.results ?? [] }, 200);
  } catch (err) {
    return jsonResp(
      { ok: false, error: `Failed to list feeds: ${err instanceof Error ? err.message : String(err)}` },
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
      return jsonResp({ ok: false, error: "Feed not found" }, 404);
    }
  } catch (err) {
    return jsonResp(
      { ok: false, error: `Failed to verify feed: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }

  // Validate refresh interval if provided
  if (body.refreshIntervalMs !== undefined) {
    if (!VALID_REFRESH_INTERVALS.includes(body.refreshIntervalMs)) {
      return jsonResp(
        {
          ok: false,
          error: `Invalid refresh interval. Valid values: ${VALID_REFRESH_INTERVALS.join(", ")} (milliseconds)`,
        },
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

    return jsonResp({
      ok: true,
      data: {
        account_id: feedId,
        refresh_interval_ms: body.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
      },
    }, 200);
  } catch (err) {
    return jsonResp(
      { ok: false, error: `Failed to update feed config: ${err instanceof Error ? err.message : String(err)}` },
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
      return jsonResp({ ok: false, error: "Feed not found" }, 404);
    }

    const intervalMs = row.feed_refresh_interval_ms ?? DEFAULT_REFRESH_INTERVAL_MS;
    const state: FeedRefreshState = {
      lastSuccessfulRefreshAt: row.feed_last_refresh_at,
      refreshIntervalMs: intervalMs,
      consecutiveFailures: row.feed_consecutive_failures,
    };

    const staleness = computeStaleness(state);

    return jsonResp({
      ok: true,
      data: {
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
      },
    }, 200);
  } catch (err) {
    return jsonResp(
      { ok: false, error: `Failed to get feed health: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResp(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
