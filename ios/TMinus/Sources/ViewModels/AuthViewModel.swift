// AuthViewModel.swift
// T-Minus iOS -- Authentication state management.
//
// Manages login flow, token persistence, and auth state observation.
// Views bind to @Published properties for reactive UI updates.

import Foundation
import Combine

/// Observable auth state for SwiftUI views.
@MainActor
final class AuthViewModel: ObservableObject {

    @Published var isAuthenticated = false
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var userEmail: String?

    private let apiClient: APIClientProtocol
    private let keychain: KeychainServiceProtocol

    init(
        apiClient: APIClientProtocol,
        keychain: KeychainServiceProtocol = KeychainService()
    ) {
        self.apiClient = apiClient
        self.keychain = keychain
        // Check if we already have a stored token
        self.isAuthenticated = apiClient.isAuthenticated
        self.userEmail = keychain.load(key: TokenKeys.userEmail)
    }

    /// Attempt login with email and password.
    func login(email: String, password: String) async {
        guard !email.isEmpty, !password.isEmpty else {
            errorMessage = "Email and password are required."
            return
        }

        isLoading = true
        errorMessage = nil

        do {
            let auth = try await apiClient.login(email: email, password: password)
            isAuthenticated = true
            userEmail = auth.user.email
        } catch let error as APIError {
            errorMessage = error.errorDescription
        } catch {
            errorMessage = "Unexpected error: \(error.localizedDescription)"
        }

        isLoading = false
    }

    /// Log out and clear stored tokens.
    func logout() {
        apiClient.logout()
        isAuthenticated = false
        userEmail = nil
        errorMessage = nil
    }

    /// Attempt to refresh the session silently.
    func refreshSession() async {
        do {
            _ = try await apiClient.refreshToken()
            isAuthenticated = true
        } catch {
            // Silent failure -- user will need to re-login
            isAuthenticated = false
        }
    }
}
