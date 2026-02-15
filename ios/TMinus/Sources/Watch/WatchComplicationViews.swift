// WatchComplicationViews.swift
// T-Minus iOS -- SwiftUI views for Apple Watch complications.
//
// These views render complication content for the three supported families:
// - accessoryCircular: compact gauge with meeting count or next event time
// - accessoryRectangular: next event title + time + free time summary
// - accessoryInline: single-line text with next event info
//
// NOTE: This file imports WidgetKit and is excluded from the SPM test target.
// It compiles only in the Xcode project's watch widget extension target.
// All logic is in WatchComplicationLogic.swift (testable via SPM).

#if canImport(WidgetKit) && os(watchOS)
import WidgetKit
import SwiftUI

// MARK: - Timeline Entry

/// WidgetKit timeline entry for watch complications.
struct TMinusComplicationEntry: TimelineEntry {
    let date: Date
    let complicationData: ComplicationData
}

// MARK: - Circular Complication

/// Compact circular display: shows meeting count as a gauge, or "next event" time.
struct CircularComplicationView: View {
    let data: ComplicationData

    var body: some View {
        if let eventTime = data.nextEventTime {
            // Show next event time
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Text(eventTime)
                        .font(.system(.caption2, design: .rounded))
                        .fontWeight(.semibold)
                        .minimumScaleFactor(0.6)
                }
            }
        } else {
            // No events: show meeting count
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Text("\(data.meetingCount)")
                        .font(.system(.title3, design: .rounded))
                        .fontWeight(.bold)
                    Text("mtgs")
                        .font(.system(.caption2))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

// MARK: - Rectangular Complication

/// Shows next event with title, time, and free time summary.
struct RectangularComplicationView: View {
    let data: ComplicationData

    var body: some View {
        if let title = data.nextEventTitle, let time = data.nextEventTime {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.headline)
                    .lineLimit(1)

                HStack {
                    Text(time)
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    Spacer()

                    Text(data.freeTimeDisplay)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                Text(data.meetingCountDisplay)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        } else {
            VStack(alignment: .leading, spacing: 2) {
                Text("No upcoming events")
                    .font(.headline)
                    .foregroundStyle(.secondary)

                Text(data.freeTimeDisplay)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: - Inline Complication

/// Single-line text for inline/bezel display.
struct InlineComplicationView: View {
    let data: ComplicationData

    var body: some View {
        if let title = data.nextEventTitle, let time = data.nextEventTime {
            Text("\(time) \(title)")
                .lineLimit(1)
        } else {
            Text(data.meetingCountDisplay)
                .lineLimit(1)
        }
    }
}

// MARK: - Complication Entry View (dispatches by family)

struct TMinusComplicationEntryView: View {
    let entry: TMinusComplicationEntry

    @Environment(\.widgetFamily) var family

    var body: some View {
        switch family {
        case .accessoryCircular:
            CircularComplicationView(data: entry.complicationData)
        case .accessoryRectangular:
            RectangularComplicationView(data: entry.complicationData)
        case .accessoryInline:
            InlineComplicationView(data: entry.complicationData)
        default:
            CircularComplicationView(data: entry.complicationData)
        }
    }
}

// MARK: - Widget Configuration

struct TMinusComplication: Widget {
    let kind: String = "TMinusComplication"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: TMinusComplicationProvider()) { entry in
            TMinusComplicationEntryView(entry: entry)
        }
        .configurationDisplayName("T-Minus")
        .description("Next event, free time, and meeting count.")
        .supportedFamilies([
            .accessoryCircular,
            .accessoryRectangular,
            .accessoryInline,
        ])
    }
}

// MARK: - Timeline Provider

struct TMinusComplicationProvider: TimelineProvider {
    private let dataProvider = WidgetDataProvider()

    func placeholder(in context: Context) -> TMinusComplicationEntry {
        let data = ComplicationData(
            family: .circular,
            nextEventTitle: nil,
            nextEventTime: nil,
            nextEventStartDate: nil,
            meetingCount: 0,
            freeTimeMinutes: 0,
            freeTimeDisplay: "-- free",
            meetingCountDisplay: "-- meetings"
        )
        return TMinusComplicationEntry(date: Date(), complicationData: data)
    }

    func getSnapshot(in context: Context, completion: @escaping (TMinusComplicationEntry) -> Void) {
        let events = dataProvider.readEvents()
        let family = complicationFamily(for: context.family)
        let data = WatchComplicationLogic.complicationData(
            family: family, events: events
        )
        completion(TMinusComplicationEntry(date: Date(), complicationData: data))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TMinusComplicationEntry>) -> Void) {
        let events = dataProvider.readEvents()
        let family = complicationFamily(for: context.family)
        let now = Date()

        // Current entry
        let currentData = WatchComplicationLogic.complicationData(
            family: family, events: events, referenceDate: now
        )
        var entries = [TMinusComplicationEntry(date: now, complicationData: currentData)]

        // Add entries at future event start times for automatic updates
        let todayEvents = WidgetTimelineLogic.eventsForToday(from: events, referenceDate: now)
        let futureTimes = todayEvents
            .filter { !$0.isAllDay && $0.startDate > now }
            .map { $0.startDate }

        for time in Array(Set(futureTimes)).sorted().prefix(6) {
            let data = WatchComplicationLogic.complicationData(
                family: family, events: events, referenceDate: time
            )
            entries.append(TMinusComplicationEntry(date: time, complicationData: data))
        }

        // Refresh in 30 minutes or before next event
        let refreshDate = WidgetTimelineLogic.nextRefreshDate(events: events, referenceDate: now)
        let timeline = Timeline(entries: entries, policy: .after(refreshDate))
        completion(timeline)
    }

    private func complicationFamily(for widgetFamily: WidgetFamily) -> ComplicationFamily {
        switch widgetFamily {
        case .accessoryCircular: return .circular
        case .accessoryRectangular: return .rectangular
        case .accessoryInline: return .inline
        default: return .circular
        }
    }
}

#endif // canImport(WidgetKit) && os(watchOS)
