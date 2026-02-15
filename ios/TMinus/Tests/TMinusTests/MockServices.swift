// MockServices.swift
// T-Minus iOS Tests -- Mock implementations for unit testing.
//
// These mocks replace real network and Keychain calls in tests,
// allowing deterministic, fast, isolated unit testing.

import Foundation
@testable import TMinusLib

// MARK: - Mock Keychain

final class MockKeychain: KeychainServiceProtocol {
    var store: [String: String] = [:]

    func save(key: String, value: String) -> Bool {
        store[key] = value
        return true
    }

    func load(key: String) -> String? {
        return store[key]
    }

    func delete(key: String) -> Bool {
        store.removeValue(forKey: key)
        return true
    }

    func deleteAll() -> Bool {
        store.removeAll()
        return true
    }
}

// MARK: - Mock API Client

final class MockAPIClient: APIClientProtocol {
    var loginResult: Result<AuthResponse, Error> = .failure(APIError.unauthorized)
    var refreshResult: Result<AuthResponse, Error> = .failure(APIError.unauthorized)
    var fetchEventsResult: Result<[CanonicalEvent], Error> = .success([])
    var fetchAccountsResult: Result<[CalendarAccount], Error> = .success([])
    var createEventResult: Result<CreateEventResponse, Error> = .success(
        CreateEventResponse(canonicalEventId: "evt_created_001", originEventId: "google_evt_new")
    )
    var proposeTimesResult: Result<ProposeTimesResponse, Error> = .success(
        ProposeTimesResponse(sessionId: "sched_001", candidates: [])
    )
    var commitCandidateResult: Result<CommitCandidateResponse, Error> = .success(
        CommitCandidateResponse(canonicalEventId: "evt_committed_001", originEventId: "google_evt_committed")
    )
    var _isAuthenticated = false
    var logoutCalled = false

    // Call tracking
    var createEventCalled = false
    var lastCreateEventRequest: CreateEventRequest?
    var proposeTimesCalled = false
    var lastProposeTimesRequest: ProposeTimesRequest?
    var commitCandidateCalled = false
    var lastCommitCandidateRequest: CommitCandidateRequest?

    var isAuthenticated: Bool { _isAuthenticated }

    func login(email: String, password: String) async throws -> AuthResponse {
        switch loginResult {
        case .success(let auth):
            _isAuthenticated = true
            return auth
        case .failure(let error):
            throw error
        }
    }

    func refreshToken() async throws -> AuthResponse {
        switch refreshResult {
        case .success(let auth):
            return auth
        case .failure(let error):
            throw error
        }
    }

    func fetchEvents(start: Date, end: Date, accountId: String?) async throws -> [CanonicalEvent] {
        switch fetchEventsResult {
        case .success(let events):
            return events
        case .failure(let error):
            throw error
        }
    }

    func fetchAccounts() async throws -> [CalendarAccount] {
        switch fetchAccountsResult {
        case .success(let accounts):
            return accounts
        case .failure(let error):
            throw error
        }
    }

    func createEvent(_ request: CreateEventRequest) async throws -> CreateEventResponse {
        createEventCalled = true
        lastCreateEventRequest = request
        switch createEventResult {
        case .success(let response):
            return response
        case .failure(let error):
            throw error
        }
    }

    func proposeTimes(_ request: ProposeTimesRequest) async throws -> ProposeTimesResponse {
        proposeTimesCalled = true
        lastProposeTimesRequest = request
        switch proposeTimesResult {
        case .success(let response):
            return response
        case .failure(let error):
            throw error
        }
    }

    func commitCandidate(_ request: CommitCandidateRequest) async throws -> CommitCandidateResponse {
        commitCandidateCalled = true
        lastCommitCandidateRequest = request
        switch commitCandidateResult {
        case .success(let response):
            return response
        case .failure(let error):
            throw error
        }
    }

    func logout() {
        _isAuthenticated = false
        logoutCalled = true
    }
}

// MARK: - Mock Haptic Service

final class MockHapticService: HapticServiceProtocol {
    var triggeredFeedbacks: [HapticFeedbackType] = []
    var lastTriggered: HapticFeedbackType?

    func trigger(_ type: HapticFeedbackType) {
        triggeredFeedbacks.append(type)
        lastTriggered = type
    }
}

// MARK: - Mock Offline Queue

final class MockOfflineQueue: OfflineQueueProtocol {
    var operations: [PendingOperation] = []
    var enqueueCalled = false
    var clearCalled = false

    func enqueue(_ operation: PendingOperation) {
        enqueueCalled = true
        operations.append(operation)
    }

    func dequeue() -> PendingOperation? {
        guard !operations.isEmpty else { return nil }
        return operations.removeFirst()
    }

    func peek() -> PendingOperation? {
        return operations.first
    }

    func remove(id: String) {
        operations.removeAll { $0.id == id }
    }

    func updateRetryCount(id: String, retryCount: Int) {
        if let index = operations.firstIndex(where: { $0.id == id }) {
            operations[index].retryCount = retryCount
        }
    }

    var count: Int { operations.count }

    var allOperations: [PendingOperation] { operations }

    func clear() {
        clearCalled = true
        operations.removeAll()
    }
}

// MARK: - Mock Event Cache

final class MockEventCache: EventCacheProtocol {
    var cachedEvents: [DateRange: [CanonicalEvent]] = [:]
    var _lastSyncDate: Date?
    var clearCacheCalled = false

    func cacheEvents(_ events: [CanonicalEvent], for range: DateRange) {
        cachedEvents[range] = events
        _lastSyncDate = Date()
    }

    func loadEvents(for range: DateRange) -> [CanonicalEvent]? {
        return cachedEvents[range]
    }

    func isCacheValid(for range: DateRange) -> Bool {
        return cachedEvents[range] != nil
    }

    func clearCache() {
        cachedEvents.removeAll()
        clearCacheCalled = true
    }

    var lastSyncDate: Date? { _lastSyncDate }
}

// MARK: - Test Fixtures

enum TestFixtures {

    static let authResponse = AuthResponse(
        token: "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.test.signature",
        refreshToken: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        user: AuthUser(id: "usr_01ABCDEF", email: "test@example.com", tier: "free")
    )

    static func makeEvent(
        id: String = "evt_01TEST001",
        accountId: String = "acc_01ACCT001",
        title: String = "Team Meeting",
        startISO: String = "2026-02-15T10:00:00Z",
        endISO: String = "2026-02-15T11:00:00Z",
        allDay: Bool = false,
        status: String = "confirmed"
    ) -> CanonicalEvent {
        CanonicalEvent(
            canonicalEventId: id,
            originAccountId: accountId,
            originEventId: "google_evt_123",
            title: title,
            description: "Weekly sync",
            location: "Conference Room A",
            start: EventDateTime(dateTime: startISO, date: nil, timeZone: "America/New_York"),
            end: EventDateTime(dateTime: endISO, date: nil, timeZone: "America/New_York"),
            allDay: allDay,
            status: status,
            visibility: "default",
            transparency: "opaque",
            recurrenceRule: nil,
            source: "provider",
            version: 1,
            createdAt: "2026-02-10T08:00:00Z",
            updatedAt: "2026-02-10T08:00:00Z"
        )
    }

    static func makeAllDayEvent(
        id: String = "evt_01ALLDAY",
        accountId: String = "acc_01ACCT002",
        title: String = "Company Holiday"
    ) -> CanonicalEvent {
        CanonicalEvent(
            canonicalEventId: id,
            originAccountId: accountId,
            originEventId: "google_evt_456",
            title: title,
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
            createdAt: "2026-02-10T08:00:00Z",
            updatedAt: "2026-02-10T08:00:00Z"
        )
    }

    static let sampleEvents: [CanonicalEvent] = [
        makeEvent(id: "evt_01A", accountId: "acc_01ACCT001", title: "Morning Standup",
                  startISO: "2026-02-15T09:00:00Z", endISO: "2026-02-15T09:30:00Z"),
        makeEvent(id: "evt_01B", accountId: "acc_01ACCT002", title: "Design Review",
                  startISO: "2026-02-15T14:00:00Z", endISO: "2026-02-15T15:00:00Z"),
        makeEvent(id: "evt_01C", accountId: "acc_01ACCT001", title: "1:1 with Manager",
                  startISO: "2026-02-16T10:00:00Z", endISO: "2026-02-16T10:30:00Z"),
        makeAllDayEvent(),
    ]

    static let sampleAccounts: [CalendarAccount] = [
        CalendarAccount(
            accountId: "acc_01ACCT001",
            provider: "google",
            email: "work@example.com",
            displayName: "Work Calendar",
            status: "active"
        ),
        CalendarAccount(
            accountId: "acc_01ACCT002",
            provider: "google",
            email: "personal@example.com",
            displayName: "Personal Calendar",
            status: "active"
        ),
    ]

    static let sampleCandidates: [SchedulingCandidate] = [
        SchedulingCandidate(
            candidateId: "cand_001",
            start: "2026-02-17T09:00:00Z",
            end: "2026-02-17T09:30:00Z",
            score: 0.95,
            reason: "Best available slot"
        ),
        SchedulingCandidate(
            candidateId: "cand_002",
            start: "2026-02-17T14:00:00Z",
            end: "2026-02-17T14:30:00Z",
            score: 0.82,
            reason: "Afternoon option"
        ),
        SchedulingCandidate(
            candidateId: "cand_003",
            start: "2026-02-18T10:00:00Z",
            end: "2026-02-18T10:30:00Z",
            score: 0.71,
            reason: "Next day fallback"
        ),
    ]
}
