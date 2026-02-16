/**
 * Route group: ICS feeds (Phase 6C: zero-auth onboarding).
 *
 * Handler implementations are in routes/feeds.ts.
 */

import {
  handleImportFeed,
  handleListFeeds,
  handleUpdateFeedConfig,
  handleGetFeedHealth,
  handleUpgradeFeed,
  handleDowngradeFeed,
  handleDetectFeedProvider,
} from "../feeds";
import { type RouteGroupHandler } from "../shared";

// ---------------------------------------------------------------------------
// Route group: Feeds
// ---------------------------------------------------------------------------

export const routeFeedRoutes: RouteGroupHandler = async (request, method, pathname, auth, env) => {
  if (method === "POST" && pathname === "/v1/feeds") {
    return handleImportFeed(request, auth, env);
  }

  if (method === "GET" && pathname === "/v1/feeds") {
    return handleListFeeds(request, auth, env);
  }

  // Feed-specific routes: /v1/feeds/:id/config, /v1/feeds/:id/health
  const feedConfigMatch = pathname.match(/^\/v1\/feeds\/([^/]+)\/config$/);
  if (method === "PATCH" && feedConfigMatch) {
    let body: { refreshIntervalMs?: number };
    try {
      body = await request.json() as { refreshIntervalMs?: number };
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "Invalid JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    return handleUpdateFeedConfig(request, auth, env, feedConfigMatch[1], body);
  }

  const feedHealthMatch = pathname.match(/^\/v1\/feeds\/([^/]+)\/health$/);
  if (method === "GET" && feedHealthMatch) {
    return handleGetFeedHealth(request, auth, env, feedHealthMatch[1]);
  }

  // Feed upgrade/downgrade routes (TM-d17.5: OAuth Upgrade Flow)
  const feedUpgradeMatch = pathname.match(/^\/v1\/feeds\/([^/]+)\/upgrade$/);
  if (method === "POST" && feedUpgradeMatch) {
    return handleUpgradeFeed(request, auth, env, feedUpgradeMatch[1]);
  }

  const feedProviderMatch = pathname.match(/^\/v1\/feeds\/([^/]+)\/provider$/);
  if (method === "GET" && feedProviderMatch) {
    return handleDetectFeedProvider(request, auth, env, feedProviderMatch[1]);
  }

  if (method === "POST" && pathname === "/v1/feeds/downgrade") {
    return handleDowngradeFeed(request, auth, env);
  }

  return null;
};

