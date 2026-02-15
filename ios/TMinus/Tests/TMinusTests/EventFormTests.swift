// EventFormTests.swift
// T-Minus iOS Tests -- Unit tests for event creation, form validation,
// quick actions, scheduling workflow, offline queue, and haptic feedback.

import XCTest
@testable import TMinusLib

// MARK: - EventFormValidator Tests

final class EventFormValidatorTests: XCTestCase {

    let now = Date()
    let futureStart = Date().addingTimeInterval(3600)  // +1 hour
    let futureEnd = Date().addingTimeInterval(7200)    // +2 hours

    // MARK: - Title Validation

    func testValidFormReturnsNil() {
        let error = EventFormValidator.validate(
            title: "Team Meeting",
            accountId: "acc_001",
            startDate: futureStart,
            endDate: futureEnd,
            now: now
        )
        XCTAssertNil(error)
    }

    func testEmptyTitleReturnsTitleEmpty() {
        let error = EventFormValidator.validate(
            title: "",
            accountId: "acc_001",
            startDate: futureStart,
            endDate: futureEnd,
            now: now
        )
        XCTAssertEqual(error, .titleEmpty)
    }

    func testWhitespaceTitleReturnsTitleEmpty() {
        let error = EventFormValidator.validate(
            title: "   \t\n  ",
            accountId: "acc_001",
            startDate: futureStart,
            endDate: futureEnd,
            now: now
        )
        XCTAssertEqual(error, .titleEmpty)
    }

    func testTitleExceeding200CharsReturnsTitleTooLong() {
        let longTitle = String(repeating: "A", count: 201)
        let error = EventFormValidator.validate(
            title: longTitle,
            accountId: "acc_001",
            startDate: futureStart,
            endDate: futureEnd,
            now: now
        )
        XCTAssertEqual(error, .titleTooLong)
    }

    func testTitleExactly200CharsIsValid() {
        let exactTitle = String(repeating: "A", count: 200)
        let error = EventFormValidator.validate(
            title: exactTitle,
            accountId: "acc_001",
            startDate: futureStart,
            endDate: futureEnd,
            now: now
        )
        XCTAssertNil(error)
    }

    // MARK: - Account Validation

    func testNilAccountReturnsNoAccountSelected() {
        let error = EventFormValidator.validate(
            title: "Meeting",
            accountId: nil,
            startDate: futureStart,
            endDate: futureEnd,
            now: now
        )
        XCTAssertEqual(error, .noAccountSelected)
    }

    func testEmptyAccountReturnsNoAccountSelected() {
        let error = EventFormValidator.validate(
            title: "Meeting",
            accountId: "",
            startDate: futureStart,
            endDate: futureEnd,
            now: now
        )
        XCTAssertEqual(error, .noAccountSelected)
    }

    // MARK: - Date Validation

    func testEndBeforeStartReturnsError() {
        let error = EventFormValidator.validate(
            title: "Meeting",
            accountId: "acc_001",
            startDate: futureEnd,   // start AFTER end
            endDate: futureStart,
            now: now
        )
        XCTAssertEqual(error, .endBeforeStart)
    }

    func testEndEqualsStartReturnsError() {
        let error = EventFormValidator.validate(
            title: "Meeting",
            accountId: "acc_001",
            startDate: futureStart,
            endDate: futureStart,  // same as start
            now: now
        )
        XCTAssertEqual(error, .endEqualsStart)
    }

    func testStartInPastReturnsError() {
        let pastStart = now.addingTimeInterval(-7200)  // 2 hours ago (well beyond 1 min grace)
        let pastEnd = now.addingTimeInterval(-3600)
        let error = EventFormValidator.validate(
            title: "Meeting",
            accountId: "acc_001",
            startDate: pastStart,
            endDate: pastEnd,
            now: now
        )
        XCTAssertEqual(error, .startInPast)
    }

    func testStartSlightlyInPastAllowedWithGracePeriod() {
        // Start 30 seconds ago should be allowed (1 minute grace)
        let recentStart = now.addingTimeInterval(-30)
        let error = EventFormValidator.validate(
            title: "Meeting",
            accountId: "acc_001",
            startDate: recentStart,
            endDate: futureEnd,
            now: now
        )
        XCTAssertNil(error)
    }

    // MARK: - validateAll Returns Multiple Errors

    func testValidateAllReturnsMultipleErrors() {
        let errors = EventFormValidator.validateAll(
            title: "",
            accountId: nil,
            startDate: now.addingTimeInterval(-7200),
            endDate: now.addingTimeInterval(-10800),
            now: now
        )
        // Should have titleEmpty, noAccountSelected, startInPast, endBeforeStart
        XCTAssertTrue(errors.contains(.titleEmpty))
        XCTAssertTrue(errors.contains(.noAccountSelected))
        XCTAssertTrue(errors.contains(.startInPast))
        XCTAssertTrue(errors.contains(.endBeforeStart))
        XCTAssertGreaterThanOrEqual(errors.count, 4)
    }

    func testValidateAllReturnsEmptyForValidForm() {
        let errors = EventFormValidator.validateAll(
            title: "Meeting",
            accountId: "acc_001",
            startDate: futureStart,
            endDate: futureEnd,
            now: now
        )
        XCTAssertTrue(errors.isEmpty)
    }

    // MARK: - Error Messages

    func testAllErrorsHaveMessages() {
        let allErrors: [EventFormError] = [
            .titleEmpty, .titleTooLong, .noAccountSelected,
            .endBeforeStart, .endEqualsStart, .startInPast
        ]
        for error in allErrors {
            XCTAssertFalse(error.message.isEmpty, "Error \(error) should have a message")
        }
    }
}

// MARK: - QuickAction Tests

final class QuickActionTests: XCTestCase {

    func testAllQuickActionsHaveDisplayNames() {
        for action in QuickAction.allCases {
            XCTAssertFalse(action.displayName.isEmpty)
        }
    }

    func testAllQuickActionsHaveIconNames() {
        for action in QuickAction.allCases {
            XCTAssertFalse(action.iconName.isEmpty)
        }
    }

    func testAllQuickActionsHaveDefaultTitles() {
        for action in QuickAction.allCases {
            XCTAssertFalse(action.defaultTitle.isEmpty)
        }
    }

    func testDefaultDurationsAreReasonable() {
        XCTAssertEqual(QuickAction.findOneOnOne.defaultDurationMinutes, 30)
        XCTAssertEqual(QuickAction.blockFocusTime.defaultDurationMinutes, 120)
        XCTAssertEqual(QuickAction.addTrip.defaultDurationMinutes, 480)
    }

    func testSchedulingModes() {
        XCTAssertTrue(QuickAction.findOneOnOne.usesScheduling)
        XCTAssertTrue(QuickAction.blockFocusTime.usesScheduling)
        XCTAssertFalse(QuickAction.addTrip.usesScheduling)
    }

    func testQuickActionIdentifiableConformance() {
        let ids = QuickAction.allCases.map { $0.id }
        let uniqueIds = Set(ids)
        XCTAssertEqual(ids.count, uniqueIds.count, "QuickAction IDs must be unique")
    }
}

// MARK: - EventFormViewModel Tests

@MainActor
final class EventFormViewModelTests: XCTestCase {

    var mockAPI: MockAPIClient!
    var mockHaptics: MockHapticService!
    var mockQueue: MockOfflineQueue!
    var viewModel: EventFormViewModel!

    override func setUp() {
        super.setUp()
        mockAPI = MockAPIClient()
        mockHaptics = MockHapticService()
        mockQueue = MockOfflineQueue()
        viewModel = EventFormViewModel(
            apiClient: mockAPI,
            haptics: mockHaptics,
            offlineQueue: mockQueue
        )
    }

    // MARK: - Initial State

    func testInitialState() {
        XCTAssertTrue(viewModel.title.isEmpty)
        XCTAssertFalse(viewModel.isAllDay)
        XCTAssertNil(viewModel.selectedAccountId)
        XCTAssertFalse(viewModel.isLoading)
        XCTAssertFalse(viewModel.isSubmitting)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertNil(viewModel.successMessage)
        XCTAssertTrue(viewModel.validationErrors.isEmpty)
        XCTAssertFalse(viewModel.isSchedulingMode)
        XCTAssertTrue(viewModel.schedulingCandidates.isEmpty)
        XCTAssertNil(viewModel.selectedCandidateId)
        XCTAssertNil(viewModel.schedulingSessionId)
        XCTAssertEqual(viewModel.pendingOperationCount, 0)
    }

    // MARK: - Load Accounts

    func testLoadAccountsSuccess() async {
        mockAPI.fetchAccountsResult = .success(TestFixtures.sampleAccounts)

        await viewModel.loadAccounts()

        XCTAssertEqual(viewModel.accounts.count, 2)
        XCTAssertFalse(viewModel.isLoading)
        // Should auto-select first account
        XCTAssertEqual(viewModel.selectedAccountId, "acc_01ACCT001")
    }

    func testLoadAccountsFailure() async {
        mockAPI.fetchAccountsResult = .failure(APIError.networkError("No connection"))

        await viewModel.loadAccounts()

        XCTAssertTrue(viewModel.accounts.isEmpty)
        XCTAssertNotNil(viewModel.errorMessage)
        XCTAssertTrue(viewModel.errorMessage!.contains("Failed to load accounts"))
    }

    func testLoadAccountsDoesNotOverrideSelection() async {
        viewModel.selectedAccountId = "acc_01ACCT002"
        mockAPI.fetchAccountsResult = .success(TestFixtures.sampleAccounts)

        await viewModel.loadAccounts()

        XCTAssertEqual(viewModel.selectedAccountId, "acc_01ACCT002")
    }

    // MARK: - Form Validation

    func testValidateFormValid() {
        viewModel.title = "Team Meeting"
        viewModel.selectedAccountId = "acc_001"
        viewModel.startDate = Date().addingTimeInterval(3600)
        viewModel.endDate = Date().addingTimeInterval(7200)

        let valid = viewModel.validateForm()

        XCTAssertTrue(valid)
        XCTAssertTrue(viewModel.validationErrors.isEmpty)
    }

    func testValidateFormInvalid() {
        viewModel.title = ""
        viewModel.selectedAccountId = nil

        let valid = viewModel.validateForm()

        XCTAssertFalse(valid)
        XCTAssertFalse(viewModel.validationErrors.isEmpty)
    }

    func testFirstValidationErrorMessage() {
        viewModel.title = ""
        _ = viewModel.validateForm()

        XCTAssertNotNil(viewModel.firstValidationError)
    }

    // MARK: - Quick Actions

    func testApplyQuickActionFindOneOnOne() {
        viewModel.applyQuickAction(.findOneOnOne)

        XCTAssertEqual(viewModel.title, "1:1 Meeting")
        XCTAssertTrue(viewModel.isSchedulingMode)
        XCTAssertFalse(viewModel.isAllDay)
        XCTAssertEqual(viewModel.transparency, "opaque")
        XCTAssertEqual(mockHaptics.lastTriggered, .selectionChanged)
    }

    func testApplyQuickActionBlockFocusTime() {
        viewModel.applyQuickAction(.blockFocusTime)

        XCTAssertEqual(viewModel.title, "Focus Time")
        XCTAssertTrue(viewModel.isSchedulingMode)
        XCTAssertFalse(viewModel.isAllDay)
        // Duration should be ~2 hours
        let durationMinutes = viewModel.endDate.timeIntervalSince(viewModel.startDate) / 60
        XCTAssertEqual(durationMinutes, 120, accuracy: 1)
    }

    func testApplyQuickActionAddTrip() {
        viewModel.applyQuickAction(.addTrip)

        XCTAssertEqual(viewModel.title, "Trip")
        XCTAssertFalse(viewModel.isSchedulingMode)
        XCTAssertTrue(viewModel.isAllDay)
    }

    func testQuickActionTriggersHaptic() {
        viewModel.applyQuickAction(.findOneOnOne)
        XCTAssertEqual(mockHaptics.triggeredFeedbacks.count, 1)
        XCTAssertEqual(mockHaptics.triggeredFeedbacks[0], .selectionChanged)
    }

    // MARK: - Event Creation (Success)

    func testSubmitEventSuccess() async {
        viewModel.title = "Team Meeting"
        viewModel.selectedAccountId = "acc_001"
        viewModel.startDate = Date().addingTimeInterval(3600)
        viewModel.endDate = Date().addingTimeInterval(7200)

        await viewModel.submitEvent()

        XCTAssertTrue(mockAPI.createEventCalled)
        XCTAssertNotNil(viewModel.successMessage)
        XCTAssertTrue(viewModel.successMessage!.contains("Event created"))
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertFalse(viewModel.isSubmitting)
        XCTAssertEqual(mockHaptics.lastTriggered, .success)
    }

    func testSubmitEventSendsCorrectRequest() async {
        viewModel.title = "  Team Meeting  "  // with whitespace
        viewModel.selectedAccountId = "acc_001"
        viewModel.startDate = Date().addingTimeInterval(3600)
        viewModel.endDate = Date().addingTimeInterval(7200)
        viewModel.isAllDay = false
        viewModel.eventDescription = "Weekly sync"
        viewModel.location = "Room 101"
        viewModel.visibility = "private"
        viewModel.transparency = "transparent"

        await viewModel.submitEvent()

        let request = mockAPI.lastCreateEventRequest!
        XCTAssertEqual(request.title, "Team Meeting")  // trimmed
        XCTAssertEqual(request.accountId, "acc_001")
        XCTAssertFalse(request.allDay)
        XCTAssertEqual(request.description, "Weekly sync")
        XCTAssertEqual(request.location, "Room 101")
        XCTAssertEqual(request.visibility, "private")
        XCTAssertEqual(request.transparency, "transparent")
    }

    func testSubmitEventResetsFormOnSuccess() async {
        viewModel.title = "Team Meeting"
        viewModel.selectedAccountId = "acc_001"
        viewModel.startDate = Date().addingTimeInterval(3600)
        viewModel.endDate = Date().addingTimeInterval(7200)
        viewModel.eventDescription = "Weekly sync"

        await viewModel.submitEvent()

        XCTAssertTrue(viewModel.title.isEmpty)
        XCTAssertTrue(viewModel.eventDescription.isEmpty)
    }

    // MARK: - Event Creation (Validation Failure)

    func testSubmitEventWithValidationErrorsDoesNotCallAPI() async {
        viewModel.title = ""  // invalid
        viewModel.selectedAccountId = nil

        await viewModel.submitEvent()

        XCTAssertFalse(mockAPI.createEventCalled)
        XCTAssertFalse(viewModel.validationErrors.isEmpty)
        XCTAssertEqual(mockHaptics.lastTriggered, .warning)
    }

    // MARK: - Event Creation (Offline Queue)

    func testSubmitEventQueuesOnNetworkFailure() async {
        viewModel.title = "Team Meeting"
        viewModel.selectedAccountId = "acc_001"
        viewModel.startDate = Date().addingTimeInterval(3600)
        viewModel.endDate = Date().addingTimeInterval(7200)
        mockAPI.createEventResult = .failure(APIError.networkError("No connection"))

        await viewModel.submitEvent()

        XCTAssertTrue(mockQueue.enqueueCalled)
        XCTAssertEqual(mockQueue.count, 1)
        XCTAssertEqual(viewModel.pendingOperationCount, 1)
        XCTAssertNotNil(viewModel.successMessage)
        XCTAssertTrue(viewModel.successMessage!.contains("queued"))
        XCTAssertEqual(mockHaptics.lastTriggered, .warning)
    }

    // MARK: - Scheduling Workflow

    func testProposeTimesSuccess() async {
        viewModel.title = "1:1 Meeting"
        viewModel.selectedAccountId = "acc_001"
        viewModel.startDate = Date().addingTimeInterval(3600)
        viewModel.endDate = Date().addingTimeInterval(5400)  // 30 min

        let response = ProposeTimesResponse(
            sessionId: "sched_001",
            candidates: TestFixtures.sampleCandidates
        )
        mockAPI.proposeTimesResult = .success(response)

        await viewModel.proposeTimes()

        XCTAssertTrue(mockAPI.proposeTimesCalled)
        XCTAssertEqual(viewModel.schedulingSessionId, "sched_001")
        XCTAssertEqual(viewModel.schedulingCandidates.count, 3)
        XCTAssertEqual(mockHaptics.lastTriggered, .success)
    }

    func testProposeTimesMinimumDuration() async {
        viewModel.title = "Quick Chat"
        viewModel.selectedAccountId = "acc_001"
        // Set 5 minute duration (below 15 min minimum)
        viewModel.startDate = Date().addingTimeInterval(3600)
        viewModel.endDate = Date().addingTimeInterval(3900)

        mockAPI.proposeTimesResult = .success(
            ProposeTimesResponse(sessionId: "s1", candidates: [])
        )

        await viewModel.proposeTimes()

        // Should enforce minimum 15 minutes
        XCTAssertEqual(mockAPI.lastProposeTimesRequest?.durationMinutes, 15)
    }

    func testProposeTimesWithConstraints() async {
        viewModel.title = "Meeting"
        viewModel.selectedAccountId = "acc_001"
        viewModel.startDate = Date().addingTimeInterval(3600)
        viewModel.endDate = Date().addingTimeInterval(7200)
        viewModel.preferMorning = true
        viewModel.avoidBackToBack = true

        mockAPI.proposeTimesResult = .success(
            ProposeTimesResponse(sessionId: "s1", candidates: [])
        )

        await viewModel.proposeTimes()

        let request = mockAPI.lastProposeTimesRequest!
        XCTAssertEqual(request.constraints?.preferMorning, true)
        XCTAssertEqual(request.constraints?.avoidBackToBack, true)
        XCTAssertNil(request.constraints?.preferAfternoon)  // false -> nil
    }

    func testProposeTimesFailure() async {
        viewModel.title = "Meeting"
        viewModel.selectedAccountId = "acc_001"
        viewModel.startDate = Date().addingTimeInterval(3600)
        viewModel.endDate = Date().addingTimeInterval(7200)
        mockAPI.proposeTimesResult = .failure(APIError.networkError("Timeout"))

        await viewModel.proposeTimes()

        XCTAssertNotNil(viewModel.errorMessage)
        XCTAssertTrue(viewModel.errorMessage!.contains("Failed to propose times"))
        XCTAssertEqual(mockHaptics.lastTriggered, .error)
    }

    func testSelectCandidate() {
        viewModel.selectCandidate("cand_002")

        XCTAssertEqual(viewModel.selectedCandidateId, "cand_002")
        XCTAssertEqual(mockHaptics.lastTriggered, .selectionChanged)
    }

    func testCommitSelectedCandidateSuccess() async {
        viewModel.schedulingSessionId = "sched_001"
        viewModel.selectedCandidateId = "cand_001"
        viewModel.selectedAccountId = "acc_001"
        viewModel.title = "1:1 Meeting"

        await viewModel.commitSelectedCandidate()

        XCTAssertTrue(mockAPI.commitCandidateCalled)
        let request = mockAPI.lastCommitCandidateRequest!
        XCTAssertEqual(request.sessionId, "sched_001")
        XCTAssertEqual(request.candidateId, "cand_001")
        XCTAssertEqual(request.accountId, "acc_001")
        XCTAssertNotNil(viewModel.successMessage)
        XCTAssertTrue(viewModel.successMessage!.contains("Meeting scheduled"))
        XCTAssertEqual(mockHaptics.lastTriggered, .success)
    }

    func testCommitWithoutSelectionShowsError() async {
        viewModel.schedulingSessionId = nil
        viewModel.selectedCandidateId = nil

        await viewModel.commitSelectedCandidate()

        XCTAssertFalse(mockAPI.commitCandidateCalled)
        XCTAssertNotNil(viewModel.errorMessage)
        XCTAssertEqual(mockHaptics.lastTriggered, .warning)
    }

    func testCommitQueuesOnNetworkFailure() async {
        viewModel.schedulingSessionId = "sched_001"
        viewModel.selectedCandidateId = "cand_001"
        viewModel.selectedAccountId = "acc_001"
        viewModel.title = "Meeting"
        mockAPI.commitCandidateResult = .failure(APIError.networkError("Offline"))

        await viewModel.commitSelectedCandidate()

        XCTAssertTrue(mockQueue.enqueueCalled)
        XCTAssertEqual(mockQueue.count, 1)
        XCTAssertNotNil(viewModel.successMessage)
        XCTAssertTrue(viewModel.successMessage!.contains("queued"))
    }

    // MARK: - Offline Queue Drain

    func testDrainOfflineQueueSuccess() async {
        // Enqueue a pending create event
        let request = CreateEventRequest(
            title: "Queued Meeting",
            accountId: "acc_001",
            start: "2026-02-17T10:00:00Z",
            end: "2026-02-17T11:00:00Z",
            allDay: false,
            description: nil,
            location: nil,
            visibility: "default",
            transparency: "opaque"
        )
        if let op = PendingOperation.createEvent(request) {
            mockQueue.enqueue(op)
        }
        viewModel.pendingOperationCount = mockQueue.count

        XCTAssertEqual(mockQueue.count, 1)

        await viewModel.drainOfflineQueue()

        XCTAssertTrue(mockAPI.createEventCalled)
        XCTAssertEqual(mockQueue.count, 0)
        XCTAssertEqual(viewModel.pendingOperationCount, 0)
    }

    func testDrainOfflineQueueSkipsMaxRetries() async {
        let op = PendingOperation(
            id: "op_expired",
            type: .createEvent,
            payload: Data(),
            createdAt: Date(),
            retryCount: PendingOperation.maxRetries  // Already at max
        )
        mockQueue.enqueue(op)
        viewModel.pendingOperationCount = mockQueue.count

        await viewModel.drainOfflineQueue()

        // Should have been removed without API call
        XCTAssertFalse(mockAPI.createEventCalled)
        XCTAssertEqual(mockQueue.count, 0)
    }

    // MARK: - Share Meeting Link

    func testShareMeetingLinkWithAccount() {
        viewModel.title = "Team Sync"
        viewModel.selectedAccountId = "acc_001"

        let url = viewModel.shareMeetingLink()

        XCTAssertNotNil(url)
        XCTAssertTrue(url!.absoluteString.contains("app.tminus.ink/schedule"))
        XCTAssertTrue(url!.absoluteString.contains("account=acc_001"))
        XCTAssertTrue(url!.absoluteString.contains("title=Team"))
    }

    func testShareMeetingLinkWithoutAccountReturnsNil() {
        viewModel.title = "Meeting"
        viewModel.selectedAccountId = nil

        let url = viewModel.shareMeetingLink()

        XCTAssertNil(url)
    }

    // MARK: - Reset Form

    func testResetFormClearsAllState() {
        viewModel.title = "Meeting"
        viewModel.eventDescription = "Weekly"
        viewModel.location = "Room 101"
        viewModel.isAllDay = true
        viewModel.isSchedulingMode = true
        viewModel.preferMorning = true
        viewModel.schedulingCandidates = TestFixtures.sampleCandidates
        viewModel.selectedCandidateId = "cand_001"
        viewModel.schedulingSessionId = "sched_001"

        viewModel.resetForm()

        XCTAssertTrue(viewModel.title.isEmpty)
        XCTAssertTrue(viewModel.eventDescription.isEmpty)
        XCTAssertTrue(viewModel.location.isEmpty)
        XCTAssertFalse(viewModel.isAllDay)
        XCTAssertFalse(viewModel.isSchedulingMode)
        XCTAssertFalse(viewModel.preferMorning)
        XCTAssertTrue(viewModel.schedulingCandidates.isEmpty)
        XCTAssertNil(viewModel.selectedCandidateId)
        XCTAssertNil(viewModel.schedulingSessionId)
        XCTAssertTrue(viewModel.validationErrors.isEmpty)
        XCTAssertEqual(viewModel.visibility, "default")
        XCTAssertEqual(viewModel.transparency, "opaque")
    }
}
