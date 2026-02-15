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
// Helpers
// ---------------------------------------------------------------------------

function jsonResp(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
