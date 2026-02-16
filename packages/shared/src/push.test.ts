/**
 * Unit tests for push notification types and utilities.
 *
 * Tests cover:
 * - APNs payload construction
 * - Notification type validation
 * - User preference filtering
 * - Quiet hours enforcement (same-day, overnight, timezone-aware)
 * - Time parsing utilities
 * - Default settings factory
 */

import { describe, it, expect } from "vitest";
import {
  buildAPNsPayload,
  isValidNotificationType,
  NOTIFICATION_TYPES,
  shouldDeliverNotification,
  isWithinQuietHours,
  parseTimeToMinutes,
  getLocalMinutesSinceMidnight,
  defaultNotificationSettings,
  DEFAULT_DEEP_LINK_PATHS,
} from "./push";
import type {
  PushMessage,
  NotificationSettings,
  QuietHoursConfig,
  NotificationType,
} from "./push";

// ---------------------------------------------------------------------------
// APNs payload construction
// ---------------------------------------------------------------------------

describe("buildAPNsPayload", () => {
  const baseMessage: PushMessage = {
    user_id: "usr_01HXYZ00000000000000000001",
    notification_type: "drift_alert",
    title: "Relationship Drift",
    body: "You haven't met with Alice in 14 days",
    deep_link_path: "/drift/rel_01HXY000000000000000000E01",
  };

  it("builds a valid APNs payload with correct alert fields", () => {
    const payload = buildAPNsPayload(baseMessage);

    expect(payload.aps.alert.title).toBe("Relationship Drift");
    expect(payload.aps.alert.body).toBe("You haven't met with Alice in 14 days");
  });

  it("sets sound to default", () => {
    const payload = buildAPNsPayload(baseMessage);
    expect(payload.aps.sound).toBe("default");
  });

  it("sets category to the notification type", () => {
    const payload = buildAPNsPayload(baseMessage);
    expect(payload.aps.category).toBe("drift_alert");
  });

  it("sets thread-id for notification grouping", () => {
    const payload = buildAPNsPayload(baseMessage);
    expect(payload.aps["thread-id"]).toBe("tminus-drift_alert");
  });

  it("includes deep_link as tminus:// URL", () => {
    const payload = buildAPNsPayload(baseMessage);
    expect(payload.deep_link).toBe("tminus:///drift/rel_01HXY000000000000000000E01");
  });

  it("includes notification_type at top level", () => {
    const payload = buildAPNsPayload(baseMessage);
    expect(payload.notification_type).toBe("drift_alert");
  });

  it("includes metadata when provided", () => {
    const message: PushMessage = {
      ...baseMessage,
      metadata: { relationship_id: "rel_01HXY000000000000000000E01" },
    };
    const payload = buildAPNsPayload(message);
    expect(payload.metadata).toEqual({ relationship_id: "rel_01HXY000000000000000000E01" });
  });

  it("omits metadata when not provided", () => {
    const payload = buildAPNsPayload(baseMessage);
    expect(payload.metadata).toBeUndefined();
  });

  it("builds correct payload for each notification type", () => {
    for (const type of NOTIFICATION_TYPES) {
      const message: PushMessage = {
        ...baseMessage,
        notification_type: type,
        deep_link_path: DEFAULT_DEEP_LINK_PATHS[type],
      };
      const payload = buildAPNsPayload(message);
      expect(payload.aps.category).toBe(type);
      expect(payload.notification_type).toBe(type);
      expect(payload.aps["thread-id"]).toBe(`tminus-${type}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Notification type validation
// ---------------------------------------------------------------------------

describe("isValidNotificationType", () => {
  it("returns true for all valid types", () => {
    for (const type of NOTIFICATION_TYPES) {
      expect(isValidNotificationType(type)).toBe(true);
    }
  });

  it("returns false for invalid types", () => {
    expect(isValidNotificationType("invalid")).toBe(false);
    expect(isValidNotificationType("")).toBe(false);
    expect(isValidNotificationType("DRIFT_ALERT")).toBe(false);
  });

  it("validates all five expected types", () => {
    expect(NOTIFICATION_TYPES).toHaveLength(5);
    expect(NOTIFICATION_TYPES).toContain("drift_alert");
    expect(NOTIFICATION_TYPES).toContain("reconnection_suggestion");
    expect(NOTIFICATION_TYPES).toContain("scheduling_proposal");
    expect(NOTIFICATION_TYPES).toContain("risk_warning");
    expect(NOTIFICATION_TYPES).toContain("hold_expiry");
  });
});

// ---------------------------------------------------------------------------
// Default notification settings
// ---------------------------------------------------------------------------

describe("defaultNotificationSettings", () => {
  it("enables all notification types by default", () => {
    const settings = defaultNotificationSettings();
    for (const type of NOTIFICATION_TYPES) {
      expect(settings.preferences[type].enabled).toBe(true);
    }
  });

  it("disables quiet hours by default", () => {
    const settings = defaultNotificationSettings();
    expect(settings.quiet_hours.enabled).toBe(false);
  });

  it("sets default quiet hours window to 22:00-07:00 UTC", () => {
    const settings = defaultNotificationSettings();
    expect(settings.quiet_hours.start).toBe("22:00");
    expect(settings.quiet_hours.end).toBe("07:00");
    expect(settings.quiet_hours.timezone).toBe("UTC");
  });
});

// ---------------------------------------------------------------------------
// Preference filtering: shouldDeliverNotification
// ---------------------------------------------------------------------------

describe("shouldDeliverNotification", () => {
  // A standard "allowed" time: 2025-06-15 12:00:00 UTC (midday)
  const midday = new Date("2025-06-15T12:00:00Z");

  function makeSettings(overrides?: {
    types?: Partial<Record<NotificationType, { enabled: boolean }>>;
    quietHours?: Partial<QuietHoursConfig>;
  }): NotificationSettings {
    const defaults = defaultNotificationSettings();
    return {
      preferences: {
        ...defaults.preferences,
        ...(overrides?.types || {}),
      },
      quiet_hours: {
        ...defaults.quiet_hours,
        ...(overrides?.quietHours || {}),
      },
    };
  }

  it("allows notification when type is enabled and outside quiet hours", () => {
    const settings = makeSettings();
    expect(shouldDeliverNotification(settings, "drift_alert", midday)).toBe(true);
  });

  it("suppresses notification when type is disabled", () => {
    const settings = makeSettings({
      types: { drift_alert: { enabled: false } },
    });
    expect(shouldDeliverNotification(settings, "drift_alert", midday)).toBe(false);
  });

  it("allows other types when one type is disabled", () => {
    const settings = makeSettings({
      types: { drift_alert: { enabled: false } },
    });
    expect(shouldDeliverNotification(settings, "risk_warning", midday)).toBe(true);
  });

  it("suppresses notification during quiet hours", () => {
    const settings = makeSettings({
      quietHours: { enabled: true, start: "10:00", end: "14:00", timezone: "UTC" },
    });
    // midday (12:00 UTC) is within 10:00-14:00
    expect(shouldDeliverNotification(settings, "drift_alert", midday)).toBe(false);
  });

  it("allows notification outside quiet hours", () => {
    const settings = makeSettings({
      quietHours: { enabled: true, start: "22:00", end: "07:00", timezone: "UTC" },
    });
    // midday (12:00 UTC) is outside 22:00-07:00
    expect(shouldDeliverNotification(settings, "drift_alert", midday)).toBe(true);
  });

  it("allows notification when quiet hours are disabled even during quiet window", () => {
    const settings = makeSettings({
      quietHours: { enabled: false, start: "10:00", end: "14:00", timezone: "UTC" },
    });
    expect(shouldDeliverNotification(settings, "drift_alert", midday)).toBe(true);
  });

  it("type-disable takes precedence over quiet hours check", () => {
    const settings = makeSettings({
      types: { drift_alert: { enabled: false } },
      quietHours: { enabled: true, start: "22:00", end: "07:00", timezone: "UTC" },
    });
    // Type disabled, but also outside quiet hours -- should still be suppressed (type check first)
    expect(shouldDeliverNotification(settings, "drift_alert", midday)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Quiet hours logic: isWithinQuietHours
// ---------------------------------------------------------------------------

describe("isWithinQuietHours", () => {
  it("returns false when quiet hours are disabled", () => {
    const config: QuietHoursConfig = {
      enabled: false,
      start: "22:00",
      end: "07:00",
      timezone: "UTC",
    };
    const lateNight = new Date("2025-06-15T23:30:00Z");
    expect(isWithinQuietHours(config, lateNight)).toBe(false);
  });

  it("detects time within same-day quiet window", () => {
    const config: QuietHoursConfig = {
      enabled: true,
      start: "09:00",
      end: "17:00",
      timezone: "UTC",
    };
    const noonUtc = new Date("2025-06-15T12:00:00Z");
    expect(isWithinQuietHours(config, noonUtc)).toBe(true);
  });

  it("detects time outside same-day quiet window", () => {
    const config: QuietHoursConfig = {
      enabled: true,
      start: "09:00",
      end: "17:00",
      timezone: "UTC",
    };
    const eveningUtc = new Date("2025-06-15T20:00:00Z");
    expect(isWithinQuietHours(config, eveningUtc)).toBe(false);
  });

  it("detects time within overnight quiet window (before midnight)", () => {
    const config: QuietHoursConfig = {
      enabled: true,
      start: "22:00",
      end: "07:00",
      timezone: "UTC",
    };
    const lateNight = new Date("2025-06-15T23:30:00Z");
    expect(isWithinQuietHours(config, lateNight)).toBe(true);
  });

  it("detects time within overnight quiet window (after midnight)", () => {
    const config: QuietHoursConfig = {
      enabled: true,
      start: "22:00",
      end: "07:00",
      timezone: "UTC",
    };
    const earlyMorning = new Date("2025-06-16T05:00:00Z");
    expect(isWithinQuietHours(config, earlyMorning)).toBe(true);
  });

  it("detects time outside overnight quiet window", () => {
    const config: QuietHoursConfig = {
      enabled: true,
      start: "22:00",
      end: "07:00",
      timezone: "UTC",
    };
    const midday = new Date("2025-06-15T12:00:00Z");
    expect(isWithinQuietHours(config, midday)).toBe(false);
  });

  it("handles timezone conversion (America/Chicago is UTC-5 in June)", () => {
    const config: QuietHoursConfig = {
      enabled: true,
      start: "22:00",
      end: "07:00",
      timezone: "America/Chicago",
    };
    // 03:00 UTC = 22:00 CDT (within quiet hours in Chicago)
    const utc3am = new Date("2025-06-15T03:00:00Z");
    expect(isWithinQuietHours(config, utc3am)).toBe(true);
  });

  it("handles timezone conversion -- outside quiet hours in local time", () => {
    const config: QuietHoursConfig = {
      enabled: true,
      start: "22:00",
      end: "07:00",
      timezone: "America/Chicago",
    };
    // 18:00 UTC = 13:00 CDT (outside quiet hours in Chicago)
    const utc6pm = new Date("2025-06-15T18:00:00Z");
    expect(isWithinQuietHours(config, utc6pm)).toBe(false);
  });

  it("boundary: start time is inclusive", () => {
    const config: QuietHoursConfig = {
      enabled: true,
      start: "22:00",
      end: "07:00",
      timezone: "UTC",
    };
    const exactStart = new Date("2025-06-15T22:00:00Z");
    expect(isWithinQuietHours(config, exactStart)).toBe(true);
  });

  it("boundary: end time is exclusive", () => {
    const config: QuietHoursConfig = {
      enabled: true,
      start: "22:00",
      end: "07:00",
      timezone: "UTC",
    };
    const exactEnd = new Date("2025-06-15T07:00:00Z");
    expect(isWithinQuietHours(config, exactEnd)).toBe(false);
  });

  it("fails open for invalid time format", () => {
    const config: QuietHoursConfig = {
      enabled: true,
      start: "invalid",
      end: "07:00",
      timezone: "UTC",
    };
    const midday = new Date("2025-06-15T12:00:00Z");
    expect(isWithinQuietHours(config, midday)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseTimeToMinutes
// ---------------------------------------------------------------------------

describe("parseTimeToMinutes", () => {
  it("parses 00:00 to 0", () => {
    expect(parseTimeToMinutes("00:00")).toBe(0);
  });

  it("parses 12:30 to 750", () => {
    expect(parseTimeToMinutes("12:30")).toBe(750);
  });

  it("parses 23:59 to 1439", () => {
    expect(parseTimeToMinutes("23:59")).toBe(1439);
  });

  it("parses single-digit hour (7:00)", () => {
    expect(parseTimeToMinutes("7:00")).toBe(420);
  });

  it("returns null for invalid format", () => {
    expect(parseTimeToMinutes("invalid")).toBeNull();
    expect(parseTimeToMinutes("")).toBeNull();
    expect(parseTimeToMinutes("25:00")).toBeNull();
    expect(parseTimeToMinutes("12:60")).toBeNull();
    expect(parseTimeToMinutes("12:00:00")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getLocalMinutesSinceMidnight
// ---------------------------------------------------------------------------

describe("getLocalMinutesSinceMidnight", () => {
  it("returns UTC minutes for UTC timezone", () => {
    const noon = new Date("2025-06-15T12:00:00Z");
    expect(getLocalMinutesSinceMidnight(noon, "UTC")).toBe(720);
  });

  it("converts to local time for non-UTC timezone", () => {
    // 18:00 UTC = 13:00 CDT (UTC-5 in June)
    const utc6pm = new Date("2025-06-15T18:00:00Z");
    const localMinutes = getLocalMinutesSinceMidnight(utc6pm, "America/Chicago");
    // 13:00 = 780 minutes
    expect(localMinutes).toBe(780);
  });

  it("falls back to UTC for invalid timezone", () => {
    const noon = new Date("2025-06-15T12:00:00Z");
    const result = getLocalMinutesSinceMidnight(noon, "Invalid/Timezone");
    expect(result).toBe(720); // UTC fallback
  });

  it("handles midnight correctly", () => {
    const midnight = new Date("2025-06-15T00:00:00Z");
    expect(getLocalMinutesSinceMidnight(midnight, "UTC")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Deep link paths
// ---------------------------------------------------------------------------

describe("DEFAULT_DEEP_LINK_PATHS", () => {
  it("has a path for every notification type", () => {
    for (const type of NOTIFICATION_TYPES) {
      expect(DEFAULT_DEEP_LINK_PATHS[type]).toBeDefined();
      expect(typeof DEFAULT_DEEP_LINK_PATHS[type]).toBe("string");
      expect(DEFAULT_DEEP_LINK_PATHS[type].startsWith("/")).toBe(true);
    }
  });
});
