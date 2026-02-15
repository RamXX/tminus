// EventFormViewModel.swift
// T-Minus iOS -- Event creation form and scheduling workflow view model.
//
// Manages:
// 1. Event creation form state and validation
// 2. Quick actions (Find 1:1, Block Focus Time, Add Trip)
// 3. Scheduling workflow (propose times -> select candidate -> commit)
// 4. Offline queueing when connectivity is poor
// 5. Haptic feedback triggers for confirmations

import Foundation
import Combine

// MARK: - Quick Action Types

/// Predefined quick actions for common event creation patterns.
enum QuickAction: String, CaseIterable, Identifiable {
    case findOneOnOne = "find_1on1"
    case blockFocusTime = "block_focus"
    case addTrip = "add_trip"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .findOneOnOne: return "Find time for 1:1"
        case .blockFocusTime: return "Block focus time"
        case .addTrip: return "Add trip"
        }
    }

    var iconName: String {
        switch self {
        case .findOneOnOne: return "person.2"
        case .blockFocusTime: return "brain.head.profile"
        case .addTrip: return "airplane"
        }
    }

    /// Default duration in minutes for this quick action.
    var defaultDurationMinutes: Int {
        switch self {
        case .findOneOnOne: return 30
        case .blockFocusTime: return 120
        case .addTrip: return 480  // 8 hours (full day)
        }
    }

    /// Default title for the created event.
    var defaultTitle: String {
        switch self {
        case .findOneOnOne: return "1:1 Meeting"
        case .blockFocusTime: return "Focus Time"
        case .addTrip: return "Trip"
        }
    }

    /// Default transparency (opaque = busy, transparent = free).
    var defaultTransparency: String {
        switch self {
        case .findOneOnOne: return "opaque"
        case .blockFocusTime: return "opaque"
        case .addTrip: return "opaque"
        }
    }

    /// Whether this action uses the scheduling workflow (propose/commit)
    /// vs direct event creation.
    var usesScheduling: Bool {
        switch self {
        case .findOneOnOne: return true
        case .blockFocusTime: return true
        case .addTrip: return false
        }
    }
}

// MARK: - Form Validation

/// Validation errors for the event creation form.
enum EventFormError: Error, Equatable {
    case titleEmpty
    case titleTooLong
    case noAccountSelected
    case endBeforeStart
    case endEqualsStart
    case startInPast

    var message: String {
        switch self {
        case .titleEmpty: return "Title is required."
        case .titleTooLong: return "Title must be 200 characters or fewer."
        case .noAccountSelected: return "Please select an account."
        case .endBeforeStart: return "End time must be after start time."
        case .endEqualsStart: return "End time must be different from start time."
        case .startInPast: return "Start time cannot be in the past."
        }
    }
}

/// Validates event form fields. Pure function -- no side effects.
enum EventFormValidator {

    /// Maximum title length.
    static let maxTitleLength = 200

    /// Validate all form fields. Returns nil if valid, or the first error found.
    static func validate(
        title: String,
        accountId: String?,
        startDate: Date,
        endDate: Date,
        now: Date = Date()
    ) -> EventFormError? {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return .titleEmpty }
        if trimmed.count > maxTitleLength { return .titleTooLong }
        if accountId == nil || accountId?.isEmpty == true { return .noAccountSelected }
        // Allow start times up to 1 minute in the past to handle form submission delay
        if startDate.addingTimeInterval(60) < now { return .startInPast }
        if endDate < startDate { return .endBeforeStart }
        if endDate == startDate { return .endEqualsStart }
        return nil
    }

    /// Validate all fields and return ALL errors (useful for UI highlighting).
    static func validateAll(
        title: String,
        accountId: String?,
        startDate: Date,
        endDate: Date,
        now: Date = Date()
    ) -> [EventFormError] {
        var errors: [EventFormError] = []
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { errors.append(.titleEmpty) }
        if trimmed.count > maxTitleLength { errors.append(.titleTooLong) }
        if accountId == nil || accountId?.isEmpty == true { errors.append(.noAccountSelected) }
        if startDate.addingTimeInterval(60) < now { errors.append(.startInPast) }
        if endDate < startDate { errors.append(.endBeforeStart) }
        if endDate == startDate { errors.append(.endEqualsStart) }
        return errors
    }
}

// MARK: - View Model

/// Observable state for event creation form and scheduling workflow.
@MainActor
final class EventFormViewModel: ObservableObject {

    // MARK: - Form State

    @Published var title: String = ""
    @Published var startDate: Date = Date()
    @Published var endDate: Date = Date().addingTimeInterval(3600) // +1 hour
    @Published var isAllDay: Bool = false
    @Published var selectedAccountId: String?
    @Published var eventDescription: String = ""
    @Published var location: String = ""
    @Published var visibility: String = "default"
    @Published var transparency: String = "opaque"

    // MARK: - Constraint Toggles

    @Published var preferMorning: Bool = false
    @Published var preferAfternoon: Bool = false
    @Published var avoidBackToBack: Bool = false

    // MARK: - Scheduling State

    @Published var isSchedulingMode: Bool = false
    @Published var schedulingCandidates: [SchedulingCandidate] = []
    @Published var selectedCandidateId: String?
    @Published var schedulingSessionId: String?

    // MARK: - UI State

    @Published var accounts: [CalendarAccount] = []
    @Published var isLoading: Bool = false
    @Published var isSubmitting: Bool = false
    @Published var errorMessage: String?
    @Published var validationErrors: [EventFormError] = []
    @Published var successMessage: String?
    @Published var pendingOperationCount: Int = 0

    // MARK: - Dependencies

    private let apiClient: APIClientProtocol
    private let haptics: HapticServiceProtocol
    private let offlineQueue: OfflineQueueProtocol

    init(
        apiClient: APIClientProtocol,
        haptics: HapticServiceProtocol = HapticService(),
        offlineQueue: OfflineQueueProtocol = OfflineQueue()
    ) {
        self.apiClient = apiClient
        self.haptics = haptics
        self.offlineQueue = offlineQueue
        self.pendingOperationCount = offlineQueue.count
    }

    // MARK: - Account Loading

    /// Fetch available accounts for the account selector.
    func loadAccounts() async {
        isLoading = true
        do {
            accounts = try await apiClient.fetchAccounts()
            // Auto-select first account if none selected
            if selectedAccountId == nil, let first = accounts.first {
                selectedAccountId = first.accountId
            }
        } catch {
            errorMessage = "Failed to load accounts: \(error.localizedDescription)"
        }
        isLoading = false
    }

    // MARK: - Form Validation

    /// Validate the current form state. Returns true if valid.
    func validateForm() -> Bool {
        validationErrors = EventFormValidator.validateAll(
            title: title,
            accountId: selectedAccountId,
            startDate: startDate,
            endDate: endDate
        )
        return validationErrors.isEmpty
    }

    /// Convenience: first validation error message, or nil.
    var firstValidationError: String? {
        validationErrors.first?.message
    }

    // MARK: - Quick Actions

    /// Apply a quick action, pre-filling form fields with defaults.
    func applyQuickAction(_ action: QuickAction) {
        title = action.defaultTitle
        transparency = action.defaultTransparency

        let cal = Calendar.current
        let now = Date()

        switch action {
        case .findOneOnOne:
            // Set to next available hour, 30 min duration
            let nextHour = cal.date(bySetting: .minute, value: 0, of: now)
                .flatMap { cal.date(byAdding: .hour, value: 1, to: $0) } ?? now
            startDate = nextHour
            endDate = cal.date(byAdding: .minute, value: action.defaultDurationMinutes, to: nextHour) ?? nextHour
            isSchedulingMode = true
            isAllDay = false

        case .blockFocusTime:
            // Set to tomorrow 9:00 AM, 2 hour block
            var components = cal.dateComponents([.year, .month, .day], from: now)
            components.day! += 1
            components.hour = 9
            components.minute = 0
            let tomorrow9am = cal.date(from: components) ?? now
            startDate = tomorrow9am
            endDate = cal.date(byAdding: .minute, value: action.defaultDurationMinutes, to: tomorrow9am) ?? tomorrow9am
            isSchedulingMode = true
            isAllDay = false

        case .addTrip:
            // Full day event starting tomorrow
            let tomorrow = cal.date(byAdding: .day, value: 1, to: now) ?? now
            let dayAfter = cal.date(byAdding: .day, value: 2, to: now) ?? now
            startDate = cal.startOfDay(for: tomorrow)
            endDate = cal.startOfDay(for: dayAfter)
            isSchedulingMode = false
            isAllDay = true
        }

        haptics.trigger(.selectionChanged)
    }

    // MARK: - Event Creation

    /// Submit the event creation form.
    /// If offline, queues the operation for later execution.
    func submitEvent() async {
        guard validateForm() else {
            haptics.trigger(.warning)
            return
        }

        isSubmitting = true
        errorMessage = nil
        successMessage = nil

        let iso = ISO8601DateFormatter()
        let request = CreateEventRequest(
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            accountId: selectedAccountId!,
            start: iso.string(from: startDate),
            end: iso.string(from: endDate),
            allDay: isAllDay,
            description: eventDescription.isEmpty ? nil : eventDescription,
            location: location.isEmpty ? nil : location,
            visibility: visibility,
            transparency: transparency
        )

        do {
            let response = try await apiClient.createEvent(request)
            successMessage = "Event created (ID: \(response.canonicalEventId))"
            haptics.trigger(.success)
            resetForm()
        } catch {
            // Queue for offline retry
            if let pendingOp = PendingOperation.createEvent(request) {
                offlineQueue.enqueue(pendingOp)
                pendingOperationCount = offlineQueue.count
                successMessage = "Event queued for creation when online."
                haptics.trigger(.warning)
            } else {
                errorMessage = "Failed to create event: \(error.localizedDescription)"
                haptics.trigger(.error)
            }
        }

        isSubmitting = false
    }

    // MARK: - Scheduling Workflow

    /// Step 1: Propose times for the scheduling workflow.
    func proposeTimes() async {
        guard validateForm() else {
            haptics.trigger(.warning)
            return
        }

        isSubmitting = true
        errorMessage = nil

        let durationMinutes = Int(endDate.timeIntervalSince(startDate) / 60)

        let constraints = SchedulingConstraints(
            preferMorning: preferMorning ? true : nil,
            preferAfternoon: preferAfternoon ? true : nil,
            avoidBackToBack: avoidBackToBack ? true : nil,
            minimumNotice: nil
        )

        let request = ProposeTimesRequest(
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            durationMinutes: max(durationMinutes, 15),  // minimum 15 min
            participants: nil,
            constraints: constraints
        )

        do {
            let response = try await apiClient.proposeTimes(request)
            schedulingSessionId = response.sessionId
            schedulingCandidates = response.candidates
            haptics.trigger(.success)
        } catch {
            errorMessage = "Failed to propose times: \(error.localizedDescription)"
            haptics.trigger(.error)
        }

        isSubmitting = false
    }

    /// Step 2: Select a candidate from the proposals.
    func selectCandidate(_ candidateId: String) {
        selectedCandidateId = candidateId
        haptics.trigger(.selectionChanged)
    }

    /// Step 3: Commit the selected candidate, creating the actual event.
    func commitSelectedCandidate() async {
        guard let sessionId = schedulingSessionId,
              let candidateId = selectedCandidateId,
              let accountId = selectedAccountId else {
            errorMessage = "Please select a time slot and account."
            haptics.trigger(.warning)
            return
        }

        isSubmitting = true
        errorMessage = nil
        successMessage = nil

        let request = CommitCandidateRequest(
            sessionId: sessionId,
            candidateId: candidateId,
            accountId: accountId
        )

        do {
            let response = try await apiClient.commitCandidate(request)
            successMessage = "Meeting scheduled (ID: \(response.canonicalEventId))"
            haptics.trigger(.success)
            resetForm()
        } catch {
            // Queue for offline retry
            if let pendingOp = PendingOperation.commitCandidate(request) {
                offlineQueue.enqueue(pendingOp)
                pendingOperationCount = offlineQueue.count
                successMessage = "Scheduling queued for when online."
                haptics.trigger(.warning)
            } else {
                errorMessage = "Failed to schedule: \(error.localizedDescription)"
                haptics.trigger(.error)
            }
        }

        isSubmitting = false
    }

    // MARK: - Offline Queue Drain

    /// Process all pending offline operations.
    /// Called when connectivity is restored.
    func drainOfflineQueue() async {
        let decoder = JSONDecoder()

        while let operation = offlineQueue.peek() {
            if operation.retryCount >= PendingOperation.maxRetries {
                offlineQueue.remove(id: operation.id)
                pendingOperationCount = offlineQueue.count
                continue
            }

            do {
                switch operation.type {
                case .createEvent:
                    let request = try decoder.decode(CreateEventRequest.self, from: operation.payload)
                    _ = try await apiClient.createEvent(request)
                case .commitCandidate:
                    let request = try decoder.decode(CommitCandidateRequest.self, from: operation.payload)
                    _ = try await apiClient.commitCandidate(request)
                }
                // Success: remove from queue
                offlineQueue.remove(id: operation.id)
                pendingOperationCount = offlineQueue.count
            } catch {
                // Increment retry count and move to next
                offlineQueue.updateRetryCount(id: operation.id, retryCount: operation.retryCount + 1)
                // Dequeue to avoid infinite loop on persistent failure
                _ = offlineQueue.dequeue()
                if operation.retryCount + 1 < PendingOperation.maxRetries {
                    // Re-enqueue at end for retry
                    var retried = operation
                    retried.retryCount += 1
                    offlineQueue.enqueue(retried)
                }
                pendingOperationCount = offlineQueue.count
                break  // Stop draining on first failure (network likely still down)
            }
        }
    }

    // MARK: - Share

    /// Generate a shareable meeting link URL string.
    /// Returns nil if no event was just created.
    func shareMeetingLink() -> URL? {
        // Use the T-Minus deep link format for sharing.
        // The recipient can open this in T-Minus to view the event.
        guard let accountId = selectedAccountId else { return nil }
        let encoded = title.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? title
        return URL(string: "https://app.tminus.ink/schedule?title=\(encoded)&account=\(accountId)")
    }

    // MARK: - Reset

    /// Reset the form to its initial state after successful submission.
    func resetForm() {
        title = ""
        eventDescription = ""
        location = ""
        isAllDay = false
        startDate = Date()
        endDate = Date().addingTimeInterval(3600)
        visibility = "default"
        transparency = "opaque"
        preferMorning = false
        preferAfternoon = false
        avoidBackToBack = false
        isSchedulingMode = false
        schedulingCandidates = []
        selectedCandidateId = nil
        schedulingSessionId = nil
        validationErrors = []
    }
}
