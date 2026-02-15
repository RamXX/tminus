// WidgetTimelineLogicTests.swift
// T-Minus iOS Tests -- Unit tests for widget timeline computation logic.

import XCTest
@testable import TMinusLib

final class WidgetTimelineLogicTests: XCTestCase {

    // Use a fixed reference date for deterministic tests: 2026-02-15 10:00 UTC
    let referenceDate = ISO8601DateFormatter().date(from: "2026-02-15T10:00:00Z")!
    let calendar: Calendar = {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        return cal
    }()

    // MARK: - Test Fixtures

    func makeWidgetEvent(
        id: String,
        title: String,
        accountId: String = "acc_01",
        startHour: Int,
        startMinute: Int = 0,
        durationMinutes: Int = 60,
        isAllDay: Bool = false,
        location: String? = nil
    ) -> WidgetEventData {
        var startComponents = DateComponents()
        startComponents.year = 2026
        startComponents.month = 2
        startComponents.day = 15
        startComponents.hour = startHour
        startComponents.minute = startMinute
        startComponents.timeZone = TimeZone(identifier: "UTC")

        let start = calendar.date(from: startComponents)!
        let end = start.addingTimeInterval(TimeInterval(durationMinutes * 60))

        return WidgetEventData(
            eventId: id,
            title: title,
            accountId: accountId,
            startDate: start,
            endDate: end,
            isAllDay: isAllDay,
            location: location
        )
    }

    func makeTomorrowEvent(id: String, title: String) -> WidgetEventData {
        var components = DateComponents()
        components.year = 2026
        components.month = 2
        components.day = 16
        components.hour = 9
        components.timeZone = TimeZone(identifier: "UTC")

        let start = calendar.date(from: components)!
        let end = start.addingTimeInterval(3600)

        return WidgetEventData(
            eventId: id, title: title, accountId: "acc_01",
            startDate: start, endDate: end,
            isAllDay: false, location: nil
        )
    }

    func makeYesterdayEvent(id: String, title: String) -> WidgetEventData {
        var components = DateComponents()
        components.year = 2026
        components.month = 2
        components.day = 14
        components.hour = 9
        components.timeZone = TimeZone(identifier: "UTC")

        let start = calendar.date(from: components)!
        let end = start.addingTimeInterval(3600)

        return WidgetEventData(
            eventId: id, title: title, accountId: "acc_01",
            startDate: start, endDate: end,
            isAllDay: false, location: nil
        )
    }

    // MARK: - eventsForToday

    func testEventsForTodayFiltersTodayOnly() {
        let events = [
            makeWidgetEvent(id: "e1", title: "Morning", startHour: 8),
            makeWidgetEvent(id: "e2", title: "Afternoon", startHour: 14),
            makeTomorrowEvent(id: "e3", title: "Tomorrow"),
            makeYesterdayEvent(id: "e4", title: "Yesterday"),
        ]

        let today = WidgetTimelineLogic.eventsForToday(
            from: events, referenceDate: referenceDate, calendar: calendar
        )

        XCTAssertEqual(today.count, 2)
        XCTAssertEqual(today[0].eventId, "e1")
        XCTAssertEqual(today[1].eventId, "e2")
    }

    func testEventsForTodaySortsAllDayFirst() {
        let events = [
            makeWidgetEvent(id: "timed", title: "Meeting", startHour: 9),
            makeWidgetEvent(id: "allday", title: "Holiday", startHour: 0, durationMinutes: 1440, isAllDay: true),
        ]

        let today = WidgetTimelineLogic.eventsForToday(
            from: events, referenceDate: referenceDate, calendar: calendar
        )

        XCTAssertEqual(today.count, 2)
        XCTAssertEqual(today[0].eventId, "allday", "All-day events should come first")
        XCTAssertEqual(today[1].eventId, "timed")
    }

    func testEventsForTodaySortsChronologically() {
        let events = [
            makeWidgetEvent(id: "late", title: "Late", startHour: 16),
            makeWidgetEvent(id: "early", title: "Early", startHour: 8),
            makeWidgetEvent(id: "mid", title: "Mid", startHour: 12),
        ]

        let today = WidgetTimelineLogic.eventsForToday(
            from: events, referenceDate: referenceDate, calendar: calendar
        )

        XCTAssertEqual(today.map(\.eventId), ["early", "mid", "late"])
    }

    func testEventsForTodayIncludesSpanningEvents() {
        // An event that started yesterday and ends today
        var startComponents = DateComponents()
        startComponents.year = 2026
        startComponents.month = 2
        startComponents.day = 14
        startComponents.hour = 22
        startComponents.timeZone = TimeZone(identifier: "UTC")

        let start = calendar.date(from: startComponents)!
        let end = start.addingTimeInterval(14 * 3600) // Ends Feb 15 at 12:00

        let spanning = WidgetEventData(
            eventId: "spanning", title: "Multi-day",
            accountId: "acc_01",
            startDate: start, endDate: end,
            isAllDay: false, location: nil
        )

        let today = WidgetTimelineLogic.eventsForToday(
            from: [spanning], referenceDate: referenceDate, calendar: calendar
        )

        XCTAssertEqual(today.count, 1, "Events spanning into today should be included")
        XCTAssertEqual(today[0].eventId, "spanning")
    }

    func testEventsForTodayReturnsEmptyForNoEvents() {
        let today = WidgetTimelineLogic.eventsForToday(
            from: [], referenceDate: referenceDate, calendar: calendar
        )
        XCTAssertTrue(today.isEmpty)
    }

    func testEventsForTodayExcludesEndedEvents() {
        // Event that ended yesterday
        let yesterday = makeYesterdayEvent(id: "ended", title: "Ended Yesterday")
        let today = WidgetTimelineLogic.eventsForToday(
            from: [yesterday], referenceDate: referenceDate, calendar: calendar
        )
        XCTAssertTrue(today.isEmpty)
    }

    // MARK: - nextUpcomingEvents

    func testNextUpcomingEventsReturnsRequestedCount() {
        let events = [
            makeWidgetEvent(id: "e1", title: "First", startHour: 11),
            makeWidgetEvent(id: "e2", title: "Second", startHour: 13),
            makeWidgetEvent(id: "e3", title: "Third", startHour: 15),
            makeWidgetEvent(id: "e4", title: "Fourth", startHour: 17),
        ]

        let next3 = WidgetTimelineLogic.nextUpcomingEvents(
            from: events, count: 3, referenceDate: referenceDate, calendar: calendar
        )

        XCTAssertEqual(next3.count, 3)
        XCTAssertEqual(next3[0].eventId, "e1")
        XCTAssertEqual(next3[1].eventId, "e2")
        XCTAssertEqual(next3[2].eventId, "e3")
    }

    func testNextUpcomingEventsReturnsFewerIfNotEnough() {
        let events = [
            makeWidgetEvent(id: "e1", title: "Only One", startHour: 11),
        ]

        let next3 = WidgetTimelineLogic.nextUpcomingEvents(
            from: events, count: 3, referenceDate: referenceDate, calendar: calendar
        )

        XCTAssertEqual(next3.count, 1)
    }

    func testNextUpcomingEventsExcludesEndedEvents() {
        let events = [
            makeWidgetEvent(id: "past", title: "Already Over", startHour: 8, durationMinutes: 60),
            // This event ended at 9:00, reference is 10:00 -- should be excluded
            makeWidgetEvent(id: "future", title: "Coming Up", startHour: 11),
        ]

        let upcoming = WidgetTimelineLogic.nextUpcomingEvents(
            from: events, count: 3, referenceDate: referenceDate, calendar: calendar
        )

        XCTAssertEqual(upcoming.count, 1)
        XCTAssertEqual(upcoming[0].eventId, "future")
    }

    func testNextUpcomingEventsIncludesCurrentlyRunningEvents() {
        // Event started at 9:30, ends at 10:30 -- currently running at 10:00
        let events = [
            makeWidgetEvent(id: "running", title: "In Progress", startHour: 9, startMinute: 30),
        ]

        let upcoming = WidgetTimelineLogic.nextUpcomingEvents(
            from: events, count: 1, referenceDate: referenceDate, calendar: calendar
        )

        XCTAssertEqual(upcoming.count, 1)
        XCTAssertEqual(upcoming[0].eventId, "running")
    }

    func testNextUpcomingEventsExcludesTomorrowEvents() {
        let events = [
            makeTomorrowEvent(id: "tomorrow", title: "Tomorrow"),
        ]

        let upcoming = WidgetTimelineLogic.nextUpcomingEvents(
            from: events, count: 3, referenceDate: referenceDate, calendar: calendar
        )

        XCTAssertTrue(upcoming.isEmpty, "Tomorrow's events should not appear in upcoming")
    }

    func testNextUpcomingEventsAllDayFirst() {
        let events = [
            makeWidgetEvent(id: "timed", title: "Meeting", startHour: 11),
            makeWidgetEvent(id: "allday", title: "Holiday", startHour: 0, durationMinutes: 1440, isAllDay: true),
        ]

        let upcoming = WidgetTimelineLogic.nextUpcomingEvents(
            from: events, count: 3, referenceDate: referenceDate, calendar: calendar
        )

        XCTAssertEqual(upcoming[0].eventId, "allday", "All-day events should be listed first")
    }

    // MARK: - eventCount

    func testEventCountForSmall() {
        XCTAssertEqual(WidgetTimelineLogic.eventCount(for: .small), 1)
    }

    func testEventCountForMedium() {
        XCTAssertEqual(WidgetTimelineLogic.eventCount(for: .medium), 3)
    }

    func testEventCountForLarge() {
        XCTAssertEqual(WidgetTimelineLogic.eventCount(for: .large), 10)
    }

    // MARK: - Snapshot Generation

    func testSnapshotSmallShowsOneEvent() {
        let events = [
            makeWidgetEvent(id: "e1", title: "First", startHour: 11),
            makeWidgetEvent(id: "e2", title: "Second", startHour: 13),
        ]

        let snap = WidgetTimelineLogic.snapshot(
            for: .small, events: events,
            referenceDate: referenceDate, isStale: false, lastUpdated: nil,
            calendar: calendar
        )

        XCTAssertEqual(snap.events.count, 1)
        XCTAssertEqual(snap.events[0].eventId, "e1")
        XCTAssertFalse(snap.isStale)
    }

    func testSnapshotMediumShowsThreeEvents() {
        let events = [
            makeWidgetEvent(id: "e1", title: "First", startHour: 11),
            makeWidgetEvent(id: "e2", title: "Second", startHour: 13),
            makeWidgetEvent(id: "e3", title: "Third", startHour: 15),
            makeWidgetEvent(id: "e4", title: "Fourth", startHour: 17),
        ]

        let snap = WidgetTimelineLogic.snapshot(
            for: .medium, events: events,
            referenceDate: referenceDate, isStale: false, lastUpdated: nil,
            calendar: calendar
        )

        XCTAssertEqual(snap.events.count, 3)
    }

    func testSnapshotLargeShowsAllTodayEvents() {
        let events = [
            makeWidgetEvent(id: "e1", title: "Morning", startHour: 8),
            makeWidgetEvent(id: "e2", title: "Midday", startHour: 12),
            makeWidgetEvent(id: "e3", title: "Afternoon", startHour: 14),
            makeWidgetEvent(id: "e4", title: "Evening", startHour: 18),
            makeTomorrowEvent(id: "e5", title: "Tomorrow"),
        ]

        let snap = WidgetTimelineLogic.snapshot(
            for: .large, events: events,
            referenceDate: referenceDate, isStale: false, lastUpdated: nil,
            calendar: calendar
        )

        // Should include 4 today events (not tomorrow), including the 8am one that already passed
        XCTAssertEqual(snap.events.count, 4)
        XCTAssertFalse(snap.events.contains(where: { $0.eventId == "e5" }))
    }

    func testSnapshotPreservesStaleFlag() {
        let snap = WidgetTimelineLogic.snapshot(
            for: .small, events: [],
            referenceDate: referenceDate, isStale: true, lastUpdated: nil,
            calendar: calendar
        )
        XCTAssertTrue(snap.isStale)
    }

    func testSnapshotIncludesLastUpdatedString() {
        let tenMinAgo = referenceDate.addingTimeInterval(-600)
        let snap = WidgetTimelineLogic.snapshot(
            for: .small, events: [],
            referenceDate: referenceDate, isStale: false, lastUpdated: tenMinAgo,
            calendar: calendar
        )
        XCTAssertNotNil(snap.lastUpdatedString)
        // RelativeDateTimeFormatter will produce something like "10 min. ago"
        XCTAssertFalse(snap.lastUpdatedString!.isEmpty)
    }

    func testSnapshotLastUpdatedNilWhenNoTimestamp() {
        let snap = WidgetTimelineLogic.snapshot(
            for: .small, events: [],
            referenceDate: referenceDate, isStale: false, lastUpdated: nil,
            calendar: calendar
        )
        XCTAssertNil(snap.lastUpdatedString)
    }

    func testSnapshotDateMatchesReference() {
        let snap = WidgetTimelineLogic.snapshot(
            for: .small, events: [],
            referenceDate: referenceDate, calendar: calendar
        )
        XCTAssertEqual(snap.date, referenceDate)
    }

    // MARK: - Next Refresh Date

    func testNextRefreshDateBeforeUpcomingEvent() {
        let events = [
            makeWidgetEvent(id: "e1", title: "Soon", startHour: 10, startMinute: 30),
        ]

        let refresh = WidgetTimelineLogic.nextRefreshDate(
            events: events, referenceDate: referenceDate, calendar: calendar
        )

        // Event at 10:30, reference at 10:00.
        // 5 min before event = 10:25. That's > referenceDate + 60s, so should be ~10:25
        let expectedRefresh = ISO8601DateFormatter().date(from: "2026-02-15T10:25:00Z")!
        XCTAssertEqual(refresh.timeIntervalSince1970, expectedRefresh.timeIntervalSince1970, accuracy: 1.0)
    }

    func testNextRefreshDateCapsAtOneHour() {
        // No upcoming events -- should default to 1 hour
        let events: [WidgetEventData] = []

        let refresh = WidgetTimelineLogic.nextRefreshDate(
            events: events, referenceDate: referenceDate, calendar: calendar
        )

        let oneHourLater = referenceDate.addingTimeInterval(3600)
        XCTAssertEqual(refresh.timeIntervalSince1970, oneHourLater.timeIntervalSince1970, accuracy: 1.0)
    }

    func testNextRefreshDateIgnoresAllDayEvents() {
        let events = [
            makeWidgetEvent(id: "allday", title: "Holiday", startHour: 0, durationMinutes: 1440, isAllDay: true),
        ]

        let refresh = WidgetTimelineLogic.nextRefreshDate(
            events: events, referenceDate: referenceDate, calendar: calendar
        )

        // Should be 1 hour since all-day events are excluded from refresh calculation
        let oneHourLater = referenceDate.addingTimeInterval(3600)
        XCTAssertEqual(refresh.timeIntervalSince1970, oneHourLater.timeIntervalSince1970, accuracy: 1.0)
    }

    func testNextRefreshDateForVeryCloseEvent() {
        // Event starts in 2 minutes -- should use referenceDate + 60s minimum
        let events = [
            makeWidgetEvent(id: "imminent", title: "Starting Now", startHour: 10, startMinute: 2),
        ]

        let refresh = WidgetTimelineLogic.nextRefreshDate(
            events: events, referenceDate: referenceDate, calendar: calendar
        )

        let minRefresh = referenceDate.addingTimeInterval(60)
        XCTAssertGreaterThanOrEqual(refresh.timeIntervalSince1970, minRefresh.timeIntervalSince1970)
    }

    func testNextRefreshDateIgnoresPastEvents() {
        let events = [
            makeWidgetEvent(id: "past", title: "Already Started", startHour: 9),
        ]

        let refresh = WidgetTimelineLogic.nextRefreshDate(
            events: events, referenceDate: referenceDate, calendar: calendar
        )

        // Past event ignored, defaults to 1 hour
        let oneHourLater = referenceDate.addingTimeInterval(3600)
        XCTAssertEqual(refresh.timeIntervalSince1970, oneHourLater.timeIntervalSince1970, accuracy: 1.0)
    }

    // MARK: - Timeline Entries

    func testTimelineEntriesIncludesCurrentAndFutureSnapshots() {
        let events = [
            makeWidgetEvent(id: "e1", title: "Now", startHour: 10),
            makeWidgetEvent(id: "e2", title: "Later", startHour: 13),
            makeWidgetEvent(id: "e3", title: "Evening", startHour: 17),
        ]

        let entries = WidgetTimelineLogic.timelineEntries(
            for: .small, events: events,
            referenceDate: referenceDate, isStale: false, lastUpdated: nil,
            calendar: calendar
        )

        XCTAssertGreaterThanOrEqual(entries.count, 1, "Must have at least the current snapshot")
        XCTAssertEqual(entries[0].date, referenceDate, "First entry is at reference date")

        // Should have additional entries at future event start times
        if entries.count > 1 {
            XCTAssertGreaterThan(entries[1].date, referenceDate)
        }
    }

    func testTimelineEntriesForEmptyEventsHasSingleEntry() {
        let entries = WidgetTimelineLogic.timelineEntries(
            for: .medium, events: [],
            referenceDate: referenceDate, calendar: calendar
        )

        XCTAssertEqual(entries.count, 1)
        XCTAssertTrue(entries[0].events.isEmpty)
    }

    func testTimelineEntriesDoNotIncludePastEventStarts() {
        let events = [
            makeWidgetEvent(id: "past", title: "Past", startHour: 8),
            makeWidgetEvent(id: "future", title: "Future", startHour: 14),
        ]

        let entries = WidgetTimelineLogic.timelineEntries(
            for: .small, events: events,
            referenceDate: referenceDate, calendar: calendar
        )

        // All entry dates should be >= referenceDate
        for entry in entries {
            XCTAssertGreaterThanOrEqual(entry.date, referenceDate)
        }
    }

    // MARK: - WidgetSize

    func testWidgetSizeHasThreeCases() {
        XCTAssertEqual(WidgetSize.allCases.count, 3)
        XCTAssertTrue(WidgetSize.allCases.contains(.small))
        XCTAssertTrue(WidgetSize.allCases.contains(.medium))
        XCTAssertTrue(WidgetSize.allCases.contains(.large))
    }
}
