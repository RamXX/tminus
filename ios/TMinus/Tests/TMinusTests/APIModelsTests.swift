// APIModelsTests.swift
// T-Minus iOS Tests -- Unit tests for API model decoding and date parsing.

import XCTest
@testable import TMinusLib

final class APIModelsTests: XCTestCase {

    // MARK: - CanonicalEvent Decoding

    func testDecodeCanonicalEvent() throws {
        let json = """
        {
            "canonical_event_id": "evt_01TEST001",
            "origin_account_id": "acc_01ACCT001",
            "origin_event_id": "google_123",
            "title": "Team Meeting",
            "description": "Weekly sync",
            "location": "Room A",
            "start": {"dateTime": "2026-02-15T10:00:00Z"},
            "end": {"dateTime": "2026-02-15T11:00:00Z"},
            "all_day": false,
            "status": "confirmed",
            "visibility": "default",
            "transparency": "opaque",
            "source": "provider",
            "version": 1,
            "created_at": "2026-02-10T08:00:00Z",
            "updated_at": "2026-02-10T08:00:00Z"
        }
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(CanonicalEvent.self, from: json)
        XCTAssertEqual(event.canonicalEventId, "evt_01TEST001")
        XCTAssertEqual(event.originAccountId, "acc_01ACCT001")
        XCTAssertEqual(event.title, "Team Meeting")
        XCTAssertEqual(event.allDay, false)
        XCTAssertEqual(event.status, "confirmed")
        XCTAssertNotNil(event.startDate)
        XCTAssertNotNil(event.endDate)
        XCTAssertEqual(event.id, "evt_01TEST001")
    }

    func testDecodeAllDayEvent() throws {
        let json = """
        {
            "canonical_event_id": "evt_01ALLDAY",
            "origin_account_id": "acc_01ACCT002",
            "origin_event_id": "google_456",
            "title": "Company Holiday",
            "start": {"date": "2026-02-15"},
            "end": {"date": "2026-02-16"},
            "all_day": true,
            "status": "confirmed",
            "visibility": "default",
            "transparency": "transparent",
            "source": "provider",
            "version": 1,
            "created_at": "2026-02-10T08:00:00Z",
            "updated_at": "2026-02-10T08:00:00Z"
        }
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(CanonicalEvent.self, from: json)
        XCTAssertEqual(event.allDay, true)
        XCTAssertNotNil(event.startDate)
        XCTAssertEqual(event.timeDisplayString, "All day")
    }

    func testDecodeAPIEnvelope() throws {
        let json = """
        {
            "ok": true,
            "data": [
                {
                    "canonical_event_id": "evt_01A",
                    "origin_account_id": "acc_01A",
                    "origin_event_id": "g_1",
                    "title": "Test",
                    "start": {"dateTime": "2026-02-15T09:00:00Z"},
                    "end": {"dateTime": "2026-02-15T10:00:00Z"},
                    "all_day": false,
                    "status": "confirmed",
                    "visibility": "default",
                    "transparency": "opaque",
                    "source": "provider",
                    "version": 1,
                    "created_at": "2026-02-10T08:00:00Z",
                    "updated_at": "2026-02-10T08:00:00Z"
                }
            ],
            "meta": {
                "request_id": "req_abc123",
                "timestamp": "2026-02-15T10:00:00Z"
            }
        }
        """.data(using: .utf8)!

        let envelope = try JSONDecoder().decode(APIEnvelope<[CanonicalEvent]>.self, from: json)
        XCTAssertTrue(envelope.ok)
        XCTAssertEqual(envelope.data?.count, 1)
        XCTAssertNil(envelope.error)
        XCTAssertEqual(envelope.meta.requestId, "req_abc123")
    }

    func testDecodeErrorEnvelope() throws {
        let json = """
        {
            "ok": false,
            "error": "Unauthorized",
            "meta": {
                "request_id": "req_err001",
                "timestamp": "2026-02-15T10:00:00Z"
            }
        }
        """.data(using: .utf8)!

        let envelope = try JSONDecoder().decode(APIEnvelope<[CanonicalEvent]>.self, from: json)
        XCTAssertFalse(envelope.ok)
        XCTAssertNil(envelope.data)
        XCTAssertEqual(envelope.error, "Unauthorized")
    }

    // MARK: - Date Parsing

    func testStartDateParsesISO8601() {
        let event = TestFixtures.makeEvent(startISO: "2026-02-15T10:00:00Z")
        let date = event.startDate
        XCTAssertNotNil(date)
        let cal = Calendar(identifier: .gregorian)
        let components = cal.dateComponents(in: TimeZone(identifier: "UTC")!, from: date!)
        XCTAssertEqual(components.year, 2026)
        XCTAssertEqual(components.month, 2)
        XCTAssertEqual(components.day, 15)
        XCTAssertEqual(components.hour, 10)
    }

    func testStartDateParsesDateOnly() {
        let event = TestFixtures.makeAllDayEvent()
        let date = event.startDate
        XCTAssertNotNil(date)
        let cal = Calendar(identifier: .gregorian)
        let components = cal.dateComponents(in: TimeZone(identifier: "UTC")!, from: date!)
        XCTAssertEqual(components.year, 2026)
        XCTAssertEqual(components.month, 2)
        XCTAssertEqual(components.day, 15)
    }

    func testTimeDisplayStringForTimedEvent() {
        let event = TestFixtures.makeEvent(startISO: "2026-02-15T10:00:00Z")
        let display = event.timeDisplayString
        // Should produce a non-empty time string (locale dependent)
        XCTAssertFalse(display.isEmpty)
        XCTAssertNotEqual(display, "All day")
    }

    func testTimeDisplayStringForAllDayEvent() {
        let event = TestFixtures.makeAllDayEvent()
        XCTAssertEqual(event.timeDisplayString, "All day")
    }

    // MARK: - Auth Models

    func testDecodeAuthResponse() throws {
        let json = """
        {
            "token": "jwt.token.here",
            "refresh_token": "refresh_abc123",
            "user": {
                "id": "usr_01ABC",
                "email": "user@example.com",
                "tier": "free"
            }
        }
        """.data(using: .utf8)!

        let auth = try JSONDecoder().decode(AuthResponse.self, from: json)
        XCTAssertEqual(auth.token, "jwt.token.here")
        XCTAssertEqual(auth.refreshToken, "refresh_abc123")
        XCTAssertEqual(auth.user.id, "usr_01ABC")
        XCTAssertEqual(auth.user.email, "user@example.com")
        XCTAssertEqual(auth.user.tier, "free")
    }

    func testEncodeLoginRequest() throws {
        let request = LoginRequest(email: "test@example.com", password: "secret123")
        let data = try JSONEncoder().encode(request)
        let dict = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(dict["email"] as? String, "test@example.com")
        XCTAssertEqual(dict["password"] as? String, "secret123")
    }

    func testEncodeRefreshRequest() throws {
        let request = RefreshRequest(refreshToken: "refresh_token_value")
        let data = try JSONEncoder().encode(request)
        let dict = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(dict["refresh_token"] as? String, "refresh_token_value")
    }

    // MARK: - CalendarAccount

    func testDecodeCalendarAccount() throws {
        let json = """
        {
            "account_id": "acc_01ACCT001",
            "provider": "google",
            "email": "work@gmail.com",
            "display_name": "Work Gmail",
            "status": "active"
        }
        """.data(using: .utf8)!

        let account = try JSONDecoder().decode(CalendarAccount.self, from: json)
        XCTAssertEqual(account.accountId, "acc_01ACCT001")
        XCTAssertEqual(account.provider, "google")
        XCTAssertEqual(account.email, "work@gmail.com")
        XCTAssertEqual(account.displayName, "Work Gmail")
        XCTAssertEqual(account.id, "acc_01ACCT001")
    }
}
