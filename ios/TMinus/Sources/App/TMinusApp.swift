// TMinusApp.swift
// T-Minus iOS -- Application entry point.
//
// Configures the API client, push notification service, and launches
// the root ContentView. Registers for remote notifications on launch
// and delegates APNs callbacks to PushNotificationService.

import SwiftUI
import UserNotifications

@main
struct TMinusApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

/// AppDelegate handles UIKit-level callbacks for push notifications.
/// SwiftUI's App protocol doesn't directly expose didRegisterForRemoteNotifications,
/// so we use UIApplicationDelegateAdaptor.
class AppDelegate: NSObject, UIApplicationDelegate {
    let pushService = PushNotificationService(apiClient: APIClient())

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Set push service as notification center delegate
        UNUserNotificationCenter.current().delegate = pushService

        // Request push permission and register
        Task {
            let granted = await pushService.requestAuthorization()
            if granted {
                await MainActor.run {
                    application.registerForRemoteNotifications()
                }
            }
        }

        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        pushService.didRegisterForRemoteNotifications(withDeviceToken: deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        pushService.didFailToRegisterForRemoteNotifications(withError: error)
    }
}
