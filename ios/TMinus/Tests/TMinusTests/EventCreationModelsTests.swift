// EventCreationModelsTests.swift
// T-Minus iOS Tests -- Encoding/decoding tests for event creation and scheduling models.

import XCTest
@testable import TMinusLib

final class EventCreationModelsTests: XCTestCase {

    let encoder = JSONEncoder()
    let decoder = JSONDecoder()

    // MARK: - CreateEventRequest

    func testCreateEventRequestEncoding() throws {
        let request = CreateEventRequest(
            title: "Team Sync",
            accountId: "acc_001",
            start: "2026-02-17T10:00:00Z",
            end: "2026-02-17T11:00:00Z",
            allDay: false,
            description: "Weekly team sync",
            location: "Room 101",
            visibility: "default",
            transparency: "opaque"
        )

        let data = try encoder.encode(request)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(json["title"] as? String, "Team Sync")
        XCTAssertEqual(json["account_id"] as? String, "acc_001")
        XCTAssertEqual(json["start"] as? String, "2026-02-17T10:00:00Z")
        XCTAssertEqual(json["end"] as? String, "2026-02-17T11:00:00Z")
        XCTAssertEqual(json["all_day"] as? Bool, false)
        XCTAssertEqual(json["description"] as? String, "Weekly team sync")
        XCTAssertEqual(json["location"] as? String, "Room 101")
        XCTAssertEqual(json["visibility"] as? String, "default")
        XCTAssertEqual(json["transparency"] as? String, "opaque")
    }

    func testCreateEventRequestRoundTrip() throws {
        let original = CreateEventRequest(
            title: "Lunch",
            accountId: "acc_002",
            start: "2026-02-17T12:00:00Z",
            end: "2026-02-17T13:00:00Z",
            allDay: false,
            description: nil,
            location: nil,
            visibility: "private",
            transparency: "transparent"
        )

        let data = try encoder.encode(original)
        let decoded = try decoder.decode(CreateEventRequest.self, from: data)

        XCTAssertEqual(decoded, original)
    }

    // MARK: - CreateEventResponse

    func testCreateEventResponseDecoding() throws {
        let json = """
        {
            "canonical_event_id": "evt_new_001",
            "origin_event_id": "google_evt_new_001"
        }
        """.data(using: .utf8)!

        let response = try decoder.decode(CreateEventResponse.self, from: json)

        XCTAssertEqual(response.canonicalEventId, "evt_new_001")
        XCTAssertEqual(response.originEventId, "google_evt_new_001")
    }

    // MARK: - ProposeTimesRequest

    func testProposeTimesRequestEncoding() throws {
        let constraints = SchedulingConstraints(
            preferMorning: true,
            preferAfternoon: nil,
            avoidBackToBack: true,
            minimumNotice: 2
        )
        let request = ProposeTimesRequest(
            title: "1:1 Meeting",
            durationMinutes: 30,
            participants: ["alice@example.com"],
            constraints: constraints
        )

        let data = try encoder.encode(request)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(json["title"] as? String, "1:1 Meeting")
        XCTAssertEqual(json["duration_minutes"] as? Int, 30)
        XCTAssertEqual(json["participants"] as? [String], ["alice@example.com"])

        let constraintsJson = json["constraints"] as? [String: Any]
        XCTAssertEqual(constraintsJson?["prefer_morning"] as? Bool, true)
        XCTAssertEqual(constraintsJson?["avoid_back_to_back"] as? Bool, true)
        XCTAssertEqual(constraintsJson?["minimum_notice"] as? Int, 2)
    }

    func testProposeTimesRequestWithNilConstraints() throws {
        let request = ProposeTimesRequest(
            title: "Quick Chat",
            durationMinutes: 15,
            participants: nil,
            constraints: nil
        )

        let data = try encoder.encode(request)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(json["title"] as? String, "Quick Chat")
        XCTAssertEqual(json["duration_minutes"] as? Int, 15)
    }

    // MARK: - SchedulingCandidate

    func testSchedulingCandidateDecoding() throws {
        let json = """
        {
            "candidate_id": "cand_001",
            "start": "2026-02-17T09:00:00Z",
            "end": "2026-02-17T09:30:00Z",
            "score": 0.95,
            "reason": "Best available morning slot"
        }
        """.data(using: .utf8)!

        let candidate = try decoder.decode(SchedulingCandidate.self, from: json)

        XCTAssertEqual(candidate.candidateId, "cand_001")
        XCTAssertEqual(candidate.start, "2026-02-17T09:00:00Z")
        XCTAssertEqual(candidate.end, "2026-02-17T09:30:00Z")
        XCTAssertEqual(candidate.score, 0.95)
        XCTAssertEqual(candidate.reason, "Best available morning slot")
        XCTAssertEqual(candidate.id, "cand_001")
    }

    func testSchedulingCandidateDateParsing() throws {
        let json = """
        {
            "candidate_id": "cand_001",
            "start": "2026-02-17T09:00:00Z",
            "end": "2026-02-17T09:30:00Z",
            "score": 0.9,
            "reason": null
        }
        """.data(using: .utf8)!

        let candidate = try decoder.decode(SchedulingCandidate.self, from: json)

        XCTAssertNotNil(candidate.startDate)
        XCTAssertNotNil(candidate.endDate)
        XCTAssertNil(candidate.reason)
    }

    // MARK: - ProposeTimesResponse

    func testProposeTimesResponseDecoding() throws {
        let json = """
        {
            "session_id": "sched_001",
            "candidates": [
                {
                    "candidate_id": "cand_001",
                    "start": "2026-02-17T09:00:00Z",
                    "end": "2026-02-17T09:30:00Z",
                    "score": 0.95,
                    "reason": "Best slot"
                },
                {
                    "candidate_id": "cand_002",
                    "start": "2026-02-17T14:00:00Z",
                    "end": "2026-02-17T14:30:00Z",
                    "score": 0.82,
                    "reason": null
                }
            ]
        }
        """.data(using: .utf8)!

        let response = try decoder.decode(ProposeTimesResponse.self, from: json)

        XCTAssertEqual(response.sessionId, "sched_001")
        XCTAssertEqual(response.candidates.count, 2)
        XCTAssertEqual(response.candidates[0].candidateId, "cand_001")
        XCTAssertEqual(response.candidates[1].candidateId, "cand_002")
    }

    // MARK: - CommitCandidateRequest

    func testCommitCandidateRequestEncoding() throws {
        let request = CommitCandidateRequest(
            sessionId: "sched_001",
            candidateId: "cand_001",
            accountId: "acc_001"
        )

        let data = try encoder.encode(request)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(json["session_id"] as? String, "sched_001")
        XCTAssertEqual(json["candidate_id"] as? String, "cand_001")
        XCTAssertEqual(json["account_id"] as? String, "acc_001")
    }

    func testCommitCandidateRequestRoundTrip() throws {
        let original = CommitCandidateRequest(
            sessionId: "sched_002",
            candidateId: "cand_003",
            accountId: "acc_002"
        )

        let data = try encoder.encode(original)
        let decoded = try decoder.decode(CommitCandidateRequest.self, from: data)

        XCTAssertEqual(decoded, original)
    }

    // MARK: - CommitCandidateResponse

    func testCommitCandidateResponseDecoding() throws {
        let json = """
        {
            "canonical_event_id": "evt_committed_001",
            "origin_event_id": "google_evt_committed_001"
        }
        """.data(using: .utf8)!

        let response = try decoder.decode(CommitCandidateResponse.self, from: json)

        XCTAssertEqual(response.canonicalEventId, "evt_committed_001")
        XCTAssertEqual(response.originEventId, "google_evt_committed_001")
    }

    // MARK: - SchedulingConstraints

    func testSchedulingConstraintsRoundTrip() throws {
        let original = SchedulingConstraints(
            preferMorning: true,
            preferAfternoon: false,
            avoidBackToBack: true,
            minimumNotice: 4
        )

        let data = try encoder.encode(original)
        let decoded = try decoder.decode(SchedulingConstraints.self, from: data)

        XCTAssertEqual(decoded, original)
    }

    func testSchedulingConstraintsAllNils() throws {
        let original = SchedulingConstraints(
            preferMorning: nil,
            preferAfternoon: nil,
            avoidBackToBack: nil,
            minimumNotice: nil
        )

        let data = try encoder.encode(original)
        let decoded = try decoder.decode(SchedulingConstraints.self, from: data)

        XCTAssertEqual(decoded, original)
        XCTAssertNil(decoded.preferMorning)
        XCTAssertNil(decoded.preferAfternoon)
        XCTAssertNil(decoded.avoidBackToBack)
        XCTAssertNil(decoded.minimumNotice)
    }

    // MARK: - API Envelope Integration

    func testCreateEventResponseInEnvelope() throws {
        let json = """
        {
            "ok": true,
            "data": {
                "canonical_event_id": "evt_001",
                "origin_event_id": "google_001"
            },
            "error": null,
            "meta": {
                "request_id": "req_123",
                "timestamp": "2026-02-17T10:00:00Z"
            }
        }
        """.data(using: .utf8)!

        let envelope = try decoder.decode(APIEnvelope<CreateEventResponse>.self, from: json)

        XCTAssertTrue(envelope.ok)
        XCTAssertEqual(envelope.data?.canonicalEventId, "evt_001")
        XCTAssertEqual(envelope.data?.originEventId, "google_001")
        XCTAssertNil(envelope.error)
    }

    func testProposeTimesResponseInEnvelope() throws {
        let json = """
        {
            "ok": true,
            "data": {
                "session_id": "sched_001",
                "candidates": [
                    {
                        "candidate_id": "c1",
                        "start": "2026-02-17T09:00:00Z",
                        "end": "2026-02-17T09:30:00Z",
                        "score": 0.9,
                        "reason": "Good"
                    }
                ]
            },
            "error": null,
            "meta": {
                "request_id": "req_456",
                "timestamp": "2026-02-17T10:00:00Z"
            }
        }
        """.data(using: .utf8)!

        let envelope = try decoder.decode(APIEnvelope<ProposeTimesResponse>.self, from: json)

        XCTAssertTrue(envelope.ok)
        XCTAssertEqual(envelope.data?.sessionId, "sched_001")
        XCTAssertEqual(envelope.data?.candidates.count, 1)
    }
}
