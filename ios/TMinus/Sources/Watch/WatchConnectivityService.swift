// WatchConnectivityService.swift
// T-Minus iOS -- Data sync protocol between iPhone and Apple Watch.
//
// This file defines the data transfer types and serialization for
// WatchConnectivity-based sync. The actual WCSession delegate lives in
// platform-specific code (guarded by #if canImport(WatchConnectivity)).
//
// Architecture:
// - WatchSyncPayload: the data packet sent from iPhone to Watch
// - WatchSyncState: tracks sync currency on the watch side
// - WatchSyncMessageType: discriminator for different message kinds
// - WatchSyncError: typed errors for sync failures
//
// All types are framework-independent and fully testable via `swift test`.

import Foundation

// MARK: - Sync Errors

/// Errors that can occur during watch sync operations.
enum WatchSyncError: Error, Equatable {
    /// The dictionary received from WCSession is missing required keys.
    case missingRequiredKey(String)

    /// The events data could not be decoded from the payload.
    case decodingFailed(String)

    /// The session is not reachable (watch not connected, app not installed).
    case sessionNotReachable

    /// A sync is already in progress.
    case syncInProgress
}

// MARK: - Message Types

/// Discriminator for the type of message sent via WCSession.
/// Encoded as a string in the message dictionary under the "message_type" key.
enum WatchSyncMessageType: String, CaseIterable {
    /// iPhone -> Watch: full event data sync.
    case eventSync = "event_sync"

    /// Watch -> iPhone: request a fresh sync of event data.
    case syncRequest = "sync_request"

    /// iPhone -> Watch: targeted complication data update (via transferCurrentComplicationUserInfo).
    case complicationUpdate = "complication_update"
}

// MARK: - Sync Payload

/// The data packet transferred from iPhone to Apple Watch.
/// Designed for WCSession's `sendMessage(_:)` and `transferUserInfo(_:)`.
///
/// Encoding: events are JSON-encoded into Data (stored under "events_data"),
/// with scalar metadata as top-level dictionary keys. This keeps the payload
/// compatible with WCSession's [String: Any] dictionary requirement.
struct WatchSyncPayload {
    /// The events to display on the watch.
    let events: [WidgetEventData]

    /// When this payload was created (for freshness checks on the watch).
    let syncTimestamp: Date

    /// Monotonically increasing version for ordering out-of-order deliveries.
    let syncVersion: Int

    /// The message type (defaults to .eventSync).
    let messageType: WatchSyncMessageType

    init(
        events: [WidgetEventData],
        syncTimestamp: Date = Date(),
        syncVersion: Int = 1,
        messageType: WatchSyncMessageType = .eventSync
    ) {
        self.events = events
        self.syncTimestamp = syncTimestamp
        self.syncVersion = syncVersion
        self.messageType = messageType
    }

    // MARK: - Encoding (iPhone side)

    /// Encode to a WCSession-compatible [String: Any] dictionary.
    /// Events are JSON-serialized into a Data blob stored under "events_data".
    func toDictionary() throws -> [String: Any] {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970

        let eventsData = try encoder.encode(events)

        return [
            "message_type": messageType.rawValue,
            "events_data": eventsData,
            "sync_timestamp": syncTimestamp.timeIntervalSince1970,
            "sync_version": syncVersion,
        ]
    }

    // MARK: - Decoding (Watch side)

    /// Decode from a WCSession message dictionary.
    static func fromDictionary(_ dict: [String: Any]) throws -> WatchSyncPayload {
        guard let eventsData = dict["events_data"] as? Data else {
            throw WatchSyncError.missingRequiredKey("events_data")
        }

        guard let timestampValue = dict["sync_timestamp"] as? Double else {
            throw WatchSyncError.missingRequiredKey("sync_timestamp")
        }

        guard let versionValue = dict["sync_version"] as? Int else {
            throw WatchSyncError.missingRequiredKey("sync_version")
        }

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970

        let events: [WidgetEventData]
        do {
            events = try decoder.decode([WidgetEventData].self, from: eventsData)
        } catch {
            throw WatchSyncError.decodingFailed(error.localizedDescription)
        }

        let messageTypeRaw = dict["message_type"] as? String ?? WatchSyncMessageType.eventSync.rawValue
        let messageType = WatchSyncMessageType(rawValue: messageTypeRaw) ?? .eventSync

        return WatchSyncPayload(
            events: events,
            syncTimestamp: Date(timeIntervalSince1970: timestampValue),
            syncVersion: versionValue,
            messageType: messageType
        )
    }
}

// MARK: - Sync State

/// Tracks the sync currency on the watch side.
/// Used to determine if complication data is fresh or stale.
struct WatchSyncState {
    /// When the last successful sync occurred, or nil if never synced.
    private(set) var lastSyncTimestamp: Date?

    /// The version of the last synced payload.
    private(set) var syncVersion: Int = 0

    /// Whether any sync has occurred.
    var isSynced: Bool { lastSyncTimestamp != nil }

    /// Record a successful sync.
    mutating func recordSync(timestamp: Date, version: Int) {
        lastSyncTimestamp = timestamp
        syncVersion = version
    }

    /// Whether the synced data is still within the given TTL.
    func isDataFresh(at now: Date = Date(), ttl: TimeInterval = 3600) -> Bool {
        guard let lastSync = lastSyncTimestamp else { return false }
        return now.timeIntervalSince(lastSync) <= ttl
    }
}

// MARK: - WatchConnectivity Session Delegate (platform-guarded)

#if canImport(WatchConnectivity)
import WatchConnectivity

/// Protocol for receiving watch sync events.
/// Implemented by the watch app's view model or data layer.
protocol WatchSyncDelegate: AnyObject {
    /// Called when new event data is received from the iPhone.
    func didReceiveEventSync(_ payload: WatchSyncPayload)

    /// Called when a sync error occurs.
    func didFailSync(error: WatchSyncError)
}

/// Manages the WCSession lifecycle and delegates sync events.
/// Create one instance in the app's entry point and keep it alive.
final class WatchConnectivityManager: NSObject, WCSessionDelegate {
    static let shared = WatchConnectivityManager()

    weak var delegate: WatchSyncDelegate?

    private let session: WCSession

    override init() {
        self.session = WCSession.default
        super.init()
    }

    /// Activate the WCSession. Call once at app launch.
    func activate() {
        guard WCSession.isSupported() else { return }
        session.delegate = self
        session.activate()
    }

    /// Send event data to the watch (iPhone side).
    func sendEvents(_ events: [WidgetEventData], version: Int) throws {
        let payload = WatchSyncPayload(events: events, syncVersion: version)
        let dict = try payload.toDictionary()

        if session.isReachable {
            session.sendMessage(dict, replyHandler: nil, errorHandler: nil)
        } else {
            // Use transferUserInfo for background delivery
            session.transferUserInfo(dict)
        }
    }

    /// Send complication data update (uses transferCurrentComplicationUserInfo for priority delivery).
    func sendComplicationUpdate(_ events: [WidgetEventData], version: Int) throws {
        let payload = WatchSyncPayload(
            events: events,
            syncVersion: version,
            messageType: .complicationUpdate
        )
        let dict = try payload.toDictionary()

        #if os(iOS)
        if session.isComplicationEnabled {
            session.transferCurrentComplicationUserInfo(dict)
        } else {
            session.transferUserInfo(dict)
        }
        #else
        session.transferUserInfo(dict)
        #endif
    }

    /// Request a sync from the watch side.
    func requestSync() {
        guard session.isReachable else {
            delegate?.didFailSync(error: .sessionNotReachable)
            return
        }

        let message: [String: Any] = [
            "message_type": WatchSyncMessageType.syncRequest.rawValue
        ]
        session.sendMessage(message, replyHandler: nil, errorHandler: nil)
    }

    // MARK: - WCSessionDelegate

    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        // Activation complete -- no action needed unless there's an error
    }

    #if os(iOS)
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) {
        // Re-activate for watch switching support
        session.activate()
    }
    #endif

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        handleIncomingMessage(message)
    }

    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        handleIncomingMessage(userInfo)
    }

    private func handleIncomingMessage(_ message: [String: Any]) {
        guard let typeRaw = message["message_type"] as? String,
              let messageType = WatchSyncMessageType(rawValue: typeRaw) else {
            return
        }

        switch messageType {
        case .eventSync, .complicationUpdate:
            do {
                let payload = try WatchSyncPayload.fromDictionary(message)
                delegate?.didReceiveEventSync(payload)
            } catch let error as WatchSyncError {
                delegate?.didFailSync(error: error)
            } catch {
                delegate?.didFailSync(error: .decodingFailed(error.localizedDescription))
            }

        case .syncRequest:
            // Watch requested a sync -- handled by the phone's CalendarViewModel
            // which observes this via NotificationCenter or delegate pattern.
            NotificationCenter.default.post(
                name: .watchRequestedSync,
                object: nil
            )
        }
    }
}

// MARK: - Notification Names

extension Notification.Name {
    /// Posted when the Apple Watch requests a data sync.
    static let watchRequestedSync = Notification.Name("com.tminus.watchRequestedSync")
}
#endif
