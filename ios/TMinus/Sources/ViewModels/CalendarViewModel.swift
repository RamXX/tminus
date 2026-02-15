// CalendarViewModel.swift
// T-Minus iOS -- Unified calendar view model.
//
// Fetches events from the API (with offline cache fallback),
// groups them by date, and provides pull-to-refresh support.
// This is the core view model for the calendar display.

import Foundation
import Combine

/// Observable state for the unified calendar view.
@MainActor
final class CalendarViewModel: ObservableObject {

    // MARK: - Published State

    @Published var events: [CanonicalEvent] = []
    @Published var eventsByDate: [Date: [CanonicalEvent]] = [:]
    @Published var selectedDate: Date = Calendar.current.startOfDay(for: Date())
    @Published var isLoading = false
    @Published var isRefreshing = false
    @Published var errorMessage: String?
    @Published var isOffline = false
    @Published var lastSyncDate: Date?

    // MARK: - View Range

    /// Current visible date range (default: current month).
    var viewStart: Date {
        let cal = Calendar.current
        return cal.date(from: cal.dateComponents([.year, .month], from: selectedDate))
            ?? cal.startOfDay(for: selectedDate)
    }

    var viewEnd: Date {
        let cal = Calendar.current
        guard let nextMonth = cal.date(byAdding: .month, value: 1, to: viewStart) else {
            return cal.date(byAdding: .day, value: 30, to: viewStart) ?? viewStart
        }
        return nextMonth
    }

    // MARK: - Dependencies

    private let apiClient: APIClientProtocol
    private let cache: EventCacheProtocol
    private let widgetDataProvider: WidgetDataProvider?

    init(
        apiClient: APIClientProtocol,
        cache: EventCacheProtocol = EventCache(),
        widgetDataProvider: WidgetDataProvider? = WidgetDataProvider()
    ) {
        self.apiClient = apiClient
        self.cache = cache
        self.widgetDataProvider = widgetDataProvider
        self.lastSyncDate = cache.lastSyncDate
    }

    // MARK: - Data Loading

    /// Load events for the current view range.
    /// Falls back to cache on network failure.
    func loadEvents() async {
        isLoading = true
        errorMessage = nil

        let range = DateRange(start: viewStart, end: viewEnd)

        do {
            let fetched = try await apiClient.fetchEvents(start: viewStart, end: viewEnd, accountId: nil)
            events = fetched
            groupEventsByDate()
            cache.cacheEvents(fetched, for: range)
            widgetDataProvider?.writeEvents(fetched)
            isOffline = false
            lastSyncDate = Date()
        } catch {
            // Attempt cache fallback
            if let cached = cache.loadEvents(for: range) {
                events = cached
                groupEventsByDate()
                isOffline = true
                lastSyncDate = cache.lastSyncDate
                errorMessage = "Showing cached events. Pull to refresh."
            } else {
                errorMessage = "Failed to load events: \(error.localizedDescription)"
            }
        }

        isLoading = false
    }

    /// Pull-to-refresh: force network fetch, update cache.
    func refresh() async {
        isRefreshing = true
        errorMessage = nil

        let range = DateRange(start: viewStart, end: viewEnd)

        do {
            let fetched = try await apiClient.fetchEvents(start: viewStart, end: viewEnd, accountId: nil)
            events = fetched
            groupEventsByDate()
            cache.cacheEvents(fetched, for: range)
            widgetDataProvider?.writeEvents(fetched)
            isOffline = false
            lastSyncDate = Date()
        } catch {
            errorMessage = "Refresh failed: \(error.localizedDescription)"
        }

        isRefreshing = false
    }

    /// Change selected date and reload events if the month changed.
    func selectDate(_ date: Date) async {
        let cal = Calendar.current
        let oldMonth = cal.component(.month, from: selectedDate)
        let newMonth = cal.component(.month, from: date)
        let oldYear = cal.component(.year, from: selectedDate)
        let newYear = cal.component(.year, from: date)

        selectedDate = cal.startOfDay(for: date)

        // Reload if month/year changed
        if oldMonth != newMonth || oldYear != newYear {
            await loadEvents()
        }
    }

    /// Events for the currently selected date.
    var eventsForSelectedDate: [CanonicalEvent] {
        let cal = Calendar.current
        let dayStart = cal.startOfDay(for: selectedDate)
        return eventsByDate[dayStart] ?? []
    }

    // MARK: - Grouping

    private func groupEventsByDate() {
        let cal = Calendar.current
        var grouped: [Date: [CanonicalEvent]] = [:]

        for event in events {
            guard let date = event.startDate else { continue }
            let dayStart = cal.startOfDay(for: date)
            grouped[dayStart, default: []].append(event)
        }

        // Sort events within each day by start time
        for (date, dayEvents) in grouped {
            grouped[date] = dayEvents.sorted { a, b in
                guard let aDate = a.startDate, let bDate = b.startDate else { return false }
                return aDate < bDate
            }
        }

        eventsByDate = grouped
    }
}
