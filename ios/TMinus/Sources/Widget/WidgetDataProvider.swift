// WidgetDataProvider.swift
// T-Minus iOS -- Shared data layer for widget and app.
//
// Reads and writes event data via a shared App Group UserDefaults container.
// The main app writes events after each sync; the widget extension reads them.
//
// Design:
// - Data is stored as JSON-encoded [WidgetEventData] under a well-known key.
// - TTL-based validity (default 1 hour) so the widget shows stale indicators.
// - Thread-safe reads/writes via value types and atomic UserDefaults operations.

import Foundation

// MARK: - App Group Configuration

/// Well-known constants for App Group data sharing between the main app and widget.
enum WidgetConstants {
    /// App Group suite name for shared UserDefaults.
    /// Must match the App Group entitlement on both targets.
    static let appGroupId = "group.com.tminus.ios"

    /// UserDefaults key for the cached widget event data.
    static let eventsKey = "tminus_widget_events"

    /// UserDefaults key for the timestamp when events were last written.
    static let lastUpdatedKey = "tminus_widget_last_updated"

    /// Default TTL for widget data validity (1 hour).
    static let defaultTTL: TimeInterval = 3600

    /// URL scheme for deep links from widget to app.
    static let urlScheme = "tminus"
}

// MARK: - Widget Event Data

/// Lightweight, Codable representation of an event for widget display.
/// Smaller than CanonicalEvent -- only the fields the widget needs.
struct WidgetEventData: Codable, Equatable, Identifiable {
    let eventId: String
    let title: String
    let accountId: String
    let startDate: Date
    let endDate: Date
    let isAllDay: Bool
    let location: String?

    var id: String { eventId }

    /// Display-friendly time string for widget rendering.
    var timeDisplayString: String {
        if isAllDay { return "All day" }
        let fmt = DateFormatter()
        fmt.timeStyle = .short
        fmt.dateStyle = .none
        return fmt.string(from: startDate)
    }

    /// Deep link URL that opens this event in the main app.
    var deepLinkURL: URL {
        DeepLinkGenerator.eventURL(eventId: eventId)
    }
}

// MARK: - Deep Link Generator

/// Generates deep link URLs for widget tap actions.
enum DeepLinkGenerator {

    /// URL that opens the main app to a specific event's detail view.
    static func eventURL(eventId: String) -> URL {
        // Percent-encode the event ID to handle special characters safely.
        let encoded = eventId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? eventId
        return URL(string: "\(WidgetConstants.urlScheme)://event/\(encoded)")!
    }

    /// URL that opens the main app's today view (no specific event).
    static func todayURL() -> URL {
        URL(string: "\(WidgetConstants.urlScheme)://today")!
    }

    /// Parses an incoming deep link URL and returns the event ID if present.
    /// Returns nil for non-event URLs or malformed links.
    static func parseEventId(from url: URL) -> String? {
        guard url.scheme == WidgetConstants.urlScheme,
              url.host == "event" else {
            return nil
        }
        // The path is "/{eventId}" -- strip the leading slash.
        let path = url.path
        let eventId = path.hasPrefix("/") ? String(path.dropFirst()) : path
        guard !eventId.isEmpty else { return nil }
        // Decode percent-encoding.
        return eventId.removingPercentEncoding
    }
}

// MARK: - Widget Data Provider

/// Reads and writes widget event data to the shared App Group UserDefaults.
/// The main app calls `writeEvents(_:)` after each sync. The widget extension
/// calls `readEvents()` when building its timeline.
final class WidgetDataProvider {

    private let defaults: UserDefaults
    private let ttl: TimeInterval

    /// Initialize with a UserDefaults instance (defaults to the App Group suite).
    /// Pass a custom `UserDefaults` in tests for isolation.
    init(
        defaults: UserDefaults? = nil,
        ttl: TimeInterval = WidgetConstants.defaultTTL
    ) {
        self.defaults = defaults ?? UserDefaults(suiteName: WidgetConstants.appGroupId) ?? .standard
        self.ttl = ttl
    }

    // MARK: - Write (called by the main app)

    /// Persist events for the widget to consume.
    /// Converts CanonicalEvent array to lightweight WidgetEventData.
    func writeEvents(_ events: [CanonicalEvent]) {
        let widgetEvents = events.compactMap { event -> WidgetEventData? in
            guard let start = event.startDate, let end = event.endDate else { return nil }
            return WidgetEventData(
                eventId: event.canonicalEventId,
                title: event.title ?? "(No title)",
                accountId: event.originAccountId,
                startDate: start,
                endDate: end,
                isAllDay: event.allDay,
                location: event.location
            )
        }
        writeWidgetEvents(widgetEvents)
    }

    /// Persist pre-formatted WidgetEventData array directly.
    func writeWidgetEvents(_ events: [WidgetEventData]) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        guard let data = try? encoder.encode(events) else { return }
        defaults.set(data, forKey: WidgetConstants.eventsKey)
        defaults.set(Date().timeIntervalSince1970, forKey: WidgetConstants.lastUpdatedKey)
    }

    // MARK: - Read (called by the widget)

    /// Load all cached widget events. Returns empty array if none stored.
    func readEvents() -> [WidgetEventData] {
        guard let data = defaults.data(forKey: WidgetConstants.eventsKey) else {
            return []
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return (try? decoder.decode([WidgetEventData].self, from: data)) ?? []
    }

    /// Whether the cached data is still within the TTL window.
    var isDataFresh: Bool {
        let ts = defaults.double(forKey: WidgetConstants.lastUpdatedKey)
        guard ts > 0 else { return false }
        let lastUpdated = Date(timeIntervalSince1970: ts)
        return Date().timeIntervalSince(lastUpdated) <= ttl
    }

    /// Timestamp of the last data write, or nil if never written.
    var lastUpdated: Date? {
        let ts = defaults.double(forKey: WidgetConstants.lastUpdatedKey)
        return ts > 0 ? Date(timeIntervalSince1970: ts) : nil
    }

    /// Clear all widget data from the shared container.
    func clearData() {
        defaults.removeObject(forKey: WidgetConstants.eventsKey)
        defaults.removeObject(forKey: WidgetConstants.lastUpdatedKey)
    }
}
