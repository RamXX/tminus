// WatchTodayView.swift
// T-Minus iOS -- Apple Watch companion app: Today schedule view.
//
// A minimal, glanceable view showing today's schedule on the watch.
// Designed for quick glances with minimal tap interaction.
//
// Data comes from WatchConnectivity sync (not direct API calls).
// The view reads from WidgetDataProvider (shared App Group storage).
//
// NOTE: This file is guarded with #if os(watchOS) so it only compiles
// for the watchOS target. All testable logic is in WatchComplicationLogic.swift.

#if os(watchOS)
import SwiftUI

// MARK: - Watch Today View

/// Main view for the watchOS companion app.
/// Shows today's schedule in a scrollable list with meeting summary header.
struct WatchTodayView: View {
    let events: [WidgetEventData]
    let complicationData: ComplicationData
    let isStale: Bool
    let lastSyncString: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    // Summary header
                    WatchSummaryHeader(data: complicationData, isStale: isStale)
                        .padding(.bottom, 4)

                    // Event list
                    if events.isEmpty {
                        WatchEmptyState()
                    } else {
                        ForEach(events) { event in
                            WatchEventRow(event: event)
                        }
                    }
                }
                .padding(.horizontal)
            }
            .navigationTitle("Today")
        }
    }
}

// MARK: - Summary Header

struct WatchSummaryHeader: View {
    let data: ComplicationData
    let isStale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(data.meetingCountDisplay)
                    .font(.caption)
                    .fontWeight(.medium)
                Spacer()
                if isStale {
                    Image(systemName: "arrow.clockwise")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
            }

            Text(data.freeTimeDisplay)
                .font(.caption2)
                .foregroundStyle(.secondary)

            if let nextTitle = data.nextEventTitle, let nextTime = data.nextEventTime {
                Divider()
                HStack(spacing: 4) {
                    Text("Next:")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(nextTitle)
                        .font(.caption2)
                        .fontWeight(.medium)
                        .lineLimit(1)
                    Text(nextTime)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(8)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - Event Row

struct WatchEventRow: View {
    let event: WidgetEventData

    var body: some View {
        HStack(spacing: 8) {
            // Account color indicator
            RoundedRectangle(cornerRadius: 2)
                .fill(AccountColors.color(for: event.accountId))
                .frame(width: 3, height: 28)

            VStack(alignment: .leading, spacing: 1) {
                Text(event.title)
                    .font(.caption)
                    .fontWeight(.medium)
                    .lineLimit(1)

                Text(event.timeDisplayString)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Spacer()
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Empty State

struct WatchEmptyState: View {
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "calendar")
                .font(.title3)
                .foregroundStyle(.secondary)
            Text("No events today")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 20)
    }
}

#endif // os(watchOS)
