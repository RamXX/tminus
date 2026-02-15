// WatchConnectivityTests.swift
// T-Minus iOS Tests -- Unit and integration tests for Watch connectivity layer.
//
// Tests the data transfer protocol between iPhone and Apple Watch:
// - Message encoding/decoding for event sync
// - Data payload serialization (events -> transferable format)
// - Sync state tracking (last synced, data freshness)
// - Message validation and error handling
// - Integration: full encode->transfer->decode cycle

import XCTest
@testable import TMinusLib

final class WatchSyncPayloadTests: XCTestCase {

    // Fixed reference date: 2026-02-15 10:00 UTC
    let referenceDate = ISO8601DateFormatter().date(from: "2026-02-15T10:00:00Z")!
    let calendar: Calendar = {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        return cal
    }()

    // MARK: - Fixture Helpers

    func makeEvent(
        id: String,
        title: String,
        startHour: Int,
        startMinute: Int = 0,
        durationMinutes: Int = 60,
        isAllDay: Bool = false,
        location: String? = nil,
        accountId: String = "acc_01"
    ) -> WidgetEventData {
        var components = DateComponents()
        components.year = 2026
        components.month = 2
        components.day = 15
        components.hour = startHour
        components.minute = startMinute
        components.timeZone = TimeZone(identifier: "UTC")

        let start = calendar.date(from: components)!
        let end = start.addingTimeInterval(TimeInterval(durationMinutes * 60))

        return WidgetEventData(
            eventId: id,
            title: title,
            accountId: accountId,
            startDate: start,
            endDate: end,
            isAllDay: isAllDay,
            location: location
        )
    }

    // MARK: - WatchSyncPayload Encoding/Decoding

    func testPayloadEncodesAndDecodes() throws {
        let events = [
            makeEvent(id: "e1", title: "Standup", startHour: 9),
            makeEvent(id: "e2", title: "Review", startHour: 14, location: "Room A"),
        ]

        let payload = WatchSyncPayload(
            events: events,
            syncTimestamp: referenceDate,
            syncVersion: 1
        )

        // Encode to dictionary (simulates WCSession message format)
        let encoded = try payload.toDictionary()

        // Decode back
        let decoded = try WatchSyncPayload.fromDictionary(encoded)

        XCTAssertEqual(decoded.events.count, 2)
        XCTAssertEqual(decoded.events[0].eventId, "e1")
        XCTAssertEqual(decoded.events[0].title, "Standup")
        XCTAssertEqual(decoded.events[1].eventId, "e2")
        XCTAssertEqual(decoded.events[1].location, "Room A")
        XCTAssertEqual(decoded.syncVersion, 1)
    }

    func testPayloadPreservesAllEventFields() throws {
        let event = makeEvent(
            id: "evt_full",
            title: "Full Event",
            startHour: 11,
            startMinute: 30,
            durationMinutes: 45,
            isAllDay: false,
            location: "Conference B",
            accountId: "acc_special"
        )

        let payload = WatchSyncPayload(
            events: [event],
            syncTimestamp: referenceDate,
            syncVersion: 1
        )

        let encoded = try payload.toDictionary()
        let decoded = try WatchSyncPayload.fromDictionary(encoded)
        let decoded_event = decoded.events[0]

        XCTAssertEqual(decoded_event.eventId, "evt_full")
        XCTAssertEqual(decoded_event.title, "Full Event")
        XCTAssertEqual(decoded_event.accountId, "acc_special")
        XCTAssertEqual(decoded_event.isAllDay, false)
        XCTAssertEqual(decoded_event.location, "Conference B")
        XCTAssertEqual(decoded_event.startDate.timeIntervalSince1970,
                       event.startDate.timeIntervalSince1970, accuracy: 0.001)
        XCTAssertEqual(decoded_event.endDate.timeIntervalSince1970,
                       event.endDate.timeIntervalSince1970, accuracy: 0.001)
    }

    func testPayloadPreservesSyncTimestamp() throws {
        let payload = WatchSyncPayload(
            events: [],
            syncTimestamp: referenceDate,
            syncVersion: 5
        )

        let encoded = try payload.toDictionary()
        let decoded = try WatchSyncPayload.fromDictionary(encoded)

        XCTAssertEqual(decoded.syncTimestamp.timeIntervalSince1970,
                       referenceDate.timeIntervalSince1970, accuracy: 0.001)
        XCTAssertEqual(decoded.syncVersion, 5)
    }

    func testPayloadHandlesEmptyEvents() throws {
        let payload = WatchSyncPayload(
            events: [],
            syncTimestamp: referenceDate,
            syncVersion: 1
        )

        let encoded = try payload.toDictionary()
        let decoded = try WatchSyncPayload.fromDictionary(encoded)

        XCTAssertTrue(decoded.events.isEmpty)
    }

    func testPayloadFromInvalidDictionaryThrows() {
        let invalidDict: [String: Any] = ["garbage": "data"]

        XCTAssertThrowsError(try WatchSyncPayload.fromDictionary(invalidDict)) { error in
            XCTAssertTrue(error is WatchSyncError)
        }
    }

    func testPayloadFromMissingEventsKeyThrows() {
        let badDict: [String: Any] = [
            "sync_timestamp": referenceDate.timeIntervalSince1970,
            "sync_version": 1,
            // "events_data" key is missing
        ]

        XCTAssertThrowsError(try WatchSyncPayload.fromDictionary(badDict)) { error in
            XCTAssertTrue(error is WatchSyncError)
        }
    }

    func testPayloadFromCorruptEventsDataThrows() {
        let badDict: [String: Any] = [
            "events_data": Data([0xFF, 0xFE]),  // Invalid JSON
            "sync_timestamp": referenceDate.timeIntervalSince1970,
            "sync_version": 1,
        ]

        XCTAssertThrowsError(try WatchSyncPayload.fromDictionary(badDict)) { error in
            XCTAssertTrue(error is WatchSyncError)
        }
    }

    // MARK: - WatchSyncState

    func testSyncStateInitiallyNotSynced() {
        let state = WatchSyncState()
        XCTAssertNil(state.lastSyncTimestamp)
        XCTAssertFalse(state.isSynced)
        XCTAssertEqual(state.syncVersion, 0)
    }

    func testSyncStateUpdatesAfterSync() {
        var state = WatchSyncState()
        state.recordSync(timestamp: referenceDate, version: 3)

        XCTAssertNotNil(state.lastSyncTimestamp)
        if let ts = state.lastSyncTimestamp {
            XCTAssertEqual(ts.timeIntervalSince1970,
                           referenceDate.timeIntervalSince1970, accuracy: 0.001)
        }
        XCTAssertTrue(state.isSynced)
        XCTAssertEqual(state.syncVersion, 3)
    }

    func testSyncStateFreshnessCheck() {
        var state = WatchSyncState()

        // Not synced at all
        XCTAssertFalse(state.isDataFresh(at: referenceDate, ttl: 3600))

        // Synced recently
        state.recordSync(timestamp: referenceDate, version: 1)
        XCTAssertTrue(state.isDataFresh(at: referenceDate.addingTimeInterval(1800), ttl: 3600))

        // Stale
        XCTAssertFalse(state.isDataFresh(at: referenceDate.addingTimeInterval(7200), ttl: 3600))
    }

    // MARK: - WatchSyncMessageType

    func testSyncMessageTypeRoundTrips() {
        XCTAssertEqual(WatchSyncMessageType(rawValue: "event_sync"), .eventSync)
        XCTAssertEqual(WatchSyncMessageType(rawValue: "sync_request"), .syncRequest)
        XCTAssertEqual(WatchSyncMessageType(rawValue: "complication_update"), .complicationUpdate)
    }

    func testSyncMessageTypeInvalidReturnsNil() {
        XCTAssertNil(WatchSyncMessageType(rawValue: "unknown"))
    }
}

// MARK: - Integration: Full encode-transfer-decode cycle

final class WatchConnectivityIntegrationTests: XCTestCase {

    let referenceDate = ISO8601DateFormatter().date(from: "2026-02-15T10:00:00Z")!
    let calendar: Calendar = {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        return cal
    }()

    func makeEvent(
        id: String,
        title: String,
        startHour: Int,
        durationMinutes: Int = 60,
        isAllDay: Bool = false,
        location: String? = nil,
        accountId: String = "acc_01"
    ) -> WidgetEventData {
        var components = DateComponents()
        components.year = 2026
        components.month = 2
        components.day = 15
        components.hour = startHour
        components.timeZone = TimeZone(identifier: "UTC")

        let start = calendar.date(from: components)!
        let end = start.addingTimeInterval(TimeInterval(durationMinutes * 60))

        return WidgetEventData(
            eventId: id, title: title, accountId: accountId,
            startDate: start, endDate: end,
            isAllDay: isAllDay, location: location
        )
    }

    /// Full integration: iPhone creates payload -> encodes -> simulated transfer -> Watch decodes -> computes complications
    func testFullSyncCycleFromPhoneToWatch() throws {
        // 1. iPhone side: create events and payload
        let phoneEvents = [
            makeEvent(id: "e1", title: "Morning Standup", startHour: 9),
            makeEvent(id: "e2", title: "Design Review", startHour: 11, location: "Zoom"),
            makeEvent(id: "e3", title: "Sprint Planning", startHour: 14, durationMinutes: 90),
            makeEvent(id: "allday", title: "Company Holiday", startHour: 0, durationMinutes: 1440, isAllDay: true),
        ]

        let payload = WatchSyncPayload(
            events: phoneEvents,
            syncTimestamp: referenceDate,
            syncVersion: 42
        )

        // 2. Encode for transfer (simulates WCSession.sendMessage)
        let transferDict = try payload.toDictionary()

        // Verify it's a valid WCSession-compatible dictionary (all values must be plist-compatible)
        XCTAssertTrue(transferDict["events_data"] is Data)
        XCTAssertTrue(transferDict["sync_timestamp"] is Double)
        XCTAssertTrue(transferDict["sync_version"] is Int)
        XCTAssertTrue(transferDict["message_type"] is String)

        // 3. Watch side: decode the payload
        let watchPayload = try WatchSyncPayload.fromDictionary(transferDict)
        XCTAssertEqual(watchPayload.events.count, 4)
        XCTAssertEqual(watchPayload.syncVersion, 42)

        // 4. Watch side: compute complication data from received events
        let circularData = WatchComplicationLogic.complicationData(
            family: .circular,
            events: watchPayload.events,
            referenceDate: referenceDate,
            calendar: calendar
        )
        XCTAssertEqual(circularData.meetingCount, 3, "3 timed meetings today (excluding all-day)")
        XCTAssertNotNil(circularData.nextEventTime, "Next event should exist")

        let rectData = WatchComplicationLogic.complicationData(
            family: .rectangular,
            events: watchPayload.events,
            referenceDate: referenceDate,
            calendar: calendar
        )
        XCTAssertEqual(rectData.nextEventTitle, "Design Review")
        XCTAssertGreaterThan(rectData.freeTimeMinutes, 0)

        // 5. Watch side: update sync state
        var syncState = WatchSyncState()
        syncState.recordSync(timestamp: watchPayload.syncTimestamp, version: watchPayload.syncVersion)
        XCTAssertTrue(syncState.isSynced)
        XCTAssertEqual(syncState.syncVersion, 42)
    }

    /// Integration: payload with many events (stress test the encoding)
    func testPayloadWithManyEvents() throws {
        let events = (0..<50).map { i in
            makeEvent(
                id: "e\(i)",
                title: "Event \(i)",
                startHour: i % 24,
                accountId: "acc_\(i % 5)"
            )
        }

        let payload = WatchSyncPayload(
            events: events,
            syncTimestamp: referenceDate,
            syncVersion: 1
        )

        let encoded = try payload.toDictionary()
        let decoded = try WatchSyncPayload.fromDictionary(encoded)

        XCTAssertEqual(decoded.events.count, 50)

        // Verify data integrity for a few random events
        XCTAssertEqual(decoded.events[0].eventId, "e0")
        XCTAssertEqual(decoded.events[25].eventId, "e25")
        XCTAssertEqual(decoded.events[49].eventId, "e49")
    }

    /// Integration: complication data after receiving an empty sync
    func testComplicationDataAfterEmptySync() throws {
        let payload = WatchSyncPayload(
            events: [],
            syncTimestamp: referenceDate,
            syncVersion: 1
        )

        let encoded = try payload.toDictionary()
        let decoded = try WatchSyncPayload.fromDictionary(encoded)

        let data = WatchComplicationLogic.complicationData(
            family: .rectangular,
            events: decoded.events,
            referenceDate: referenceDate,
            calendar: calendar
        )

        XCTAssertNil(data.nextEventTitle)
        XCTAssertNil(data.nextEventTime)
        XCTAssertEqual(data.meetingCount, 0)
        XCTAssertEqual(data.freeTimeMinutes, 840) // Full remainder of day
    }

    /// Integration: verify UserInfo context (used for background complication updates)
    func testUserInfoContextForComplicationUpdate() throws {
        let events = [
            makeEvent(id: "e1", title: "Next Meeting", startHour: 11),
        ]

        let payload = WatchSyncPayload(
            events: events,
            syncTimestamp: referenceDate,
            syncVersion: 7
        )

        // transferUserInfo sends [String: Any] -- verify compatibility
        let dict = try payload.toDictionary()

        // All keys must be strings (dict is [String: Any], so verify non-empty)
        XCTAssertFalse(dict.keys.isEmpty, "Dictionary must have keys for WCSession")

        // Values must be plist-compatible types
        XCTAssertTrue(dict["message_type"] is String)
        XCTAssertTrue(dict["events_data"] is Data)
        XCTAssertTrue(dict["sync_timestamp"] is Double)
        XCTAssertTrue(dict["sync_version"] is Int)
    }
}
