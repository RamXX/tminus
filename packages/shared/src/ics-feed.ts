/**
 * @tminus/shared -- ICS feed URL validation and event normalization.
 *
 * Provides utilities for the zero-auth onboarding flow where users
 * paste a public ICS feed URL and see events imported without OAuth.
 *
 * Reuses the existing iCalendar parser (ical-parse.ts) and follows
 * the same normalization patterns as normalize-caldav.ts.
 *
 * Key design decisions:
 * - HTTPS required for all feed URLs (security)
 * - .ics extension is NOT required (many feeds use query strings)
 * - Events are tagged with source "ics_feed" to distinguish from synced events
 * - Read-only: no write-back capability for feed-sourced events
 * - Reuses ParsedVEvent -> normalized event pattern from CalDAV
 */

import type { EventDateTime } from "./types";
import { parseVEvents } from "./ical-parse";
import { icalDateTimeToEventDateTime } from "./ical-parse";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of validating an ICS feed URL. */
export interface FeedValidationResult {
  /** Whether the URL is valid. */
  readonly valid: boolean;
  /** Cleaned URL (trimmed, normalized). Present only when valid. */
  readonly url?: string;
  /** Error message. Present only when invalid. */
  readonly error?: string;
}

/**
 * A normalized feed event ready for storage in UserGraphDO.
 *
 * This is the same shape as the event payload in ProviderDelta,
 * with the addition of the "ics_feed" source marker.
 */
export interface NormalizedFeedEvent {
  readonly origin_event_id: string;
  readonly origin_account_id: string;
  readonly title?: string;
  readonly description?: string;
  readonly location?: string;
  readonly start: EventDateTime;
  readonly end: EventDateTime;
  readonly all_day: boolean;
  readonly status: "confirmed" | "tentative" | "cancelled";
  readonly visibility: "default" | "public" | "private" | "confidential";
  readonly transparency: "opaque" | "transparent";
  readonly recurrence_rule?: string;
  readonly source: "ics_feed";
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

/**
 * Validate an ICS feed URL.
 *
 * Requirements:
 * - Must be a valid URL
 * - Must use HTTPS protocol (security requirement)
 * - .ics extension is optional (many feeds use query strings)
 * - Whitespace is trimmed
 */
export function validateFeedUrl(url: string): FeedValidationResult {
  const trimmed = url.trim();

  if (!trimmed) {
    return { valid: false, error: "URL is required" };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }

  if (parsed.protocol !== "https:") {
    return { valid: false, error: "HTTPS is required for feed URLs" };
  }

  return { valid: true, url: trimmed };
}

// ---------------------------------------------------------------------------
// ICS event normalization
// ---------------------------------------------------------------------------

/**
 * Parse raw iCalendar text and normalize all VEVENTs into feed events.
 *
 * Reuses parseVEvents() from ical-parse.ts for RFC 5545 compliance,
 * then normalizes each ParsedVEvent into NormalizedFeedEvent format.
 *
 * @param icsText - Raw iCalendar text (VCALENDAR document)
 * @param accountId - The feed account ID to tag events with
 * @returns Array of normalized feed events
 */
export function normalizeIcsFeedEvents(
  icsText: string,
  accountId: string,
): NormalizedFeedEvent[] {
  if (!icsText.trim()) {
    return [];
  }

  const vevents = parseVEvents(icsText);

  return vevents.map((vevent) => {
    const start = normalizeDateTime(vevent.dtstart, vevent.dtstartParams);
    const end = normalizeDateTime(vevent.dtend, vevent.dtendParams);
    const allDay = isAllDay(vevent.dtstartParams);

    return {
      origin_event_id: vevent.uid,
      origin_account_id: accountId,
      title: vevent.summary,
      description: vevent.description,
      location: vevent.location,
      start,
      end,
      all_day: allDay,
      status: normalizeStatus(vevent.status),
      visibility: normalizeVisibility(vevent.class),
      transparency: normalizeTransparency(vevent.transp),
      recurrence_rule: vevent.rrule,
      source: "ics_feed" as const,
    };
  });
}

// ---------------------------------------------------------------------------
// Internal helpers (parallel to normalize-caldav.ts)
// ---------------------------------------------------------------------------

function normalizeDateTime(
  value?: string,
  params?: Record<string, string>,
): EventDateTime {
  if (!value) {
    return {};
  }
  return icalDateTimeToEventDateTime(value, params);
}

function isAllDay(dtstartParams?: Record<string, string>): boolean {
  return dtstartParams?.["VALUE"] === "DATE";
}

function normalizeStatus(
  status: string | undefined,
): "confirmed" | "tentative" | "cancelled" {
  if (!status) return "confirmed";
  const upper = status.toUpperCase();
  if (upper === "TENTATIVE") return "tentative";
  if (upper === "CANCELLED") return "cancelled";
  return "confirmed";
}

function normalizeVisibility(
  cls: string | undefined,
): "default" | "public" | "private" | "confidential" {
  if (!cls) return "default";
  const upper = cls.toUpperCase();
  if (upper === "PUBLIC") return "public";
  if (upper === "PRIVATE") return "private";
  if (upper === "CONFIDENTIAL") return "confidential";
  return "default";
}

function normalizeTransparency(
  transp: string | undefined,
): "opaque" | "transparent" {
  if (!transp) return "opaque";
  if (transp.toUpperCase() === "TRANSPARENT") return "transparent";
  return "opaque";
}
