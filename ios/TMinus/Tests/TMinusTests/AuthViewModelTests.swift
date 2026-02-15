// AuthViewModelTests.swift
// T-Minus iOS Tests -- Unit tests for AuthViewModel.

import XCTest
@testable import TMinusLib

@MainActor
final class AuthViewModelTests: XCTestCase {

    var mockAPI: MockAPIClient!
    var mockKeychain: MockKeychain!
    var viewModel: AuthViewModel!

    override func setUp() {
        super.setUp()
        mockAPI = MockAPIClient()
        mockKeychain = MockKeychain()
        viewModel = AuthViewModel(apiClient: mockAPI, keychain: mockKeychain)
    }

    // MARK: - Initial State

    func testInitialStateNotAuthenticated() {
        XCTAssertFalse(viewModel.isAuthenticated)
        XCTAssertFalse(viewModel.isLoading)
        XCTAssertNil(viewModel.errorMessage)
    }

    func testInitialStateDetectsExistingToken() {
        mockAPI._isAuthenticated = true
        _ = mockKeychain.save(key: TokenKeys.userEmail, value: "existing@test.com")
        let vm = AuthViewModel(apiClient: mockAPI, keychain: mockKeychain)
        XCTAssertTrue(vm.isAuthenticated)
        XCTAssertEqual(vm.userEmail, "existing@test.com")
    }

    // MARK: - Login

    func testLoginSuccess() async {
        mockAPI.loginResult = .success(TestFixtures.authResponse)

        await viewModel.login(email: "test@example.com", password: "password123")

        XCTAssertTrue(viewModel.isAuthenticated)
        XCTAssertEqual(viewModel.userEmail, "test@example.com")
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertFalse(viewModel.isLoading)
    }

    func testLoginFailure() async {
        mockAPI.loginResult = .failure(APIError.serverError(401, "Invalid credentials"))

        await viewModel.login(email: "test@example.com", password: "wrong")

        XCTAssertFalse(viewModel.isAuthenticated)
        XCTAssertNotNil(viewModel.errorMessage)
        XCTAssertTrue(viewModel.errorMessage!.contains("401"))
        XCTAssertFalse(viewModel.isLoading)
    }

    func testLoginWithEmptyFieldsShowsError() async {
        await viewModel.login(email: "", password: "")

        XCTAssertFalse(viewModel.isAuthenticated)
        XCTAssertEqual(viewModel.errorMessage, "Email and password are required.")
    }

    func testLoginWithEmptyEmailShowsError() async {
        await viewModel.login(email: "", password: "password123")

        XCTAssertFalse(viewModel.isAuthenticated)
        XCTAssertEqual(viewModel.errorMessage, "Email and password are required.")
    }

    func testLoginWithEmptyPasswordShowsError() async {
        await viewModel.login(email: "test@example.com", password: "")

        XCTAssertFalse(viewModel.isAuthenticated)
        XCTAssertEqual(viewModel.errorMessage, "Email and password are required.")
    }

    // MARK: - Logout

    func testLogoutClearsState() async {
        mockAPI.loginResult = .success(TestFixtures.authResponse)
        await viewModel.login(email: "test@example.com", password: "password123")
        XCTAssertTrue(viewModel.isAuthenticated)

        viewModel.logout()

        XCTAssertFalse(viewModel.isAuthenticated)
        XCTAssertNil(viewModel.userEmail)
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertTrue(mockAPI.logoutCalled)
    }

    // MARK: - Token Refresh

    func testRefreshSessionSuccess() async {
        mockAPI.refreshResult = .success(TestFixtures.authResponse)

        await viewModel.refreshSession()

        XCTAssertTrue(viewModel.isAuthenticated)
    }

    func testRefreshSessionFailureSetsUnauthenticated() async {
        mockAPI.refreshResult = .failure(APIError.unauthorized)

        await viewModel.refreshSession()

        XCTAssertFalse(viewModel.isAuthenticated)
    }
}
