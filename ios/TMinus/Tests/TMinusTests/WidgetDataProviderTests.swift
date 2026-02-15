// WidgetDataProviderTests.swift
// T-Minus iOS Tests -- Unit tests for widget data provider (shared storage layer).

import XCTest
@testable import TMinusLib

final class WidgetDataProviderTests: XCTestCase {

    var provider: WidgetDataProvider!
    var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: "com.tminus.test.widget")!
        defaults.removePersistentDomain(forName: "com.tminus.test.widget")
        provider = WidgetDataProvider(defaults: defaults, ttl: 3600)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: "com.tminus.test.widget")
        super.tearDown()
    }

    // MARK: - Read/Write Round-Trip

    func testWriteAndReadEventsRoundTrip() {
        let events = [
            WidgetEventData(
                eventId: "evt_001",
                title: "Team Meeting",
                accountId: "acc_001",
                startDate: Date(timeIntervalSince1970: 1000000),
                endDate: Date(timeIntervalSince1970: 1003600),
                isAllDay: false,
                location: "Room A"
            ),
            WidgetEventData(
                eventId: "evt_002",
                title: "Lunch",
                accountId: "acc_002",
                startDate: Date(timeIntervalSince1970: 1010000),
                endDate: Date(timeIntervalSince1970: 1013600),
                isAllDay: false,
                location: nil
            ),
        ]

        provider.writeWidgetEvents(events)
        let loaded = provider.readEvents()

        XCTAssertEqual(loaded.count, 2)
        XCTAssertEqual(loaded[0].eventId, "evt_001")
        XCTAssertEqual(loaded[0].title, "Team Meeting")
        XCTAssertEqual(loaded[0].accountId, "acc_001")
        XCTAssertEqual(loaded[0].isAllDay, false)
        XCTAssertEqual(loaded[0].location, "Room A")
        XCTAssertEqual(loaded[1].eventId, "evt_002")
        XCTAssertEqual(loaded[1].title, "Lunch")
        XCTAssertEqual(loaded[1].location, nil)
    }

    func testReadReturnsEmptyArrayWhenNoData() {
        let loaded = provider.readEvents()
        XCTAssertEqual(loaded, [])
    }

    // MARK: - Write from CanonicalEvent

    func testWriteFromCanonicalEvents() {
        let canonical = [
            TestFixtures.makeEvent(
                id: "evt_canon_01",
                accountId: "acc_01",
                title: "From Canonical",
                startISO: "2026-02-15T10:00:00Z",
                endISO: "2026-02-15T11:00:00Z"
            )
        ]

        provider.writeEvents(canonical)
        let loaded = provider.readEvents()

        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded[0].eventId, "evt_canon_01")
        XCTAssertEqual(loaded[0].title, "From Canonical")
        XCTAssertEqual(loaded[0].accountId, "acc_01")
        XCTAssertEqual(loaded[0].isAllDay, false)
    }

    func testWriteFromCanonicalAllDayEvent() {
        let canonical = [TestFixtures.makeAllDayEvent(id: "evt_allday", accountId: "acc_02")]
        provider.writeEvents(canonical)
        let loaded = provider.readEvents()

        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded[0].isAllDay, true)
        XCTAssertEqual(loaded[0].title, "Company Holiday")
    }

    func testWriteSkipsEventsWithUnparsableDates() {
        // An event with no start dateTime and no start date
        let badEvent = CanonicalEvent(
            canonicalEventId: "evt_bad",
            originAccountId: "acc_bad",
            originEventId: "origin_bad",
            title: "Bad Event",
            description: nil,
            location: nil,
            start: EventDateTime(dateTime: nil, date: nil, timeZone: nil),
            end: EventDateTime(dateTime: nil, date: nil, timeZone: nil),
            allDay: false,
            status: "confirmed",
            visibility: "default",
            transparency: "opaque",
            recurrenceRule: nil,
            source: "provider",
            version: 1,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z"
        )
        let goodEvent = TestFixtures.makeEvent(id: "evt_good")

        provider.writeEvents([badEvent, goodEvent])
        let loaded = provider.readEvents()

        XCTAssertEqual(loaded.count, 1, "Should skip events with unparsable dates")
        XCTAssertEqual(loaded[0].eventId, "evt_good")
    }

    func testWriteHandlesNilTitle() {
        let event = CanonicalEvent(
            canonicalEventId: "evt_notitle",
            originAccountId: "acc_01",
            originEventId: "origin_01",
            title: nil,
            description: nil,
            location: nil,
            start: EventDateTime(dateTime: "2026-02-15T10:00:00Z", date: nil, timeZone: nil),
            end: EventDateTime(dateTime: "2026-02-15T11:00:00Z", date: nil, timeZone: nil),
            allDay: false,
            status: "confirmed",
            visibility: "default",
            transparency: "opaque",
            recurrenceRule: nil,
            source: "provider",
            version: 1,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z"
        )

        provider.writeEvents([event])
        let loaded = provider.readEvents()

        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded[0].title, "(No title)", "Nil titles should become placeholder text")
    }

    // MARK: - Data Freshness

    func testIsDataFreshReturnsTrueForRecentWrite() {
        let events = [
            WidgetEventData(
                eventId: "evt_fresh",
                title: "Fresh",
                accountId: "acc_01",
                startDate: Date(),
                endDate: Date().addingTimeInterval(3600),
                isAllDay: false,
                location: nil
            )
        ]
        provider.writeWidgetEvents(events)
        XCTAssertTrue(provider.isDataFresh)
    }

    func testIsDataFreshReturnsFalseWhenNoData() {
        XCTAssertFalse(provider.isDataFresh)
    }

    func testIsDataFreshReturnsFalseForExpiredData() {
        // Create provider with 0-second TTL
        let expiredProvider = WidgetDataProvider(defaults: defaults, ttl: 0)
        let events = [
            WidgetEventData(
                eventId: "evt_stale",
                title: "Stale",
                accountId: "acc_01",
                startDate: Date(),
                endDate: Date().addingTimeInterval(3600),
                isAllDay: false,
                location: nil
            )
        ]
        expiredProvider.writeWidgetEvents(events)
        Thread.sleep(forTimeInterval: 0.01)
        XCTAssertFalse(expiredProvider.isDataFresh)
    }

    // MARK: - Last Updated

    func testLastUpdatedIsNilInitially() {
        XCTAssertNil(provider.lastUpdated)
    }

    func testLastUpdatedIsSetAfterWrite() {
        let before = Date()
        provider.writeWidgetEvents([
            WidgetEventData(
                eventId: "evt_1", title: "T", accountId: "a",
                startDate: Date(), endDate: Date().addingTimeInterval(3600),
                isAllDay: false, location: nil
            )
        ])
        let after = Date()
        let lastUpdated = provider.lastUpdated

        XCTAssertNotNil(lastUpdated)
        XCTAssertGreaterThanOrEqual(lastUpdated!, before)
        XCTAssertLessThanOrEqual(lastUpdated!, after)
    }

    // MARK: - Clear Data

    func testClearDataRemovesEverything() {
        provider.writeWidgetEvents([
            WidgetEventData(
                eventId: "evt_1", title: "T", accountId: "a",
                startDate: Date(), endDate: Date().addingTimeInterval(3600),
                isAllDay: false, location: nil
            )
        ])
        XCTAssertFalse(provider.readEvents().isEmpty)
        XCTAssertNotNil(provider.lastUpdated)

        provider.clearData()

        XCTAssertTrue(provider.readEvents().isEmpty)
        XCTAssertNil(provider.lastUpdated)
        XCTAssertFalse(provider.isDataFresh)
    }

    // MARK: - Date Preservation

    func testDateFieldsPreservedExactly() {
        let startDate = Date(timeIntervalSince1970: 1771200000) // Fixed timestamp
        let endDate = Date(timeIntervalSince1970: 1771203600)

        provider.writeWidgetEvents([
            WidgetEventData(
                eventId: "evt_dates",
                title: "Date Test",
                accountId: "acc_01",
                startDate: startDate,
                endDate: endDate,
                isAllDay: false,
                location: nil
            )
        ])

        let loaded = provider.readEvents()
        XCTAssertEqual(loaded[0].startDate.timeIntervalSince1970, startDate.timeIntervalSince1970, accuracy: 1.0)
        XCTAssertEqual(loaded[0].endDate.timeIntervalSince1970, endDate.timeIntervalSince1970, accuracy: 1.0)
    }
}
