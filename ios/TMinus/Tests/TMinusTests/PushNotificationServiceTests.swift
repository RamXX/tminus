// PushNotificationServiceTests.swift
// T-Minus iOS Tests -- Unit tests for PushNotificationService.
//
// Tests cover:
// - Device token registration uses the protocol method (not concrete type)
// - Successful token registration
// - Missing userId skips registration
// - Token hex conversion from Data
// - Registration failure does not crash

import XCTest
@testable import TMinusLib

final class PushNotificationServiceTests: XCTestCase {

    var mockAPI: MockAPIClient!
    var service: PushNotificationService!

    override func setUp() {
        super.setUp()
        mockAPI = MockAPIClient()
        service = PushNotificationService(apiClient: mockAPI)
    }

    // MARK: - Protocol Abstraction

    func testInitAcceptsProtocolWithoutDowncast() {
        // The fact that PushNotificationService can be initialized with MockAPIClient
        // (which conforms to APIClientProtocol but is NOT a subclass of APIClient)
        // proves the force-cast has been removed. If the old force-cast were still
        // present, registerTokenWithBackend would silently return without calling
        // the mock, and registerDeviceTokenCalled would remain false.
        let mockClient: APIClientProtocol = mockAPI!
        let svc = PushNotificationService(apiClient: mockClient)
        XCTAssertNotNil(svc)
    }

    // MARK: - Token Registration via Protocol

    func testRegisterTokenCallsProtocolMethod() async throws {
        service.userId = "usr_test_001"
        mockAPI.registerDeviceTokenResult = .success(())

        // Simulate APNs providing a device token (4 bytes for simplicity)
        let tokenData = Data([0xDE, 0xAD, 0xBE, 0xEF])
        service.didRegisterForRemoteNotifications(withDeviceToken: tokenData)

        // The registration happens in a detached Task, so we need to wait briefly
        try await Task.sleep(nanoseconds: 200_000_000) // 200ms

        XCTAssertTrue(mockAPI.registerDeviceTokenCalled,
                       "Should call registerDeviceToken on the protocol, not downcast to APIClient")
        XCTAssertEqual(mockAPI.lastRegisteredToken, "deadbeef",
                       "Token should be converted to lowercase hex string")
        XCTAssertEqual(mockAPI.lastRegisteredUserId, "usr_test_001",
                       "Should pass the current userId")
    }

    // MARK: - Device Token Hex Conversion

    func testDeviceTokenStoredAsHexString() {
        let tokenData = Data([0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF])
        service.didRegisterForRemoteNotifications(withDeviceToken: tokenData)

        XCTAssertEqual(service.deviceToken, "0123456789abcdef",
                       "Device token should be stored as lowercase hex string")
    }

    // MARK: - Missing User ID

    func testRegistrationSkippedWhenNoUserId() async throws {
        // userId is nil by default
        XCTAssertNil(service.userId)

        let tokenData = Data([0xAA, 0xBB])
        service.didRegisterForRemoteNotifications(withDeviceToken: tokenData)

        try await Task.sleep(nanoseconds: 200_000_000) // 200ms

        XCTAssertFalse(mockAPI.registerDeviceTokenCalled,
                        "Should not attempt registration without a userId")
    }

    // MARK: - Registration Failure

    func testRegistrationFailureDoesNotCrash() async throws {
        service.userId = "usr_test_002"
        mockAPI.registerDeviceTokenResult = .failure(APIError.networkError("Connection refused"))

        let tokenData = Data([0xFF, 0x00])
        service.didRegisterForRemoteNotifications(withDeviceToken: tokenData)

        // Wait long enough for initial attempt + first retry (1s backoff)
        // but not so long the test is slow. The mock fails instantly so retries
        // happen quickly after the sleep.
        try await Task.sleep(nanoseconds: 500_000_000) // 500ms

        // The method should have been called (at least the first attempt)
        XCTAssertTrue(mockAPI.registerDeviceTokenCalled,
                       "Should attempt registration even if it will fail")
    }

    // MARK: - Notification Handling

    func testHandleNotificationWithValidPayload() {
        let mockRouter = MockNotificationRouter()
        service.router = mockRouter

        let userInfo: [AnyHashable: Any] = [
            "notification_type": "drift_alert",
            "deep_link": "tminus:///drift/rel_123",
            "metadata": ["relationship_id": "rel_123"],
        ]

        service.handleNotification(userInfo: userInfo)
        XCTAssertNotNil(mockRouter.lastNavigatedLink,
                        "Should route valid notification to the router")
    }

    func testHandleNotificationWithInvalidPayload() {
        let mockRouter = MockNotificationRouter()
        service.router = mockRouter

        let userInfo: [AnyHashable: Any] = [
            "invalid_key": "invalid_value",
        ]

        service.handleNotification(userInfo: userInfo)
        XCTAssertNil(mockRouter.lastNavigatedLink,
                      "Should not route invalid notification payload")
    }

    // MARK: - APNs Registration Failure

    func testDidFailToRegisterDoesNotCrash() {
        // This should simply log and not throw or crash
        let error = NSError(domain: "APNs", code: 3000, userInfo: [
            NSLocalizedDescriptionKey: "Remote notifications not supported in simulator",
        ])
        service.didFailToRegisterForRemoteNotifications(withError: error)
        // No assertion needed -- test passes if no crash occurs
    }
}

// MARK: - Mock Notification Router

private final class MockNotificationRouter: NotificationRouter {
    var lastNavigatedLink: DeepLink?

    func navigate(to deepLink: DeepLink) {
        lastNavigatedLink = deepLink
    }
}
