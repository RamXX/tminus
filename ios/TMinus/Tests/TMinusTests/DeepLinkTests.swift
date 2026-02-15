// DeepLinkTests.swift
// T-Minus iOS Tests -- Unit tests for deep link generation and parsing.

import XCTest
@testable import TMinusLib

final class DeepLinkTests: XCTestCase {

    // MARK: - Event URL Generation

    func testEventURLHasCorrectScheme() {
        let url = DeepLinkGenerator.eventURL(eventId: "evt_001")
        XCTAssertEqual(url.scheme, "tminus")
    }

    func testEventURLHasCorrectHost() {
        let url = DeepLinkGenerator.eventURL(eventId: "evt_001")
        XCTAssertEqual(url.host, "event")
    }

    func testEventURLContainsEventId() {
        let url = DeepLinkGenerator.eventURL(eventId: "evt_001")
        XCTAssertTrue(url.absoluteString.contains("evt_001"))
    }

    func testEventURLFullFormat() {
        let url = DeepLinkGenerator.eventURL(eventId: "evt_01ABC")
        XCTAssertEqual(url.absoluteString, "tminus://event/evt_01ABC")
    }

    func testEventURLEncodesSpecialCharacters() {
        let url = DeepLinkGenerator.eventURL(eventId: "evt with spaces")
        // Space should be percent-encoded
        XCTAssertTrue(url.absoluteString.contains("evt%20with%20spaces"))
    }

    // MARK: - Today URL

    func testTodayURL() {
        let url = DeepLinkGenerator.todayURL()
        XCTAssertEqual(url.scheme, "tminus")
        XCTAssertEqual(url.host, "today")
        XCTAssertEqual(url.absoluteString, "tminus://today")
    }

    // MARK: - Parse Event ID

    func testParseEventIdFromValidURL() {
        let url = URL(string: "tminus://event/evt_01ABC")!
        let eventId = DeepLinkGenerator.parseEventId(from: url)
        XCTAssertEqual(eventId, "evt_01ABC")
    }

    func testParseEventIdDecodesPercentEncoding() {
        let url = URL(string: "tminus://event/evt%20with%20spaces")!
        let eventId = DeepLinkGenerator.parseEventId(from: url)
        XCTAssertEqual(eventId, "evt with spaces")
    }

    func testParseEventIdReturnsNilForWrongScheme() {
        let url = URL(string: "https://event/evt_001")!
        let eventId = DeepLinkGenerator.parseEventId(from: url)
        XCTAssertNil(eventId)
    }

    func testParseEventIdReturnsNilForWrongHost() {
        let url = URL(string: "tminus://today")!
        let eventId = DeepLinkGenerator.parseEventId(from: url)
        XCTAssertNil(eventId)
    }

    func testParseEventIdReturnsNilForEmptyPath() {
        let url = URL(string: "tminus://event/")!
        let eventId = DeepLinkGenerator.parseEventId(from: url)
        XCTAssertNil(eventId)
    }

    func testParseEventIdReturnsNilForNoPath() {
        let url = URL(string: "tminus://event")!
        let eventId = DeepLinkGenerator.parseEventId(from: url)
        XCTAssertNil(eventId)
    }

    // MARK: - Round-Trip (Generate then Parse)

    func testDeepLinkRoundTrip() {
        let originalId = "evt_01ROUNDTRIP"
        let url = DeepLinkGenerator.eventURL(eventId: originalId)
        let parsedId = DeepLinkGenerator.parseEventId(from: url)
        XCTAssertEqual(parsedId, originalId)
    }

    func testDeepLinkRoundTripWithSpecialChars() {
        let originalId = "evt/special+chars=yes"
        let url = DeepLinkGenerator.eventURL(eventId: originalId)
        let parsedId = DeepLinkGenerator.parseEventId(from: url)
        XCTAssertEqual(parsedId, originalId)
    }

    // MARK: - WidgetEventData Deep Link

    func testWidgetEventDataDeepLinkURL() {
        let event = WidgetEventData(
            eventId: "evt_from_data",
            title: "Test Event",
            accountId: "acc_01",
            startDate: Date(),
            endDate: Date().addingTimeInterval(3600),
            isAllDay: false,
            location: nil
        )

        let url = event.deepLinkURL
        XCTAssertEqual(url.scheme, "tminus")
        XCTAssertEqual(url.host, "event")
        let parsedId = DeepLinkGenerator.parseEventId(from: url)
        XCTAssertEqual(parsedId, "evt_from_data")
    }

    // MARK: - WidgetEventData Display

    func testWidgetEventDataTimeDisplayStringForTimedEvent() {
        let event = WidgetEventData(
            eventId: "evt_timed",
            title: "Timed",
            accountId: "acc_01",
            startDate: Date(),
            endDate: Date().addingTimeInterval(3600),
            isAllDay: false,
            location: nil
        )
        let display = event.timeDisplayString
        XCTAssertFalse(display.isEmpty)
        XCTAssertNotEqual(display, "All day")
    }

    func testWidgetEventDataTimeDisplayStringForAllDayEvent() {
        let event = WidgetEventData(
            eventId: "evt_allday",
            title: "All Day",
            accountId: "acc_01",
            startDate: Date(),
            endDate: Date().addingTimeInterval(86400),
            isAllDay: true,
            location: nil
        )
        XCTAssertEqual(event.timeDisplayString, "All day")
    }

    // MARK: - Widget Constants

    func testWidgetConstantsURLScheme() {
        XCTAssertEqual(WidgetConstants.urlScheme, "tminus")
    }

    func testWidgetConstantsAppGroupId() {
        XCTAssertEqual(WidgetConstants.appGroupId, "group.com.tminus.ios")
    }

    func testWidgetConstantsDefaultTTL() {
        XCTAssertEqual(WidgetConstants.defaultTTL, 3600)
    }
}
