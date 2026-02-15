// APIClient.swift
// T-Minus iOS -- HTTP client for the T-Minus REST API.
//
// Uses URLSession with async/await. Handles JWT auth header injection,
// automatic token refresh on 401, and consistent error handling.
// All API calls go through this client.

import Foundation

/// Errors produced by the API client.
enum APIError: Error, LocalizedError, Equatable {
    case unauthorized
    case invalidResponse
    case serverError(Int, String?)
    case networkError(String)
    case decodingError(String)

    var errorDescription: String? {
        switch self {
        case .unauthorized:
            return "Authentication required. Please log in."
        case .invalidResponse:
            return "Invalid response from server."
        case .serverError(let code, let message):
            return "Server error \(code): \(message ?? "Unknown")"
        case .networkError(let message):
            return "Network error: \(message)"
        case .decodingError(let message):
            return "Failed to parse response: \(message)"
        }
    }
}

/// Protocol for the API client, enabling test mocking.
protocol APIClientProtocol {
    func login(email: String, password: String) async throws -> AuthResponse
    func refreshToken() async throws -> AuthResponse
    func fetchEvents(start: Date, end: Date, accountId: String?) async throws -> [CanonicalEvent]
    func fetchAccounts() async throws -> [CalendarAccount]
    var isAuthenticated: Bool { get }
    func logout()
}

/// Production API client backed by URLSession.
final class APIClient: APIClientProtocol {

    /// Base URL for the T-Minus API.
    let baseURL: URL

    /// Keychain service for token storage.
    private let keychain: KeychainServiceProtocol

    /// URLSession for network requests.
    private let session: URLSession

    /// JSON decoder configured for the API's snake_case convention.
    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        return d
    }()

    /// JSON encoder for request bodies.
    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        return e
    }()

    /// Whether we currently have a stored JWT.
    var isAuthenticated: Bool {
        keychain.load(key: TokenKeys.jwt) != nil
    }

    init(
        baseURL: URL = URL(string: "https://api.tminus.ink")!,
        keychain: KeychainServiceProtocol = KeychainService(),
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.keychain = keychain
        self.session = session
    }

    // MARK: - Auth

    func login(email: String, password: String) async throws -> AuthResponse {
        let body = LoginRequest(email: email, password: password)
        let data = try encoder.encode(body)

        let envelope: APIEnvelope<AuthResponse> = try await request(
            method: "POST",
            path: "/v1/auth/login",
            body: data,
            authenticated: false
        )

        guard envelope.ok, let auth = envelope.data else {
            throw APIError.serverError(401, envelope.error ?? "Login failed")
        }

        // Store tokens securely
        keychain.save(key: TokenKeys.jwt, value: auth.token)
        keychain.save(key: TokenKeys.refreshToken, value: auth.refreshToken)
        keychain.save(key: TokenKeys.userId, value: auth.user.id)
        keychain.save(key: TokenKeys.userEmail, value: auth.user.email)

        return auth
    }

    func refreshToken() async throws -> AuthResponse {
        guard let refreshToken = keychain.load(key: TokenKeys.refreshToken) else {
            throw APIError.unauthorized
        }

        let body = RefreshRequest(refreshToken: refreshToken)
        let data = try encoder.encode(body)

        let envelope: APIEnvelope<AuthResponse> = try await request(
            method: "POST",
            path: "/v1/auth/refresh",
            body: data,
            authenticated: false
        )

        guard envelope.ok, let auth = envelope.data else {
            // Refresh failed -- tokens are stale, force re-login
            logout()
            throw APIError.unauthorized
        }

        keychain.save(key: TokenKeys.jwt, value: auth.token)
        keychain.save(key: TokenKeys.refreshToken, value: auth.refreshToken)
        keychain.save(key: TokenKeys.userId, value: auth.user.id)
        keychain.save(key: TokenKeys.userEmail, value: auth.user.email)

        return auth
    }

    func logout() {
        keychain.delete(key: TokenKeys.jwt)
        keychain.delete(key: TokenKeys.refreshToken)
        keychain.delete(key: TokenKeys.userId)
        keychain.delete(key: TokenKeys.userEmail)
    }

    // MARK: - Events

    func fetchEvents(start: Date, end: Date, accountId: String? = nil) async throws -> [CanonicalEvent] {
        let iso = ISO8601DateFormatter()
        var queryItems = [
            URLQueryItem(name: "start", value: iso.string(from: start)),
            URLQueryItem(name: "end", value: iso.string(from: end)),
        ]
        if let accountId = accountId {
            queryItems.append(URLQueryItem(name: "account_id", value: accountId))
        }

        let envelope: APIEnvelope<[CanonicalEvent]> = try await request(
            method: "GET",
            path: "/v1/events",
            queryItems: queryItems,
            authenticated: true
        )

        guard envelope.ok, let events = envelope.data else {
            throw APIError.serverError(500, envelope.error ?? "Failed to fetch events")
        }

        return events
    }

    // MARK: - Accounts

    func fetchAccounts() async throws -> [CalendarAccount] {
        let envelope: APIEnvelope<[CalendarAccount]> = try await request(
            method: "GET",
            path: "/v1/accounts",
            authenticated: true
        )

        guard envelope.ok, let accounts = envelope.data else {
            throw APIError.serverError(500, envelope.error ?? "Failed to fetch accounts")
        }

        return accounts
    }

    // MARK: - Generic Request

    /// Send an authenticated or unauthenticated request to the API.
    /// Automatically retries once with a refreshed token on 401.
    private func request<T: Decodable>(
        method: String,
        path: String,
        queryItems: [URLQueryItem]? = nil,
        body: Data? = nil,
        authenticated: Bool,
        isRetry: Bool = false
    ) async throws -> T {
        var urlComponents = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if let queryItems = queryItems, !queryItems.isEmpty {
            urlComponents.queryItems = queryItems
        }

        guard let url = urlComponents.url else {
            throw APIError.networkError("Invalid URL: \(path)")
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = method
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if authenticated, let token = keychain.load(key: TokenKeys.jwt) {
            urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        if let body = body {
            urlRequest.httpBody = body
        }

        let data: Data
        let response: URLResponse

        do {
            (data, response) = try await session.data(for: urlRequest)
        } catch {
            throw APIError.networkError(error.localizedDescription)
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }

        // Handle 401 with automatic token refresh (one retry)
        if httpResponse.statusCode == 401 && authenticated && !isRetry {
            do {
                _ = try await refreshToken()
                return try await request(
                    method: method,
                    path: path,
                    queryItems: queryItems,
                    body: body,
                    authenticated: true,
                    isRetry: true
                )
            } catch {
                throw APIError.unauthorized
            }
        }

        if httpResponse.statusCode == 401 {
            throw APIError.unauthorized
        }

        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decodingError(error.localizedDescription)
        }
    }
}
