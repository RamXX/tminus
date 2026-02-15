// WatchComplicationLogic.swift
// T-Minus iOS -- Pure-logic computation for Apple Watch complications.
//
// This file contains all business logic for computing complication data
// WITHOUT importing WidgetKit or WatchKit. This allows full unit testing
// via `swift test` on macOS.
//
// Responsibilities:
// - Extract next event (time + title) for complication display
// - Compute free time remaining today
// - Count meetings for today
// - Format complication data for circular, rectangular, inline families
// - Generate display strings for glanceable information

import Foundation

// MARK: - Complication Family Abstraction

/// Abstraction over WidgetKit complication families so tests don't need the framework.
/// Maps to watchOS WidgetKit families:
/// - circular: CLKComplicationFamily.graphicCircular / WidgetFamily.accessoryCircular
/// - rectangular: CLKComplicationFamily.graphicRectangular / WidgetFamily.accessoryRectangular
/// - inline: CLKComplicationFamily.graphicBezel / WidgetFamily.accessoryInline
enum ComplicationFamily: String, CaseIterable {
    case circular
    case rectangular
    case inline
}

// MARK: - Complication Data

/// All data needed to render a single complication, regardless of family.
/// The view layer picks which fields to use based on the family.
struct ComplicationData: Equatable {
    /// Which complication family this data is for.
    let family: ComplicationFamily

    /// Title of the next upcoming event, or nil if none.
    let nextEventTitle: String?

    /// Display-friendly time string for the next event (e.g., "in 30m", "now").
    let nextEventTime: String?

    /// Start date of the next event (for WidgetKit date-relative display).
    let nextEventStartDate: Date?

    /// Number of timed meetings today (excludes all-day events).
    let meetingCount: Int

    /// Free time remaining today in minutes (excludes all-day events from busy calculation).
    let freeTimeMinutes: Int

    /// Human-readable free time string (e.g., "2h 30m free").
    let freeTimeDisplay: String

    /// Human-readable meeting count string (e.g., "3 meetings").
    let meetingCountDisplay: String
}

// MARK: - Computation Logic

/// Pure functions for computing Apple Watch complication data.
/// No side effects, no framework imports. Fully testable.
enum WatchComplicationLogic {

    // MARK: - Next Event

    /// Returns the next upcoming timed event (skips all-day events).
    /// An event is "upcoming" if it hasn't ended yet and occurs today.
    /// Prefers timed events over all-day for the "next event" display.
    static func nextEvent(
        from events: [WidgetEventData],
        referenceDate: Date = Date(),
        calendar: Calendar = .current
    ) -> WidgetEventData? {
        let dayStart = calendar.startOfDay(for: referenceDate)
        guard let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) else {
            return nil
        }

        // Filter to today's timed events that haven't ended
        let candidates = events.filter { event in
            !event.isAllDay &&
            event.endDate > referenceDate &&
            event.startDate < dayEnd &&
            event.endDate > dayStart
        }

        // Sort by start time, return earliest
        return candidates.sorted { $0.startDate < $1.startDate }.first
    }

    // MARK: - Free Time Remaining

    /// Computes free time remaining today in minutes from referenceDate to midnight.
    /// Subtracts all timed (non-all-day) meeting durations that fall within the remaining window.
    /// Handles overlapping meetings by merging busy intervals.
    static func freeTimeRemainingToday(
        from events: [WidgetEventData],
        referenceDate: Date = Date(),
        calendar: Calendar = .current
    ) -> Int {
        let dayStart = calendar.startOfDay(for: referenceDate)
        guard let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) else {
            return 0
        }

        // Total remaining minutes from now to midnight
        let totalRemainingMinutes = Int(dayEnd.timeIntervalSince(referenceDate) / 60)

        // Collect busy intervals from timed events (clipped to [referenceDate, dayEnd])
        var busyIntervals: [(start: Date, end: Date)] = []

        for event in events where !event.isAllDay {
            // Must overlap with remaining time window
            guard event.endDate > referenceDate && event.startDate < dayEnd else { continue }

            let intervalStart = max(event.startDate, referenceDate)
            let intervalEnd = min(event.endDate, dayEnd)

            if intervalStart < intervalEnd {
                busyIntervals.append((start: intervalStart, end: intervalEnd))
            }
        }

        // Merge overlapping intervals
        let merged = mergeIntervals(busyIntervals)

        // Sum busy minutes
        let busyMinutes = merged.reduce(0) { total, interval in
            total + Int(interval.end.timeIntervalSince(interval.start) / 60)
        }

        return max(totalRemainingMinutes - busyMinutes, 0)
    }

    // MARK: - Meeting Count

    /// Count of timed meetings today (excludes all-day events).
    /// Includes past and future meetings for the full day.
    static func meetingCountToday(
        from events: [WidgetEventData],
        referenceDate: Date = Date(),
        calendar: Calendar = .current
    ) -> Int {
        let dayStart = calendar.startOfDay(for: referenceDate)
        guard let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) else {
            return 0
        }

        return events.filter { event in
            !event.isAllDay &&
            event.startDate < dayEnd &&
            event.endDate > dayStart
        }.count
    }

    // MARK: - Complication Data Assembly

    /// Assemble all complication data for a specific family.
    static func complicationData(
        family: ComplicationFamily,
        events: [WidgetEventData],
        referenceDate: Date = Date(),
        calendar: Calendar = .current
    ) -> ComplicationData {
        let next = nextEvent(from: events, referenceDate: referenceDate, calendar: calendar)
        let freeMinutes = freeTimeRemainingToday(from: events, referenceDate: referenceDate, calendar: calendar)
        let meetingCount = meetingCountToday(from: events, referenceDate: referenceDate, calendar: calendar)

        let nextTime: String? = next.map { event in
            nextEventTimeDisplay(for: event, referenceDate: referenceDate)
        }

        return ComplicationData(
            family: family,
            nextEventTitle: next?.title,
            nextEventTime: nextTime,
            nextEventStartDate: next?.startDate,
            meetingCount: meetingCount,
            freeTimeMinutes: freeMinutes,
            freeTimeDisplay: freeTimeDisplayString(minutes: freeMinutes),
            meetingCountDisplay: meetingCountDisplayString(count: meetingCount)
        )
    }

    // MARK: - Display Strings

    /// Human-readable free time string (e.g., "2h 30m free", "45m free").
    static func freeTimeDisplayString(minutes: Int) -> String {
        let hours = minutes / 60
        let mins = minutes % 60

        if hours > 0 && mins > 0 {
            return "\(hours)h \(mins)m free"
        } else if hours > 0 {
            return "\(hours)h free"
        } else {
            return "\(mins)m free"
        }
    }

    /// Human-readable meeting count string.
    static func meetingCountDisplayString(count: Int) -> String {
        switch count {
        case 0: return "No meetings"
        case 1: return "1 meeting"
        default: return "\(count) meetings"
        }
    }

    /// Relative time display for the next event (e.g., "in 30m", "in 2h 15m", "now").
    static func nextEventTimeDisplay(
        for event: WidgetEventData,
        referenceDate: Date = Date()
    ) -> String {
        let diff = event.startDate.timeIntervalSince(referenceDate)

        // Already started (diff <= 0)
        if diff <= 0 {
            return "now"
        }

        let totalMinutes = Int(diff / 60)
        let hours = totalMinutes / 60
        let minutes = totalMinutes % 60

        if hours > 0 && minutes > 0 {
            return "in \(hours)h \(minutes)m"
        } else if hours > 0 {
            return "in \(hours)h"
        } else {
            return "in \(minutes)m"
        }
    }

    // MARK: - Interval Merging

    /// Merge overlapping time intervals into non-overlapping ones.
    private static func mergeIntervals(
        _ intervals: [(start: Date, end: Date)]
    ) -> [(start: Date, end: Date)] {
        guard !intervals.isEmpty else { return [] }

        let sorted = intervals.sorted { $0.start < $1.start }
        var merged: [(start: Date, end: Date)] = [sorted[0]]

        for interval in sorted.dropFirst() {
            if interval.start <= merged[merged.count - 1].end {
                // Overlapping: extend the current merged interval
                merged[merged.count - 1] = (
                    start: merged[merged.count - 1].start,
                    end: max(merged[merged.count - 1].end, interval.end)
                )
            } else {
                merged.append(interval)
            }
        }

        return merged
    }
}
