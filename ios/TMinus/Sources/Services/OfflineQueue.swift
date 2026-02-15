// OfflineQueue.swift
// T-Minus iOS -- Offline operation queue for poor connectivity.
//
// Stores pending API operations (event creation, scheduling commits) in
// UserDefaults as JSON. When connectivity returns, the queue is drained
// in FIFO order. Failed operations are retried up to maxRetries times.
//
// Design:
// - Operations are Codable structs stored as a JSON array
// - Each operation has a unique ID, type, payload, and retry count
// - Queue is atomic: load-modify-save on each mutation
// - Thread safety: callers must serialize access (view model is @MainActor)

import Foundation

// MARK: - Operation Types

/// The kind of pending operation stored in the offline queue.
enum OfflineOperationType: String, Codable, Equatable {
    case createEvent
    case commitCandidate
}

/// A pending operation waiting to be sent to the API.
struct PendingOperation: Codable, Identifiable, Equatable {
    let id: String
    let type: OfflineOperationType
    let payload: Data  // JSON-encoded request body
    let createdAt: Date
    var retryCount: Int

    /// Maximum number of retry attempts before the operation is discarded.
    static let maxRetries = 3
}

// MARK: - Protocol

/// Protocol for the offline queue, enabling test mocking.
protocol OfflineQueueProtocol {
    func enqueue(_ operation: PendingOperation)
    func dequeue() -> PendingOperation?
    func peek() -> PendingOperation?
    func remove(id: String)
    func updateRetryCount(id: String, retryCount: Int)
    var count: Int { get }
    var allOperations: [PendingOperation] { get }
    func clear()
}

// MARK: - Implementation

/// UserDefaults-backed offline operation queue.
final class OfflineQueue: OfflineQueueProtocol {

    private let defaults: UserDefaults
    private let storageKey: String

    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .secondsSince1970
        return e
    }()

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .secondsSince1970
        return d
    }()

    init(
        defaults: UserDefaults = .standard,
        storageKey: String = "tminus_offline_queue"
    ) {
        self.defaults = defaults
        self.storageKey = storageKey
    }

    /// Add an operation to the end of the queue.
    func enqueue(_ operation: PendingOperation) {
        var ops = loadOperations()
        ops.append(operation)
        saveOperations(ops)
    }

    /// Remove and return the first operation in the queue.
    func dequeue() -> PendingOperation? {
        var ops = loadOperations()
        guard !ops.isEmpty else { return nil }
        let first = ops.removeFirst()
        saveOperations(ops)
        return first
    }

    /// Return the first operation without removing it.
    func peek() -> PendingOperation? {
        return loadOperations().first
    }

    /// Remove a specific operation by ID.
    func remove(id: String) {
        var ops = loadOperations()
        ops.removeAll { $0.id == id }
        saveOperations(ops)
    }

    /// Update the retry count for a specific operation.
    func updateRetryCount(id: String, retryCount: Int) {
        var ops = loadOperations()
        if let index = ops.firstIndex(where: { $0.id == id }) {
            ops[index].retryCount = retryCount
            saveOperations(ops)
        }
    }

    /// Number of pending operations.
    var count: Int {
        loadOperations().count
    }

    /// All pending operations (for inspection/display).
    var allOperations: [PendingOperation] {
        loadOperations()
    }

    /// Remove all pending operations.
    func clear() {
        defaults.removeObject(forKey: storageKey)
    }

    // MARK: - Storage

    private func loadOperations() -> [PendingOperation] {
        guard let data = defaults.data(forKey: storageKey) else { return [] }
        return (try? decoder.decode([PendingOperation].self, from: data)) ?? []
    }

    private func saveOperations(_ operations: [PendingOperation]) {
        guard let data = try? encoder.encode(operations) else { return }
        defaults.set(data, forKey: storageKey)
    }
}

// MARK: - Convenience

extension PendingOperation {

    /// Create a pending event creation operation.
    static func createEvent(_ request: CreateEventRequest) -> PendingOperation? {
        let encoder = JSONEncoder()
        guard let payload = try? encoder.encode(request) else { return nil }
        return PendingOperation(
            id: UUID().uuidString,
            type: .createEvent,
            payload: payload,
            createdAt: Date(),
            retryCount: 0
        )
    }

    /// Create a pending commit candidate operation.
    static func commitCandidate(_ request: CommitCandidateRequest) -> PendingOperation? {
        let encoder = JSONEncoder()
        guard let payload = try? encoder.encode(request) else { return nil }
        return PendingOperation(
            id: UUID().uuidString,
            type: .commitCandidate,
            payload: payload,
            createdAt: Date(),
            retryCount: 0
        )
    }
}
