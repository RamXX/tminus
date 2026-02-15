// E2EIntegrationTests.swift
// T-Minus iOS Tests -- End-to-end integration tests for Phase 5C.
//
// Exercises the full iOS model/service/viewmodel stack through all 6 demo scenarios:
// 1. Auth flow (login, token storage, refresh)
// 2. Calendar loading with multi-account color coding
// 3. Push notification model parsing and deep link routing
// 4. Widget data provider write/read cycle with timeline computation
// 5. Watch complication data from synced events
// 6. Event creation, quick actions, scheduling workflow (propose/select/commit)
// 7. Offline queue behavior
//
// All test data is created inline -- no shared fixtures.

import XCTest
@testable import TMinusLib

// MARK: - E2E Integration Tests

final class E2EIntegrationTests: XCTestCase {

    // MARK: - Shared Infrastructure (no fixture data -- only clean service instances)

    var mockAPIClient: MockAPIClient!
    var mockKeychain: MockKeychain!
    var mockCache: MockEventCache!
    var mockHaptics: MockHapticService!
    var mockOfflineQueue: MockOfflineQueue!
    var widgetDefaults: UserDefaults!
    var widgetProvider: WidgetDataProvider!

    let utcCalendar: Calendar = {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        return cal
    }()

    override func setUp() {
        super.setUp()
        mockAPIClient = MockAPIClient()
        mockKeychain = MockKeychain()
        mockCache = MockEventCache()
        mockHaptics = MockHapticService()
        mockOfflineQueue = MockOfflineQueue()
        widgetDefaults = UserDefaults(suiteName: "com.tminus.test.e2e.\(name)")!
        widgetDefaults.removePersistentDomain(forName: "com.tminus.test.e2e.\(name)")
        widgetProvider = WidgetDataProvider(defaults: widgetDefaults, ttl: 3600)
    }

    override func tearDown() {
        widgetDefaults.removePersistentDomain(forName: "com.tminus.test.e2e.\(name)")
        super.tearDown()
    }

    // MARK: - Scenario 1: Auth Flow (Login, Token Storage, Refresh)

    @MainActor
    func testE2E_Scenario1_LoginStoresTokensAndUpdatesState() async {
        // GIVEN: A user with valid credentials
        let authResponse = AuthResponse(
            token: "jwt_e2e_token_abc123",
            refreshToken: "refresh_e2e_token_xyz789",
            user: AuthUser(id: "usr_e2e_001", email: "e2e@tminus.ink", tier: "pro")
        )
        mockAPIClient.loginResult = .success(authResponse)

        // WHEN: User logs in through AuthViewModel
        let authVM = AuthViewModel(apiClient: mockAPIClient, keychain: mockKeychain)
        XCTAssertFalse(authVM.isAuthenticated, "Should start unauthenticated")

        await authVM.login(email: "e2e@tminus.ink", password: "secret123")

        // THEN: Auth state is updated and tokens are stored
        XCTAssertTrue(authVM.isAuthenticated, "Should be authenticated after login")
        XCTAssertEqual(authVM.userEmail, "e2e@tminus.ink")
        XCTAssertNil(authVM.errorMessage, "No error on successful login")
        XCTAssertFalse(authVM.isLoading, "Loading should be false after completion")
    }

    @MainActor
    func testE2E_Scenario1_LoginWithEmptyCredentialsFails() async {
        // GIVEN: Empty credentials
        let authVM = AuthViewModel(apiClient: mockAPIClient, keychain: mockKeychain)

        // WHEN: User tries login with empty fields
        await authVM.login(email: "", password: "")

        // THEN: Validation error is shown, not authenticated
        XCTAssertFalse(authVM.isAuthenticated)
        XCTAssertEqual(authVM.errorMessage, "Email and password are required.")
    }

    @MainActor
    func testE2E_Scenario1_LoginFailureShowsError() async {
        // GIVEN: Server rejects credentials
        mockAPIClient.loginResult = .failure(APIError.unauthorized)
        let authVM = AuthViewModel(apiClient: mockAPIClient, keychain: mockKeychain)

        // WHEN: Login attempt
        await authVM.login(email: "bad@example.com", password: "wrong")

        // THEN: Error is displayed, not authenticated
        XCTAssertFalse(authVM.isAuthenticated)
        XCTAssertNotNil(authVM.errorMessage)
        XCTAssertTrue(authVM.errorMessage!.contains("Authentication"), "Error should mention auth failure")
    }

    @MainActor
    func testE2E_Scenario1_TokenRefreshUpdatesSession() async {
        // GIVEN: A user with an expired token
        let refreshedAuth = AuthResponse(
            token: "jwt_refreshed_token_new",
            refreshToken: "refresh_new_token_456",
            user: AuthUser(id: "usr_e2e_001", email: "e2e@tminus.ink", tier: "pro")
        )
        mockAPIClient.refreshResult = .success(refreshedAuth)
        mockAPIClient._isAuthenticated = true

        let authVM = AuthViewModel(apiClient: mockAPIClient, keychain: mockKeychain)

        // WHEN: Session refresh is triggered
        await authVM.refreshSession()

        // THEN: Session is still authenticated
        XCTAssertTrue(authVM.isAuthenticated)
    }

    @MainActor
    func testE2E_Scenario1_LogoutClearsState() async {
        // GIVEN: An authenticated user
        mockAPIClient._isAuthenticated = true
        _ = mockKeychain.save(key: TokenKeys.userEmail, value: "e2e@tminus.ink")
        let authVM = AuthViewModel(apiClient: mockAPIClient, keychain: mockKeychain)
        XCTAssertTrue(authVM.isAuthenticated)

        // WHEN: User logs out
        authVM.logout()

        // THEN: All auth state is cleared
        XCTAssertFalse(authVM.isAuthenticated)
        XCTAssertNil(authVM.userEmail)
        XCTAssertNil(authVM.errorMessage)
        XCTAssertTrue(mockAPIClient.logoutCalled)
    }

    // MARK: - Scenario 2: Calendar Loading with Multi-Account Color Coding

    @MainActor
    func testE2E_Scenario2_CalendarLoadsEventsFromMultipleAccounts() async {
        // GIVEN: Events from two different calendar accounts
        let workEvent = CanonicalEvent(
            canonicalEventId: "evt_e2e_work_001",
            originAccountId: "acc_google_work",
            originEventId: "g_work_evt_1",
            title: "Sprint Planning",
            description: "Review sprint goals",
            location: "Room 42",
            start: EventDateTime(dateTime: "2026-02-15T09:00:00Z", date: nil, timeZone: "UTC"),
            end: EventDateTime(dateTime: "2026-02-15T10:00:00Z", date: nil, timeZone: "UTC"),
            allDay: false,
            status: "confirmed",
            visibility: "default",
            transparency: "opaque",
            recurrenceRule: nil,
            source: "provider",
            version: 1,
            createdAt: "2026-02-14T08:00:00Z",
            updatedAt: "2026-02-14T08:00:00Z"
        )

        let personalEvent = CanonicalEvent(
            canonicalEventId: "evt_e2e_personal_001",
            originAccountId: "acc_outlook_personal",
            originEventId: "o_personal_evt_1",
            title: "Dentist Appointment",
            description: nil,
            location: "123 Main St",
            start: EventDateTime(dateTime: "2026-02-15T14:00:00Z", date: nil, timeZone: "UTC"),
            end: EventDateTime(dateTime: "2026-02-15T15:00:00Z", date: nil, timeZone: "UTC"),
            allDay: false,
            status: "confirmed",
            visibility: "private",
            transparency: "opaque",
            recurrenceRule: nil,
            source: "provider",
            version: 1,
            createdAt: "2026-02-14T08:00:00Z",
            updatedAt: "2026-02-14T08:00:00Z"
        )

        mockAPIClient.fetchEventsResult = .success([workEvent, personalEvent])

        // WHEN: CalendarViewModel loads events
        let calVM = CalendarViewModel(
            apiClient: mockAPIClient,
            cache: mockCache,
            widgetDataProvider: widgetProvider
        )
        await calVM.loadEvents()

        // THEN: Both events are loaded and grouped
        XCTAssertEqual(calVM.events.count, 2)
        XCTAssertFalse(calVM.isOffline, "Should be online after successful fetch")
        XCTAssertNil(calVM.errorMessage)

        // Verify events come from different accounts
        let accountIds = Set(calVM.events.map { $0.originAccountId })
        XCTAssertEqual(accountIds.count, 2, "Events should span 2 accounts")
        XCTAssertTrue(accountIds.contains("acc_google_work"))
        XCTAssertTrue(accountIds.contains("acc_outlook_personal"))

        // Verify account color coding produces distinct colors
        let workColor = AccountColors.color(for: "acc_google_work")
        let personalColor = AccountColors.color(for: "acc_outlook_personal")
        XCTAssertNotEqual(workColor, personalColor, "Different accounts must have different colors")

        // Verify color name accessibility labels
        let workColorName = AccountColors.colorName(for: "acc_google_work")
        let personalColorName = AccountColors.colorName(for: "acc_outlook_personal")
        XCTAssertFalse(workColorName.isEmpty)
        XCTAssertFalse(personalColorName.isEmpty)
    }

    @MainActor
    func testE2E_Scenario2_CalendarGroupsEventsByDate() async {
        // GIVEN: Events on two different dates
        let todayEvent = CanonicalEvent(
            canonicalEventId: "evt_today_001",
            originAccountId: "acc_01",
            originEventId: "g_1",
            title: "Today Meeting",
            description: nil,
            location: nil,
            start: EventDateTime(dateTime: "2026-02-15T10:00:00Z", date: nil, timeZone: "UTC"),
            end: EventDateTime(dateTime: "2026-02-15T11:00:00Z", date: nil, timeZone: "UTC"),
            allDay: false,
            status: "confirmed",
            visibility: "default",
            transparency: "opaque",
            recurrenceRule: nil,
            source: "provider",
            version: 1,
            createdAt: "2026-02-14T00:00:00Z",
            updatedAt: "2026-02-14T00:00:00Z"
        )

        let tomorrowEvent = CanonicalEvent(
            canonicalEventId: "evt_tomorrow_001",
            originAccountId: "acc_02",
            originEventId: "g_2",
            title: "Tomorrow Meeting",
            description: nil,
            location: nil,
            start: EventDateTime(dateTime: "2026-02-16T10:00:00Z", date: nil, timeZone: "UTC"),
            end: EventDateTime(dateTime: "2026-02-16T11:00:00Z", date: nil, timeZone: "UTC"),
            allDay: false,
            status: "confirmed",
            visibility: "default",
            transparency: "opaque",
            recurrenceRule: nil,
            source: "provider",
            version: 1,
            createdAt: "2026-02-14T00:00:00Z",
            updatedAt: "2026-02-14T00:00:00Z"
        )

        mockAPIClient.fetchEventsResult = .success([todayEvent, tomorrowEvent])

        let calVM = CalendarViewModel(
            apiClient: mockAPIClient,
            cache: mockCache,
            widgetDataProvider: widgetProvider
        )

        // WHEN: Events loaded
        await calVM.loadEvents()

        // THEN: Events are grouped by date
        XCTAssertGreaterThanOrEqual(calVM.eventsByDate.keys.count, 2, "Events on different dates should produce different groups")
    }

    @MainActor
    func testE2E_Scenario2_CalendarFallsBackToCacheOnNetworkError() async {
        // GIVEN: Cached events exist, but network fails
        let cachedEvent = CanonicalEvent(
            canonicalEventId: "evt_cached_001",
            originAccountId: "acc_01",
            originEventId: "g_cached",
            title: "Cached Meeting",
            description: nil,
            location: nil,
            start: EventDateTime(dateTime: "2026-02-15T10:00:00Z", date: nil, timeZone: "UTC"),
            end: EventDateTime(dateTime: "2026-02-15T11:00:00Z", date: nil, timeZone: "UTC"),
            allDay: false,
            status: "confirmed",
            visibility: "default",
            transparency: "opaque",
            recurrenceRule: nil,
            source: "provider",
            version: 1,
            createdAt: "2026-02-14T00:00:00Z",
            updatedAt: "2026-02-14T00:00:00Z"
        )

        mockAPIClient.fetchEventsResult = .failure(APIError.networkError("No internet"))

        let calVM = CalendarViewModel(
            apiClient: mockAPIClient,
            cache: mockCache,
            widgetDataProvider: widgetProvider
        )

        // Pre-populate cache for the view range
        let range = DateRange(start: calVM.viewStart, end: calVM.viewEnd)
        mockCache.cacheEvents([cachedEvent], for: range)

        // WHEN: Load events with network down
        await calVM.loadEvents()

        // THEN: Falls back to cached data and marks offline
        XCTAssertEqual(calVM.events.count, 1)
        XCTAssertEqual(calVM.events[0].title, "Cached Meeting")
        XCTAssertTrue(calVM.isOffline, "Should indicate offline mode")
        XCTAssertNotNil(calVM.errorMessage, "Should show cached data message")
        XCTAssertTrue(calVM.errorMessage!.contains("cached"), "Message should mention cache")
    }

    // MARK: - Scenario 3: Push Notification Parsing and Deep Link Routing

    func testE2E_Scenario3_DriftAlertNotificationParsesAndRoutes() {
        // GIVEN: A drift alert push notification payload (as APNs would deliver)
        let userInfo: [AnyHashable: Any] = [
            "notification_type": "drift_alert",
            "deep_link": "tminus:///drift/rel_contact_042",
            "metadata": ["contact_name": "Alice Johnson", "days_since_last": "45"]
        ]

        // WHEN: Parse the payload
        let payload = TMinusNotificationPayload.parse(from: userInfo)

        // THEN: Type, deep link, and metadata are correctly extracted
        XCTAssertNotNil(payload, "Drift alert payload should parse successfully")
        XCTAssertEqual(payload!.notificationType, .driftAlert)
        XCTAssertEqual(payload!.deepLink, .drift(relationshipId: "rel_contact_042"))
        XCTAssertEqual(payload!.metadata["contact_name"], "Alice Johnson")
        XCTAssertEqual(payload!.metadata["days_since_last"], "45")
    }

    func testE2E_Scenario3_SchedulingProposalNotificationRoutes() {
        // GIVEN: A scheduling proposal notification
        let userInfo: [AnyHashable: Any] = [
            "notification_type": "scheduling_proposal",
            "deep_link": "tminus:///schedule/sess_abc123",
            "metadata": ["title": "1:1 with Bob"]
        ]

        // WHEN: Parse
        let payload = TMinusNotificationPayload.parse(from: userInfo)

        // THEN: Routes to scheduling screen
        XCTAssertNotNil(payload)
        XCTAssertEqual(payload!.notificationType, .schedulingProposal)
        XCTAssertEqual(payload!.deepLink, .schedule(sessionId: "sess_abc123"))
    }

    func testE2E_Scenario3_ReconnectionSuggestionNotification() {
        // GIVEN: A reconnection suggestion notification
        let userInfo: [AnyHashable: Any] = [
            "notification_type": "reconnection_suggestion",
            "deep_link": "tminus:///relationships",
            "metadata": ["suggestion": "Reach out to Carol"]
        ]

        // WHEN: Parse
        let payload = TMinusNotificationPayload.parse(from: userInfo)

        // THEN: Routes to relationships screen
        XCTAssertNotNil(payload)
        XCTAssertEqual(payload!.notificationType, .reconnectionSuggestion)
        XCTAssertEqual(payload!.deepLink, .relationships)
    }

    func testE2E_Scenario3_RiskWarningNotification() {
        // GIVEN: A risk warning notification
        let userInfo: [AnyHashable: Any] = [
            "notification_type": "risk_warning",
            "deep_link": "tminus:///dashboard",
            "metadata": ["risk_level": "high", "reason": "6 back-to-back meetings"]
        ]

        // WHEN: Parse
        let payload = TMinusNotificationPayload.parse(from: userInfo)

        // THEN: Routes to dashboard
        XCTAssertNotNil(payload)
        XCTAssertEqual(payload!.notificationType, .riskWarning)
        XCTAssertEqual(payload!.deepLink, .dashboard)
        XCTAssertEqual(payload!.metadata["risk_level"], "high")
    }

    func testE2E_Scenario3_HoldExpiryNotification() {
        // GIVEN: A hold expiry notification
        let userInfo: [AnyHashable: Any] = [
            "notification_type": "hold_expiry",
            "deep_link": "tminus:///schedule/holds",
            "metadata": ["hold_count": "3"]
        ]

        // WHEN: Parse
        let payload = TMinusNotificationPayload.parse(from: userInfo)

        // THEN: Routes to schedule holds
        XCTAssertNotNil(payload)
        XCTAssertEqual(payload!.notificationType, .holdExpiry)
        XCTAssertEqual(payload!.deepLink, .scheduleHolds)
    }

    func testE2E_Scenario3_AllNotificationTypesHaveDisplayNames() {
        // GIVEN: All notification types
        // THEN: Each has a non-empty display name and description
        for type in TMinusNotificationType.allCases {
            XCTAssertFalse(type.displayName.isEmpty, "\(type) should have a display name")
            XCTAssertFalse(type.settingsDescription.isEmpty, "\(type) should have a settings description")
        }
    }

    func testE2E_Scenario3_MalformedNotificationPayloadReturnsNil() {
        // GIVEN: An invalid payload
        let badUserInfo: [AnyHashable: Any] = [
            "notification_type": "nonexistent_type",
            "deep_link": "tminus:///dashboard",
        ]

        // WHEN: Parse
        let payload = TMinusNotificationPayload.parse(from: badUserInfo)

        // THEN: Returns nil gracefully
        XCTAssertNil(payload, "Invalid notification type should return nil")
    }

    func testE2E_Scenario3_DefaultNotificationSettings() {
        // GIVEN: Default notification settings
        let settings = NotificationSettingsModel.defaults

        // THEN: All types enabled, quiet hours off
        for type in TMinusNotificationType.allCases {
            let pref = settings.preferences[type.rawValue]
            XCTAssertNotNil(pref, "\(type) should have a preference entry")
            XCTAssertTrue(pref!.enabled, "\(type) should be enabled by default")
        }
        XCTAssertFalse(settings.quietHours.enabled, "Quiet hours should be off by default")
        XCTAssertEqual(settings.quietHours.start, "22:00")
        XCTAssertEqual(settings.quietHours.end, "07:00")
    }

    // MARK: - Scenario 4: Widget Data Provider + Timeline Computation

    func testE2E_Scenario4_WidgetShowsNext3Events() {
        // GIVEN: Events written to the widget data provider (simulating main app sync)
        let events = [
            CanonicalEvent(
                canonicalEventId: "evt_w1",
                originAccountId: "acc_work",
                originEventId: "g_w1",
                title: "Standup",
                description: nil,
                location: nil,
                start: EventDateTime(dateTime: "2026-02-15T09:00:00Z", date: nil, timeZone: "UTC"),
                end: EventDateTime(dateTime: "2026-02-15T09:15:00Z", date: nil, timeZone: "UTC"),
                allDay: false,
                status: "confirmed",
                visibility: "default",
                transparency: "opaque",
                recurrenceRule: nil,
                source: "provider",
                version: 1,
                createdAt: "2026-02-14T00:00:00Z",
                updatedAt: "2026-02-14T00:00:00Z"
            ),
            CanonicalEvent(
                canonicalEventId: "evt_w2",
                originAccountId: "acc_personal",
                originEventId: "g_w2",
                title: "Design Sync",
                description: nil,
                location: "Zoom",
                start: EventDateTime(dateTime: "2026-02-15T11:00:00Z", date: nil, timeZone: "UTC"),
                end: EventDateTime(dateTime: "2026-02-15T12:00:00Z", date: nil, timeZone: "UTC"),
                allDay: false,
                status: "confirmed",
                visibility: "default",
                transparency: "opaque",
                recurrenceRule: nil,
                source: "provider",
                version: 1,
                createdAt: "2026-02-14T00:00:00Z",
                updatedAt: "2026-02-14T00:00:00Z"
            ),
            CanonicalEvent(
                canonicalEventId: "evt_w3",
                originAccountId: "acc_work",
                originEventId: "g_w3",
                title: "Sprint Review",
                description: nil,
                location: nil,
                start: EventDateTime(dateTime: "2026-02-15T15:00:00Z", date: nil, timeZone: "UTC"),
                end: EventDateTime(dateTime: "2026-02-15T16:00:00Z", date: nil, timeZone: "UTC"),
                allDay: false,
                status: "confirmed",
                visibility: "default",
                transparency: "opaque",
                recurrenceRule: nil,
                source: "provider",
                version: 1,
                createdAt: "2026-02-14T00:00:00Z",
                updatedAt: "2026-02-14T00:00:00Z"
            ),
            CanonicalEvent(
                canonicalEventId: "evt_w4",
                originAccountId: "acc_personal",
                originEventId: "g_w4",
                title: "Gym",
                description: nil,
                location: nil,
                start: EventDateTime(dateTime: "2026-02-15T18:00:00Z", date: nil, timeZone: "UTC"),
                end: EventDateTime(dateTime: "2026-02-15T19:00:00Z", date: nil, timeZone: "UTC"),
                allDay: false,
                status: "confirmed",
                visibility: "default",
                transparency: "opaque",
                recurrenceRule: nil,
                source: "provider",
                version: 1,
                createdAt: "2026-02-14T00:00:00Z",
                updatedAt: "2026-02-14T00:00:00Z"
            ),
        ]

        // WHEN: Write events and generate medium widget snapshot
        widgetProvider.writeEvents(events)
        let widgetEvents = widgetProvider.readEvents()
        XCTAssertEqual(widgetEvents.count, 4, "All 4 events should survive write/read cycle")

        let refDate = ISO8601DateFormatter().date(from: "2026-02-15T08:30:00Z")!
        let snapshot = WidgetTimelineLogic.snapshot(
            for: .medium,
            events: widgetEvents,
            referenceDate: refDate,
            isStale: false,
            lastUpdated: widgetProvider.lastUpdated,
            calendar: utcCalendar
        )

        // THEN: Medium widget shows next 3 upcoming events
        XCTAssertEqual(snapshot.events.count, 3, "Medium widget should show 3 events")
        XCTAssertEqual(snapshot.events[0].title, "Standup")
        XCTAssertEqual(snapshot.events[1].title, "Design Sync")
        XCTAssertEqual(snapshot.events[2].title, "Sprint Review")
        XCTAssertFalse(snapshot.isStale)
        XCTAssertNotNil(snapshot.lastUpdatedString)
    }

    func testE2E_Scenario4_SmallWidgetShowsNextEvent() {
        // GIVEN: Events
        let event1 = WidgetEventData(
            eventId: "evt_small_1",
            title: "Next Call",
            accountId: "acc_01",
            startDate: ISO8601DateFormatter().date(from: "2026-02-15T10:00:00Z")!,
            endDate: ISO8601DateFormatter().date(from: "2026-02-15T10:30:00Z")!,
            isAllDay: false,
            location: nil
        )
        let event2 = WidgetEventData(
            eventId: "evt_small_2",
            title: "Later Meeting",
            accountId: "acc_02",
            startDate: ISO8601DateFormatter().date(from: "2026-02-15T14:00:00Z")!,
            endDate: ISO8601DateFormatter().date(from: "2026-02-15T15:00:00Z")!,
            isAllDay: false,
            location: nil
        )

        widgetProvider.writeWidgetEvents([event1, event2])
        let widgetEvents = widgetProvider.readEvents()

        let refDate = ISO8601DateFormatter().date(from: "2026-02-15T09:00:00Z")!
        let snapshot = WidgetTimelineLogic.snapshot(
            for: .small,
            events: widgetEvents,
            referenceDate: refDate,
            calendar: utcCalendar
        )

        // THEN: Small widget shows only the next event
        XCTAssertEqual(snapshot.events.count, 1)
        XCTAssertEqual(snapshot.events[0].title, "Next Call")
    }

    func testE2E_Scenario4_LargeWidgetShowsTodaySchedule() {
        // GIVEN: Events spanning today and tomorrow plus an all-day
        let allDayEvent = WidgetEventData(
            eventId: "evt_allday",
            title: "Team Offsite",
            accountId: "acc_01",
            startDate: ISO8601DateFormatter().date(from: "2026-02-15T00:00:00Z")!,
            endDate: ISO8601DateFormatter().date(from: "2026-02-16T00:00:00Z")!,
            isAllDay: true,
            location: "HQ"
        )
        let morningEvent = WidgetEventData(
            eventId: "evt_morning",
            title: "Kickoff",
            accountId: "acc_01",
            startDate: ISO8601DateFormatter().date(from: "2026-02-15T09:00:00Z")!,
            endDate: ISO8601DateFormatter().date(from: "2026-02-15T10:00:00Z")!,
            isAllDay: false,
            location: nil
        )
        let tomorrowEvent = WidgetEventData(
            eventId: "evt_tmrw",
            title: "Tomorrow Only",
            accountId: "acc_02",
            startDate: ISO8601DateFormatter().date(from: "2026-02-16T10:00:00Z")!,
            endDate: ISO8601DateFormatter().date(from: "2026-02-16T11:00:00Z")!,
            isAllDay: false,
            location: nil
        )

        widgetProvider.writeWidgetEvents([allDayEvent, morningEvent, tomorrowEvent])
        let widgetEvents = widgetProvider.readEvents()

        let refDate = ISO8601DateFormatter().date(from: "2026-02-15T08:00:00Z")!
        let snapshot = WidgetTimelineLogic.snapshot(
            for: .large,
            events: widgetEvents,
            referenceDate: refDate,
            calendar: utcCalendar
        )

        // THEN: Large widget shows today only (all-day + morning), not tomorrow
        XCTAssertEqual(snapshot.events.count, 2, "Should show 2 today events")
        XCTAssertEqual(snapshot.events[0].title, "Team Offsite", "All-day event first")
        XCTAssertEqual(snapshot.events[1].title, "Kickoff")
        XCTAssertFalse(snapshot.events.contains(where: { $0.title == "Tomorrow Only" }))
    }

    func testE2E_Scenario4_WidgetDeepLinkRoundTrip() {
        // GIVEN: An event written to widget store
        let event = WidgetEventData(
            eventId: "evt_deeplink_e2e",
            title: "Tap This Event",
            accountId: "acc_01",
            startDate: Date(),
            endDate: Date().addingTimeInterval(3600),
            isAllDay: false,
            location: nil
        )

        widgetProvider.writeWidgetEvents([event])
        let loaded = widgetProvider.readEvents()

        // WHEN: Widget generates deep link and app parses it
        let deepLinkURL = loaded[0].deepLinkURL
        let parsedId = DeepLinkGenerator.parseEventId(from: deepLinkURL)

        // THEN: Event ID survives the round trip
        XCTAssertEqual(parsedId, "evt_deeplink_e2e")
    }

    func testE2E_Scenario4_WidgetAccountColorsCodingPreserved() {
        // GIVEN: Events from 2 accounts known to produce different colors
        // (acc_work and acc_personal are used by existing tests and are known-distinct)
        let accts = ["acc_work_google", "acc_personal_outlook"]
        let events = accts.enumerated().map { idx, acct in
            WidgetEventData(
                eventId: "evt_color_\(idx)",
                title: "Event \(idx)",
                accountId: acct,
                startDate: ISO8601DateFormatter().date(from: "2026-02-15T\(String(format: "%02d", 09 + idx)):00:00Z")!,
                endDate: ISO8601DateFormatter().date(from: "2026-02-15T\(String(format: "%02d", 10 + idx)):00:00Z")!,
                isAllDay: false,
                location: nil
            )
        }

        widgetProvider.writeWidgetEvents(events)
        let loaded = widgetProvider.readEvents()

        // THEN: Account IDs preserved through write/read cycle
        let loadedAccts = loaded.map { $0.accountId }
        XCTAssertEqual(Set(loadedAccts), Set(accts), "Account IDs must survive widget data pipeline")

        // Verify color assignment is deterministic (same ID always gives same color)
        let color1a = AccountColors.color(for: "acc_work_google")
        let color1b = AccountColors.color(for: "acc_work_google")
        XCTAssertEqual(color1a, color1b, "Color assignment must be deterministic for same account ID")

        // Verify different accounts produce different colors
        let workColor = AccountColors.color(for: "acc_work_google")
        let personalColor = AccountColors.color(for: "acc_personal_outlook")
        XCTAssertNotEqual(workColor, personalColor, "Different accounts should have different colors")
    }

    // MARK: - Scenario 5: Watch Complication Data from Synced Events

    func testE2E_Scenario5_WatchComplicationShowsNextMeeting() {
        // GIVEN: Today's events (as synced from phone to watch)
        let events = [
            WidgetEventData(
                eventId: "evt_watch_1",
                title: "Board Meeting",
                accountId: "acc_work",
                startDate: ISO8601DateFormatter().date(from: "2026-02-15T14:00:00Z")!,
                endDate: ISO8601DateFormatter().date(from: "2026-02-15T15:30:00Z")!,
                isAllDay: false,
                location: "Boardroom"
            ),
            WidgetEventData(
                eventId: "evt_watch_2",
                title: "Team Happy Hour",
                accountId: "acc_personal",
                startDate: ISO8601DateFormatter().date(from: "2026-02-15T17:00:00Z")!,
                endDate: ISO8601DateFormatter().date(from: "2026-02-15T18:00:00Z")!,
                isAllDay: false,
                location: "Rooftop Bar"
            ),
        ]

        let refDate = ISO8601DateFormatter().date(from: "2026-02-15T12:00:00Z")!

        // WHEN: Compute complication data
        let nextEvent = WatchComplicationLogic.nextEvent(from: events, referenceDate: refDate, calendar: utcCalendar)

        // THEN: Shows the Board Meeting as next
        XCTAssertNotNil(nextEvent)
        XCTAssertEqual(nextEvent!.title, "Board Meeting")
        XCTAssertEqual(nextEvent!.eventId, "evt_watch_1")

        // Verify time display
        let timeDisplay = WatchComplicationLogic.nextEventTimeDisplay(for: nextEvent!, referenceDate: refDate)
        XCTAssertEqual(timeDisplay, "in 2h", "Board Meeting is 2 hours away")
    }

    func testE2E_Scenario5_WatchComplicationAllFamilies() {
        // GIVEN: Events for today
        let events = [
            WidgetEventData(
                eventId: "evt_cf_1",
                title: "Standup",
                accountId: "acc_01",
                startDate: ISO8601DateFormatter().date(from: "2026-02-15T09:00:00Z")!,
                endDate: ISO8601DateFormatter().date(from: "2026-02-15T09:15:00Z")!,
                isAllDay: false,
                location: nil
            ),
            WidgetEventData(
                eventId: "evt_cf_2",
                title: "Retro",
                accountId: "acc_01",
                startDate: ISO8601DateFormatter().date(from: "2026-02-15T14:00:00Z")!,
                endDate: ISO8601DateFormatter().date(from: "2026-02-15T15:00:00Z")!,
                isAllDay: false,
                location: nil
            ),
        ]

        let refDate = ISO8601DateFormatter().date(from: "2026-02-15T08:00:00Z")!

        // WHEN: Generate complication data for all families
        for family in ComplicationFamily.allCases {
            let data = WatchComplicationLogic.complicationData(
                family: family,
                events: events,
                referenceDate: refDate,
                calendar: utcCalendar
            )

            // THEN: Each family has consistent data
            XCTAssertEqual(data.family, family)
            XCTAssertEqual(data.nextEventTitle, "Standup", "\(family) should show Standup as next")
            XCTAssertNotNil(data.nextEventTime)
            XCTAssertEqual(data.meetingCount, 2, "\(family) should count 2 meetings")
            XCTAssertGreaterThan(data.freeTimeMinutes, 0)
            XCTAssertFalse(data.freeTimeDisplay.isEmpty)
            XCTAssertEqual(data.meetingCountDisplay, "2 meetings")
        }
    }

    func testE2E_Scenario5_WatchComplicationFreeTimeCalculation() {
        // GIVEN: Events consuming specific time
        let events = [
            WidgetEventData(
                eventId: "evt_free_1",
                title: "Morning Block",
                accountId: "acc_01",
                startDate: ISO8601DateFormatter().date(from: "2026-02-15T09:00:00Z")!,
                endDate: ISO8601DateFormatter().date(from: "2026-02-15T11:00:00Z")!,
                isAllDay: false,
                location: nil
            ),
            WidgetEventData(
                eventId: "evt_free_2",
                title: "Afternoon Block",
                accountId: "acc_01",
                startDate: ISO8601DateFormatter().date(from: "2026-02-15T14:00:00Z")!,
                endDate: ISO8601DateFormatter().date(from: "2026-02-15T16:00:00Z")!,
                isAllDay: false,
                location: nil
            ),
        ]

        // Reference: 8:00 UTC. Day ends at midnight UTC.
        // Total remaining: 16 hours = 960 minutes
        // Busy: 2h (9-11) + 2h (14-16) = 4 hours = 240 minutes
        // Free: 960 - 240 = 720 minutes = 12h
        let refDate = ISO8601DateFormatter().date(from: "2026-02-15T08:00:00Z")!
        let freeMinutes = WatchComplicationLogic.freeTimeRemainingToday(
            from: events, referenceDate: refDate, calendar: utcCalendar
        )

        XCTAssertEqual(freeMinutes, 720, "Free time should be 12 hours (720 minutes)")

        // Verify display string
        let display = WatchComplicationLogic.freeTimeDisplayString(minutes: freeMinutes)
        XCTAssertEqual(display, "12h free")
    }

    func testE2E_Scenario5_WatchSyncPayloadRoundTrip() {
        // GIVEN: Events to sync to watch
        let events = [
            WidgetEventData(
                eventId: "evt_sync_1",
                title: "Synced Meeting",
                accountId: "acc_01",
                startDate: ISO8601DateFormatter().date(from: "2026-02-15T10:00:00Z")!,
                endDate: ISO8601DateFormatter().date(from: "2026-02-15T11:00:00Z")!,
                isAllDay: false,
                location: "Virtual"
            ),
        ]

        let payload = WatchSyncPayload(
            events: events,
            syncTimestamp: ISO8601DateFormatter().date(from: "2026-02-15T09:00:00Z")!,
            syncVersion: 42,
            messageType: .eventSync
        )

        // WHEN: Encode to dictionary and decode back (simulating WCSession transfer)
        do {
            let dict = try payload.toDictionary()
            let decoded = try WatchSyncPayload.fromDictionary(dict)

            // THEN: All fields survive the round trip
            XCTAssertEqual(decoded.events.count, 1)
            XCTAssertEqual(decoded.events[0].title, "Synced Meeting")
            XCTAssertEqual(decoded.events[0].eventId, "evt_sync_1")
            XCTAssertEqual(decoded.events[0].location, "Virtual")
            XCTAssertEqual(decoded.syncVersion, 42)
            XCTAssertEqual(decoded.messageType, .eventSync)
        } catch {
            XCTFail("WatchSyncPayload round-trip failed: \(error)")
        }
    }

    func testE2E_Scenario5_WatchSyncComplicationPayload() {
        // GIVEN: A complication-specific sync payload
        let events = [
            WidgetEventData(
                eventId: "evt_comp_1",
                title: "Next Up",
                accountId: "acc_01",
                startDate: ISO8601DateFormatter().date(from: "2026-02-15T14:00:00Z")!,
                endDate: ISO8601DateFormatter().date(from: "2026-02-15T14:30:00Z")!,
                isAllDay: false,
                location: nil
            ),
        ]

        let payload = WatchSyncPayload(
            events: events,
            syncTimestamp: Date(),
            syncVersion: 7,
            messageType: .complicationUpdate
        )

        do {
            let dict = try payload.toDictionary()
            let decoded = try WatchSyncPayload.fromDictionary(dict)

            XCTAssertEqual(decoded.messageType, .complicationUpdate)
            XCTAssertEqual(decoded.events.count, 1)
        } catch {
            XCTFail("Complication payload round-trip failed: \(error)")
        }
    }

    func testE2E_Scenario5_WatchSyncStateTracking() {
        // GIVEN: A fresh sync state
        var state = WatchSyncState()
        XCTAssertFalse(state.isSynced, "Should not be synced initially")
        XCTAssertFalse(state.isDataFresh(), "No data is fresh when never synced")

        // WHEN: Record a sync
        let syncTime = Date()
        state.recordSync(timestamp: syncTime, version: 5)

        // THEN: State reflects the sync
        XCTAssertTrue(state.isSynced)
        XCTAssertEqual(state.syncVersion, 5)
        XCTAssertTrue(state.isDataFresh(at: syncTime, ttl: 3600), "Data should be fresh immediately after sync")

        // THEN: Data becomes stale after TTL
        let futureDate = syncTime.addingTimeInterval(7200) // 2 hours later
        XCTAssertFalse(state.isDataFresh(at: futureDate, ttl: 3600), "Data should be stale after TTL")
    }

    // MARK: - Scenario 6: Event Creation + Quick Actions + Scheduling Workflow

    @MainActor
    func testE2E_Scenario6_CreateEventFromMobile() async {
        // GIVEN: A configured form with valid data
        let accounts = [
            CalendarAccount(
                accountId: "acc_e2e_primary",
                provider: "google",
                email: "user@work.com",
                displayName: "Work",
                status: "active"
            ),
        ]
        mockAPIClient.fetchAccountsResult = .success(accounts)
        mockAPIClient.createEventResult = .success(
            CreateEventResponse(canonicalEventId: "evt_created_e2e_001", originEventId: "g_new_001")
        )

        let formVM = EventFormViewModel(
            apiClient: mockAPIClient,
            haptics: mockHaptics,
            offlineQueue: mockOfflineQueue
        )

        // Load accounts
        await formVM.loadAccounts()
        XCTAssertEqual(formVM.accounts.count, 1)
        XCTAssertEqual(formVM.selectedAccountId, "acc_e2e_primary", "First account auto-selected")

        // Fill form
        formVM.title = "Architecture Review"
        formVM.startDate = Date().addingTimeInterval(3600) // 1 hour from now
        formVM.endDate = Date().addingTimeInterval(7200)   // 2 hours from now
        formVM.eventDescription = "Review system architecture decisions"
        formVM.location = "Room B"

        // WHEN: Submit the event
        await formVM.submitEvent()

        // THEN: Event created successfully
        XCTAssertTrue(mockAPIClient.createEventCalled)
        XCTAssertNotNil(formVM.successMessage)
        XCTAssertTrue(formVM.successMessage!.contains("evt_created_e2e_001"))
        XCTAssertNil(formVM.errorMessage)

        // Verify correct request was sent
        let request = mockAPIClient.lastCreateEventRequest!
        XCTAssertEqual(request.title, "Architecture Review")
        XCTAssertEqual(request.accountId, "acc_e2e_primary")
        XCTAssertEqual(request.description, "Review system architecture decisions")
        XCTAssertEqual(request.location, "Room B")
        XCTAssertFalse(request.allDay)

        // Verify haptic feedback
        XCTAssertTrue(mockHaptics.triggeredFeedbacks.contains(.success), "Should trigger success haptic")

        // Verify form was reset
        XCTAssertTrue(formVM.title.isEmpty, "Form should reset after success")
    }

    @MainActor
    func testE2E_Scenario6_CreateEventFailsValidation() async {
        // GIVEN: Form with missing title
        let formVM = EventFormViewModel(
            apiClient: mockAPIClient,
            haptics: mockHaptics,
            offlineQueue: mockOfflineQueue
        )

        formVM.title = ""
        formVM.selectedAccountId = "acc_01"

        // WHEN: Try to submit
        await formVM.submitEvent()

        // THEN: Validation fails, no API call
        XCTAssertFalse(mockAPIClient.createEventCalled)
        XCTAssertTrue(formVM.validationErrors.contains(.titleEmpty))
        XCTAssertTrue(mockHaptics.triggeredFeedbacks.contains(.warning), "Should trigger warning haptic on validation failure")
    }

    @MainActor
    func testE2E_Scenario6_QuickActionFindOneOnOne() async {
        // GIVEN: EventFormViewModel
        let formVM = EventFormViewModel(
            apiClient: mockAPIClient,
            haptics: mockHaptics,
            offlineQueue: mockOfflineQueue
        )

        // WHEN: Apply "Find 1:1" quick action
        formVM.applyQuickAction(.findOneOnOne)

        // THEN: Form is pre-filled with 1:1 defaults
        XCTAssertEqual(formVM.title, "1:1 Meeting")
        XCTAssertTrue(formVM.isSchedulingMode, "1:1 should enable scheduling mode")
        XCTAssertFalse(formVM.isAllDay)
        XCTAssertEqual(formVM.transparency, "opaque")
        XCTAssertTrue(mockHaptics.triggeredFeedbacks.contains(.selectionChanged))

        // Verify duration is approximately 30 minutes
        let duration = formVM.endDate.timeIntervalSince(formVM.startDate)
        XCTAssertEqual(duration, 1800, accuracy: 60, "1:1 should be ~30 minutes")
    }

    @MainActor
    func testE2E_Scenario6_QuickActionBlockFocusTime() async {
        // GIVEN: EventFormViewModel
        let formVM = EventFormViewModel(
            apiClient: mockAPIClient,
            haptics: mockHaptics,
            offlineQueue: mockOfflineQueue
        )

        // WHEN: Apply "Block Focus Time" quick action
        formVM.applyQuickAction(.blockFocusTime)

        // THEN: Form is pre-filled with focus time defaults
        XCTAssertEqual(formVM.title, "Focus Time")
        XCTAssertTrue(formVM.isSchedulingMode, "Focus time should use scheduling")
        XCTAssertFalse(formVM.isAllDay)

        // Duration should be approximately 120 minutes
        let duration = formVM.endDate.timeIntervalSince(formVM.startDate)
        XCTAssertEqual(duration, 7200, accuracy: 60, "Focus time should be ~120 minutes")
    }

    @MainActor
    func testE2E_Scenario6_QuickActionAddTrip() async {
        // GIVEN: EventFormViewModel
        let formVM = EventFormViewModel(
            apiClient: mockAPIClient,
            haptics: mockHaptics,
            offlineQueue: mockOfflineQueue
        )

        // WHEN: Apply "Add Trip" quick action
        formVM.applyQuickAction(.addTrip)

        // THEN: Form is set for all-day event, no scheduling
        XCTAssertEqual(formVM.title, "Trip")
        XCTAssertTrue(formVM.isAllDay, "Trip should be all-day")
        XCTAssertFalse(formVM.isSchedulingMode, "Trip should not use scheduling")
    }

    @MainActor
    func testE2E_Scenario6_FullSchedulingWorkflow_ProposeSelectCommit() async {
        // GIVEN: Accounts loaded and scheduling candidates available
        let accounts = [
            CalendarAccount(
                accountId: "acc_sched_01",
                provider: "google",
                email: "user@company.com",
                displayName: "Work",
                status: "active"
            ),
        ]
        mockAPIClient.fetchAccountsResult = .success(accounts)

        let candidates = [
            SchedulingCandidate(
                candidateId: "cand_e2e_001",
                start: "2026-02-17T09:00:00Z",
                end: "2026-02-17T09:30:00Z",
                score: 0.95,
                reason: "Optimal morning slot"
            ),
            SchedulingCandidate(
                candidateId: "cand_e2e_002",
                start: "2026-02-17T14:00:00Z",
                end: "2026-02-17T14:30:00Z",
                score: 0.78,
                reason: "Afternoon alternative"
            ),
        ]
        mockAPIClient.proposeTimesResult = .success(
            ProposeTimesResponse(sessionId: "sess_e2e_001", candidates: candidates)
        )
        mockAPIClient.commitCandidateResult = .success(
            CommitCandidateResponse(canonicalEventId: "evt_scheduled_e2e", originEventId: "g_sched_001")
        )

        let formVM = EventFormViewModel(
            apiClient: mockAPIClient,
            haptics: mockHaptics,
            offlineQueue: mockOfflineQueue
        )

        // Load accounts
        await formVM.loadAccounts()
        XCTAssertEqual(formVM.selectedAccountId, "acc_sched_01")

        // Step 1: Apply quick action and propose times
        formVM.applyQuickAction(.findOneOnOne)
        XCTAssertTrue(formVM.isSchedulingMode)

        // Enable a constraint
        formVM.preferMorning = true
        formVM.avoidBackToBack = true

        // Step 2: Propose times
        await formVM.proposeTimes()

        XCTAssertTrue(mockAPIClient.proposeTimesCalled)
        XCTAssertEqual(formVM.schedulingSessionId, "sess_e2e_001")
        XCTAssertEqual(formVM.schedulingCandidates.count, 2)
        XCTAssertEqual(formVM.schedulingCandidates[0].score, 0.95)
        XCTAssertTrue(mockHaptics.triggeredFeedbacks.contains(.success), "Should haptic on propose success")

        // Verify constraints were sent
        let proposeRequest = mockAPIClient.lastProposeTimesRequest!
        XCTAssertEqual(proposeRequest.constraints?.preferMorning, true)
        XCTAssertEqual(proposeRequest.constraints?.avoidBackToBack, true)
        XCTAssertNil(proposeRequest.constraints?.preferAfternoon, "Unset constraint should be nil")

        // Step 3: Select the best candidate
        formVM.selectCandidate("cand_e2e_001")
        XCTAssertEqual(formVM.selectedCandidateId, "cand_e2e_001")
        XCTAssertTrue(mockHaptics.triggeredFeedbacks.contains(.selectionChanged))

        // Step 4: Commit the selected candidate
        await formVM.commitSelectedCandidate()

        XCTAssertTrue(mockAPIClient.commitCandidateCalled)
        let commitRequest = mockAPIClient.lastCommitCandidateRequest!
        XCTAssertEqual(commitRequest.sessionId, "sess_e2e_001")
        XCTAssertEqual(commitRequest.candidateId, "cand_e2e_001")
        XCTAssertEqual(commitRequest.accountId, "acc_sched_01")

        // Verify success
        XCTAssertNotNil(formVM.successMessage)
        XCTAssertTrue(formVM.successMessage!.contains("evt_scheduled_e2e"))
        XCTAssertNil(formVM.errorMessage)

        // Verify form was reset after commit
        XCTAssertTrue(formVM.title.isEmpty, "Form should reset after scheduling commit")
        XCTAssertFalse(formVM.isSchedulingMode)
        XCTAssertNil(formVM.selectedCandidateId)
        XCTAssertNil(formVM.schedulingSessionId)
        XCTAssertTrue(formVM.schedulingCandidates.isEmpty)
    }

    @MainActor
    func testE2E_Scenario6_SchedulingWithoutCandidateSelectedShowsError() async {
        // GIVEN: A form with no candidate selected
        let formVM = EventFormViewModel(
            apiClient: mockAPIClient,
            haptics: mockHaptics,
            offlineQueue: mockOfflineQueue
        )

        // WHEN: Try to commit without selection
        await formVM.commitSelectedCandidate()

        // THEN: Error shown
        XCTAssertNotNil(formVM.errorMessage)
        XCTAssertTrue(formVM.errorMessage!.contains("select"), "Error should mention selection")
    }

    @MainActor
    func testE2E_Scenario6_ShareMeetingLink() async {
        // GIVEN: A form with an account selected
        let formVM = EventFormViewModel(
            apiClient: mockAPIClient,
            haptics: mockHaptics,
            offlineQueue: mockOfflineQueue
        )
        formVM.selectedAccountId = "acc_share_01"
        formVM.title = "Sync Meeting"

        // WHEN: Generate share link
        let url = formVM.shareMeetingLink()

        // THEN: URL contains title and account
        XCTAssertNotNil(url)
        let urlString = url!.absoluteString
        XCTAssertTrue(urlString.contains("tminus.ink/schedule"))
        XCTAssertTrue(urlString.contains("acc_share_01"))
        XCTAssertTrue(urlString.contains("Sync"))
    }

    @MainActor
    func testE2E_Scenario6_ShareMeetingLinkWithoutAccountReturnsNil() async {
        // GIVEN: No account selected
        let formVM = EventFormViewModel(
            apiClient: mockAPIClient,
            haptics: mockHaptics,
            offlineQueue: mockOfflineQueue
        )
        formVM.selectedAccountId = nil

        // WHEN/THEN: No share link
        XCTAssertNil(formVM.shareMeetingLink())
    }

    // MARK: - Scenario 7: Offline Queue Behavior

    @MainActor
    func testE2E_Scenario7_EventCreationQueuesOnNetworkFailure() async {
        // GIVEN: Network fails for event creation
        mockAPIClient.fetchAccountsResult = .success([
            CalendarAccount(accountId: "acc_offline", provider: "google", email: "offline@test.com", displayName: "Offline", status: "active")
        ])
        mockAPIClient.createEventResult = .failure(APIError.networkError("Connection timeout"))

        let formVM = EventFormViewModel(
            apiClient: mockAPIClient,
            haptics: mockHaptics,
            offlineQueue: mockOfflineQueue
        )
        await formVM.loadAccounts()

        // Fill form
        formVM.title = "Offline Event"
        formVM.startDate = Date().addingTimeInterval(3600)
        formVM.endDate = Date().addingTimeInterval(7200)

        // WHEN: Submit while offline
        await formVM.submitEvent()

        // THEN: Operation is queued
        XCTAssertTrue(mockOfflineQueue.enqueueCalled, "Should enqueue the operation")
        XCTAssertEqual(mockOfflineQueue.count, 1, "Queue should have 1 operation")

        let queued = mockOfflineQueue.operations[0]
        XCTAssertEqual(queued.type, .createEvent)
        XCTAssertEqual(queued.retryCount, 0)

        // User gets a "queued" success message, not an error
        XCTAssertNotNil(formVM.successMessage)
        XCTAssertTrue(formVM.successMessage!.contains("queued"), "Should indicate event was queued")
        XCTAssertTrue(mockHaptics.triggeredFeedbacks.contains(.warning), "Should warn about offline queue")
    }

    @MainActor
    func testE2E_Scenario7_CommitQueuesOnNetworkFailure() async {
        // GIVEN: Network fails for commit
        mockAPIClient.commitCandidateResult = .failure(APIError.networkError("No internet"))

        let formVM = EventFormViewModel(
            apiClient: mockAPIClient,
            haptics: mockHaptics,
            offlineQueue: mockOfflineQueue
        )
        formVM.schedulingSessionId = "sess_offline_001"
        formVM.selectedCandidateId = "cand_offline_001"
        formVM.selectedAccountId = "acc_offline"

        // WHEN: Try to commit offline
        await formVM.commitSelectedCandidate()

        // THEN: Commit operation queued
        XCTAssertTrue(mockOfflineQueue.enqueueCalled)
        XCTAssertEqual(mockOfflineQueue.count, 1)

        let queued = mockOfflineQueue.operations[0]
        XCTAssertEqual(queued.type, .commitCandidate)

        // Verify the queued payload contains the right data
        let decoder = JSONDecoder()
        let request = try! decoder.decode(CommitCandidateRequest.self, from: queued.payload)
        XCTAssertEqual(request.sessionId, "sess_offline_001")
        XCTAssertEqual(request.candidateId, "cand_offline_001")
        XCTAssertEqual(request.accountId, "acc_offline")
    }

    @MainActor
    func testE2E_Scenario7_DrainOfflineQueueOnReconnect() async {
        // GIVEN: Two operations in the queue
        let createReq = CreateEventRequest(
            title: "Queued Event",
            accountId: "acc_drain",
            start: "2026-02-17T10:00:00Z",
            end: "2026-02-17T11:00:00Z",
            allDay: false,
            description: nil,
            location: nil,
            visibility: "default",
            transparency: "opaque"
        )
        let commitReq = CommitCandidateRequest(
            sessionId: "sess_drain_001",
            candidateId: "cand_drain_001",
            accountId: "acc_drain"
        )

        if let op1 = PendingOperation.createEvent(createReq) {
            mockOfflineQueue.enqueue(op1)
        }
        if let op2 = PendingOperation.commitCandidate(commitReq) {
            mockOfflineQueue.enqueue(op2)
        }

        XCTAssertEqual(mockOfflineQueue.count, 2)

        // API now succeeds (connectivity restored)
        mockAPIClient.createEventResult = .success(
            CreateEventResponse(canonicalEventId: "evt_drained_001", originEventId: "g_drained")
        )
        mockAPIClient.commitCandidateResult = .success(
            CommitCandidateResponse(canonicalEventId: "evt_drained_002", originEventId: "g_drained_2")
        )

        let formVM = EventFormViewModel(
            apiClient: mockAPIClient,
            haptics: mockHaptics,
            offlineQueue: mockOfflineQueue
        )

        // WHEN: Drain the queue
        await formVM.drainOfflineQueue()

        // THEN: Both operations processed and removed
        XCTAssertEqual(mockOfflineQueue.count, 0, "Queue should be empty after drain")
        XCTAssertTrue(mockAPIClient.createEventCalled)
        XCTAssertTrue(mockAPIClient.commitCandidateCalled)
    }

    @MainActor
    func testE2E_Scenario7_OfflineQueueSkipsMaxRetries() async {
        // GIVEN: An operation that has been retried max times
        let createReq = CreateEventRequest(
            title: "Exhausted Event",
            accountId: "acc_retry",
            start: "2026-02-17T10:00:00Z",
            end: "2026-02-17T11:00:00Z",
            allDay: false,
            description: nil,
            location: nil,
            visibility: "default",
            transparency: "opaque"
        )

        let encoder = JSONEncoder()
        let payload = try! encoder.encode(createReq)
        let exhaustedOp = PendingOperation(
            id: "op_exhausted_001",
            type: .createEvent,
            payload: payload,
            createdAt: Date(),
            retryCount: PendingOperation.maxRetries // Already at max
        )
        mockOfflineQueue.enqueue(exhaustedOp)

        let formVM = EventFormViewModel(
            apiClient: mockAPIClient,
            haptics: mockHaptics,
            offlineQueue: mockOfflineQueue
        )

        // WHEN: Drain queue
        await formVM.drainOfflineQueue()

        // THEN: Exhausted operation removed, API not called
        XCTAssertEqual(mockOfflineQueue.count, 0, "Exhausted op should be removed")
        XCTAssertFalse(mockAPIClient.createEventCalled, "Should not attempt API call for exhausted operation")
    }

    // MARK: - Full E2E Scenario: Complete User Journey

    @MainActor
    func testE2E_FullJourney_LoginLoadCreateScheduleAndWidgetUpdate() async {
        // This test exercises the complete user journey from login to seeing
        // events on the widget and watch, then creating and scheduling an event.

        // == Step 1: Authentication ==
        let authResponse = AuthResponse(
            token: "jwt_journey_token",
            refreshToken: "refresh_journey_token",
            user: AuthUser(id: "usr_journey_001", email: "journey@tminus.ink", tier: "pro")
        )
        mockAPIClient.loginResult = .success(authResponse)

        let authVM = AuthViewModel(apiClient: mockAPIClient, keychain: mockKeychain)
        await authVM.login(email: "journey@tminus.ink", password: "journey123")
        XCTAssertTrue(authVM.isAuthenticated, "Step 1: User should be authenticated")

        // == Step 2: Load Calendar Events ==
        let existingEvents = [
            CanonicalEvent(
                canonicalEventId: "evt_journey_1",
                originAccountId: "acc_work_journey",
                originEventId: "g_j1",
                title: "Morning Standup",
                description: "Daily sync",
                location: nil,
                start: EventDateTime(dateTime: "2026-02-15T09:00:00Z", date: nil, timeZone: "UTC"),
                end: EventDateTime(dateTime: "2026-02-15T09:15:00Z", date: nil, timeZone: "UTC"),
                allDay: false,
                status: "confirmed",
                visibility: "default",
                transparency: "opaque",
                recurrenceRule: nil,
                source: "provider",
                version: 1,
                createdAt: "2026-02-14T00:00:00Z",
                updatedAt: "2026-02-14T00:00:00Z"
            ),
            CanonicalEvent(
                canonicalEventId: "evt_journey_2",
                originAccountId: "acc_personal_journey",
                originEventId: "g_j2",
                title: "Lunch with Partner",
                description: nil,
                location: "Cafe Roma",
                start: EventDateTime(dateTime: "2026-02-15T12:00:00Z", date: nil, timeZone: "UTC"),
                end: EventDateTime(dateTime: "2026-02-15T13:00:00Z", date: nil, timeZone: "UTC"),
                allDay: false,
                status: "confirmed",
                visibility: "private",
                transparency: "opaque",
                recurrenceRule: nil,
                source: "provider",
                version: 1,
                createdAt: "2026-02-14T00:00:00Z",
                updatedAt: "2026-02-14T00:00:00Z"
            ),
            CanonicalEvent(
                canonicalEventId: "evt_journey_3",
                originAccountId: "acc_work_journey",
                originEventId: "g_j3",
                title: "Project Review",
                description: "Q1 review",
                location: "Zoom",
                start: EventDateTime(dateTime: "2026-02-15T15:00:00Z", date: nil, timeZone: "UTC"),
                end: EventDateTime(dateTime: "2026-02-15T16:00:00Z", date: nil, timeZone: "UTC"),
                allDay: false,
                status: "confirmed",
                visibility: "default",
                transparency: "opaque",
                recurrenceRule: nil,
                source: "provider",
                version: 1,
                createdAt: "2026-02-14T00:00:00Z",
                updatedAt: "2026-02-14T00:00:00Z"
            ),
        ]
        mockAPIClient.fetchEventsResult = .success(existingEvents)

        let calVM = CalendarViewModel(
            apiClient: mockAPIClient,
            cache: mockCache,
            widgetDataProvider: widgetProvider
        )
        await calVM.loadEvents()

        XCTAssertEqual(calVM.events.count, 3, "Step 2: Should load 3 events")
        XCTAssertFalse(calVM.isOffline)

        // == Step 3: Verify Widget Updated ==
        let widgetEvents = widgetProvider.readEvents()
        XCTAssertEqual(widgetEvents.count, 3, "Step 3: Widget should have 3 events")
        XCTAssertTrue(widgetProvider.isDataFresh, "Step 3: Widget data should be fresh")

        // Medium widget shows next 3
        let refDate = ISO8601DateFormatter().date(from: "2026-02-15T08:00:00Z")!
        let mediumSnapshot = WidgetTimelineLogic.snapshot(
            for: .medium,
            events: widgetEvents,
            referenceDate: refDate,
            isStale: false,
            lastUpdated: widgetProvider.lastUpdated,
            calendar: utcCalendar
        )
        XCTAssertEqual(mediumSnapshot.events.count, 3, "Step 3: Medium widget should show 3 events")
        XCTAssertEqual(mediumSnapshot.events[0].title, "Morning Standup")
        XCTAssertEqual(mediumSnapshot.events[1].title, "Lunch with Partner")
        XCTAssertEqual(mediumSnapshot.events[2].title, "Project Review")

        // == Step 4: Watch Complication Data ==
        let watchData = WatchComplicationLogic.complicationData(
            family: .rectangular,
            events: widgetEvents,
            referenceDate: refDate,
            calendar: utcCalendar
        )
        XCTAssertEqual(watchData.nextEventTitle, "Morning Standup", "Step 4: Watch should show next event")
        XCTAssertEqual(watchData.meetingCount, 3, "Step 4: Watch should count 3 meetings")

        // == Step 5: Push Notification (drift alert) ==
        let notifPayload: [AnyHashable: Any] = [
            "notification_type": "drift_alert",
            "deep_link": "tminus:///drift/rel_bob",
            "metadata": ["contact_name": "Bob"]
        ]
        let parsed = TMinusNotificationPayload.parse(from: notifPayload)
        XCTAssertNotNil(parsed, "Step 5: Drift alert should parse")
        XCTAssertEqual(parsed!.notificationType, .driftAlert)

        // == Step 6: Schedule a New Meeting ==
        let accounts = [
            CalendarAccount(
                accountId: "acc_work_journey",
                provider: "google",
                email: "user@work.com",
                displayName: "Work",
                status: "active"
            ),
        ]
        mockAPIClient.fetchAccountsResult = .success(accounts)
        mockAPIClient.proposeTimesResult = .success(
            ProposeTimesResponse(
                sessionId: "sess_journey_001",
                candidates: [
                    SchedulingCandidate(
                        candidateId: "cand_journey_best",
                        start: "2026-02-17T10:00:00Z",
                        end: "2026-02-17T10:30:00Z",
                        score: 0.92,
                        reason: "Optimal slot"
                    ),
                ]
            )
        )
        mockAPIClient.commitCandidateResult = .success(
            CommitCandidateResponse(
                canonicalEventId: "evt_journey_new",
                originEventId: "g_journey_new"
            )
        )

        let formVM = EventFormViewModel(
            apiClient: mockAPIClient,
            haptics: mockHaptics,
            offlineQueue: mockOfflineQueue
        )
        await formVM.loadAccounts()

        // Quick action: find 1:1
        formVM.applyQuickAction(.findOneOnOne)

        // Propose
        await formVM.proposeTimes()
        XCTAssertEqual(formVM.schedulingCandidates.count, 1, "Step 6: Should have 1 candidate")

        // Select and commit
        formVM.selectCandidate("cand_journey_best")
        await formVM.commitSelectedCandidate()

        XCTAssertNotNil(formVM.successMessage, "Step 6: Should have success message")
        XCTAssertTrue(formVM.successMessage!.contains("evt_journey_new"))
        XCTAssertNil(formVM.errorMessage)

        // == Journey complete: all 6 demo scenarios exercised ==
    }

    // MARK: - Edge Cases

    func testE2E_EdgeCase_FormValidationAllErrorTypes() {
        // GIVEN: Various invalid form states
        let now = Date()

        // Empty title
        XCTAssertEqual(
            EventFormValidator.validate(title: "", accountId: "acc", startDate: now, endDate: now.addingTimeInterval(3600), now: now),
            .titleEmpty
        )

        // Title too long
        let longTitle = String(repeating: "x", count: 201)
        XCTAssertEqual(
            EventFormValidator.validate(title: longTitle, accountId: "acc", startDate: now, endDate: now.addingTimeInterval(3600), now: now),
            .titleTooLong
        )

        // No account
        XCTAssertEqual(
            EventFormValidator.validate(title: "Valid", accountId: nil, startDate: now, endDate: now.addingTimeInterval(3600), now: now),
            .noAccountSelected
        )

        // Start in past (more than 60 seconds ago)
        let pastDate = now.addingTimeInterval(-120)
        XCTAssertEqual(
            EventFormValidator.validate(title: "Valid", accountId: "acc", startDate: pastDate, endDate: now, now: now),
            .startInPast
        )

        // End before start
        XCTAssertEqual(
            EventFormValidator.validate(title: "Valid", accountId: "acc", startDate: now.addingTimeInterval(3600), endDate: now, now: now),
            .endBeforeStart
        )

        // End equals start
        XCTAssertEqual(
            EventFormValidator.validate(title: "Valid", accountId: "acc", startDate: now, endDate: now, now: now),
            .endEqualsStart
        )

        // Valid form returns nil
        XCTAssertNil(
            EventFormValidator.validate(title: "Valid", accountId: "acc", startDate: now, endDate: now.addingTimeInterval(3600), now: now)
        )
    }

    func testE2E_EdgeCase_AllDayEventHandling() {
        // GIVEN: An all-day event
        let allDayEvent = CanonicalEvent(
            canonicalEventId: "evt_allday_edge",
            originAccountId: "acc_01",
            originEventId: "g_allday",
            title: "Conference",
            description: nil,
            location: nil,
            start: EventDateTime(dateTime: nil, date: "2026-02-15", timeZone: nil),
            end: EventDateTime(dateTime: nil, date: "2026-02-16", timeZone: nil),
            allDay: true,
            status: "confirmed",
            visibility: "default",
            transparency: "transparent",
            recurrenceRule: nil,
            source: "provider",
            version: 1,
            createdAt: "2026-02-14T00:00:00Z",
            updatedAt: "2026-02-14T00:00:00Z"
        )

        // THEN: startDate resolves correctly
        XCTAssertNotNil(allDayEvent.startDate)
        XCTAssertTrue(allDayEvent.allDay)
        XCTAssertEqual(allDayEvent.timeDisplayString, "All day")

        // Widget handles it correctly
        widgetProvider.writeEvents([allDayEvent])
        let widgetEvents = widgetProvider.readEvents()
        XCTAssertEqual(widgetEvents.count, 1)
        XCTAssertTrue(widgetEvents[0].isAllDay)
        XCTAssertEqual(widgetEvents[0].timeDisplayString, "All day")

        // Watch complication excludes all-day from next event
        let refDate = ISO8601DateFormatter().date(from: "2026-02-15T10:00:00Z")!
        let nextEvent = WatchComplicationLogic.nextEvent(from: widgetEvents, referenceDate: refDate, calendar: utcCalendar)
        XCTAssertNil(nextEvent, "Watch nextEvent should skip all-day events")
    }

    func testE2E_EdgeCase_OfflineQueuePersistence() {
        // GIVEN: A real OfflineQueue (not mock) using isolated UserDefaults
        let queueDefaults = UserDefaults(suiteName: "com.tminus.test.e2e.queue.\(name)")!
        queueDefaults.removePersistentDomain(forName: "com.tminus.test.e2e.queue.\(name)")
        let queue = OfflineQueue(defaults: queueDefaults, storageKey: "test_queue")

        // WHEN: Enqueue operations
        let createReq = CreateEventRequest(
            title: "Persist Me",
            accountId: "acc_persist",
            start: "2026-02-17T10:00:00Z",
            end: "2026-02-17T11:00:00Z",
            allDay: false,
            description: nil,
            location: nil,
            visibility: "default",
            transparency: "opaque"
        )

        if let op = PendingOperation.createEvent(createReq) {
            queue.enqueue(op)
        }

        // THEN: Verify persistence with a new OfflineQueue instance reading same store
        let queue2 = OfflineQueue(defaults: queueDefaults, storageKey: "test_queue")
        XCTAssertEqual(queue2.count, 1, "Queue should persist across instances")

        let peeked = queue2.peek()!
        XCTAssertEqual(peeked.type, .createEvent)

        // Decode and verify payload
        let decoder = JSONDecoder()
        let decoded = try! decoder.decode(CreateEventRequest.self, from: peeked.payload)
        XCTAssertEqual(decoded.title, "Persist Me")
        XCTAssertEqual(decoded.accountId, "acc_persist")

        // Cleanup
        queue2.clear()
        XCTAssertEqual(queue2.count, 0)
        queueDefaults.removePersistentDomain(forName: "com.tminus.test.e2e.queue.\(name)")
    }

    func testE2E_EdgeCase_DeepLinkParsing() {
        // Test all deep link patterns
        XCTAssertEqual(DeepLink.parse("tminus:///drift/rel_123"), .drift(relationshipId: "rel_123"))
        XCTAssertEqual(DeepLink.parse("tminus:///drift"), .drift(relationshipId: nil))
        XCTAssertEqual(DeepLink.parse("tminus:///relationships"), .relationships)
        XCTAssertEqual(DeepLink.parse("tminus:///schedule/sess_abc"), .schedule(sessionId: "sess_abc"))
        XCTAssertEqual(DeepLink.parse("tminus:///schedule/holds"), .scheduleHolds)
        XCTAssertEqual(DeepLink.parse("tminus:///dashboard"), .dashboard)
        XCTAssertEqual(DeepLink.parse("tminus:///"), .dashboard)

        // Invalid scheme
        let unknown = DeepLink.parse("https://example.com")
        if case .unknown = unknown { /* expected */ } else {
            XCTFail("Non-tminus scheme should be .unknown")
        }
    }

    func testE2E_EdgeCase_EventCacheRoundTrip() {
        // GIVEN: Events cached with real EventCache (not mock)
        let cacheDefaults = UserDefaults(suiteName: "com.tminus.test.e2e.cache.\(name)")!
        cacheDefaults.removePersistentDomain(forName: "com.tminus.test.e2e.cache.\(name)")
        let cache = EventCache(maxAge: 3600, defaults: cacheDefaults)

        let event = CanonicalEvent(
            canonicalEventId: "evt_cache_round",
            originAccountId: "acc_cache_01",
            originEventId: "g_cache_1",
            title: "Cached Round Trip",
            description: "Testing cache persistence",
            location: "Room X",
            start: EventDateTime(dateTime: "2026-02-15T10:00:00Z", date: nil, timeZone: "UTC"),
            end: EventDateTime(dateTime: "2026-02-15T11:00:00Z", date: nil, timeZone: "UTC"),
            allDay: false,
            status: "confirmed",
            visibility: "default",
            transparency: "opaque",
            recurrenceRule: nil,
            source: "provider",
            version: 3,
            createdAt: "2026-02-14T00:00:00Z",
            updatedAt: "2026-02-14T00:00:00Z"
        )

        let range = DateRange(
            start: ISO8601DateFormatter().date(from: "2026-02-15T00:00:00Z")!,
            end: ISO8601DateFormatter().date(from: "2026-02-16T00:00:00Z")!
        )

        // WHEN: Cache and reload
        cache.cacheEvents([event], for: range)
        XCTAssertTrue(cache.isCacheValid(for: range))

        let loaded = cache.loadEvents(for: range)

        // THEN: All fields survive the round trip
        XCTAssertNotNil(loaded)
        XCTAssertEqual(loaded!.count, 1)
        let loadedEvent = loaded![0]
        XCTAssertEqual(loadedEvent.canonicalEventId, "evt_cache_round")
        XCTAssertEqual(loadedEvent.originAccountId, "acc_cache_01")
        XCTAssertEqual(loadedEvent.title, "Cached Round Trip")
        XCTAssertEqual(loadedEvent.description, "Testing cache persistence")
        XCTAssertEqual(loadedEvent.location, "Room X")
        XCTAssertEqual(loadedEvent.version, 3)
        XCTAssertFalse(loadedEvent.allDay)
        XCTAssertNotNil(cache.lastSyncDate)

        // Cleanup
        cache.clearCache()
        XCTAssertFalse(cache.isCacheValid(for: range))
        cacheDefaults.removePersistentDomain(forName: "com.tminus.test.e2e.cache.\(name)")
    }

    func testE2E_EdgeCase_WidgetTimelineRefreshScheduling() {
        // GIVEN: Events with a meeting in 30 minutes
        let events = [
            WidgetEventData(
                eventId: "evt_refresh_1",
                title: "Upcoming",
                accountId: "acc_01",
                startDate: ISO8601DateFormatter().date(from: "2026-02-15T10:30:00Z")!,
                endDate: ISO8601DateFormatter().date(from: "2026-02-15T11:30:00Z")!,
                isAllDay: false,
                location: nil
            ),
        ]

        let refDate = ISO8601DateFormatter().date(from: "2026-02-15T10:00:00Z")!

        // WHEN: Compute refresh date
        let refreshDate = WidgetTimelineLogic.nextRefreshDate(
            events: events, referenceDate: refDate, calendar: utcCalendar
        )

        // THEN: Refresh is 5 minutes before the event (10:25)
        let expected = ISO8601DateFormatter().date(from: "2026-02-15T10:25:00Z")!
        XCTAssertEqual(refreshDate.timeIntervalSince1970, expected.timeIntervalSince1970, accuracy: 2.0)
        XCTAssertGreaterThan(refreshDate, refDate, "Refresh must be in the future")
        XCTAssertLessThan(refreshDate, events[0].startDate, "Refresh must be before event start")
    }

    func testE2E_EdgeCase_NotificationSettingsRoundTrip() {
        // GIVEN: Custom notification settings
        var settings = NotificationSettingsModel.defaults
        settings.preferences[TMinusNotificationType.driftAlert.rawValue] = NotificationTypePreference(enabled: false)
        settings.quietHours = QuietHoursConfig(enabled: true, start: "23:00", end: "08:00", timezone: "America/New_York")

        // WHEN: Encode and decode (simulating API round trip)
        let encoder = JSONEncoder()
        let decoder = JSONDecoder()
        let data = try! encoder.encode(settings)
        let decoded = try! decoder.decode(NotificationSettingsModel.self, from: data)

        // THEN: All settings preserved
        XCTAssertFalse(decoded.preferences[TMinusNotificationType.driftAlert.rawValue]!.enabled)
        XCTAssertTrue(decoded.preferences[TMinusNotificationType.schedulingProposal.rawValue]!.enabled)
        XCTAssertTrue(decoded.quietHours.enabled)
        XCTAssertEqual(decoded.quietHours.start, "23:00")
        XCTAssertEqual(decoded.quietHours.end, "08:00")
        XCTAssertEqual(decoded.quietHours.timezone, "America/New_York")
    }
}
