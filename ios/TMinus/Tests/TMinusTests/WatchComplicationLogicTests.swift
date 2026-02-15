// WatchComplicationLogicTests.swift
// T-Minus iOS Tests -- Unit tests for Apple Watch complication data logic.
//
// Tests the pure computation layer that produces complication data:
// - Next event extraction (time + title)
// - Free time remaining today
// - Meeting count for today
// - Complication template data for circular, rectangular, inline families
// - Edge cases: no events, all-day events, events already in progress

import XCTest
@testable import TMinusLib

final class WatchComplicationLogicTests: XCTestCase {

    // Fixed reference date: 2026-02-15 10:00 UTC
    let referenceDate = ISO8601DateFormatter().date(from: "2026-02-15T10:00:00Z")!
    let calendar: Calendar = {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        return cal
    }()

    // MARK: - Test Fixtures

    func makeEvent(
        id: String,
        title: String,
        accountId: String = "acc_01",
        startHour: Int,
        startMinute: Int = 0,
        durationMinutes: Int = 60,
        isAllDay: Bool = false,
        location: String? = nil
    ) -> WidgetEventData {
        var components = DateComponents()
        components.year = 2026
        components.month = 2
        components.day = 15
        components.hour = startHour
        components.minute = startMinute
        components.timeZone = TimeZone(identifier: "UTC")

        let start = calendar.date(from: components)!
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

    // MARK: - nextEvent

    func testNextEventReturnsUpcomingEvent() {
        let events = [
            makeEvent(id: "e1", title: "Standup", startHour: 11),
            makeEvent(id: "e2", title: "Lunch", startHour: 12),
        ]

        let next = WatchComplicationLogic.nextEvent(
            from: events, referenceDate: referenceDate, calendar: calendar
        )

        XCTAssertNotNil(next)
        XCTAssertEqual(next?.eventId, "e1")
        XCTAssertEqual(next?.title, "Standup")
    }

    func testNextEventSkipsEndedEvents() {
        let events = [
            makeEvent(id: "past", title: "Done", startHour: 8, durationMinutes: 60),
            makeEvent(id: "future", title: "Coming", startHour: 14),
        ]

        let next = WatchComplicationLogic.nextEvent(
            from: events, referenceDate: referenceDate, calendar: calendar
        )

        XCTAssertNotNil(next)
        XCTAssertEqual(next?.eventId, "future")
    }

    func testNextEventReturnsCurrentlyRunningEvent() {
        // Event started at 9:30, ends at 10:30 -- currently in progress at 10:00
        let events = [
            makeEvent(id: "running", title: "In Progress", startHour: 9, startMinute: 30),
        ]

        let next = WatchComplicationLogic.nextEvent(
            from: events, referenceDate: referenceDate, calendar: calendar
        )

        XCTAssertNotNil(next)
        XCTAssertEqual(next?.eventId, "running")
    }

    func testNextEventReturnsNilWhenNoEvents() {
        let next = WatchComplicationLogic.nextEvent(
            from: [], referenceDate: referenceDate, calendar: calendar
        )
        XCTAssertNil(next)
    }

    func testNextEventReturnsNilWhenAllEventsEnded() {
        let events = [
            makeEvent(id: "done1", title: "Done 1", startHour: 7, durationMinutes: 60),
            makeEvent(id: "done2", title: "Done 2", startHour: 8, durationMinutes: 60),
        ]

        let next = WatchComplicationLogic.nextEvent(
            from: events, referenceDate: referenceDate, calendar: calendar
        )

        XCTAssertNil(next)
    }

    func testNextEventExcludesTomorrow() {
        let events = [
            makeTomorrowEvent(id: "tomorrow", title: "Tomorrow Event"),
        ]

        let next = WatchComplicationLogic.nextEvent(
            from: events, referenceDate: referenceDate, calendar: calendar
        )

        XCTAssertNil(next, "Next event should only include today's events")
    }

    func testNextEventSkipsAllDayEventsForTimedDisplay() {
        let events = [
            makeEvent(id: "allday", title: "Holiday", startHour: 0, durationMinutes: 1440, isAllDay: true),
            makeEvent(id: "timed", title: "Meeting", startHour: 11),
        ]

        let next = WatchComplicationLogic.nextEvent(
            from: events, referenceDate: referenceDate, calendar: calendar
        )

        // For the "next event" complication, timed events are more useful than all-day
        XCTAssertNotNil(next)
        XCTAssertEqual(next?.eventId, "timed")
    }

    // MARK: - freeTimeRemainingToday

    func testFreeTimeRemainingWithNoEvents() {
        let freeMinutes = WatchComplicationLogic.freeTimeRemainingToday(
            from: [], referenceDate: referenceDate, calendar: calendar
        )

        // From 10:00 to midnight = 14 hours = 840 minutes
        XCTAssertEqual(freeMinutes, 840)
    }

    func testFreeTimeRemainingSubtractsMeetings() {
        let events = [
            makeEvent(id: "e1", title: "Meeting 1", startHour: 11, durationMinutes: 60),
            makeEvent(id: "e2", title: "Meeting 2", startHour: 14, durationMinutes: 30),
        ]

        let freeMinutes = WatchComplicationLogic.freeTimeRemainingToday(
            from: events, referenceDate: referenceDate, calendar: calendar
        )

        // From 10:00 to midnight = 840 min, minus 60+30 = 90 min of meetings
        XCTAssertEqual(freeMinutes, 750)
    }

    func testFreeTimeRemainingExcludesAllDayEvents() {
        let events = [
            makeEvent(id: "allday", title: "Holiday", startHour: 0, durationMinutes: 1440, isAllDay: true),
        ]

        let freeMinutes = WatchComplicationLogic.freeTimeRemainingToday(
            from: events, referenceDate: referenceDate, calendar: calendar
        )

        // All-day events don't count as busy time
        XCTAssertEqual(freeMinutes, 840)
    }

    func testFreeTimeRemainingHandlesOverlappingMeetings() {
        let events = [
            makeEvent(id: "e1", title: "Meeting A", startHour: 11, durationMinutes: 60),
            // Overlaps with e1: starts at 11:30, ends at 12:30
            makeEvent(id: "e2", title: "Meeting B", startHour: 11, startMinute: 30, durationMinutes: 60),
        ]

        let freeMinutes = WatchComplicationLogic.freeTimeRemainingToday(
            from: events, referenceDate: referenceDate, calendar: calendar
        )

        // Merged busy: 11:00-12:30 = 90 min. Free = 840 - 90 = 750
        XCTAssertEqual(freeMinutes, 750)
    }

    func testFreeTimeRemainingOnlyCountsFutureTime() {
        // An event that already started at 9:00 and runs until 10:30
        let events = [
            makeEvent(id: "running", title: "Running", startHour: 9, durationMinutes: 90),
        ]

        let freeMinutes = WatchComplicationLogic.freeTimeRemainingToday(
            from: events, referenceDate: referenceDate, calendar: calendar
        )

        // Running event occupies 10:00-10:30 of remaining time = 30 min busy
        // Free = 840 - 30 = 810
        XCTAssertEqual(freeMinutes, 810)
    }

    func testFreeTimeRemainingExcludesTomorrowEvents() {
        let events = [
            makeTomorrowEvent(id: "tomorrow", title: "Tomorrow"),
        ]

        let freeMinutes = WatchComplicationLogic.freeTimeRemainingToday(
            from: events, referenceDate: referenceDate, calendar: calendar
        )

        XCTAssertEqual(freeMinutes, 840)
    }

    func testFreeTimeRemainingHandlesAlreadyEndedEvents() {
        let events = [
            makeEvent(id: "past", title: "Past", startHour: 7, durationMinutes: 60),
        ]

        let freeMinutes = WatchComplicationLogic.freeTimeRemainingToday(
            from: events, referenceDate: referenceDate, calendar: calendar
        )

        // Past event fully before reference time, does not reduce free time
        XCTAssertEqual(freeMinutes, 840)
    }

    // MARK: - meetingCountToday

    func testMeetingCountTodayWithEvents() {
        let events = [
            makeEvent(id: "e1", title: "Standup", startHour: 9),
            makeEvent(id: "e2", title: "Design", startHour: 11),
            makeEvent(id: "e3", title: "Review", startHour: 14),
        ]

        let count = WatchComplicationLogic.meetingCountToday(
            from: events, referenceDate: referenceDate, calendar: calendar
        )

        XCTAssertEqual(count, 3)
    }

    func testMeetingCountTodayExcludesAllDayEvents() {
        let events = [
            makeEvent(id: "allday", title: "Holiday", startHour: 0, durationMinutes: 1440, isAllDay: true),
            makeEvent(id: "meeting", title: "Meeting", startHour: 11),
        ]

        let count = WatchComplicationLogic.meetingCountToday(
            from: events, referenceDate: referenceDate, calendar: calendar
        )

        XCTAssertEqual(count, 1, "All-day events should not count as meetings")
    }

    func testMeetingCountTodayExcludesTomorrow() {
        let events = [
            makeEvent(id: "today", title: "Today", startHour: 11),
            makeTomorrowEvent(id: "tomorrow", title: "Tomorrow"),
        ]

        let count = WatchComplicationLogic.meetingCountToday(
            from: events, referenceDate: referenceDate, calendar: calendar
        )

        XCTAssertEqual(count, 1)
    }

    func testMeetingCountTodayReturnsZeroForEmpty() {
        let count = WatchComplicationLogic.meetingCountToday(
            from: [], referenceDate: referenceDate, calendar: calendar
        )

        XCTAssertEqual(count, 0)
    }

    func testMeetingCountTodayIncludesPastMeetings() {
        // Meeting count is for the whole day, including past events
        let events = [
            makeEvent(id: "past", title: "Past", startHour: 8),
            makeEvent(id: "future", title: "Future", startHour: 14),
        ]

        let count = WatchComplicationLogic.meetingCountToday(
            from: events, referenceDate: referenceDate, calendar: calendar
        )

        XCTAssertEqual(count, 2, "Meeting count includes past meetings for the day")
    }

    // MARK: - Complication Data

    func testCircularComplicationDataWithEvent() {
        let events = [
            makeEvent(id: "e1", title: "Team Standup", startHour: 11),
        ]

        let data = WatchComplicationLogic.complicationData(
            family: .circular,
            events: events,
            referenceDate: referenceDate,
            calendar: calendar
        )

        XCTAssertEqual(data.family, .circular)
        XCTAssertNotNil(data.nextEventTime)
        XCTAssertEqual(data.meetingCount, 1)
    }

    func testCircularComplicationDataNoEvents() {
        let data = WatchComplicationLogic.complicationData(
            family: .circular,
            events: [],
            referenceDate: referenceDate,
            calendar: calendar
        )

        XCTAssertEqual(data.family, .circular)
        XCTAssertNil(data.nextEventTime)
        XCTAssertNil(data.nextEventTitle)
        XCTAssertEqual(data.meetingCount, 0)
    }

    func testRectangularComplicationDataShowsTitleAndTime() {
        let events = [
            makeEvent(id: "e1", title: "Design Review", startHour: 14, location: "Room B"),
        ]

        let data = WatchComplicationLogic.complicationData(
            family: .rectangular,
            events: events,
            referenceDate: referenceDate,
            calendar: calendar
        )

        XCTAssertEqual(data.family, .rectangular)
        XCTAssertEqual(data.nextEventTitle, "Design Review")
        XCTAssertNotNil(data.nextEventTime)
        XCTAssertGreaterThan(data.freeTimeMinutes, 0)
    }

    func testInlineComplicationDataCompact() {
        let events = [
            makeEvent(id: "e1", title: "Very Long Event Title That Should Be Truncated", startHour: 11),
        ]

        let data = WatchComplicationLogic.complicationData(
            family: .inline,
            events: events,
            referenceDate: referenceDate,
            calendar: calendar
        )

        XCTAssertEqual(data.family, .inline)
        XCTAssertNotNil(data.nextEventTitle)
        XCTAssertNotNil(data.nextEventTime)
    }

    func testComplicationDataIncludesFreeTime() {
        let events = [
            makeEvent(id: "e1", title: "Meeting", startHour: 11, durationMinutes: 60),
        ]

        let data = WatchComplicationLogic.complicationData(
            family: .rectangular,
            events: events,
            referenceDate: referenceDate,
            calendar: calendar
        )

        // 840 total minutes - 60 min meeting = 780 min free
        XCTAssertEqual(data.freeTimeMinutes, 780)
    }

    func testComplicationDataIncludesMeetingCount() {
        let events = [
            makeEvent(id: "e1", title: "A", startHour: 11),
            makeEvent(id: "e2", title: "B", startHour: 14),
            makeEvent(id: "e3", title: "C", startHour: 16),
        ]

        let data = WatchComplicationLogic.complicationData(
            family: .circular,
            events: events,
            referenceDate: referenceDate,
            calendar: calendar
        )

        XCTAssertEqual(data.meetingCount, 3)
    }

    // MARK: - Complication Family Enum

    func testAllComplicationFamilies() {
        XCTAssertEqual(ComplicationFamily.allCases.count, 3)
        XCTAssertTrue(ComplicationFamily.allCases.contains(.circular))
        XCTAssertTrue(ComplicationFamily.allCases.contains(.rectangular))
        XCTAssertTrue(ComplicationFamily.allCases.contains(.inline))
    }

    // MARK: - Display Strings

    func testFreeTimeDisplayStringHoursAndMinutes() {
        let display = WatchComplicationLogic.freeTimeDisplayString(minutes: 150)
        XCTAssertEqual(display, "2h 30m free")
    }

    func testFreeTimeDisplayStringHoursOnly() {
        let display = WatchComplicationLogic.freeTimeDisplayString(minutes: 120)
        XCTAssertEqual(display, "2h free")
    }

    func testFreeTimeDisplayStringMinutesOnly() {
        let display = WatchComplicationLogic.freeTimeDisplayString(minutes: 45)
        XCTAssertEqual(display, "45m free")
    }

    func testFreeTimeDisplayStringZero() {
        let display = WatchComplicationLogic.freeTimeDisplayString(minutes: 0)
        XCTAssertEqual(display, "0m free")
    }

    func testMeetingCountDisplayStringPlural() {
        let display = WatchComplicationLogic.meetingCountDisplayString(count: 3)
        XCTAssertEqual(display, "3 meetings")
    }

    func testMeetingCountDisplayStringSingular() {
        let display = WatchComplicationLogic.meetingCountDisplayString(count: 1)
        XCTAssertEqual(display, "1 meeting")
    }

    func testMeetingCountDisplayStringZero() {
        let display = WatchComplicationLogic.meetingCountDisplayString(count: 0)
        XCTAssertEqual(display, "No meetings")
    }

    func testNextEventTimeDisplayString() {
        let event = makeEvent(id: "e1", title: "Test", startHour: 14, startMinute: 30)
        let display = WatchComplicationLogic.nextEventTimeDisplay(
            for: event, referenceDate: referenceDate
        )

        // Event is 4.5 hours away -- should show "in 4h 30m"
        XCTAssertEqual(display, "in 4h 30m")
    }

    func testNextEventTimeDisplaySoon() {
        let event = makeEvent(id: "e1", title: "Test", startHour: 10, startMinute: 5)
        let display = WatchComplicationLogic.nextEventTimeDisplay(
            for: event, referenceDate: referenceDate
        )

        // 5 minutes away -- should show "in 5m"
        XCTAssertEqual(display, "in 5m")
    }

    func testNextEventTimeDisplayNow() {
        // Event already started, still running
        let event = makeEvent(id: "e1", title: "Test", startHour: 9, startMinute: 30)
        let display = WatchComplicationLogic.nextEventTimeDisplay(
            for: event, referenceDate: referenceDate
        )

        XCTAssertEqual(display, "now")
    }
}
