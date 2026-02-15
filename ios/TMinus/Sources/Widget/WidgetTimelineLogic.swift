// WidgetTimelineLogic.swift
// T-Minus iOS -- Pure-logic timeline computation for the widget.
//
// This file contains all the business logic for computing widget timelines
// WITHOUT importing WidgetKit. This allows full unit testing via `swift test`.
// The actual WidgetKit TimelineProvider delegates to these functions.
//
// Responsibilities:
// - Filter events for "today" based on a reference date
// - Sort events chronologically
// - Compute next-N events for small/medium widget sizes
// - Compute full day schedule for large widget size
// - Compute timeline refresh dates

import Foundation

// MARK: - Widget Size Abstraction

/// Abstraction over WidgetKit's WidgetFamily so tests don't need the framework.
enum WidgetSize: String, CaseIterable {
    case small
    case medium
    case large
}

// MARK: - Widget Timeline Entry (Framework-Independent)

/// A single snapshot of widget state at a point in time.
/// Maps 1:1 to a WidgetKit TimelineEntry but without the framework dependency.
struct WidgetSnapshot: Equatable {
    /// The date this snapshot represents (for WidgetKit's timeline scheduling).
    let date: Date

    /// Events to display in this snapshot.
    let events: [WidgetEventData]

    /// Whether the underlying data is stale (past TTL).
    let isStale: Bool

    /// Human-readable "last updated" string, or nil if unknown.
    let lastUpdatedString: String?
}

// MARK: - Timeline Logic

/// Pure functions for computing widget timeline data. No side effects, no framework imports.
enum WidgetTimelineLogic {

    // MARK: - Event Filtering

    /// Returns events occurring on the same calendar day as `referenceDate`, sorted by start time.
    /// All-day events come first, then timed events in chronological order.
    static func eventsForToday(
        from allEvents: [WidgetEventData],
        referenceDate: Date = Date(),
        calendar: Calendar = .current
    ) -> [WidgetEventData] {
        let dayStart = calendar.startOfDay(for: referenceDate)
        guard let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) else {
            return []
        }

        let todayEvents = allEvents.filter { event in
            // An event is "today" if its start is within today OR it spans across today.
            // All-day events: startDate is at midnight of their day.
            // Timed events: startDate < dayEnd AND endDate > dayStart (overlap check).
            event.startDate < dayEnd && event.endDate > dayStart
        }

        return todayEvents.sorted { a, b in
            // All-day events first
            if a.isAllDay != b.isAllDay {
                return a.isAllDay
            }
            // Then by start time
            return a.startDate < b.startDate
        }
    }

    /// Returns the next N upcoming events from `referenceDate` (events that haven't ended yet).
    /// Used for small (1) and medium (3) widget sizes.
    static func nextUpcomingEvents(
        from allEvents: [WidgetEventData],
        count: Int,
        referenceDate: Date = Date(),
        calendar: Calendar = .current
    ) -> [WidgetEventData] {
        // Include events that haven't ended yet and start within the next 24 hours,
        // plus all-day events for today.
        let dayStart = calendar.startOfDay(for: referenceDate)
        guard let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) else {
            return []
        }

        let upcoming = allEvents.filter { event in
            // Event hasn't ended yet
            event.endDate > referenceDate &&
            // And either starts today or is an all-day event spanning today
            (event.startDate < dayEnd && event.endDate > dayStart)
        }

        let sorted = upcoming.sorted { a, b in
            if a.isAllDay != b.isAllDay {
                return a.isAllDay
            }
            return a.startDate < b.startDate
        }

        return Array(sorted.prefix(count))
    }

    /// Number of events to display for a given widget size.
    static func eventCount(for size: WidgetSize) -> Int {
        switch size {
        case .small: return 1
        case .medium: return 3
        case .large: return 10  // Practical max for today's schedule overview
        }
    }

    // MARK: - Snapshot Generation

    /// Generate a WidgetSnapshot for a specific size and reference date.
    static func snapshot(
        for size: WidgetSize,
        events allEvents: [WidgetEventData],
        referenceDate: Date = Date(),
        isStale: Bool = false,
        lastUpdated: Date? = nil,
        calendar: Calendar = .current
    ) -> WidgetSnapshot {
        let displayEvents: [WidgetEventData]

        switch size {
        case .small:
            displayEvents = nextUpcomingEvents(
                from: allEvents, count: 1,
                referenceDate: referenceDate, calendar: calendar
            )
        case .medium:
            displayEvents = nextUpcomingEvents(
                from: allEvents, count: 3,
                referenceDate: referenceDate, calendar: calendar
            )
        case .large:
            displayEvents = eventsForToday(
                from: allEvents,
                referenceDate: referenceDate, calendar: calendar
            )
        }

        let lastUpdatedString: String?
        if let lastUpdated = lastUpdated {
            let formatter = RelativeDateTimeFormatter()
            formatter.unitsStyle = .abbreviated
            lastUpdatedString = formatter.localizedString(for: lastUpdated, relativeTo: referenceDate)
        } else {
            lastUpdatedString = nil
        }

        return WidgetSnapshot(
            date: referenceDate,
            events: displayEvents,
            isStale: isStale,
            lastUpdatedString: lastUpdatedString
        )
    }

    // MARK: - Timeline Scheduling

    /// Compute the next refresh date for the widget timeline.
    /// Strategy:
    /// - If there's an upcoming event, refresh 5 minutes before it starts.
    /// - If no upcoming events, refresh at the next hour boundary.
    /// - Never schedule further than 1 hour out (WidgetKit will refresh sooner anyway).
    static func nextRefreshDate(
        events: [WidgetEventData],
        referenceDate: Date = Date(),
        calendar: Calendar = .current
    ) -> Date {
        let maxRefresh = calendar.date(byAdding: .hour, value: 1, to: referenceDate)
            ?? referenceDate.addingTimeInterval(3600)

        // Find the next event that starts after now
        let futureEvents = events
            .filter { !$0.isAllDay && $0.startDate > referenceDate }
            .sorted { $0.startDate < $1.startDate }

        if let nextEvent = futureEvents.first {
            // Refresh 5 minutes before the next event, or now if it's less than 5 minutes away
            let fiveMinBefore = nextEvent.startDate.addingTimeInterval(-300)
            let refreshDate = max(fiveMinBefore, referenceDate.addingTimeInterval(60))
            return min(refreshDate, maxRefresh)
        }

        return maxRefresh
    }

    /// Generate a sequence of timeline entries covering today's events.
    /// Entries are spaced so the widget updates as events begin/end.
    static func timelineEntries(
        for size: WidgetSize,
        events allEvents: [WidgetEventData],
        referenceDate: Date = Date(),
        isStale: Bool = false,
        lastUpdated: Date? = nil,
        calendar: Calendar = .current
    ) -> [WidgetSnapshot] {
        var entries: [WidgetSnapshot] = []

        // First entry: current state
        entries.append(snapshot(
            for: size,
            events: allEvents,
            referenceDate: referenceDate,
            isStale: isStale,
            lastUpdated: lastUpdated,
            calendar: calendar
        ))

        // Additional entries at each event start time (for small/medium, shows next event)
        let todayEvents = eventsForToday(from: allEvents, referenceDate: referenceDate, calendar: calendar)
        let futureStarts = todayEvents
            .filter { !$0.isAllDay && $0.startDate > referenceDate }
            .map { $0.startDate }

        // Deduplicate and limit to prevent excessive entries
        let uniqueTimes = Array(Set(futureStarts)).sorted().prefix(8)

        for time in uniqueTimes {
            entries.append(snapshot(
                for: size,
                events: allEvents,
                referenceDate: time,
                isStale: isStale,
                lastUpdated: lastUpdated,
                calendar: calendar
            ))
        }

        return entries
    }
}
