// NotificationModels.swift
// T-Minus iOS -- Push notification data models.
//
// Defines notification types, deep link routes, and the payload
// structure expected from the T-Minus push worker.

import Foundation

// MARK: - Notification Types

/// The five notification types supported by T-Minus.
/// Must stay in sync with NotificationType in @tminus/shared/push.ts.
enum TMinusNotificationType: String, CaseIterable, Codable {
    case driftAlert = "drift_alert"
    case reconnectionSuggestion = "reconnection_suggestion"
    case schedulingProposal = "scheduling_proposal"
    case riskWarning = "risk_warning"
    case holdExpiry = "hold_expiry"

    /// Human-readable display name for notification settings UI.
    var displayName: String {
        switch self {
        case .driftAlert: return "Drift Alerts"
        case .reconnectionSuggestion: return "Reconnection Suggestions"
        case .schedulingProposal: return "Scheduling Proposals"
        case .riskWarning: return "Risk Warnings"
        case .holdExpiry: return "Hold Expiry"
        }
    }

    /// Description for notification settings UI.
    var settingsDescription: String {
        switch self {
        case .driftAlert:
            return "Alerts when relationships are drifting beyond their cadence"
        case .reconnectionSuggestion:
            return "Suggestions for reconnecting with contacts"
        case .schedulingProposal:
            return "Proposals for scheduling meetings"
        case .riskWarning:
            return "Warnings about schedule overload or burnout risk"
        case .holdExpiry:
            return "Reminders when tentative schedule holds are expiring"
        }
    }
}

// MARK: - Deep Link

/// Deep link routes for notification tap handling.
/// The push worker sends a tminus:// URL; this enum parses the path component.
enum DeepLink: Equatable {
    case drift(relationshipId: String?)
    case relationships
    case schedule(sessionId: String?)
    case scheduleHolds
    case dashboard
    case unknown(path: String)

    /// Parse a deep link URL string into a DeepLink case.
    /// Expects format: "tminus:///path" or "tminus://path"
    static func parse(_ urlString: String) -> DeepLink {
        guard let url = URL(string: urlString),
              url.scheme == "tminus" else {
            return .unknown(path: urlString)
        }

        let path = url.path
        let components = path.split(separator: "/").map(String.init)

        guard !components.isEmpty else {
            return .dashboard
        }

        switch components[0] {
        case "drift":
            let relId = components.count > 1 ? components[1] : nil
            return .drift(relationshipId: relId)
        case "relationships":
            return .relationships
        case "schedule":
            if components.count > 1 && components[1] == "holds" {
                return .scheduleHolds
            }
            let sessionId = components.count > 1 ? components[1] : nil
            return .schedule(sessionId: sessionId)
        case "dashboard":
            return .dashboard
        default:
            return .unknown(path: path)
        }
    }
}

// MARK: - Notification Payload

/// The custom data embedded in push notifications from the T-Minus backend.
/// This is the top-level JSON outside the `aps` object.
struct TMinusNotificationPayload {
    let notificationType: TMinusNotificationType
    let deepLink: DeepLink
    let metadata: [String: String]

    /// Parse the custom payload from the notification userInfo dictionary.
    /// Returns nil if the required fields are missing or malformed.
    static func parse(from userInfo: [AnyHashable: Any]) -> TMinusNotificationPayload? {
        guard let typeString = userInfo["notification_type"] as? String,
              let notificationType = TMinusNotificationType(rawValue: typeString) else {
            return nil
        }

        let deepLinkString = userInfo["deep_link"] as? String ?? ""
        let deepLink = DeepLink.parse(deepLinkString)

        let metadata = userInfo["metadata"] as? [String: String] ?? [:]

        return TMinusNotificationPayload(
            notificationType: notificationType,
            deepLink: deepLink,
            metadata: metadata
        )
    }
}

// MARK: - Notification Settings

/// Per-type notification preference (mirrors NotificationPreference in shared/push.ts).
struct NotificationTypePreference: Codable, Equatable {
    var enabled: Bool
}

/// Quiet hours configuration (mirrors QuietHoursConfig in shared/push.ts).
struct QuietHoursConfig: Codable, Equatable {
    var enabled: Bool
    var start: String
    var end: String
    var timezone: String
}

/// Complete notification settings (mirrors NotificationSettings in shared/push.ts).
struct NotificationSettingsModel: Codable, Equatable {
    var preferences: [String: NotificationTypePreference]
    var quietHours: QuietHoursConfig

    enum CodingKeys: String, CodingKey {
        case preferences
        case quietHours = "quiet_hours"
    }

    /// Default settings: all types enabled, quiet hours off.
    static var defaults: NotificationSettingsModel {
        var prefs: [String: NotificationTypePreference] = [:]
        for type in TMinusNotificationType.allCases {
            prefs[type.rawValue] = NotificationTypePreference(enabled: true)
        }
        return NotificationSettingsModel(
            preferences: prefs,
            quietHours: QuietHoursConfig(
                enabled: false,
                start: "22:00",
                end: "07:00",
                timezone: TimeZone.current.identifier
            )
        )
    }
}
