// CalendarView.swift
// T-Minus iOS -- Unified calendar view displaying events from all accounts.
//
// Layout:
// - Top: Month calendar with date picker (tap to select day)
// - Bottom: List of events for the selected day, color-coded by account
// - Pull-to-refresh on the event list
// - Offline indicator when serving cached data

import SwiftUI

struct CalendarView: View {
    @ObservedObject var calendarVM: CalendarViewModel
    @ObservedObject var authVM: AuthViewModel

    /// API client reference for creating the EventFormViewModel.
    var apiClient: APIClientProtocol?

    @State private var showEventForm = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Month Calendar Picker
                DatePicker(
                    "Select Date",
                    selection: Binding(
                        get: { calendarVM.selectedDate },
                        set: { newDate in
                            Task { await calendarVM.selectDate(newDate) }
                        }
                    ),
                    displayedComponents: [.date]
                )
                .datePickerStyle(.graphical)
                .padding(.horizontal)
                .accessibilityIdentifier("calendarPicker")

                Divider()

                // Offline indicator
                if calendarVM.isOffline {
                    HStack {
                        Image(systemName: "wifi.slash")
                        Text("Offline -- showing cached events")
                            .font(.caption)
                    }
                    .foregroundColor(.orange)
                    .padding(.vertical, 4)
                    .accessibilityIdentifier("offlineIndicator")
                }

                // Event List for selected day
                eventListView
            }
            .navigationTitle("Calendar")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                #if os(iOS)
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        showEventForm = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityIdentifier("createEventButton")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    profileMenuButton
                }
                #else
                ToolbarItem(placement: .automatic) {
                    Button {
                        showEventForm = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityIdentifier("createEventButton")
                }
                ToolbarItem(placement: .automatic) {
                    profileMenuButton
                }
                #endif
            }
            .sheet(isPresented: $showEventForm) {
                if let client = apiClient {
                    EventFormView(viewModel: EventFormViewModel(apiClient: client))
                }
            }
            .task {
                await calendarVM.loadEvents()
            }
        }
    }

    // MARK: - Profile Menu

    @ViewBuilder
    private var profileMenuButton: some View {
        Menu {
            if let email = authVM.userEmail {
                Text(email)
            }
            Button("Sign Out", role: .destructive) {
                authVM.logout()
            }
        } label: {
            Image(systemName: "person.circle")
                .accessibilityIdentifier("profileMenu")
        }
    }

    // MARK: - Event List

    @ViewBuilder
    private var eventListView: some View {
        let dayEvents = calendarVM.eventsForSelectedDate

        if calendarVM.isLoading && dayEvents.isEmpty {
            VStack {
                Spacer()
                ProgressView("Loading events...")
                Spacer()
            }
            .accessibilityIdentifier("loadingIndicator")
        } else if dayEvents.isEmpty {
            VStack {
                Spacer()
                Text("No events")
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("emptyState")
                Spacer()
            }
        } else {
            List {
                ForEach(dayEvents) { event in
                    EventRow(event: event)
                }
            }
            .listStyle(.plain)
            .refreshable {
                await calendarVM.refresh()
            }
            .accessibilityIdentifier("eventList")
        }

        // Error message at bottom
        if let error = calendarVM.errorMessage {
            Text(error)
                .font(.caption)
                .foregroundColor(.orange)
                .padding(.horizontal)
                .padding(.bottom, 4)
                .accessibilityIdentifier("calendarError")
        }

        // Last sync
        if let lastSync = calendarVM.lastSyncDate {
            Text("Last synced: \(lastSync, formatter: relativeDateFormatter)")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .padding(.bottom, 4)
                .accessibilityIdentifier("lastSyncLabel")
        }
    }
}

// MARK: - Event Row

struct EventRow: View {
    let event: CanonicalEvent

    var body: some View {
        HStack(spacing: 12) {
            // Account color indicator
            RoundedRectangle(cornerRadius: 3)
                .fill(AccountColors.color(for: event.originAccountId))
                .frame(width: 6)
                .accessibilityLabel(
                    "Account: \(AccountColors.colorName(for: event.originAccountId))"
                )

            VStack(alignment: .leading, spacing: 4) {
                Text(event.title ?? "(No title)")
                    .font(.body)
                    .lineLimit(1)

                HStack(spacing: 8) {
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

            // Status indicator
            if event.status == "tentative" {
                Image(systemName: "questionmark.circle")
                    .foregroundStyle(.orange)
                    .font(.caption)
            } else if event.transparency == "transparent" {
                Image(systemName: "circle.dashed")
                    .foregroundStyle(.secondary)
                    .font(.caption)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("eventRow_\(event.canonicalEventId)")
    }
}

// MARK: - Formatters

private let relativeDateFormatter: RelativeDateTimeFormatter = {
    let f = RelativeDateTimeFormatter()
    f.unitsStyle = .abbreviated
    return f
}()
