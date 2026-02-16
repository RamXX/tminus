/**
 * Route group: CalDAV feeds (Phase 5A).
 */

import { buildVCalendar } from "@tminus/shared";
import type { CanonicalEvent } from "@tminus/shared";
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

// ---------------------------------------------------------------------------
// CalDAV handler
// ---------------------------------------------------------------------------

async function handleCalDavFeed(
  _request: Request,
  auth: AuthContext,
  env: Env,
  requestedUserId: string,
): Promise<Response> {
  // Security: verify the authenticated user matches the requested user
  if (auth.userId !== requestedUserId) {
    return jsonResponse(
      errorEnvelope("Forbidden: cannot access another user's calendar feed", "FORBIDDEN"),
      ErrorCode.FORBIDDEN,
    );
  }

  try {
    // Fetch all canonical events from UserGraphDO (no time bounds = all events)
    const result = await callDO<{
      items: CanonicalEvent[];
      cursor: string | null;
      has_more: boolean;
    }>(env.USER_GRAPH, auth.userId, "/listCanonicalEvents", {});

    if (!result.ok) {
      return jsonResponse(
        errorEnvelope("Failed to fetch events for calendar feed", "INTERNAL_ERROR"),
        ErrorCode.INTERNAL_ERROR,
      );
    }

    // Generate iCalendar document from canonical events
    const icalBody = buildVCalendar(result.data.items);

    // Return iCalendar with appropriate headers
    return new Response(icalBody, {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'attachment; filename="calendar.ics"',
        "Cache-Control": "public, max-age=300",
        // CalDAV ETag for conditional requests (based on data hash, simplified)
        "X-Calendar-Subscription-URL": `/v1/caldav/${auth.userId}/calendar.ics`,
      },
    });
  } catch (err) {
    console.error("Failed to generate CalDAV feed", err);
    return jsonResponse(
      errorEnvelope("Failed to generate calendar feed", "INTERNAL_ERROR"),
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

// ---------------------------------------------------------------------------
// Route group: CalDAV
// ---------------------------------------------------------------------------

export const routeCalDavRoutes: RouteGroupHandler = async (request, method, pathname, auth, env) => {
  const match = matchRoute(pathname, "/v1/caldav/:user_id/calendar.ics");
  if (match && method === "GET") {
    return handleCalDavFeed(request, auth, env, match.params[0]);
  }

  if (method === "GET" && pathname === "/v1/caldav/subscription-url") {
    const baseUrl = new URL(request.url);
    const subscriptionUrl = `${baseUrl.protocol}//${baseUrl.host}/v1/caldav/${auth.userId}/calendar.ics`;
    return jsonResponse(
      successEnvelope({
        subscription_url: subscriptionUrl,
        content_type: "text/calendar",
        instructions: "Add this URL as a calendar subscription in your calendar app (Apple Calendar, Google Calendar, Outlook, etc.).",
      }),
      200,
    );
  }

  return null;
};

