// TMinusWidgetViews.swift
// T-Minus iOS -- SwiftUI views for the Today Widget (all three sizes).
//
// These views render the widget content for small, medium, and large families.
// They consume WidgetSnapshot data and are purely presentational.
//
// NOTE: This file imports WidgetKit and is excluded from the SPM test target.
// It compiles only in the Xcode project's widget extension target.
// All logic is in WidgetTimelineLogic.swift (testable via SPM).

#if canImport(WidgetKit)
import WidgetKit
import SwiftUI

// MARK: - Timeline Entry

/// WidgetKit timeline entry wrapping our framework-independent WidgetSnapshot.
struct TMinusWidgetEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot
    let family: WidgetFamily
}

// MARK: - Widget Entry View (dispatches to size-specific views)

struct TMinusWidgetEntryView: View {
    let entry: TMinusWidgetEntry

    @Environment(\.widgetFamily) var family

    var body: some View {
        switch family {
        case .systemSmall:
            SmallWidgetView(snapshot: entry.snapshot)
        case .systemMedium:
            MediumWidgetView(snapshot: entry.snapshot)
        case .systemLarge:
            LargeWidgetView(snapshot: entry.snapshot)
        default:
            // Lock screen widgets and others get the small view
            SmallWidgetView(snapshot: entry.snapshot)
        }
    }
}

// MARK: - Small Widget (next event)

struct SmallWidgetView: View {
    let snapshot: WidgetSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Header
            HStack {
                Text("T-Minus")
                    .font(.caption2)
                    .fontWeight(.semibold)
                    .foregroundStyle(.secondary)
                Spacer()
                if snapshot.isStale {
                    Image(systemName: "arrow.clockwise")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
            }

            Spacer()

            if let event = snapshot.events.first {
                // Account color indicator
                HStack(spacing: 6) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(AccountColors.color(for: event.accountId))
                        .frame(width: 4, height: 28)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(event.title)
                            .font(.subheadline)
                            .fontWeight(.medium)
                            .lineLimit(2)

                        Text(event.timeDisplayString)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .widgetURL(event.deepLinkURL)
            } else {
                Text("No upcoming events")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .widgetURL(DeepLinkGenerator.todayURL())
            }

            Spacer()
        }
        .padding()
    }
}

// MARK: - Medium Widget (next 3 events)

struct MediumWidgetView: View {
    let snapshot: WidgetSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Header row
            HStack {
                Text("T-Minus")
                    .font(.caption2)
                    .fontWeight(.semibold)
                    .foregroundStyle(.secondary)
                Text("--")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text("Today")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Spacer()
                if snapshot.isStale {
                    Image(systemName: "arrow.clockwise")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
            }
            .padding(.bottom, 2)

            if snapshot.events.isEmpty {
                Spacer()
                HStack {
                    Spacer()
                    Text("No upcoming events")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                Spacer()
            } else {
                ForEach(snapshot.events.prefix(3)) { event in
                    Link(destination: event.deepLinkURL) {
                        MediumEventRow(event: event)
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .padding()
    }
}

/// A single event row in the medium widget.
struct MediumEventRow: View {
    let event: WidgetEventData

    var body: some View {
        HStack(spacing: 8) {
            // Account color dot
            Circle()
                .fill(AccountColors.color(for: event.accountId))
                .frame(width: 8, height: 8)

            // Time
            Text(event.timeDisplayString)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 55, alignment: .leading)

            // Title
            Text(event.title)
                .font(.caption)
                .fontWeight(.medium)
                .lineLimit(1)

            Spacer()
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Large Widget (today's schedule overview)

struct LargeWidgetView: View {
    let snapshot: WidgetSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Header
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text("T-Minus")
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(.secondary)
                    Text("Today's Schedule")
                        .font(.headline)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 1) {
                    if snapshot.isStale {
                        Label("Stale", systemImage: "arrow.clockwise")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                    }
                    if let updated = snapshot.lastUpdatedString {
                        Text("Updated \(updated)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.bottom, 4)

            Divider()

            if snapshot.events.isEmpty {
                Spacer()
                HStack {
                    Spacer()
                    VStack(spacing: 8) {
                        Image(systemName: "calendar")
                            .font(.title2)
                            .foregroundStyle(.secondary)
                        Text("No events today")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                Spacer()
            } else {
                // Scrollable event list (WidgetKit handles clipping)
                ForEach(snapshot.events) { event in
                    Link(destination: event.deepLinkURL) {
                        LargeEventRow(event: event)
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .padding()
    }
}

/// A single event row in the large widget.
struct LargeEventRow: View {
    let event: WidgetEventData

    var body: some View {
        HStack(spacing: 10) {
            // Account color bar
            RoundedRectangle(cornerRadius: 2)
                .fill(AccountColors.color(for: event.accountId))
                .frame(width: 4, height: 36)

            VStack(alignment: .leading, spacing: 2) {
                Text(event.title)
                    .font(.subheadline)
                    .fontWeight(.medium)
                    .lineLimit(1)

                HStack(spacing: 6) {
                    Text(event.timeDisplayString)
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    if let location = event.location, !location.isEmpty {
                        Label(location, systemImage: "mappin")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }

            Spacer()
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Widget Configuration

struct TMinusWidget: Widget {
    let kind: String = "TMinusWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: TMinusTimelineProvider()) { entry in
            TMinusWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("T-Minus Calendar")
        .description("See your upcoming events across all accounts.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

// MARK: - Timeline Provider

struct TMinusTimelineProvider: TimelineProvider {
    private let dataProvider = WidgetDataProvider()

    func placeholder(in context: Context) -> TMinusWidgetEntry {
        let snapshot = WidgetSnapshot(
            date: Date(),
            events: [],
            isStale: false,
            lastUpdatedString: nil
        )
        return TMinusWidgetEntry(date: Date(), snapshot: snapshot, family: context.family)
    }

    func getSnapshot(in context: Context, completion: @escaping (TMinusWidgetEntry) -> Void) {
        let events = dataProvider.readEvents()
        let size = widgetSize(for: context.family)
        let snapshot = WidgetTimelineLogic.snapshot(
            for: size,
            events: events,
            referenceDate: Date(),
            isStale: !dataProvider.isDataFresh,
            lastUpdated: dataProvider.lastUpdated
        )
        let entry = TMinusWidgetEntry(date: Date(), snapshot: snapshot, family: context.family)
        completion(entry)
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TMinusWidgetEntry>) -> Void) {
        let events = dataProvider.readEvents()
        let size = widgetSize(for: context.family)
        let isStale = !dataProvider.isDataFresh
        let lastUpdated = dataProvider.lastUpdated
        let now = Date()

        let snapshots = WidgetTimelineLogic.timelineEntries(
            for: size,
            events: events,
            referenceDate: now,
            isStale: isStale,
            lastUpdated: lastUpdated
        )

        let entries = snapshots.map { snapshot in
            TMinusWidgetEntry(date: snapshot.date, snapshot: snapshot, family: context.family)
        }

        let refreshDate = WidgetTimelineLogic.nextRefreshDate(events: events, referenceDate: now)
        let timeline = Timeline(entries: entries, policy: .after(refreshDate))
        completion(timeline)
    }

    private func widgetSize(for family: WidgetFamily) -> WidgetSize {
        switch family {
        case .systemSmall: return .small
        case .systemMedium: return .medium
        case .systemLarge: return .large
        default: return .small
        }
    }
}

// MARK: - Widget Bundle (for the extension's @main)

// Uncomment below in the widget extension target's entry point file:
// @main
// struct TMinusWidgetBundle: WidgetBundle {
//     var body: some Widget {
//         TMinusWidget()
//     }
// }

// MARK: - Preview

#if DEBUG
#Preview("Small", as: .systemSmall) {
    TMinusWidget()
} timeline: {
    let snapshot = WidgetSnapshot(
        date: Date(),
        events: [
            WidgetEventData(
                eventId: "preview_1",
                title: "Team Standup",
                accountId: "acc_01",
                startDate: Date().addingTimeInterval(1800),
                endDate: Date().addingTimeInterval(3600),
                isAllDay: false,
                location: "Zoom"
            )
        ],
        isStale: false,
        lastUpdatedString: "2 min ago"
    )
    TMinusWidgetEntry(date: Date(), snapshot: snapshot, family: .systemSmall)
}
#endif

#endif // canImport(WidgetKit)
