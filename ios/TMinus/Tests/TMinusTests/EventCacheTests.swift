// EventCacheTests.swift
// T-Minus iOS Tests -- Unit tests for the offline event cache.

import XCTest
@testable import TMinusLib

final class EventCacheTests: XCTestCase {

    var cache: EventCache!
    var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        // Use a separate suite to avoid polluting standard UserDefaults
        defaults = UserDefaults(suiteName: "com.tminus.test.cache")!
        defaults.removePersistentDomain(forName: "com.tminus.test.cache")
        cache = EventCache(maxAge: 3600, defaults: defaults)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: "com.tminus.test.cache")
        super.tearDown()
    }

    // MARK: - Cache Storage and Retrieval

    func testCacheAndLoadEvents() {
        let range = DateRange(
            start: ISO8601DateFormatter().date(from: "2026-02-01T00:00:00Z")!,
            end: ISO8601DateFormatter().date(from: "2026-03-01T00:00:00Z")!
        )
        let events = TestFixtures.sampleEvents

        cache.cacheEvents(events, for: range)

        let loaded = cache.loadEvents(for: range)
        XCTAssertNotNil(loaded)
        XCTAssertEqual(loaded?.count, events.count)
        XCTAssertEqual(loaded?.first?.canonicalEventId, events.first?.canonicalEventId)
        XCTAssertEqual(loaded?.first?.title, events.first?.title)
    }

    func testLoadReturnsNilForUnknownRange() {
        let range = DateRange(
            start: ISO8601DateFormatter().date(from: "2025-01-01T00:00:00Z")!,
            end: ISO8601DateFormatter().date(from: "2025-02-01T00:00:00Z")!
        )

        let loaded = cache.loadEvents(for: range)
        XCTAssertNil(loaded)
    }

    func testCacheExpiry() {
        // Create a cache with 0-second max age (immediately expired)
        let expiredCache = EventCache(maxAge: 0, defaults: defaults)
        let range = DateRange(
            start: ISO8601DateFormatter().date(from: "2026-02-01T00:00:00Z")!,
            end: ISO8601DateFormatter().date(from: "2026-03-01T00:00:00Z")!
        )

        expiredCache.cacheEvents(TestFixtures.sampleEvents, for: range)

        // Tiny delay to ensure expiry
        Thread.sleep(forTimeInterval: 0.01)

        let loaded = expiredCache.loadEvents(for: range)
        XCTAssertNil(loaded, "Expired cache entries should return nil")
    }

    func testIsCacheValidReturnsTrueForFreshEntry() {
        let range = DateRange(
            start: ISO8601DateFormatter().date(from: "2026-02-01T00:00:00Z")!,
            end: ISO8601DateFormatter().date(from: "2026-03-01T00:00:00Z")!
        )

        cache.cacheEvents(TestFixtures.sampleEvents, for: range)
        XCTAssertTrue(cache.isCacheValid(for: range))
    }

    func testIsCacheValidReturnsFalseForExpiredEntry() {
        let expiredCache = EventCache(maxAge: 0, defaults: defaults)
        let range = DateRange(
            start: ISO8601DateFormatter().date(from: "2026-02-01T00:00:00Z")!,
            end: ISO8601DateFormatter().date(from: "2026-03-01T00:00:00Z")!
        )

        expiredCache.cacheEvents(TestFixtures.sampleEvents, for: range)
        Thread.sleep(forTimeInterval: 0.01)

        XCTAssertFalse(expiredCache.isCacheValid(for: range))
    }

    func testIsCacheValidReturnsFalseForMissingEntry() {
        let range = DateRange(
            start: ISO8601DateFormatter().date(from: "2025-01-01T00:00:00Z")!,
            end: ISO8601DateFormatter().date(from: "2025-02-01T00:00:00Z")!
        )
        XCTAssertFalse(cache.isCacheValid(for: range))
    }

    // MARK: - Cache Clear

    func testClearCacheRemovesAllEntries() {
        let range = DateRange(
            start: ISO8601DateFormatter().date(from: "2026-02-01T00:00:00Z")!,
            end: ISO8601DateFormatter().date(from: "2026-03-01T00:00:00Z")!
        )

        cache.cacheEvents(TestFixtures.sampleEvents, for: range)
        XCTAssertNotNil(cache.loadEvents(for: range))

        cache.clearCache()
        XCTAssertNil(cache.loadEvents(for: range))
    }

    // MARK: - Last Sync Date

    func testLastSyncDateIsNilInitially() {
        XCTAssertNil(cache.lastSyncDate)
    }

    func testLastSyncDateUpdatesAfterCaching() {
        let range = DateRange(
            start: ISO8601DateFormatter().date(from: "2026-02-01T00:00:00Z")!,
            end: ISO8601DateFormatter().date(from: "2026-03-01T00:00:00Z")!
        )

        let before = Date()
        cache.cacheEvents(TestFixtures.sampleEvents, for: range)
        let after = Date()

        let syncDate = cache.lastSyncDate
        XCTAssertNotNil(syncDate)
        XCTAssertGreaterThanOrEqual(syncDate!, before)
        XCTAssertLessThanOrEqual(syncDate!, after)
    }

    // MARK: - Event Field Preservation

    func testCachedEventPreservesAllFields() {
        let original = TestFixtures.makeEvent(
            id: "evt_FIELDS",
            accountId: "acc_FIELDS",
            title: "Field Test"
        )
        let range = DateRange(
            start: ISO8601DateFormatter().date(from: "2026-02-01T00:00:00Z")!,
            end: ISO8601DateFormatter().date(from: "2026-03-01T00:00:00Z")!
        )

        cache.cacheEvents([original], for: range)
        let loaded = cache.loadEvents(for: range)!.first!

        XCTAssertEqual(loaded.canonicalEventId, original.canonicalEventId)
        XCTAssertEqual(loaded.originAccountId, original.originAccountId)
        XCTAssertEqual(loaded.originEventId, original.originEventId)
        XCTAssertEqual(loaded.title, original.title)
        XCTAssertEqual(loaded.description, original.description)
        XCTAssertEqual(loaded.location, original.location)
        XCTAssertEqual(loaded.allDay, original.allDay)
        XCTAssertEqual(loaded.status, original.status)
        XCTAssertEqual(loaded.visibility, original.visibility)
        XCTAssertEqual(loaded.transparency, original.transparency)
        XCTAssertEqual(loaded.source, original.source)
        XCTAssertEqual(loaded.version, original.version)
        XCTAssertEqual(loaded.start, original.start)
        XCTAssertEqual(loaded.end, original.end)
    }

    // MARK: - DateRange

    func testDateRangeCacheKeyIsStable() {
        let range1 = DateRange(
            start: ISO8601DateFormatter().date(from: "2026-02-01T00:00:00Z")!,
            end: ISO8601DateFormatter().date(from: "2026-03-01T00:00:00Z")!
        )
        let range2 = DateRange(
            start: ISO8601DateFormatter().date(from: "2026-02-01T00:00:00Z")!,
            end: ISO8601DateFormatter().date(from: "2026-03-01T00:00:00Z")!
        )
        XCTAssertEqual(range1.cacheKey, range2.cacheKey)
    }

    func testDifferentRangesHaveDifferentKeys() {
        let range1 = DateRange(
            start: ISO8601DateFormatter().date(from: "2026-02-01T00:00:00Z")!,
            end: ISO8601DateFormatter().date(from: "2026-03-01T00:00:00Z")!
        )
        let range2 = DateRange(
            start: ISO8601DateFormatter().date(from: "2026-03-01T00:00:00Z")!,
            end: ISO8601DateFormatter().date(from: "2026-04-01T00:00:00Z")!
        )
        XCTAssertNotEqual(range1.cacheKey, range2.cacheKey)
    }
}
