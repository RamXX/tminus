// OfflineQueueTests.swift
// T-Minus iOS Tests -- Unit tests for the offline operation queue.

import XCTest
@testable import TMinusLib

final class OfflineQueueTests: XCTestCase {

    var defaults: UserDefaults!
    var queue: OfflineQueue!

    override func setUp() {
        super.setUp()
        // Use a unique suite for test isolation
        defaults = UserDefaults(suiteName: "test_offline_queue_\(UUID().uuidString)")!
        queue = OfflineQueue(defaults: defaults, storageKey: "test_queue")
    }

    override func tearDown() {
        queue.clear()
        super.tearDown()
    }

    // MARK: - Enqueue / Dequeue

    func testEnqueueAndDequeue() {
        let op = makeOperation(id: "op_1")
        queue.enqueue(op)

        XCTAssertEqual(queue.count, 1)

        let dequeued = queue.dequeue()
        XCTAssertEqual(dequeued?.id, "op_1")
        XCTAssertEqual(queue.count, 0)
    }

    func testFIFOOrder() {
        queue.enqueue(makeOperation(id: "op_1"))
        queue.enqueue(makeOperation(id: "op_2"))
        queue.enqueue(makeOperation(id: "op_3"))

        XCTAssertEqual(queue.count, 3)

        XCTAssertEqual(queue.dequeue()?.id, "op_1")
        XCTAssertEqual(queue.dequeue()?.id, "op_2")
        XCTAssertEqual(queue.dequeue()?.id, "op_3")
        XCTAssertNil(queue.dequeue())
    }

    func testDequeueEmptyReturnsNil() {
        XCTAssertNil(queue.dequeue())
    }

    // MARK: - Peek

    func testPeekDoesNotRemove() {
        queue.enqueue(makeOperation(id: "op_1"))

        let peeked = queue.peek()
        XCTAssertEqual(peeked?.id, "op_1")
        XCTAssertEqual(queue.count, 1)  // still there
    }

    func testPeekEmptyReturnsNil() {
        XCTAssertNil(queue.peek())
    }

    // MARK: - Remove by ID

    func testRemoveById() {
        queue.enqueue(makeOperation(id: "op_1"))
        queue.enqueue(makeOperation(id: "op_2"))
        queue.enqueue(makeOperation(id: "op_3"))

        queue.remove(id: "op_2")

        XCTAssertEqual(queue.count, 2)
        let ids = queue.allOperations.map { $0.id }
        XCTAssertFalse(ids.contains("op_2"))
        XCTAssertTrue(ids.contains("op_1"))
        XCTAssertTrue(ids.contains("op_3"))
    }

    func testRemoveNonExistentIdIsNoOp() {
        queue.enqueue(makeOperation(id: "op_1"))
        queue.remove(id: "op_nonexistent")
        XCTAssertEqual(queue.count, 1)
    }

    // MARK: - Retry Count

    func testUpdateRetryCount() {
        queue.enqueue(makeOperation(id: "op_1"))

        queue.updateRetryCount(id: "op_1", retryCount: 2)

        let op = queue.peek()
        XCTAssertEqual(op?.retryCount, 2)
    }

    func testUpdateRetryCountNonExistentIsNoOp() {
        queue.enqueue(makeOperation(id: "op_1"))
        queue.updateRetryCount(id: "op_nonexistent", retryCount: 5)
        XCTAssertEqual(queue.peek()?.retryCount, 0)  // unchanged
    }

    // MARK: - Clear

    func testClear() {
        queue.enqueue(makeOperation(id: "op_1"))
        queue.enqueue(makeOperation(id: "op_2"))

        queue.clear()

        XCTAssertEqual(queue.count, 0)
        XCTAssertNil(queue.dequeue())
    }

    // MARK: - All Operations

    func testAllOperationsReturnsAll() {
        queue.enqueue(makeOperation(id: "op_1"))
        queue.enqueue(makeOperation(id: "op_2"))

        let all = queue.allOperations
        XCTAssertEqual(all.count, 2)
    }

    // MARK: - Persistence

    func testPersistsAcrossInstances() {
        queue.enqueue(makeOperation(id: "op_1"))

        // Create a new queue instance with the same storage
        let queue2 = OfflineQueue(defaults: defaults, storageKey: "test_queue")

        XCTAssertEqual(queue2.count, 1)
        XCTAssertEqual(queue2.peek()?.id, "op_1")
    }

    // MARK: - Convenience Constructors

    func testCreateEventConvenience() {
        let request = CreateEventRequest(
            title: "Test Event",
            accountId: "acc_001",
            start: "2026-02-17T10:00:00Z",
            end: "2026-02-17T11:00:00Z",
            allDay: false,
            description: nil,
            location: nil,
            visibility: "default",
            transparency: "opaque"
        )

        let op = PendingOperation.createEvent(request)

        XCTAssertNotNil(op)
        XCTAssertEqual(op?.type, .createEvent)
        XCTAssertEqual(op?.retryCount, 0)
        XCTAssertFalse(op!.id.isEmpty)

        // Verify payload can be decoded back
        let decoded = try? JSONDecoder().decode(CreateEventRequest.self, from: op!.payload)
        XCTAssertEqual(decoded?.title, "Test Event")
        XCTAssertEqual(decoded?.accountId, "acc_001")
    }

    func testCommitCandidateConvenience() {
        let request = CommitCandidateRequest(
            sessionId: "sched_001",
            candidateId: "cand_001",
            accountId: "acc_001"
        )

        let op = PendingOperation.commitCandidate(request)

        XCTAssertNotNil(op)
        XCTAssertEqual(op?.type, .commitCandidate)
        XCTAssertEqual(op?.retryCount, 0)

        let decoded = try? JSONDecoder().decode(CommitCandidateRequest.self, from: op!.payload)
        XCTAssertEqual(decoded?.sessionId, "sched_001")
        XCTAssertEqual(decoded?.candidateId, "cand_001")
    }

    // MARK: - Max Retries Constant

    func testMaxRetriesIsThree() {
        XCTAssertEqual(PendingOperation.maxRetries, 3)
    }

    // MARK: - Helpers

    private func makeOperation(
        id: String,
        type: OfflineOperationType = .createEvent,
        retryCount: Int = 0
    ) -> PendingOperation {
        PendingOperation(
            id: id,
            type: type,
            payload: "{}".data(using: .utf8)!,
            createdAt: Date(),
            retryCount: retryCount
        )
    }
}
