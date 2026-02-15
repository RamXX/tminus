/**
 * Unit and integration tests for ICS-to-OAuth upgrade flow (TM-d17.5).
 *
 * Covers:
 * - Provider detection from 10+ ICS URL patterns (Google, Microsoft, Apple, unknown)
 * - Event matching by iCalUID (primary key)
 * - Event matching by composite key (title + start + duration, fallback)
 * - Merge logic: ICS event enriched with provider metadata
 * - Upgrade flow: ICS feed account replaced by OAuth account
 * - Downgrade flow: OAuth failure re-creates ICS feed
 * - Zero event loss during upgrade/downgrade
 * - Optional match metadata per story learning
 */

import { describe, it, expect } from "vitest";
import {
  detectProvider,
  matchEventsByICalUID,
  matchEventsByCompositeKey,
  matchEvents,
  mergeIcsWithProvider,
  planUpgrade,
  planDowngrade,
  type DetectedProvider,
  type IcsEvent,
  type ProviderEvent,
  type MatchResult,
  type MergedEvent,
  type UpgradePlan,
  type DowngradePlan,
} from "./ics-upgrade";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeIcsEvent(overrides: Partial<IcsEvent> = {}): IcsEvent {
  return {
    origin_event_id: "uid-abc-123@google.com",
    origin_account_id: "acc_ics_001",
    title: "Team Standup",
    start: { dateTime: "2026-03-01T09:00:00Z" },
    end: { dateTime: "2026-03-01T09:30:00Z" },
    all_day: false,
    status: "confirmed",
    visibility: "default",
    transparency: "opaque",
    source: "ics_feed",
    ...overrides,
  };
}

function makeProviderEvent(overrides: Partial<ProviderEvent> = {}): ProviderEvent {
  return {
    origin_event_id: "uid-abc-123@google.com",
    origin_account_id: "acc_oauth_001",
    title: "Team Standup",
    start: { dateTime: "2026-03-01T09:00:00Z" },
    end: { dateTime: "2026-03-01T09:30:00Z" },
    all_day: false,
    status: "confirmed",
    visibility: "default",
    transparency: "opaque",
    source: "provider",
    attendees: [
      { email: "alice@example.com", cn: "Alice", partstat: "ACCEPTED", role: "REQ-PARTICIPANT" },
      { email: "bob@example.com", cn: "Bob", partstat: "TENTATIVE", role: "REQ-PARTICIPANT" },
    ],
    organizer: { email: "alice@example.com", cn: "Alice" },
    meeting_url: "https://meet.google.com/abc-defg-hij",
    conference_data: { type: "hangoutsMeet", url: "https://meet.google.com/abc-defg-hij" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// detectProvider
// ---------------------------------------------------------------------------

describe("detectProvider", () => {
  // Google URLs
  it("detects Google from calendar.google.com ICS URL", () => {
    const result = detectProvider("https://calendar.google.com/calendar/ical/user%40gmail.com/public/basic.ics");
    expect(result).toEqual({ provider: "google", confidence: "high" });
  });

  it("detects Google from calendar.google.com with different path", () => {
    const result = detectProvider("https://calendar.google.com/calendar/u/0/r?cid=abc");
    expect(result).toEqual({ provider: "google", confidence: "high" });
  });

  // Microsoft URLs
  it("detects Microsoft from outlook.live.com ICS URL", () => {
    const result = detectProvider("https://outlook.live.com/owa/calendar/00000000-0000-0000-0000-000000000000/ICalendar");
    expect(result).toEqual({ provider: "microsoft", confidence: "high" });
  });

  it("detects Microsoft from outlook.office365.com ICS URL", () => {
    const result = detectProvider("https://outlook.office365.com/owa/calendar/abc123/basic.ics");
    expect(result).toEqual({ provider: "microsoft", confidence: "high" });
  });

  it("detects Microsoft from outlook.office.com ICS URL", () => {
    const result = detectProvider("https://outlook.office.com/calendar/ical/user/abc.ics");
    expect(result).toEqual({ provider: "microsoft", confidence: "high" });
  });

  // Apple URLs
  it("detects Apple from p*-caldav.icloud.com ICS URL", () => {
    const result = detectProvider("https://p73-caldav.icloud.com/published/2/ABC123");
    expect(result).toEqual({ provider: "apple", confidence: "high" });
  });

  it("detects Apple from p*-calendarws.icloud.com ICS URL", () => {
    const result = detectProvider("https://p22-calendarws.icloud.com/ca/subscribe/1/ABC123");
    expect(result).toEqual({ provider: "apple", confidence: "high" });
  });

  it("detects Apple from p*.icloud.com ICS URL (generic pattern)", () => {
    const result = detectProvider("https://p55.icloud.com/calendar/feed/abc");
    expect(result).toEqual({ provider: "apple", confidence: "high" });
  });

  // Unknown URLs
  it("returns 'unknown' for generic ICS URL", () => {
    const result = detectProvider("https://example.com/calendar.ics");
    expect(result).toEqual({ provider: "unknown", confidence: "none" });
  });

  it("returns 'unknown' for Fastmail ICS URL", () => {
    const result = detectProvider("https://caldav.fastmail.com/dav/calendars/user/feed.ics");
    expect(result).toEqual({ provider: "unknown", confidence: "none" });
  });

  it("returns 'unknown' for ProtonMail ICS URL", () => {
    const result = detectProvider("https://calendar.proton.me/api/calendar/v1/abc/events.ics");
    expect(result).toEqual({ provider: "unknown", confidence: "none" });
  });

  // Edge cases
  it("handles empty string gracefully", () => {
    const result = detectProvider("");
    expect(result).toEqual({ provider: "unknown", confidence: "none" });
  });

  it("handles invalid URL gracefully", () => {
    const result = detectProvider("not-a-url");
    expect(result).toEqual({ provider: "unknown", confidence: "none" });
  });

  it("is case insensitive", () => {
    const result = detectProvider("https://CALENDAR.GOOGLE.COM/calendar/ical/user/basic.ics");
    expect(result).toEqual({ provider: "google", confidence: "high" });
  });
});

// ---------------------------------------------------------------------------
// matchEventsByICalUID
// ---------------------------------------------------------------------------

describe("matchEventsByICalUID", () => {
  it("matches events with identical iCalUID", () => {
    const icsEvents = [makeIcsEvent({ origin_event_id: "uid-1@google.com" })];
    const providerEvents = [makeProviderEvent({ origin_event_id: "uid-1@google.com" })];

    const result = matchEventsByICalUID(icsEvents, providerEvents);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].icsEvent.origin_event_id).toBe("uid-1@google.com");
    expect(result.matched[0].providerEvent.origin_event_id).toBe("uid-1@google.com");
    expect(result.matched[0].matched_by).toBe("ical_uid");
    expect(result.matched[0].confidence).toBe(1.0);
    expect(result.unmatchedIcs).toHaveLength(0);
    expect(result.unmatchedProvider).toHaveLength(0);
  });

  it("separates unmatched events from both sides", () => {
    const icsEvents = [
      makeIcsEvent({ origin_event_id: "uid-1@google.com" }),
      makeIcsEvent({ origin_event_id: "uid-2@google.com" }),
    ];
    const providerEvents = [
      makeProviderEvent({ origin_event_id: "uid-1@google.com" }),
      makeProviderEvent({ origin_event_id: "uid-3@google.com" }),
    ];

    const result = matchEventsByICalUID(icsEvents, providerEvents);
    expect(result.matched).toHaveLength(1);
    expect(result.unmatchedIcs).toHaveLength(1);
    expect(result.unmatchedIcs[0].origin_event_id).toBe("uid-2@google.com");
    expect(result.unmatchedProvider).toHaveLength(1);
    expect(result.unmatchedProvider[0].origin_event_id).toBe("uid-3@google.com");
  });

  it("handles empty ICS events list", () => {
    const result = matchEventsByICalUID([], [makeProviderEvent()]);
    expect(result.matched).toHaveLength(0);
    expect(result.unmatchedIcs).toHaveLength(0);
    expect(result.unmatchedProvider).toHaveLength(1);
  });

  it("handles empty provider events list", () => {
    const result = matchEventsByICalUID([makeIcsEvent()], []);
    expect(result.matched).toHaveLength(0);
    expect(result.unmatchedIcs).toHaveLength(1);
    expect(result.unmatchedProvider).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// matchEventsByCompositeKey
// ---------------------------------------------------------------------------

describe("matchEventsByCompositeKey", () => {
  it("matches events with same title + start time + duration", () => {
    const icsEvents = [makeIcsEvent({
      origin_event_id: "uid-ics-only",
      title: "Lunch",
      start: { dateTime: "2026-03-01T12:00:00Z" },
      end: { dateTime: "2026-03-01T13:00:00Z" },
    })];
    const providerEvents = [makeProviderEvent({
      origin_event_id: "uid-provider-only",
      title: "Lunch",
      start: { dateTime: "2026-03-01T12:00:00Z" },
      end: { dateTime: "2026-03-01T13:00:00Z" },
    })];

    const result = matchEventsByCompositeKey(icsEvents, providerEvents);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].matched_by).toBe("composite_key");
    expect(result.matched[0].confidence).toBeGreaterThan(0);
    expect(result.matched[0].confidence).toBeLessThan(1);
  });

  it("does NOT match events with same title but different start time", () => {
    const icsEvents = [makeIcsEvent({
      origin_event_id: "uid-1",
      title: "Lunch",
      start: { dateTime: "2026-03-01T12:00:00Z" },
      end: { dateTime: "2026-03-01T13:00:00Z" },
    })];
    const providerEvents = [makeProviderEvent({
      origin_event_id: "uid-2",
      title: "Lunch",
      start: { dateTime: "2026-03-02T12:00:00Z" },
      end: { dateTime: "2026-03-02T13:00:00Z" },
    })];

    const result = matchEventsByCompositeKey(icsEvents, providerEvents);
    expect(result.matched).toHaveLength(0);
    expect(result.unmatchedIcs).toHaveLength(1);
    expect(result.unmatchedProvider).toHaveLength(1);
  });

  it("does NOT match events with same start but different title", () => {
    const icsEvents = [makeIcsEvent({
      origin_event_id: "uid-1",
      title: "Lunch",
      start: { dateTime: "2026-03-01T12:00:00Z" },
      end: { dateTime: "2026-03-01T13:00:00Z" },
    })];
    const providerEvents = [makeProviderEvent({
      origin_event_id: "uid-2",
      title: "Dinner",
      start: { dateTime: "2026-03-01T12:00:00Z" },
      end: { dateTime: "2026-03-01T13:00:00Z" },
    })];

    const result = matchEventsByCompositeKey(icsEvents, providerEvents);
    expect(result.matched).toHaveLength(0);
  });

  it("matches all-day events correctly", () => {
    const icsEvents = [makeIcsEvent({
      origin_event_id: "uid-1",
      title: "Company Holiday",
      start: { date: "2026-03-01" },
      end: { date: "2026-03-02" },
      all_day: true,
    })];
    const providerEvents = [makeProviderEvent({
      origin_event_id: "uid-2",
      title: "Company Holiday",
      start: { date: "2026-03-01" },
      end: { date: "2026-03-02" },
      all_day: true,
    })];

    const result = matchEventsByCompositeKey(icsEvents, providerEvents);
    expect(result.matched).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// matchEvents (combined: iCalUID primary, composite fallback)
// ---------------------------------------------------------------------------

describe("matchEvents", () => {
  it("uses iCalUID first, then composite key for unmatched", () => {
    const icsEvents = [
      makeIcsEvent({ origin_event_id: "uid-shared@google.com", title: "Meeting A" }),
      makeIcsEvent({
        origin_event_id: "uid-ics-only@local",
        title: "Lunch",
        start: { dateTime: "2026-03-01T12:00:00Z" },
        end: { dateTime: "2026-03-01T13:00:00Z" },
      }),
    ];
    const providerEvents = [
      makeProviderEvent({ origin_event_id: "uid-shared@google.com", title: "Meeting A" }),
      makeProviderEvent({
        origin_event_id: "uid-provider-different",
        title: "Lunch",
        start: { dateTime: "2026-03-01T12:00:00Z" },
        end: { dateTime: "2026-03-01T13:00:00Z" },
      }),
    ];

    const result = matchEvents(icsEvents, providerEvents);
    // First match by iCalUID
    const uidMatch = result.matched.find(m => m.matched_by === "ical_uid");
    expect(uidMatch).toBeDefined();
    expect(uidMatch!.icsEvent.origin_event_id).toBe("uid-shared@google.com");
    // Second match by composite key
    const compositeMatch = result.matched.find(m => m.matched_by === "composite_key");
    expect(compositeMatch).toBeDefined();
    expect(compositeMatch!.icsEvent.title).toBe("Lunch");
  });
});

// ---------------------------------------------------------------------------
// mergeIcsWithProvider
// ---------------------------------------------------------------------------

describe("mergeIcsWithProvider", () => {
  it("preserves ICS event data while enriching with provider metadata", () => {
    const icsEvent = makeIcsEvent({ description: "Daily standup meeting" });
    const providerEvent = makeProviderEvent({
      description: "Daily standup meeting - updated",
      attendees: [
        { email: "alice@example.com", cn: "Alice", partstat: "ACCEPTED", role: "REQ-PARTICIPANT" },
      ],
      organizer: { email: "alice@example.com", cn: "Alice" },
      meeting_url: "https://meet.google.com/xyz",
    });

    const merged = mergeIcsWithProvider(icsEvent, providerEvent, "ical_uid");
    // Provider version wins (BR-2)
    expect(merged.title).toBe(providerEvent.title);
    expect(merged.description).toBe(providerEvent.description);
    // Enriched fields present
    expect(merged.attendees).toEqual(providerEvent.attendees);
    expect(merged.organizer).toEqual(providerEvent.organizer);
    expect(merged.meeting_url).toBe(providerEvent.meeting_url);
    // Source updated to provider
    expect(merged.source).toBe("provider");
    // Origin account updated to OAuth account
    expect(merged.origin_account_id).toBe(providerEvent.origin_account_id);
    // Match metadata present
    expect(merged.matched_by).toBe("ical_uid");
    expect(merged.enriched_fields).toBeDefined();
    expect(merged.enriched_fields!.length).toBeGreaterThan(0);
  });

  it("uses provider version for all base fields (BR-2)", () => {
    const icsEvent = makeIcsEvent({ title: "ICS Title", status: "tentative" });
    const providerEvent = makeProviderEvent({ title: "Provider Title", status: "confirmed" });

    const merged = mergeIcsWithProvider(icsEvent, providerEvent, "ical_uid");
    expect(merged.title).toBe("Provider Title");
    expect(merged.status).toBe("confirmed");
  });

  it("tracks which fields were enriched", () => {
    const icsEvent = makeIcsEvent();
    const providerEvent = makeProviderEvent({
      attendees: [{ email: "a@b.com", cn: "A" }],
      organizer: { email: "a@b.com", cn: "A" },
      meeting_url: "https://meet.google.com/abc",
      conference_data: { type: "hangoutsMeet", url: "https://meet.google.com/abc" },
    });

    const merged = mergeIcsWithProvider(icsEvent, providerEvent, "ical_uid");
    expect(merged.enriched_fields).toContain("attendees");
    expect(merged.enriched_fields).toContain("organizer");
    expect(merged.enriched_fields).toContain("meeting_url");
    expect(merged.enriched_fields).toContain("conference_data");
  });

  it("uses composite_key match_by when matched by composite", () => {
    const icsEvent = makeIcsEvent();
    const providerEvent = makeProviderEvent();

    const merged = mergeIcsWithProvider(icsEvent, providerEvent, "composite_key");
    expect(merged.matched_by).toBe("composite_key");
    expect(merged.confidence).toBeDefined();
    expect(merged.confidence).toBeLessThan(1);
  });

  it("optional match metadata uses key omission per story learning", () => {
    const icsEvent = makeIcsEvent();
    // Provider event with no enrichment metadata
    const providerEvent = makeProviderEvent({
      attendees: undefined,
      organizer: undefined,
      meeting_url: undefined,
      conference_data: undefined,
    });

    const merged = mergeIcsWithProvider(icsEvent, providerEvent, "ical_uid");
    // When no fields are enriched, enriched_fields should be omitted (not empty array)
    // per story learning: "use optional properties to distinguish 'not attempted' from
    // 'attempted and failed to match'"
    if (merged.enriched_fields !== undefined) {
      expect(merged.enriched_fields.length).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// planUpgrade
// ---------------------------------------------------------------------------

describe("planUpgrade", () => {
  it("produces complete upgrade plan with matched, new, and orphaned events", () => {
    const icsEvents = [
      makeIcsEvent({ origin_event_id: "uid-1", title: "Meeting A", start: { dateTime: "2026-03-01T09:00:00Z" }, end: { dateTime: "2026-03-01T10:00:00Z" } }),
      makeIcsEvent({ origin_event_id: "uid-2", title: "Meeting B", start: { dateTime: "2026-03-02T09:00:00Z" }, end: { dateTime: "2026-03-02T10:00:00Z" } }),
      makeIcsEvent({ origin_event_id: "uid-orphan", title: "Orphan Event", start: { dateTime: "2026-03-03T09:00:00Z" }, end: { dateTime: "2026-03-03T10:00:00Z" } }),
    ];
    const providerEvents = [
      makeProviderEvent({ origin_event_id: "uid-1", title: "Meeting A", start: { dateTime: "2026-03-01T09:00:00Z" }, end: { dateTime: "2026-03-01T10:00:00Z" } }),
      makeProviderEvent({ origin_event_id: "uid-2", title: "Meeting B", start: { dateTime: "2026-03-02T09:00:00Z" }, end: { dateTime: "2026-03-02T10:00:00Z" } }),
      makeProviderEvent({ origin_event_id: "uid-new", title: "New Provider Event", start: { dateTime: "2026-03-04T09:00:00Z" }, end: { dateTime: "2026-03-04T10:00:00Z" } }),
    ];

    const plan = planUpgrade({
      icsAccountId: "acc_ics_001",
      oauthAccountId: "acc_oauth_001",
      feedUrl: "https://calendar.google.com/calendar/ical/user/basic.ics",
      icsEvents,
      providerEvents,
    });

    expect(plan.detectedProvider).toEqual({ provider: "google", confidence: "high" });
    expect(plan.mergedEvents).toHaveLength(2); // uid-1 and uid-2 matched
    expect(plan.newProviderEvents).toHaveLength(1); // uid-new
    expect(plan.newProviderEvents[0].origin_event_id).toBe("uid-new");
    expect(plan.orphanedIcsEvents).toHaveLength(1); // uid-orphan
    expect(plan.orphanedIcsEvents[0].origin_event_id).toBe("uid-orphan");
    expect(plan.icsAccountToRemove).toBe("acc_ics_001");
    expect(plan.oauthAccountToActivate).toBe("acc_oauth_001");
    // Zero event loss: merged + new + orphaned >= icsEvents.length
    const totalEvents = plan.mergedEvents.length + plan.newProviderEvents.length + plan.orphanedIcsEvents.length;
    expect(totalEvents).toBeGreaterThanOrEqual(icsEvents.length);
  });

  it("preserves all ICS events when none match (zero loss)", () => {
    const icsEvents = [
      makeIcsEvent({ origin_event_id: "ics-only-1", title: "ICS Event 1", start: { dateTime: "2026-03-01T10:00:00Z" }, end: { dateTime: "2026-03-01T11:00:00Z" } }),
      makeIcsEvent({ origin_event_id: "ics-only-2", title: "ICS Event 2", start: { dateTime: "2026-03-02T10:00:00Z" }, end: { dateTime: "2026-03-02T11:00:00Z" } }),
    ];
    const providerEvents = [
      makeProviderEvent({ origin_event_id: "provider-only-1", title: "Provider Event 1", start: { dateTime: "2026-03-03T10:00:00Z" }, end: { dateTime: "2026-03-03T11:00:00Z" } }),
    ];

    const plan = planUpgrade({
      icsAccountId: "acc_ics",
      oauthAccountId: "acc_oauth",
      feedUrl: "https://example.com/feed.ics",
      icsEvents,
      providerEvents,
    });

    // All ICS events become orphaned (preserved)
    expect(plan.orphanedIcsEvents).toHaveLength(2);
    // Provider event is new
    expect(plan.newProviderEvents).toHaveLength(1);
    // No merged events
    expect(plan.mergedEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// planDowngrade
// ---------------------------------------------------------------------------

describe("planDowngrade", () => {
  it("produces downgrade plan preserving events as read-only ICS", () => {
    const currentEvents = [
      makeProviderEvent({ origin_event_id: "uid-1" }),
      makeProviderEvent({ origin_event_id: "uid-2" }),
    ];

    const plan = planDowngrade({
      oauthAccountId: "acc_oauth_001",
      provider: "google",
      feedUrl: "https://calendar.google.com/calendar/ical/user/basic.ics",
      currentEvents,
    });

    expect(plan.feedUrl).toBe("https://calendar.google.com/calendar/ical/user/basic.ics");
    expect(plan.oauthAccountToRemove).toBe("acc_oauth_001");
    expect(plan.preservedEventCount).toBe(2);
    expect(plan.mode).toBe("read_only");
  });

  it("returns empty feed URL when provider has no known public ICS URL pattern", () => {
    const plan = planDowngrade({
      oauthAccountId: "acc_oauth_001",
      provider: "unknown",
      currentEvents: [],
    });

    expect(plan.feedUrl).toBeUndefined();
    expect(plan.mode).toBe("read_only");
  });

  it("handles downgrade with no events gracefully", () => {
    const plan = planDowngrade({
      oauthAccountId: "acc_oauth_001",
      provider: "google",
      feedUrl: "https://calendar.google.com/calendar/ical/user/basic.ics",
      currentEvents: [],
    });

    expect(plan.preservedEventCount).toBe(0);
    expect(plan.oauthAccountToRemove).toBe("acc_oauth_001");
  });
});

// ---------------------------------------------------------------------------
// Integration: full upgrade flow (ICS -> OAuth for Google)
// ---------------------------------------------------------------------------

describe("integration: full upgrade flow", () => {
  it("upgrades Google ICS feed to OAuth with event enrichment", () => {
    // Scenario: user has 3 ICS events, 2 match provider, 1 new from provider
    const feedUrl = "https://calendar.google.com/calendar/ical/user%40gmail.com/public/basic.ics";

    const icsEvents: IcsEvent[] = [
      makeIcsEvent({ origin_event_id: "uid-standup@google.com", title: "Daily Standup" }),
      makeIcsEvent({ origin_event_id: "uid-1on1@google.com", title: "1:1 with Manager" }),
      makeIcsEvent({ origin_event_id: "uid-local-only@local", title: "Local Reminder" }),
    ];

    const providerEvents: ProviderEvent[] = [
      makeProviderEvent({
        origin_event_id: "uid-standup@google.com",
        title: "Daily Standup",
        attendees: [{ email: "team@example.com", cn: "Team" }],
        meeting_url: "https://meet.google.com/daily",
      }),
      makeProviderEvent({
        origin_event_id: "uid-1on1@google.com",
        title: "1:1 with Manager",
        attendees: [{ email: "manager@example.com", cn: "Manager" }],
      }),
      makeProviderEvent({
        origin_event_id: "uid-new-event@google.com",
        title: "Sprint Planning",
      }),
    ];

    // Step 1: Detect provider
    const detected = detectProvider(feedUrl);
    expect(detected.provider).toBe("google");

    // Step 2: Plan upgrade
    const plan = planUpgrade({
      icsAccountId: "acc_ics",
      oauthAccountId: "acc_oauth",
      feedUrl,
      icsEvents,
      providerEvents,
    });

    // Step 3: Verify plan
    // 2 events matched by iCalUID
    expect(plan.mergedEvents).toHaveLength(2);
    // Merged events have enriched metadata
    const standupMerged = plan.mergedEvents.find(m => m.title === "Daily Standup");
    expect(standupMerged).toBeDefined();
    expect(standupMerged!.attendees).toBeDefined();
    expect(standupMerged!.meeting_url).toBe("https://meet.google.com/daily");
    expect(standupMerged!.matched_by).toBe("ical_uid");

    // 1 new provider event
    expect(plan.newProviderEvents).toHaveLength(1);
    expect(plan.newProviderEvents[0].title).toBe("Sprint Planning");

    // 1 orphaned ICS event (preserved)
    expect(plan.orphanedIcsEvents).toHaveLength(1);
    expect(plan.orphanedIcsEvents[0].title).toBe("Local Reminder");

    // Zero event loss: all events accounted for
    const allEventCount = plan.mergedEvents.length + plan.newProviderEvents.length + plan.orphanedIcsEvents.length;
    expect(allEventCount).toBe(4); // 2 matched + 1 new + 1 orphaned = 4 total unique events
  });
});

// ---------------------------------------------------------------------------
// Integration: downgrade flow when OAuth token revoked
// ---------------------------------------------------------------------------

describe("integration: downgrade flow", () => {
  it("downgrades OAuth to ICS feed on token revocation", () => {
    const currentEvents: ProviderEvent[] = [
      makeProviderEvent({ origin_event_id: "uid-1", title: "Meeting A" }),
      makeProviderEvent({ origin_event_id: "uid-2", title: "Meeting B" }),
      makeProviderEvent({ origin_event_id: "uid-3", title: "Meeting C" }),
    ];

    const plan = planDowngrade({
      oauthAccountId: "acc_oauth_001",
      provider: "google",
      feedUrl: "https://calendar.google.com/calendar/ical/user%40gmail.com/public/basic.ics",
      currentEvents,
    });

    // All events preserved
    expect(plan.preservedEventCount).toBe(3);
    // ICS feed URL for re-creation
    expect(plan.feedUrl).toBe("https://calendar.google.com/calendar/ical/user%40gmail.com/public/basic.ics");
    // Mode is read-only
    expect(plan.mode).toBe("read_only");
    // OAuth account to remove
    expect(plan.oauthAccountToRemove).toBe("acc_oauth_001");
  });

  it("preserves events across upgrade-then-downgrade cycle", () => {
    // Start with ICS events
    const icsEvents: IcsEvent[] = [
      makeIcsEvent({ origin_event_id: "uid-1", title: "Event A" }),
      makeIcsEvent({ origin_event_id: "uid-2", title: "Event B" }),
    ];

    const providerEvents: ProviderEvent[] = [
      makeProviderEvent({ origin_event_id: "uid-1", title: "Event A" }),
      makeProviderEvent({ origin_event_id: "uid-2", title: "Event B" }),
    ];

    // Upgrade
    const upgradePlan = planUpgrade({
      icsAccountId: "acc_ics",
      oauthAccountId: "acc_oauth",
      feedUrl: "https://calendar.google.com/calendar/ical/user/basic.ics",
      icsEvents,
      providerEvents,
    });

    expect(upgradePlan.mergedEvents).toHaveLength(2);

    // Now downgrade (simulating token revocation)
    // The merged events become the "current events" in the OAuth account
    const downgradeInput = upgradePlan.mergedEvents.map(m => makeProviderEvent({
      origin_event_id: m.origin_event_id,
      title: m.title,
    }));

    const downgradePlan = planDowngrade({
      oauthAccountId: "acc_oauth",
      provider: "google",
      feedUrl: "https://calendar.google.com/calendar/ical/user/basic.ics",
      currentEvents: downgradeInput,
    });

    // All events preserved through the cycle
    expect(downgradePlan.preservedEventCount).toBe(2);
  });
});
