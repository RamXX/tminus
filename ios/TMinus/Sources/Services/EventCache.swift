// EventCache.swift
// T-Minus iOS -- Offline cache for calendar events using UserDefaults.
//
// For the walking skeleton, we use a lightweight UserDefaults-based cache
// instead of Core Data. This keeps complexity minimal while proving the
// offline story. The cache stores JSON-encoded events keyed by date range.
//
// Design:
// - Events are stored as JSON in UserDefaults (App Group for widget sharing later)
// - Cache entries expire after 1 hour (configurable)
// - On sync, cache is updated atomically
// - On offline, cached events are served transparently

import Foundation

/// Protocol for event caching, enabling test mocking.
protocol EventCacheProtocol {
    func cacheEvents(_ events: [CanonicalEvent], for range: DateRange)
    func loadEvents(for range: DateRange) -> [CanonicalEvent]?
    func isCacheValid(for range: DateRange) -> Bool
    func clearCache()
    var lastSyncDate: Date? { get }
}

/// A date range key for cache lookups.
struct DateRange: Hashable {
    let start: Date
    let end: Date

    /// Stable string key for storage.
    var cacheKey: String {
        let iso = ISO8601DateFormatter()
        return "events_\(iso.string(from: start))_\(iso.string(from: end))"
    }
}

/// Cached entry wrapping events with a timestamp.
private struct CachedEvents: Codable {
    let events: [CachedEvent]
    let cachedAt: Date
}

/// Codable representation of a CanonicalEvent for cache storage.
/// We re-encode rather than storing raw API JSON to ensure type safety.
struct CachedEvent: Codable, Equatable {
    let canonicalEventId: String
    let originAccountId: String
    let originEventId: String
    let title: String?
    let description: String?
    let location: String?
    let startDateTime: String?
    let startDate: String?
    let startTimeZone: String?
    let endDateTime: String?
    let endDate: String?
    let endTimeZone: String?
    let allDay: Bool
    let status: String
    let visibility: String
    let transparency: String
    let recurrenceRule: String?
    let source: String
    let version: Int
    let createdAt: String
    let updatedAt: String
}

/// Production event cache backed by UserDefaults.
final class EventCache: EventCacheProtocol {

    /// How long cached events remain valid (seconds).
    let maxAge: TimeInterval

    /// UserDefaults instance (could be App Group for widget sharing).
    private let defaults: UserDefaults

    /// JSON encoder/decoder for cache serialization.
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(
        maxAge: TimeInterval = 3600, // 1 hour default
        defaults: UserDefaults = .standard
    ) {
        self.maxAge = maxAge
        self.defaults = defaults
    }

    func cacheEvents(_ events: [CanonicalEvent], for range: DateRange) {
        let cached = CachedEvents(
            events: events.map { toCachedEvent($0) },
            cachedAt: Date()
        )

        if let data = try? encoder.encode(cached) {
            defaults.set(data, forKey: range.cacheKey)
            defaults.set(Date().timeIntervalSince1970, forKey: "tminus_last_sync")
        }
    }

    func loadEvents(for range: DateRange) -> [CanonicalEvent]? {
        guard let data = defaults.data(forKey: range.cacheKey),
              let cached = try? decoder.decode(CachedEvents.self, from: data) else {
            return nil
        }

        // Check expiry
        if Date().timeIntervalSince(cached.cachedAt) > maxAge {
            return nil
        }

        return cached.events.map { fromCachedEvent($0) }
    }

    func isCacheValid(for range: DateRange) -> Bool {
        guard let data = defaults.data(forKey: range.cacheKey),
              let cached = try? decoder.decode(CachedEvents.self, from: data) else {
            return false
        }
        return Date().timeIntervalSince(cached.cachedAt) <= maxAge
    }

    func clearCache() {
        // Remove all tminus-prefixed keys
        let dict = defaults.dictionaryRepresentation()
        for key in dict.keys where key.hasPrefix("events_") || key.hasPrefix("tminus_") {
            defaults.removeObject(forKey: key)
        }
    }

    var lastSyncDate: Date? {
        let ts = defaults.double(forKey: "tminus_last_sync")
        return ts > 0 ? Date(timeIntervalSince1970: ts) : nil
    }

    // MARK: - Mapping

    private func toCachedEvent(_ event: CanonicalEvent) -> CachedEvent {
        CachedEvent(
            canonicalEventId: event.canonicalEventId,
            originAccountId: event.originAccountId,
            originEventId: event.originEventId,
            title: event.title,
            description: event.description,
            location: event.location,
            startDateTime: event.start.dateTime,
            startDate: event.start.date,
            startTimeZone: event.start.timeZone,
            endDateTime: event.end.dateTime,
            endDate: event.end.date,
            endTimeZone: event.end.timeZone,
            allDay: event.allDay,
            status: event.status,
            visibility: event.visibility,
            transparency: event.transparency,
            recurrenceRule: event.recurrenceRule,
            source: event.source,
            version: event.version,
            createdAt: event.createdAt,
            updatedAt: event.updatedAt
        )
    }

    private func fromCachedEvent(_ cached: CachedEvent) -> CanonicalEvent {
        CanonicalEvent(
            canonicalEventId: cached.canonicalEventId,
            originAccountId: cached.originAccountId,
            originEventId: cached.originEventId,
            title: cached.title,
            description: cached.description,
            location: cached.location,
            start: EventDateTime(
                dateTime: cached.startDateTime,
                date: cached.startDate,
                timeZone: cached.startTimeZone
            ),
            end: EventDateTime(
                dateTime: cached.endDateTime,
                date: cached.endDate,
                timeZone: cached.endTimeZone
            ),
            allDay: cached.allDay,
            status: cached.status,
            visibility: cached.visibility,
            transparency: cached.transparency,
            recurrenceRule: cached.recurrenceRule,
            source: cached.source,
            version: cached.version,
            createdAt: cached.createdAt,
            updatedAt: cached.updatedAt
        )
    }
}
