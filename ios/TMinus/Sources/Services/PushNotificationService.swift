// PushNotificationService.swift
// T-Minus iOS -- Push notification registration and handling.
//
// Responsibilities:
// 1. Request push notification permission from the user
// 2. Register device token with the T-Minus backend
// 3. Handle incoming notifications (foreground + tap)
// 4. Parse deep links and route to the correct screen
//
// Design decisions:
// - Uses UNUserNotificationCenter (iOS 10+, required for iOS 17+)
// - Delegates notification handling to a NavigationRouter
// - Device token registration is retried on failure (3 attempts)
// - Token refresh happens on each app launch (APNs tokens can change)

import Foundation
import UserNotifications

/// Protocol for routing deep links from notifications.
/// The app's navigation coordinator implements this to navigate to the right screen.
protocol NotificationRouter: AnyObject {
    func navigate(to deepLink: DeepLink)
}

/// Service that manages push notification lifecycle.
///
/// Thread safety: All notification delegate callbacks arrive on main thread.
/// Registration API calls use async/await with URLSession (safe from any context).
final class PushNotificationService: NSObject, @unchecked Sendable {

    /// API client for device token registration.
    private let apiClient: APIClientProtocol

    /// Weak reference to the navigation router for deep link handling.
    weak var router: NotificationRouter?

    /// The current user's ID (set after authentication).
    var userId: String?

    /// The most recently registered device token (hex string).
    private(set) var deviceToken: String?

    init(apiClient: APIClientProtocol) {
        self.apiClient = apiClient
        super.init()
    }

    // MARK: - Permission Request

    /// Request push notification authorization from the user.
    /// Returns true if authorization was granted.
    func requestAuthorization() async -> Bool {
        let center = UNUserNotificationCenter.current()
        do {
            let granted = try await center.requestAuthorization(
                options: [.alert, .badge, .sound]
            )
            if granted {
                // Register for remote notifications on the main thread
                await MainActor.run {
                    #if !targetEnvironment(simulator)
                    // UIApplication is not available in SPM library target.
                    // Registration is done from the App target (TMinusApp.swift).
                    #endif
                }
            }
            return granted
        } catch {
            print("[PushNotificationService] Authorization request failed: \(error)")
            return false
        }
    }

    // MARK: - Token Registration

    /// Called when APNs provides a device token.
    /// Converts to hex string and registers with the T-Minus backend.
    func didRegisterForRemoteNotifications(withDeviceToken tokenData: Data) {
        let hexToken = tokenData.map { String(format: "%02x", $0) }.joined()
        self.deviceToken = hexToken

        // Register with backend asynchronously
        Task {
            await registerTokenWithBackend(hexToken)
        }
    }

    /// Called when APNs registration fails.
    func didFailToRegisterForRemoteNotifications(withError error: Error) {
        print("[PushNotificationService] Failed to register for remote notifications: \(error)")
    }

    /// Register the device token with the T-Minus push worker API.
    /// Retries up to 3 times with exponential backoff.
    private func registerTokenWithBackend(_ hexToken: String, attempt: Int = 1) async {
        guard let userId = userId else {
            print("[PushNotificationService] No user ID set, skipping token registration")
            return
        }

        do {
            try await apiClient.registerDeviceToken(hexToken, userId: userId)
            print("[PushNotificationService] Device token registered successfully")
            return
        } catch {
            print("[PushNotificationService] Token registration attempt \(attempt) failed: \(error)")
        }

        // Retry with exponential backoff (1s, 2s, 4s)
        if attempt < 3 {
            let delay = UInt64(pow(2.0, Double(attempt - 1))) * 1_000_000_000
            try? await Task.sleep(nanoseconds: delay)
            await registerTokenWithBackend(hexToken, attempt: attempt + 1)
        }
    }

    // MARK: - Notification Handling

    /// Handle a notification received while app is in foreground or tapped from background.
    func handleNotification(userInfo: [AnyHashable: Any]) {
        guard let payload = TMinusNotificationPayload.parse(from: userInfo) else {
            print("[PushNotificationService] Failed to parse notification payload")
            return
        }

        print("[PushNotificationService] Received notification: type=\(payload.notificationType.rawValue)")

        // Route to the appropriate screen
        router?.navigate(to: payload.deepLink)
    }
}

// MARK: - UNUserNotificationCenterDelegate

extension PushNotificationService: UNUserNotificationCenterDelegate {

    /// Called when a notification is delivered while the app is in the foreground.
    /// We show the notification banner even in foreground for push notifications.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .badge, .sound])
    }

    /// Called when the user taps a notification.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        handleNotification(userInfo: userInfo)
        completionHandler()
    }
}
