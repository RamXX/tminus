/**
 * @tminus/shared -- Push notification types and utilities.
 *
 * Defines the notification type taxonomy, payload construction,
 * user preference model, and quiet hours enforcement logic.
 *
 * Design decisions:
 * - Five notification types map to distinct system events
 * - Quiet hours are timezone-aware (user's local time)
 * - Payload construction is pure and testable
 * - Deep link URLs follow a consistent tminus:// scheme
 */

// ---------------------------------------------------------------------------
// Notification types
// ---------------------------------------------------------------------------

/**
 * The five notification types supported by T-Minus.
 * Each maps to a specific system event and deep link target.
 */
export type NotificationType =
  | "drift_alert"
  | "reconnection_suggestion"
  | "scheduling_proposal"
  | "risk_warning"
  | "hold_expiry";

/**
 * All valid notification type values, for runtime validation.
 */
export const NOTIFICATION_TYPES: readonly NotificationType[] = [
  "drift_alert",
  "reconnection_suggestion",
  "scheduling_proposal",
  "risk_warning",
  "hold_expiry",
] as const;

/**
 * Validates a string is a valid NotificationType.
 */
export function isValidNotificationType(value: string): value is NotificationType {
  return NOTIFICATION_TYPES.includes(value as NotificationType);
}

// ---------------------------------------------------------------------------
// Push message (queue message shape)
// ---------------------------------------------------------------------------

/**
 * Message shape for the push-queue. Producers enqueue these;
 * the push worker consumes and delivers to APNs/FCM.
 */
export interface PushMessage {
  /** Target user to receive the notification. */
  readonly user_id: string;
  /** Notification type for routing and preference checks. */
  readonly notification_type: NotificationType;
  /** Human-readable title for the notification banner. */
  readonly title: string;
  /** Human-readable body text for the notification. */
  readonly body: string;
  /** Deep link path (e.g., "/drift/rel_xxx" or "/schedule/sess_xxx"). */
  readonly deep_link_path: string;
  /** Optional metadata for the notification payload. */
  readonly metadata?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// APNs payload
// ---------------------------------------------------------------------------

/**
 * APNs notification payload (simplified for HTTP/2 API).
 * Follows Apple's Notification Payload Reference.
 */
export interface APNsPayload {
  readonly aps: {
    readonly alert: {
      readonly title: string;
      readonly body: string;
    };
    /** Badge count. Null clears the badge. */
    readonly badge?: number;
    /** Sound file name. "default" uses the system sound. */
    readonly sound?: string;
    /** Category for actionable notifications. */
    readonly category?: string;
    /** Thread identifier for notification grouping. */
    readonly "thread-id"?: string;
  };
  /** Custom data passed through to the app. */
  readonly notification_type: NotificationType;
  readonly deep_link: string;
  readonly metadata?: Record<string, string>;
}

/**
 * Builds an APNs payload from a PushMessage.
 * Pure function -- no side effects.
 */
export function buildAPNsPayload(message: PushMessage): APNsPayload {
  return {
    aps: {
      alert: {
        title: message.title,
        body: message.body,
      },
      sound: "default",
      category: message.notification_type,
      "thread-id": `tminus-${message.notification_type}`,
    },
    notification_type: message.notification_type,
    deep_link: `tminus://${message.deep_link_path}`,
    metadata: message.metadata,
  };
}

// ---------------------------------------------------------------------------
// Deep link mapping
// ---------------------------------------------------------------------------

/**
 * Maps notification types to their default deep link screen.
 * Used when the producer does not supply a specific deep_link_path.
 */
export const DEFAULT_DEEP_LINK_PATHS: Readonly<Record<NotificationType, string>> = {
  drift_alert: "/drift",
  reconnection_suggestion: "/relationships",
  scheduling_proposal: "/schedule",
  risk_warning: "/dashboard",
  hold_expiry: "/schedule/holds",
} as const;

// ---------------------------------------------------------------------------
// User notification preferences
// ---------------------------------------------------------------------------

/**
 * Per-notification-type preference stored in UserGraphDO SQLite.
 */
export interface NotificationPreference {
  /** Whether this notification type is enabled. */
  readonly enabled: boolean;
}

/**
 * Complete notification settings for a user.
 * Stored as a JSON blob in UserGraphDO's notification_preferences table.
 */
export interface NotificationSettings {
  /** Per-type enable/disable toggles. */
  readonly preferences: Readonly<Record<NotificationType, NotificationPreference>>;
  /** Quiet hours configuration. */
  readonly quiet_hours: QuietHoursConfig;
}

/**
 * Quiet hours configuration.
 * When enabled, notifications are suppressed during the specified window.
 */
export interface QuietHoursConfig {
  /** Whether quiet hours are active. */
  readonly enabled: boolean;
  /** Start time in HH:MM 24-hour format (e.g., "22:00"). */
  readonly start: string;
  /** End time in HH:MM 24-hour format (e.g., "07:00"). */
  readonly end: string;
  /** IANA timezone identifier (e.g., "America/Chicago"). */
  readonly timezone: string;
}

/**
 * Default notification settings for new users.
 * All types enabled, quiet hours disabled.
 */
export function defaultNotificationSettings(): NotificationSettings {
  return {
    preferences: {
      drift_alert: { enabled: true },
      reconnection_suggestion: { enabled: true },
      scheduling_proposal: { enabled: true },
      risk_warning: { enabled: true },
      hold_expiry: { enabled: true },
    },
    quiet_hours: {
      enabled: false,
      start: "22:00",
      end: "07:00",
      timezone: "UTC",
    },
  };
}

// ---------------------------------------------------------------------------
// Preference filtering
// ---------------------------------------------------------------------------

/**
 * Checks whether a notification should be delivered based on user preferences.
 * Returns true if the notification is allowed, false if it should be suppressed.
 *
 * Suppression reasons:
 * 1. Notification type is disabled in user preferences
 * 2. Current time falls within quiet hours
 */
export function shouldDeliverNotification(
  settings: NotificationSettings,
  notificationType: NotificationType,
  nowUtc: Date,
): boolean {
  // Check type-level preference
  const pref = settings.preferences[notificationType];
  if (!pref || !pref.enabled) {
    return false;
  }

  // Check quiet hours
  if (settings.quiet_hours.enabled) {
    if (isWithinQuietHours(settings.quiet_hours, nowUtc)) {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Quiet hours logic
// ---------------------------------------------------------------------------

/**
 * Determines if the given UTC time falls within the user's quiet hours.
 *
 * Handles overnight windows (e.g., 22:00 -> 07:00) by checking
 * if the window crosses midnight.
 *
 * @param config - Quiet hours configuration with start, end, and timezone.
 * @param nowUtc - Current time in UTC.
 * @returns true if the current local time is within quiet hours.
 */
export function isWithinQuietHours(
  config: QuietHoursConfig,
  nowUtc: Date,
): boolean {
  if (!config.enabled) {
    return false;
  }

  // Convert UTC time to user's local time
  const localMinutes = getLocalMinutesSinceMidnight(nowUtc, config.timezone);

  const startMinutes = parseTimeToMinutes(config.start);
  const endMinutes = parseTimeToMinutes(config.end);

  if (startMinutes === null || endMinutes === null) {
    // Invalid time format -- fail open (do not suppress)
    return false;
  }

  // Same-day window (e.g., 09:00 -> 17:00)
  if (startMinutes <= endMinutes) {
    return localMinutes >= startMinutes && localMinutes < endMinutes;
  }

  // Overnight window (e.g., 22:00 -> 07:00)
  // Active from start to midnight, and midnight to end
  return localMinutes >= startMinutes || localMinutes < endMinutes;
}

/**
 * Parses a "HH:MM" time string to minutes since midnight.
 * Returns null for invalid formats.
 */
export function parseTimeToMinutes(time: string): number | null {
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  return hours * 60 + minutes;
}

/**
 * Converts a UTC Date to minutes since midnight in the given timezone.
 *
 * Uses Intl.DateTimeFormat to perform timezone conversion without
 * external dependencies (available in Cloudflare Workers runtime).
 */
export function getLocalMinutesSinceMidnight(
  utcDate: Date,
  timezone: string,
): number {
  try {
    // Use Intl.DateTimeFormat to extract local hour and minute
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    });

    const parts = formatter.formatToParts(utcDate);
    let hour = 0;
    let minute = 0;

    for (const part of parts) {
      if (part.type === "hour") {
        hour = parseInt(part.value, 10);
        // Intl.DateTimeFormat with hour12: false can return 24 for midnight
        if (hour === 24) hour = 0;
      }
      if (part.type === "minute") {
        minute = parseInt(part.value, 10);
      }
    }

    return hour * 60 + minute;
  } catch {
    // Invalid timezone -- fall back to UTC
    return utcDate.getUTCHours() * 60 + utcDate.getUTCMinutes();
  }
}

// ---------------------------------------------------------------------------
// Device token management types
// ---------------------------------------------------------------------------

/** Platform identifier for device tokens. */
export type DevicePlatform = "ios" | "android" | "web";

/** Device token row shape (mirrors D1 device_tokens table). */
export interface DeviceTokenRow {
  readonly token_id: string;
  readonly user_id: string;
  readonly device_token: string;
  readonly platform: DevicePlatform;
  readonly created_at: string;
  readonly updated_at: string;
}
