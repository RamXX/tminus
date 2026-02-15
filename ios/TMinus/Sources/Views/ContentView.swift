// ContentView.swift
// T-Minus iOS -- Root view that switches between login and calendar.
//
// Observes AuthViewModel.isAuthenticated to determine which view to show.

import SwiftUI

struct ContentView: View {
    @StateObject private var authVM: AuthViewModel
    @StateObject private var calendarVM: CalendarViewModel

    private let apiClient: APIClientProtocol

    init(apiClient: APIClientProtocol? = nil) {
        let client = apiClient ?? APIClient()
        self.apiClient = client
        _authVM = StateObject(wrappedValue: AuthViewModel(apiClient: client))
        _calendarVM = StateObject(wrappedValue: CalendarViewModel(apiClient: client))
    }

    var body: some View {
        Group {
            if authVM.isAuthenticated {
                CalendarView(calendarVM: calendarVM, authVM: authVM)
                    .transition(.move(edge: .trailing))
            } else {
                LoginView(viewModel: authVM)
                    .transition(.move(edge: .leading))
            }
        }
        .animation(.default, value: authVM.isAuthenticated)
    }
}
