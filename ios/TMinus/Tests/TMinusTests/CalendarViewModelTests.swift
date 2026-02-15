// CalendarViewModelTests.swift
// T-Minus iOS Tests -- Unit tests for CalendarViewModel.

import XCTest
@testable import TMinusLib

@MainActor
final class CalendarViewModelTests: XCTestCase {

    var mockAPI: MockAPIClient!
    var mockCache: MockEventCache!
    var viewModel: CalendarViewModel!

    override func setUp() {
        super.setUp()
        mockAPI = MockAPIClient()
        mockCache = MockEventCache()
        viewModel = CalendarViewModel(apiClient: mockAPI, cache: mockCache, widgetDataProvider: nil)
    }

    // MARK: - Initial State

    func testInitialStateIsEmpty() {
        XCTAssertTrue(viewModel.events.isEmpty)
        XCTAssertTrue(viewModel.eventsByDate.isEmpty)
        XCTAssertFalse(viewModel.isLoading)
        XCTAssertFalse(viewModel.isRefreshing)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertFalse(viewModel.isOffline)
    }

    // MARK: - Load Events

    func testLoadEventsSuccess() async {
        mockAPI.fetchEventsResult = .success(TestFixtures.sampleEvents)

        await viewModel.loadEvents()

        XCTAssertEqual(viewModel.events.count, TestFixtures.sampleEvents.count)
        XCTAssertFalse(viewModel.isLoading)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertFalse(viewModel.isOffline)
    }

    func testLoadEventsGroupsByDate() async {
        mockAPI.fetchEventsResult = .success(TestFixtures.sampleEvents)

        await viewModel.loadEvents()

        // sampleEvents has events on Feb 15 and Feb 16
        XCTAssertGreaterThanOrEqual(viewModel.eventsByDate.count, 1)
    }

    func testLoadEventsCachesResults() async {
        mockAPI.fetchEventsResult = .success(TestFixtures.sampleEvents)

        await viewModel.loadEvents()

        // Verify cache was populated
        XCTAssertFalse(mockCache.cachedEvents.isEmpty)
    }

    func testLoadEventsNetworkFailureFallsBackToCache() async {
        // Pre-populate cache
        let range = DateRange(start: viewModel.viewStart, end: viewModel.viewEnd)
        mockCache.cacheEvents(TestFixtures.sampleEvents, for: range)

        // Make network fail
        mockAPI.fetchEventsResult = .failure(APIError.networkError("No connection"))

        await viewModel.loadEvents()

        XCTAssertEqual(viewModel.events.count, TestFixtures.sampleEvents.count)
        XCTAssertTrue(viewModel.isOffline)
        XCTAssertNotNil(viewModel.errorMessage)
        XCTAssertTrue(viewModel.errorMessage!.contains("cached"))
    }

    func testLoadEventsNetworkFailureNoCacheShowsError() async {
        mockAPI.fetchEventsResult = .failure(APIError.networkError("No connection"))

        await viewModel.loadEvents()

        XCTAssertTrue(viewModel.events.isEmpty)
        XCTAssertNotNil(viewModel.errorMessage)
        XCTAssertTrue(viewModel.errorMessage!.contains("Failed"))
    }

    // MARK: - Refresh

    func testRefreshUpdatesEvents() async {
        let newEvents = [TestFixtures.makeEvent(id: "evt_NEW", title: "New Event")]
        mockAPI.fetchEventsResult = .success(newEvents)

        await viewModel.refresh()

        XCTAssertEqual(viewModel.events.count, 1)
        XCTAssertEqual(viewModel.events.first?.title, "New Event")
        XCTAssertFalse(viewModel.isRefreshing)
        XCTAssertFalse(viewModel.isOffline)
    }

    func testRefreshFailureShowsError() async {
        mockAPI.fetchEventsResult = .failure(APIError.networkError("Timeout"))

        await viewModel.refresh()

        XCTAssertNotNil(viewModel.errorMessage)
        XCTAssertTrue(viewModel.errorMessage!.contains("Refresh failed"))
        XCTAssertFalse(viewModel.isRefreshing)
    }

    // MARK: - Date Selection

    func testSelectDateSameMonthDoesNotReload() async {
        // Load initial events
        let events = [TestFixtures.makeEvent()]
        mockAPI.fetchEventsResult = .success(events)
        await viewModel.loadEvents()

        // Select a different day in the same month
        let cal = Calendar.current
        let nextDay = cal.date(byAdding: .day, value: 1, to: viewModel.selectedDate)!

        // Change to empty results to detect if reload happens
        mockAPI.fetchEventsResult = .success([])

        await viewModel.selectDate(nextDay)

        // Events should NOT have changed (no reload for same month)
        XCTAssertEqual(viewModel.events.count, 1)
    }

    func testEventsForSelectedDateFiltersCorrectly() async {
        mockAPI.fetchEventsResult = .success(TestFixtures.sampleEvents)
        await viewModel.loadEvents()

        // Select Feb 15 -- should include the events from that date
        let feb15 = ISO8601DateFormatter().date(from: "2026-02-15T00:00:00Z")!
        await viewModel.selectDate(feb15)

        let dayEvents = viewModel.eventsForSelectedDate
        // At minimum, the standup and design review are on Feb 15
        XCTAssertGreaterThanOrEqual(dayEvents.count, 1)
    }

    func testEventsForEmptyDayReturnsEmpty() async {
        mockAPI.fetchEventsResult = .success(TestFixtures.sampleEvents)
        await viewModel.loadEvents()

        // Select a date with no events
        let noEventsDate = ISO8601DateFormatter().date(from: "2026-02-20T00:00:00Z")!
        await viewModel.selectDate(noEventsDate)

        XCTAssertTrue(viewModel.eventsForSelectedDate.isEmpty)
    }

    // MARK: - View Range

    func testViewRangeCoversMonth() {
        let cal = Calendar.current
        let monthDiff = cal.dateComponents([.month], from: viewModel.viewStart, to: viewModel.viewEnd)
        XCTAssertEqual(monthDiff.month, 1)
    }
}
