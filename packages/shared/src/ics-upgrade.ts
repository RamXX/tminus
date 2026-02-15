/**
 * @tminus/shared -- ICS-to-OAuth Upgrade Flow (TM-d17.5).
 *
 * Provides the seamless upgrade path from an ICS-imported feed to a fully
 * OAuth-connected account. When a user upgrades, their existing ICS-imported
 * events are preserved and enriched with provider metadata.
 *
 * Key capabilities:
 * - Provider detection: analyze ICS feed URL to determine provider (Google, Microsoft, Apple)
 * - Event matching: primary by iCalUID, fallback by composite key (title + start + duration)
 * - Merge logic: ICS event enriched with provider metadata (attendees, RSVP, conference URLs)
 * - Upgrade plan: orchestrates the full ICS -> OAuth migration
 * - Downgrade plan: automatic fallback to ICS-only when OAuth fails
 *
 * Design decisions:
 * - Pure functions, no side effects -- all state passed in, results returned
 * - Optional match metadata (matched_by, confidence, enriched_fields) uses optional
 *   properties to distinguish 'not attempted' from 'attempted and failed to match'
 *   (per story learning from TM-lfy retro)
 * - Provider version supersedes ICS version on upgrade (BR-2: richer metadata)
 * - Event matching uses iCalUID as primary key, composite fallback (BR-4)
 *
 * Business rules:
 * - BR-1: Upgrade preserves all existing event data
 * - BR-2: Provider version supersedes ICS version (richer metadata)
 * - BR-3: Downgrade to ICS is automatic if OAuth fails
 * - BR-4: Event matching uses iCalUID as primary key, composite fallback
 */

import type { EventDateTime } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Detected calendar provider from an ICS feed URL. */
export interface DetectedProvider {
  readonly provider: "google" | "microsoft" | "apple" | "unknown";
  readonly confidence: "high" | "medium" | "none";
}

/** An event from an ICS feed (source: ics_feed). */
export interface IcsEvent {
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
  readonly source: "ics_feed";
  readonly recurrence_rule?: string;
}

/** Attendee information from a provider event. */
export interface ProviderAttendee {
  readonly email: string;
  readonly cn?: string;
  readonly partstat?: string;
  readonly role?: string;
}

/** Organizer information from a provider event. */
export interface ProviderOrganizer {
  readonly email: string;
  readonly cn?: string;
}

/** Conference/meeting data from a provider event. */
export interface ConferenceData {
  readonly type: string;
  readonly url: string;
}

/** An event from a provider (OAuth-synced, source: provider). */
export interface ProviderEvent {
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
  readonly source: "provider";
  readonly recurrence_rule?: string;
  readonly attendees?: readonly ProviderAttendee[];
  readonly organizer?: ProviderOrganizer;
  readonly meeting_url?: string;
  readonly conference_data?: ConferenceData;
}

/** A matched pair of ICS and provider events. */
export interface EventMatch {
  readonly icsEvent: IcsEvent;
  readonly providerEvent: ProviderEvent;
  readonly matched_by: "ical_uid" | "composite_key";
  readonly confidence: number;
}

/** Result of an event matching operation. */
export interface MatchResult {
  readonly matched: readonly EventMatch[];
  readonly unmatchedIcs: readonly IcsEvent[];
  readonly unmatchedProvider: readonly ProviderEvent[];
}

/**
 * A merged event combining ICS data with provider metadata.
 *
 * Optional match metadata uses key omission per story learning:
 * - undefined matched_by means 'not attempted' (new event, not from merge)
 * - 'ical_uid' or 'composite_key' means match was attempted and succeeded
 */
export interface MergedEvent {
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
  readonly source: "provider";
  readonly recurrence_rule?: string;
  readonly attendees?: readonly ProviderAttendee[];
  readonly organizer?: ProviderOrganizer;
  readonly meeting_url?: string;
  readonly conference_data?: ConferenceData;
  // Optional match metadata (key omission for 'not attempted')
  readonly matched_by?: "ical_uid" | "composite_key";
  readonly confidence?: number;
  readonly enriched_fields?: readonly string[];
}

/** Input for the upgrade plan. */
export interface UpgradeInput {
  readonly icsAccountId: string;
  readonly oauthAccountId: string;
  readonly feedUrl: string;
  readonly icsEvents: readonly IcsEvent[];
  readonly providerEvents: readonly ProviderEvent[];
}

/** The complete upgrade plan. */
export interface UpgradePlan {
  readonly detectedProvider: DetectedProvider;
  readonly mergedEvents: readonly MergedEvent[];
  readonly newProviderEvents: readonly ProviderEvent[];
  readonly orphanedIcsEvents: readonly IcsEvent[];
  readonly icsAccountToRemove: string;
  readonly oauthAccountToActivate: string;
}

/** Input for the downgrade plan. */
export interface DowngradeInput {
  readonly oauthAccountId: string;
  readonly provider: string;
  readonly feedUrl?: string;
  readonly currentEvents: readonly ProviderEvent[];
}

/** The complete downgrade plan. */
export interface DowngradePlan {
  readonly feedUrl?: string;
  readonly oauthAccountToRemove: string;
  readonly preservedEventCount: number;
  readonly mode: "read_only";
}

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

/** URL patterns for known providers. */
const GOOGLE_PATTERNS: readonly RegExp[] = [
  /calendar\.google\.com/i,
];

const MICROSOFT_PATTERNS: readonly RegExp[] = [
  /outlook\.live\.com/i,
  /outlook\.office365\.com/i,
  /outlook\.office\.com/i,
];

const APPLE_PATTERNS: readonly RegExp[] = [
  /p\d+-caldav\.icloud\.com/i,
  /p\d+-calendarws\.icloud\.com/i,
  /p\d+\.icloud\.com/i,
];

/**
 * Extract hostname from a URL string without relying on URL class properties.
 *
 * The shared package uses minimal URL type declarations (web-fetch.d.ts)
 * that don't include hostname/protocol. We parse manually for portability.
 */
function extractHostname(urlStr: string): string | null {
  // Match protocol://hostname pattern
  const match = urlStr.match(/^https?:\/\/([^/:?#]+)/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Detect the calendar provider from an ICS feed URL.
 *
 * Analyzes the hostname to determine:
 * - calendar.google.com -> Google
 * - outlook.live.com / outlook.office365.com / outlook.office.com -> Microsoft
 * - p*.icloud.com / p*-caldav.icloud.com / p*-calendarws.icloud.com -> Apple
 * - Anything else -> unknown
 *
 * @param feedUrl - The ICS feed URL to analyze
 * @returns Detected provider with confidence level
 */
export function detectProvider(feedUrl: string): DetectedProvider {
  if (!feedUrl || !feedUrl.trim()) {
    return { provider: "unknown", confidence: "none" };
  }

  const hostname = extractHostname(feedUrl);
  if (!hostname) {
    return { provider: "unknown", confidence: "none" };
  }

  // Check Google patterns
  for (const pattern of GOOGLE_PATTERNS) {
    if (pattern.test(hostname)) {
      return { provider: "google", confidence: "high" };
    }
  }

  // Check Microsoft patterns
  for (const pattern of MICROSOFT_PATTERNS) {
    if (pattern.test(hostname)) {
      return { provider: "microsoft", confidence: "high" };
    }
  }

  // Check Apple patterns
  for (const pattern of APPLE_PATTERNS) {
    if (pattern.test(hostname)) {
      return { provider: "apple", confidence: "high" };
    }
  }

  return { provider: "unknown", confidence: "none" };
}

// ---------------------------------------------------------------------------
// Event matching: iCalUID (primary)
// ---------------------------------------------------------------------------

/**
 * Match ICS events to provider events by iCalUID.
 *
 * This is the primary matching strategy. iCalUID is the globally unique
 * identifier assigned to an event in iCalendar format and is preserved
 * across ICS export and provider API.
 *
 * @param icsEvents - Events from the ICS feed
 * @param providerEvents - Events from the OAuth provider
 * @returns Match result with matched pairs and unmatched events from both sides
 */
export function matchEventsByICalUID(
  icsEvents: readonly IcsEvent[],
  providerEvents: readonly ProviderEvent[],
): MatchResult {
  // Build lookup map from provider events by origin_event_id (which is the iCalUID)
  const providerMap = new Map<string, ProviderEvent>();
  for (const pe of providerEvents) {
    providerMap.set(pe.origin_event_id, pe);
  }

  const matched: EventMatch[] = [];
  const unmatchedIcs: IcsEvent[] = [];
  const matchedProviderIds = new Set<string>();

  for (const icsEvent of icsEvents) {
    const providerEvent = providerMap.get(icsEvent.origin_event_id);
    if (providerEvent) {
      matched.push({
        icsEvent,
        providerEvent,
        matched_by: "ical_uid",
        confidence: 1.0,
      });
      matchedProviderIds.add(providerEvent.origin_event_id);
    } else {
      unmatchedIcs.push(icsEvent);
    }
  }

  const unmatchedProvider = providerEvents.filter(
    pe => !matchedProviderIds.has(pe.origin_event_id),
  );

  return { matched, unmatchedIcs, unmatchedProvider };
}

// ---------------------------------------------------------------------------
// Event matching: composite key (fallback)
// ---------------------------------------------------------------------------

/**
 * Compute a composite key for an event based on title + start time + end time.
 * Used as a fallback when iCalUID matching fails.
 */
function computeCompositeKey(event: {
  title?: string;
  start: EventDateTime;
  end: EventDateTime;
}): string {
  const title = (event.title ?? "").toLowerCase().trim();
  const startStr = event.start.dateTime ?? event.start.date ?? "";
  const endStr = event.end.dateTime ?? event.end.date ?? "";
  return `${title}|${startStr}|${endStr}`;
}

/**
 * Match events by composite key (title + start time + duration).
 *
 * This is the fallback matching strategy when iCalUID matching fails.
 * Used when the ICS feed uses different UIDs than the provider API.
 *
 * Confidence is set to 0.7 (lower than iCalUID's 1.0) because composite
 * matching can produce false positives for recurring events or events
 * with identical titles at the same time.
 *
 * @param icsEvents - Events NOT matched by iCalUID
 * @param providerEvents - Events NOT matched by iCalUID
 * @returns Match result with matched pairs and remaining unmatched
 */
export function matchEventsByCompositeKey(
  icsEvents: readonly IcsEvent[],
  providerEvents: readonly ProviderEvent[],
): MatchResult {
  // Build lookup map from provider events by composite key
  const providerMap = new Map<string, ProviderEvent>();
  for (const pe of providerEvents) {
    const key = computeCompositeKey(pe);
    providerMap.set(key, pe);
  }

  const matched: EventMatch[] = [];
  const unmatchedIcs: IcsEvent[] = [];
  const matchedProviderKeys = new Set<string>();

  for (const icsEvent of icsEvents) {
    const key = computeCompositeKey(icsEvent);
    const providerEvent = providerMap.get(key);
    if (providerEvent) {
      matched.push({
        icsEvent,
        providerEvent,
        matched_by: "composite_key",
        confidence: 0.7,
      });
      matchedProviderKeys.add(key);
    } else {
      unmatchedIcs.push(icsEvent);
    }
  }

  const unmatchedProvider = providerEvents.filter(
    pe => !matchedProviderKeys.has(computeCompositeKey(pe)),
  );

  return { matched, unmatchedIcs, unmatchedProvider };
}

// ---------------------------------------------------------------------------
// Combined event matching
// ---------------------------------------------------------------------------

/**
 * Match events using iCalUID first, then composite key for remaining unmatched.
 *
 * Per BR-4: Event matching uses iCalUID as primary key, composite fallback.
 *
 * @param icsEvents - All ICS events
 * @param providerEvents - All provider events
 * @returns Combined match result
 */
export function matchEvents(
  icsEvents: readonly IcsEvent[],
  providerEvents: readonly ProviderEvent[],
): MatchResult {
  // Phase 1: Match by iCalUID
  const uidResult = matchEventsByICalUID(icsEvents, providerEvents);

  // Phase 2: Match remaining by composite key
  const compositeResult = matchEventsByCompositeKey(
    uidResult.unmatchedIcs,
    uidResult.unmatchedProvider,
  );

  return {
    matched: [...uidResult.matched, ...compositeResult.matched],
    unmatchedIcs: compositeResult.unmatchedIcs,
    unmatchedProvider: compositeResult.unmatchedProvider,
  };
}

// ---------------------------------------------------------------------------
// Event merge
// ---------------------------------------------------------------------------

/**
 * Merge an ICS event with a provider event, enriching with provider metadata.
 *
 * Per BR-2: Provider version supersedes ICS version (richer metadata).
 * All base fields come from the provider event. Additionally, fields only
 * available via OAuth (attendees, organizer, meeting URL, conference data)
 * are added as enrichments.
 *
 * Match metadata (matched_by, confidence, enriched_fields) uses optional
 * properties per story learning.
 *
 * @param icsEvent - The original ICS event
 * @param providerEvent - The matching provider event
 * @param matchedBy - How the events were matched
 * @returns Merged event with enriched metadata
 */
export function mergeIcsWithProvider(
  icsEvent: IcsEvent,
  providerEvent: ProviderEvent,
  matchedBy: "ical_uid" | "composite_key",
): MergedEvent {
  // Track which fields are enriched (present in provider but not in ICS)
  const enrichedFields: string[] = [];

  if (providerEvent.attendees !== undefined && providerEvent.attendees.length > 0) {
    enrichedFields.push("attendees");
  }
  if (providerEvent.organizer !== undefined) {
    enrichedFields.push("organizer");
  }
  if (providerEvent.meeting_url !== undefined) {
    enrichedFields.push("meeting_url");
  }
  if (providerEvent.conference_data !== undefined) {
    enrichedFields.push("conference_data");
  }

  const confidence = matchedBy === "ical_uid" ? 1.0 : 0.7;

  const merged: MergedEvent = {
    // Provider version wins for all base fields (BR-2)
    origin_event_id: providerEvent.origin_event_id,
    origin_account_id: providerEvent.origin_account_id,
    title: providerEvent.title,
    description: providerEvent.description,
    location: providerEvent.location,
    start: providerEvent.start,
    end: providerEvent.end,
    all_day: providerEvent.all_day,
    status: providerEvent.status,
    visibility: providerEvent.visibility,
    transparency: providerEvent.transparency,
    source: "provider",
    recurrence_rule: providerEvent.recurrence_rule,
    // Enriched fields from provider
    ...(providerEvent.attendees !== undefined ? { attendees: providerEvent.attendees } : {}),
    ...(providerEvent.organizer !== undefined ? { organizer: providerEvent.organizer } : {}),
    ...(providerEvent.meeting_url !== undefined ? { meeting_url: providerEvent.meeting_url } : {}),
    ...(providerEvent.conference_data !== undefined ? { conference_data: providerEvent.conference_data } : {}),
    // Match metadata
    matched_by: matchedBy,
    confidence,
    enriched_fields: enrichedFields.length > 0 ? enrichedFields : [],
  };

  return merged;
}

// ---------------------------------------------------------------------------
// Upgrade plan
// ---------------------------------------------------------------------------

/**
 * Plan the upgrade from ICS feed to OAuth account.
 *
 * Steps:
 * 1. Detect provider from feed URL
 * 2. Match ICS events to provider events (iCalUID first, composite fallback)
 * 3. Merge matched events (provider version wins, enriched with metadata)
 * 4. Identify new provider events (not in ICS)
 * 5. Identify orphaned ICS events (not in provider -- preserved, not deleted)
 *
 * Per BR-1: All existing ICS events are preserved (either merged or orphaned).
 * Per BR-2: Provider version supersedes ICS version.
 *
 * @param input - Upgrade parameters
 * @returns Complete upgrade plan
 */
export function planUpgrade(input: UpgradeInput): UpgradePlan {
  const detectedProvider = detectProvider(input.feedUrl);

  // Match events
  const matchResult = matchEvents(input.icsEvents, input.providerEvents);

  // Merge matched events
  const mergedEvents: MergedEvent[] = matchResult.matched.map(match =>
    mergeIcsWithProvider(match.icsEvent, match.providerEvent, match.matched_by),
  );

  return {
    detectedProvider,
    mergedEvents,
    newProviderEvents: matchResult.unmatchedProvider,
    orphanedIcsEvents: matchResult.unmatchedIcs,
    icsAccountToRemove: input.icsAccountId,
    oauthAccountToActivate: input.oauthAccountId,
  };
}

// ---------------------------------------------------------------------------
// Downgrade plan
// ---------------------------------------------------------------------------

/**
 * Plan the downgrade from OAuth account to ICS feed (automatic fallback).
 *
 * Triggered when OAuth token is revoked, expired, or refresh fails.
 * Per BR-3: Downgrade to ICS is automatic if OAuth fails.
 *
 * The downgrade:
 * - Preserves all current events as read-only
 * - Re-creates an ICS feed account using the original feed URL
 * - Events become poll-refreshed instead of push-notified
 *
 * @param input - Downgrade parameters
 * @returns Complete downgrade plan
 */
export function planDowngrade(input: DowngradeInput): DowngradePlan {
  return {
    feedUrl: input.feedUrl,
    oauthAccountToRemove: input.oauthAccountId,
    preservedEventCount: input.currentEvents.length,
    mode: "read_only",
  };
}
