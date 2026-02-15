// NotificationModelsTests.swift
// T-Minus iOS Tests -- Unit tests for push notification models.
//
// Tests cover:
// - TMinusNotificationType enum values and display names
// - DeepLink parsing from tminus:// URLs
// - TMinusNotificationPayload parsing from userInfo dictionaries
// - NotificationSettingsModel defaults

import XCTest
@testable import TMinusLib

final class NotificationModelsTests: XCTestCase {

    // MARK: - TMinusNotificationType

    func testAllNotificationTypeRawValues() {
        XCTAssertEqual(TMinusNotificationType.driftAlert.rawValue, "drift_alert")
        XCTAssertEqual(TMinusNotificationType.reconnectionSuggestion.rawValue, "reconnection_suggestion")
        XCTAssertEqual(TMinusNotificationType.schedulingProposal.rawValue, "scheduling_proposal")
        XCTAssertEqual(TMinusNotificationType.riskWarning.rawValue, "risk_warning")
        XCTAssertEqual(TMinusNotificationType.holdExpiry.rawValue, "hold_expiry")
    }

    func testFiveNotificationTypes() {
        XCTAssertEqual(TMinusNotificationType.allCases.count, 5)
    }

    func testDisplayNamesAreNonEmpty() {
        for type in TMinusNotificationType.allCases {
            XCTAssertFalse(type.displayName.isEmpty, "Display name should not be empty for \(type)")
        }
    }

    func testSettingsDescriptionsAreNonEmpty() {
        for type in TMinusNotificationType.allCases {
            XCTAssertFalse(type.settingsDescription.isEmpty, "Settings description should not be empty for \(type)")
        }
    }

    // MARK: - DeepLink Parsing

    func testParseDriftAlertWithRelationshipId() {
        let link = DeepLink.parse("tminus:///drift/rel_01HXY000000000000000000E01")
        XCTAssertEqual(link, .drift(relationshipId: "rel_01HXY000000000000000000E01"))
    }

    func testParseDriftAlertWithoutRelationshipId() {
        let link = DeepLink.parse("tminus:///drift")
        XCTAssertEqual(link, .drift(relationshipId: nil))
    }

    func testParseRelationships() {
        let link = DeepLink.parse("tminus:///relationships")
        XCTAssertEqual(link, .relationships)
    }

    func testParseScheduleWithSessionId() {
        let link = DeepLink.parse("tminus:///schedule/sess_abc123")
        XCTAssertEqual(link, .schedule(sessionId: "sess_abc123"))
    }

    func testParseScheduleWithoutSessionId() {
        let link = DeepLink.parse("tminus:///schedule")
        XCTAssertEqual(link, .schedule(sessionId: nil))
    }

    func testParseScheduleHolds() {
        let link = DeepLink.parse("tminus:///schedule/holds")
        XCTAssertEqual(link, .scheduleHolds)
    }

    func testParseDashboard() {
        let link = DeepLink.parse("tminus:///dashboard")
        XCTAssertEqual(link, .dashboard)
    }

    func testParseEmptyPathReturnsDashboard() {
        let link = DeepLink.parse("tminus:///")
        XCTAssertEqual(link, .dashboard)
    }

    func testParseUnknownPath() {
        let link = DeepLink.parse("tminus:///unknown/path")
        XCTAssertEqual(link, .unknown(path: "/unknown/path"))
    }

    func testParseInvalidScheme() {
        let link = DeepLink.parse("https:///drift")
        XCTAssertEqual(link, .unknown(path: "https:///drift"))
    }

    func testParseInvalidURL() {
        let link = DeepLink.parse("")
        XCTAssertEqual(link, .unknown(path: ""))
    }

    // MARK: - TMinusNotificationPayload

    func testParseValidPayload() {
        let userInfo: [AnyHashable: Any] = [
            "notification_type": "drift_alert",
            "deep_link": "tminus:///drift/rel_123",
            "metadata": ["relationship_id": "rel_123"],
        ]

        let payload = TMinusNotificationPayload.parse(from: userInfo)
        XCTAssertNotNil(payload)
        XCTAssertEqual(payload?.notificationType, .driftAlert)
        XCTAssertEqual(payload?.deepLink, .drift(relationshipId: "rel_123"))
        XCTAssertEqual(payload?.metadata["relationship_id"], "rel_123")
    }

    func testParsePayloadWithoutDeepLink() {
        let userInfo: [AnyHashable: Any] = [
            "notification_type": "risk_warning",
        ]

        let payload = TMinusNotificationPayload.parse(from: userInfo)
        XCTAssertNotNil(payload)
        XCTAssertEqual(payload?.notificationType, .riskWarning)
    }

    func testParsePayloadWithInvalidType() {
        let userInfo: [AnyHashable: Any] = [
            "notification_type": "invalid_type",
        ]

        let payload = TMinusNotificationPayload.parse(from: userInfo)
        XCTAssertNil(payload)
    }

    func testParsePayloadWithMissingType() {
        let userInfo: [AnyHashable: Any] = [
            "deep_link": "tminus:///drift",
        ]

        let payload = TMinusNotificationPayload.parse(from: userInfo)
        XCTAssertNil(payload)
    }

    func testParsePayloadWithoutMetadata() {
        let userInfo: [AnyHashable: Any] = [
            "notification_type": "hold_expiry",
            "deep_link": "tminus:///schedule/holds",
        ]

        let payload = TMinusNotificationPayload.parse(from: userInfo)
        XCTAssertNotNil(payload)
        XCTAssertTrue(payload?.metadata.isEmpty ?? false)
    }

    // MARK: - NotificationSettingsModel

    func testDefaultSettingsEnableAllTypes() {
        let settings = NotificationSettingsModel.defaults
        for type in TMinusNotificationType.allCases {
            let pref = settings.preferences[type.rawValue]
            XCTAssertNotNil(pref, "Preference should exist for \(type.rawValue)")
            XCTAssertTrue(pref?.enabled ?? false, "Type \(type.rawValue) should be enabled by default")
        }
    }

    func testDefaultSettingsDisableQuietHours() {
        let settings = NotificationSettingsModel.defaults
        XCTAssertFalse(settings.quietHours.enabled)
    }

    func testDefaultQuietHoursWindow() {
        let settings = NotificationSettingsModel.defaults
        XCTAssertEqual(settings.quietHours.start, "22:00")
        XCTAssertEqual(settings.quietHours.end, "07:00")
    }

    func testDefaultQuietHoursUsesLocalTimezone() {
        let settings = NotificationSettingsModel.defaults
        XCTAssertEqual(settings.quietHours.timezone, TimeZone.current.identifier)
    }

    func testSettingsModelCodableRoundTrip() throws {
        let settings = NotificationSettingsModel.defaults
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let data = try encoder.encode(settings)
        let decoded = try JSONDecoder().decode(NotificationSettingsModel.self, from: data)
        XCTAssertEqual(settings, decoded)
    }
}
