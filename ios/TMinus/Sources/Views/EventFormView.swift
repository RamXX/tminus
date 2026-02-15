// EventFormView.swift
// T-Minus iOS -- Event creation form with scheduling integration.
//
// Features:
// - Title, date/time, account selector, constraint toggles
// - Quick action buttons for common patterns
// - Scheduling candidate selection
// - Haptic feedback on form submission
// - Share sheet for meeting links
// - Offline queue indicator

import SwiftUI

struct EventFormView: View {
    @ObservedObject var viewModel: EventFormViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var showShareSheet = false

    var body: some View {
        NavigationStack {
            Form {
                // Quick Actions Section
                quickActionsSection

                // Core Fields
                eventDetailsSection

                // Date/Time
                dateTimeSection

                // Account Selector
                accountSection

                // Constraint Toggles (visible in scheduling mode)
                if viewModel.isSchedulingMode {
                    constraintsSection
                }

                // Scheduling Candidates
                if !viewModel.schedulingCandidates.isEmpty {
                    candidatesSection
                }

                // Status Messages
                statusSection

                // Offline Queue Indicator
                if viewModel.pendingOperationCount > 0 {
                    offlineQueueSection
                }
            }
            .navigationTitle(viewModel.isSchedulingMode ? "Schedule Event" : "New Event")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                    .accessibilityIdentifier("cancelButton")
                }

                ToolbarItem(placement: .confirmationAction) {
                    submitButton
                }
            }
            .task {
                await viewModel.loadAccounts()
            }
            .sheet(isPresented: $showShareSheet) {
                if let url = viewModel.shareMeetingLink() {
                    ShareSheetView(activityItems: [url])
                }
            }
        }
    }

    // MARK: - Quick Actions

    @ViewBuilder
    private var quickActionsSection: some View {
        Section("Quick Actions") {
            HStack(spacing: 12) {
                ForEach(QuickAction.allCases) { action in
                    Button {
                        viewModel.applyQuickAction(action)
                    } label: {
                        VStack(spacing: 6) {
                            Image(systemName: action.iconName)
                                .font(.title3)
                            Text(action.displayName)
                                .font(.caption2)
                                .multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("quickAction_\(action.rawValue)")
                }
            }
        }
    }

    // MARK: - Event Details

    @ViewBuilder
    private var eventDetailsSection: some View {
        Section("Event Details") {
            TextField("Title", text: $viewModel.title)
                .accessibilityIdentifier("titleField")

            TextField("Description (optional)", text: $viewModel.eventDescription, axis: .vertical)
                .lineLimit(3...6)
                .accessibilityIdentifier("descriptionField")

            TextField("Location (optional)", text: $viewModel.location)
                .accessibilityIdentifier("locationField")
        }
    }

    // MARK: - Date/Time

    @ViewBuilder
    private var dateTimeSection: some View {
        Section("Date & Time") {
            Toggle("All Day", isOn: $viewModel.isAllDay)
                .accessibilityIdentifier("allDayToggle")

            if viewModel.isAllDay {
                DatePicker("Start", selection: $viewModel.startDate, displayedComponents: [.date])
                    .accessibilityIdentifier("startDatePicker")
                DatePicker("End", selection: $viewModel.endDate, displayedComponents: [.date])
                    .accessibilityIdentifier("endDatePicker")
            } else {
                DatePicker("Start", selection: $viewModel.startDate, displayedComponents: [.date, .hourAndMinute])
                    .accessibilityIdentifier("startDatePicker")
                DatePicker("End", selection: $viewModel.endDate, displayedComponents: [.date, .hourAndMinute])
                    .accessibilityIdentifier("endDatePicker")
            }
        }
    }

    // MARK: - Account Selector

    @ViewBuilder
    private var accountSection: some View {
        Section("Calendar Account") {
            if viewModel.accounts.isEmpty && viewModel.isLoading {
                ProgressView("Loading accounts...")
                    .accessibilityIdentifier("accountsLoading")
            } else if viewModel.accounts.isEmpty {
                Text("No accounts available")
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("noAccounts")
            } else {
                Picker("Account", selection: $viewModel.selectedAccountId) {
                    Text("Select account").tag(nil as String?)
                    ForEach(viewModel.accounts) { account in
                        HStack {
                            Circle()
                                .fill(AccountColors.color(for: account.accountId))
                                .frame(width: 10, height: 10)
                            Text(account.displayName ?? account.email)
                        }
                        .tag(account.accountId as String?)
                    }
                }
                .accessibilityIdentifier("accountPicker")
            }

            // Visibility / Transparency
            Picker("Visibility", selection: $viewModel.visibility) {
                Text("Default").tag("default")
                Text("Public").tag("public")
                Text("Private").tag("private")
            }
            .accessibilityIdentifier("visibilityPicker")

            Picker("Show as", selection: $viewModel.transparency) {
                Text("Busy").tag("opaque")
                Text("Free").tag("transparent")
            }
            .accessibilityIdentifier("transparencyPicker")
        }
    }

    // MARK: - Constraints

    @ViewBuilder
    private var constraintsSection: some View {
        Section("Scheduling Preferences") {
            Toggle("Prefer morning", isOn: $viewModel.preferMorning)
                .accessibilityIdentifier("preferMorningToggle")
            Toggle("Prefer afternoon", isOn: $viewModel.preferAfternoon)
                .accessibilityIdentifier("preferAfternoonToggle")
            Toggle("Avoid back-to-back", isOn: $viewModel.avoidBackToBack)
                .accessibilityIdentifier("avoidBackToBackToggle")
        }
    }

    // MARK: - Candidates

    @ViewBuilder
    private var candidatesSection: some View {
        Section("Proposed Times") {
            ForEach(viewModel.schedulingCandidates) { candidate in
                CandidateRow(
                    candidate: candidate,
                    isSelected: candidate.id == viewModel.selectedCandidateId
                )
                .contentShape(Rectangle())
                .onTapGesture {
                    viewModel.selectCandidate(candidate.id)
                }
                .accessibilityIdentifier("candidate_\(candidate.id)")
            }
        }
    }

    // MARK: - Status

    @ViewBuilder
    private var statusSection: some View {
        // Validation errors
        if !viewModel.validationErrors.isEmpty {
            Section {
                ForEach(viewModel.validationErrors, id: \.self) { error in
                    Label(error.message, systemImage: "exclamationmark.triangle")
                        .foregroundColor(.red)
                        .font(.caption)
                }
            }
            .accessibilityIdentifier("validationErrors")
        }

        // Error message
        if let error = viewModel.errorMessage {
            Section {
                Label(error, systemImage: "xmark.circle")
                    .foregroundColor(.red)
            }
            .accessibilityIdentifier("errorMessage")
        }

        // Success message
        if let success = viewModel.successMessage {
            Section {
                Label(success, systemImage: "checkmark.circle")
                    .foregroundColor(.green)

                if viewModel.shareMeetingLink() != nil {
                    Button {
                        showShareSheet = true
                    } label: {
                        Label("Share Meeting Link", systemImage: "square.and.arrow.up")
                    }
                    .accessibilityIdentifier("shareButton")
                }
            }
            .accessibilityIdentifier("successMessage")
        }
    }

    // MARK: - Offline Queue

    @ViewBuilder
    private var offlineQueueSection: some View {
        Section {
            HStack {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .foregroundColor(.orange)
                Text("\(viewModel.pendingOperationCount) pending operation(s)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Retry") {
                    Task { await viewModel.drainOfflineQueue() }
                }
                .font(.caption)
                .accessibilityIdentifier("retryQueueButton")
            }
        }
        .accessibilityIdentifier("offlineQueueSection")
    }

    // MARK: - Submit Button

    @ViewBuilder
    private var submitButton: some View {
        if viewModel.isSubmitting {
            ProgressView()
                .accessibilityIdentifier("submitLoading")
        } else if viewModel.isSchedulingMode && viewModel.schedulingCandidates.isEmpty {
            Button("Find Times") {
                Task { await viewModel.proposeTimes() }
            }
            .fontWeight(.semibold)
            .accessibilityIdentifier("proposeTimesButton")
        } else if viewModel.isSchedulingMode && viewModel.selectedCandidateId != nil {
            Button("Schedule") {
                Task { await viewModel.commitSelectedCandidate() }
            }
            .fontWeight(.semibold)
            .accessibilityIdentifier("commitButton")
        } else if !viewModel.isSchedulingMode {
            Button("Create") {
                Task { await viewModel.submitEvent() }
            }
            .fontWeight(.semibold)
            .accessibilityIdentifier("createEventButton")
        } else {
            // Scheduling mode, candidates shown but none selected
            Button("Schedule") {}
                .disabled(true)
                .accessibilityIdentifier("commitButton")
        }
    }
}

// MARK: - Candidate Row

struct CandidateRow: View {
    let candidate: SchedulingCandidate
    let isSelected: Bool

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                if let start = candidate.startDate, let end = candidate.endDate {
                    Text(formatDateRange(start: start, end: end))
                        .font(.body)
                } else {
                    Text("\(candidate.start) - \(candidate.end)")
                        .font(.body)
                }

                if let reason = candidate.reason {
                    Text(reason)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            // Score indicator
            Text(String(format: "%.0f%%", candidate.score * 100))
                .font(.caption)
                .foregroundStyle(.secondary)

            if isSelected {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundColor(.accentColor)
            } else {
                Image(systemName: "circle")
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
        .background(isSelected ? Color.accentColor.opacity(0.1) : Color.clear)
    }

    private func formatDateRange(start: Date, end: Date) -> String {
        let dateFmt = DateFormatter()
        dateFmt.dateStyle = .medium
        dateFmt.timeStyle = .none

        let timeFmt = DateFormatter()
        timeFmt.dateStyle = .none
        timeFmt.timeStyle = .short

        return "\(dateFmt.string(from: start)), \(timeFmt.string(from: start)) - \(timeFmt.string(from: end))"
    }
}

// MARK: - Share Sheet

/// UIActivityViewController wrapper for SwiftUI.
/// Presents the system share sheet with the provided activity items.
struct ShareSheetView: View {
    let activityItems: [Any]

    var body: some View {
        #if os(iOS)
        ShareSheetRepresentable(activityItems: activityItems)
        #else
        Text("Share is only available on iOS")
        #endif
    }
}

#if os(iOS)
import UIKit

struct ShareSheetRepresentable: UIViewControllerRepresentable {
    let activityItems: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: activityItems, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
#endif
