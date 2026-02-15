// WidgetIntegrationTests.swift
// T-Minus iOS Tests -- Integration tests for the widget data flow.
//
// These tests exercise the full pipeline without mocks:
// CanonicalEvent -> WidgetDataProvider.writeEvents() -> readEvents() ->
// WidgetTimelineLogic -> WidgetSnapshot
//
// This proves the entire widget stack works end-to-end.

import XCTest
@testable import TMinusLib

final class WidgetIntegrationTests: XCTestCase {

    var provider: WidgetDataProvider!
    var defaults: UserDefaults!
    let calendar: Calendar = {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        return cal
    }()

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: "com.tminus.test.widget.integration")!
        defaults.removePersistentDomain(forName: "com.tminus.test.widget.integration")
        provider = WidgetDataProvider(defaults: defaults, ttl: 3600)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: "com.tminus.test.widget.integration")
        super.tearDown()
    }

    // MARK: - Full Pipeline: Canonical -> Widget Display

    func testFullPipelineCanonicalToSmallWidget() {
        // 1. Create CanonicalEvents (as if fetched from the API)
        let canonicalEvents = [
            TestFixtures.makeEvent(
                id: "evt_meeting",
                accountId: "acc_work",
                title: "Design Review",
                startISO: "2026-02-15T14:00:00Z",
                endISO: "2026-02-15T15:00:00Z"
            ),
            TestFixtures.makeEvent(
                id: "evt_standup",
                accountId: "acc_personal",
                title: "Morning Standup",
                startISO: "2026-02-15T09:00:00Z",
                endISO: "2026-02-15T09:30:00Z"
            ),
        ]

        // 2. Write to shared container (as the main app would)
        provider.writeEvents(canonicalEvents)

        // 3. Read back (as the widget extension would)
        let widgetEvents = provider.readEvents()
        XCTAssertEqual(widgetEvents.count, 2, "Both events should persist through the pipeline")

        // 4. Generate small widget snapshot at 10:00 (after standup ended)
        let refDate = ISO8601DateFormatter().date(from: "2026-02-15T10:00:00Z")!
        let snapshot = WidgetTimelineLogic.snapshot(
            for: .small,
            events: widgetEvents,
            referenceDate: refDate,
            isStale: !provider.isDataFresh,
            lastUpdated: provider.lastUpdated,
            calendar: calendar
        )

        // 5. Verify: small widget should show the Design Review (next upcoming)
        XCTAssertEqual(snapshot.events.count, 1)
        XCTAssertEqual(snapshot.events[0].title, "Design Review")
        XCTAssertEqual(snapshot.events[0].accountId, "acc_work")
        XCTAssertFalse(snapshot.isStale)
        XCTAssertNotNil(snapshot.lastUpdatedString)
    }

    func testFullPipelineCanonicalToMediumWidget() {
        let canonicalEvents = [
            TestFixtures.makeEvent(
                id: "evt_1", accountId: "acc_01", title: "Team Sync",
                startISO: "2026-02-15T10:00:00Z", endISO: "2026-02-15T10:30:00Z"
            ),
            TestFixtures.makeEvent(
                id: "evt_2", accountId: "acc_02", title: "Lunch",
                startISO: "2026-02-15T12:00:00Z", endISO: "2026-02-15T13:00:00Z"
            ),
            TestFixtures.makeEvent(
                id: "evt_3", accountId: "acc_01", title: "Code Review",
                startISO: "2026-02-15T14:00:00Z", endISO: "2026-02-15T15:00:00Z"
            ),
            TestFixtures.makeEvent(
                id: "evt_4", accountId: "acc_02", title: "1:1",
                startISO: "2026-02-15T16:00:00Z", endISO: "2026-02-15T16:30:00Z"
            ),
        ]

        provider.writeEvents(canonicalEvents)
        let widgetEvents = provider.readEvents()

        let refDate = ISO8601DateFormatter().date(from: "2026-02-15T09:00:00Z")!
        let snapshot = WidgetTimelineLogic.snapshot(
            for: .medium,
            events: widgetEvents,
            referenceDate: refDate,
            calendar: calendar
        )

        // Medium shows next 3 upcoming events
        XCTAssertEqual(snapshot.events.count, 3)
        XCTAssertEqual(snapshot.events[0].title, "Team Sync")
        XCTAssertEqual(snapshot.events[1].title, "Lunch")
        XCTAssertEqual(snapshot.events[2].title, "Code Review")
    }

    func testFullPipelineCanonicalToLargeWidget() {
        let canonicalEvents = [
            TestFixtures.makeAllDayEvent(id: "evt_holiday", accountId: "acc_01", title: "Holiday"),
            TestFixtures.makeEvent(
                id: "evt_am", accountId: "acc_01", title: "Morning Meeting",
                startISO: "2026-02-15T09:00:00Z", endISO: "2026-02-15T10:00:00Z"
            ),
            TestFixtures.makeEvent(
                id: "evt_pm", accountId: "acc_02", title: "Afternoon Session",
                startISO: "2026-02-15T14:00:00Z", endISO: "2026-02-15T16:00:00Z"
            ),
            // Tomorrow's event should be excluded
            TestFixtures.makeEvent(
                id: "evt_tomorrow", accountId: "acc_01", title: "Tomorrow Thing",
                startISO: "2026-02-16T09:00:00Z", endISO: "2026-02-16T10:00:00Z"
            ),
        ]

        provider.writeEvents(canonicalEvents)
        let widgetEvents = provider.readEvents()

        let refDate = ISO8601DateFormatter().date(from: "2026-02-15T08:00:00Z")!
        let snapshot = WidgetTimelineLogic.snapshot(
            for: .large,
            events: widgetEvents,
            referenceDate: refDate,
            calendar: calendar
        )

        // Large shows today's full schedule: holiday + 2 meetings = 3, no tomorrow
        XCTAssertEqual(snapshot.events.count, 3)
        XCTAssertEqual(snapshot.events[0].title, "Holiday") // All-day first
        XCTAssertFalse(snapshot.events.contains(where: { $0.title == "Tomorrow Thing" }))
    }

    // MARK: - Account Color Coding Through Pipeline

    func testAccountColorCodingPreservedThroughPipeline() {
        let canonicalEvents = [
            TestFixtures.makeEvent(
                id: "evt_work", accountId: "acc_work_google",
                title: "Work Event", startISO: "2026-02-15T10:00:00Z", endISO: "2026-02-15T11:00:00Z"
            ),
            TestFixtures.makeEvent(
                id: "evt_personal", accountId: "acc_personal_outlook",
                title: "Personal Event", startISO: "2026-02-15T14:00:00Z", endISO: "2026-02-15T15:00:00Z"
            ),
        ]

        provider.writeEvents(canonicalEvents)
        let widgetEvents = provider.readEvents()

        // Account IDs must survive the pipeline so AccountColors.color(for:) works
        let workEvent = widgetEvents.first(where: { $0.eventId == "evt_work" })!
        let personalEvent = widgetEvents.first(where: { $0.eventId == "evt_personal" })!

        XCTAssertEqual(workEvent.accountId, "acc_work_google")
        XCTAssertEqual(personalEvent.accountId, "acc_personal_outlook")

        // Verify that different accounts produce different colors
        let workColor = AccountColors.color(for: workEvent.accountId)
        let personalColor = AccountColors.color(for: personalEvent.accountId)
        XCTAssertNotEqual(workColor, personalColor, "Different accounts should have different colors")
    }

    // MARK: - Deep Link Through Pipeline

    func testDeepLinkRoundTripThroughPipeline() {
        let canonicalEvents = [
            TestFixtures.makeEvent(
                id: "evt_deeplink_test", accountId: "acc_01",
                title: "Tap Me", startISO: "2026-02-15T10:00:00Z", endISO: "2026-02-15T11:00:00Z"
            ),
        ]

        provider.writeEvents(canonicalEvents)
        let widgetEvents = provider.readEvents()
        let event = widgetEvents[0]

        // Generate deep link as the widget would
        let url = event.deepLinkURL

        // Parse it as the main app would on tap
        let parsedEventId = DeepLinkGenerator.parseEventId(from: url)

        XCTAssertEqual(parsedEventId, "evt_deeplink_test",
                       "Event ID must survive write -> read -> deep link -> parse round trip")
    }

    // MARK: - Timeline Entries Through Pipeline

    func testTimelineEntriesProducedFromRealData() {
        let canonicalEvents = TestFixtures.sampleEvents

        provider.writeEvents(canonicalEvents)
        let widgetEvents = provider.readEvents()

        let refDate = ISO8601DateFormatter().date(from: "2026-02-15T08:00:00Z")!
        let entries = WidgetTimelineLogic.timelineEntries(
            for: .medium,
            events: widgetEvents,
            referenceDate: refDate,
            isStale: false,
            lastUpdated: provider.lastUpdated,
            calendar: calendar
        )

        XCTAssertGreaterThanOrEqual(entries.count, 1, "Timeline must have at least one entry")

        // First entry should be at reference date
        XCTAssertEqual(entries[0].date, refDate)

        // Should have events in the first entry (sample events include today's events)
        XCTAssertGreaterThan(entries[0].events.count, 0, "First entry should have upcoming events")
    }

    // MARK: - Stale Data Detection

    func testStaleDataDetectionThroughPipeline() {
        // Provider with 0-second TTL -- data is immediately stale
        let staleProvider = WidgetDataProvider(defaults: defaults, ttl: 0)

        let canonicalEvents = [
            TestFixtures.makeEvent(
                id: "evt_stale", accountId: "acc_01",
                title: "Stale Event", startISO: "2026-02-15T10:00:00Z", endISO: "2026-02-15T11:00:00Z"
            ),
        ]

        staleProvider.writeEvents(canonicalEvents)
        Thread.sleep(forTimeInterval: 0.01) // Ensure TTL passes

        let widgetEvents = staleProvider.readEvents()
        let isStale = !staleProvider.isDataFresh

        XCTAssertTrue(isStale, "Data should be stale after TTL passes")
        XCTAssertFalse(widgetEvents.isEmpty, "Stale data should still be readable")

        let refDate = ISO8601DateFormatter().date(from: "2026-02-15T09:00:00Z")!
        let snapshot = WidgetTimelineLogic.snapshot(
            for: .small,
            events: widgetEvents,
            referenceDate: refDate,
            isStale: isStale,
            calendar: calendar
        )

        XCTAssertTrue(snapshot.isStale, "Snapshot should reflect stale state")
        XCTAssertEqual(snapshot.events.count, 1, "Stale snapshot should still show events")
    }

    // MARK: - Empty State

    func testEmptyStateThroughPipeline() {
        // No events written
        let widgetEvents = provider.readEvents()
        XCTAssertTrue(widgetEvents.isEmpty)

        let refDate = ISO8601DateFormatter().date(from: "2026-02-15T10:00:00Z")!

        for size in WidgetSize.allCases {
            let snapshot = WidgetTimelineLogic.snapshot(
                for: size,
                events: widgetEvents,
                referenceDate: refDate,
                isStale: true,
                calendar: calendar
            )
            XCTAssertTrue(snapshot.events.isEmpty, "Empty state for \(size) should have no events")
        }
    }

    // MARK: - Background Refresh Timing

    func testRefreshDateComputedFromPipelineData() {
        // Use an event 30 minutes from reference so the 5-min-before logic
        // falls within the 1-hour cap window.
        let canonicalEvents = [
            TestFixtures.makeEvent(
                id: "evt_1", accountId: "acc_01", title: "Meeting",
                startISO: "2026-02-15T10:30:00Z", endISO: "2026-02-15T11:30:00Z"
            ),
        ]

        provider.writeEvents(canonicalEvents)
        let widgetEvents = provider.readEvents()

        let refDate = ISO8601DateFormatter().date(from: "2026-02-15T10:00:00Z")!
        let refreshDate = WidgetTimelineLogic.nextRefreshDate(
            events: widgetEvents, referenceDate: refDate, calendar: calendar
        )

        // Meeting at 10:30 -> 5 min before = 10:25, which is within the 1-hour cap
        let expectedRefresh = ISO8601DateFormatter().date(from: "2026-02-15T10:25:00Z")!
        XCTAssertEqual(refreshDate.timeIntervalSince1970, expectedRefresh.timeIntervalSince1970, accuracy: 2.0)
        XCTAssertGreaterThan(refreshDate, refDate, "Refresh should be in the future")
    }

    func testRefreshDateCapsAtOneHourForDistantEvent() {
        // Event 4 hours away -- the 5-min-before logic exceeds the 1-hour cap
        let canonicalEvents = [
            TestFixtures.makeEvent(
                id: "evt_far", accountId: "acc_01", title: "Far Meeting",
                startISO: "2026-02-15T14:00:00Z", endISO: "2026-02-15T15:00:00Z"
            ),
        ]

        provider.writeEvents(canonicalEvents)
        let widgetEvents = provider.readEvents()

        let refDate = ISO8601DateFormatter().date(from: "2026-02-15T10:00:00Z")!
        let refreshDate = WidgetTimelineLogic.nextRefreshDate(
            events: widgetEvents, referenceDate: refDate, calendar: calendar
        )

        // 5 min before 14:00 = 13:55, but cap at 1 hour = 11:00
        let oneHourLater = refDate.addingTimeInterval(3600)
        XCTAssertEqual(refreshDate.timeIntervalSince1970, oneHourLater.timeIntervalSince1970, accuracy: 2.0)
    }
}
