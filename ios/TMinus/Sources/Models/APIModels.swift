// APIModels.swift
// T-Minus iOS -- Domain models matching the T-Minus API response shapes.
//
// These types decode the API envelope format:
//   { ok: bool, data: T, error?: string, meta: { request_id, timestamp, next_cursor? } }

import Foundation

// MARK: - API Envelope

/// Standard API response envelope from T-Minus backend.
struct APIEnvelope<T: Decodable>: Decodable {
    let ok: Bool
    let data: T?
    let error: String?
    let meta: APIMeta
}

/// Metadata included in every API response.
struct APIMeta: Decodable {
    let requestId: String
    let timestamp: String
    let nextCursor: String?

    enum CodingKeys: String, CodingKey {
        case requestId = "request_id"
        case timestamp
        case nextCursor = "next_cursor"
    }
}

// MARK: - Auth

/// Request body for POST /v1/auth/login.
struct LoginRequest: Encodable {
    let email: String
    let password: String
}

/// Response data from login/register/refresh endpoints.
struct AuthResponse: Decodable {
    let token: String
    let refreshToken: String
    let user: AuthUser

    enum CodingKeys: String, CodingKey {
        case token
        case refreshToken = "refresh_token"
        case user
    }
}

/// User info returned in auth responses.
struct AuthUser: Decodable {
    let id: String
    let email: String
    let tier: String
}

/// Request body for POST /v1/auth/refresh.
struct RefreshRequest: Encodable {
    let refreshToken: String

    enum CodingKeys: String, CodingKey {
        case refreshToken = "refresh_token"
    }
}

// MARK: - Events

/// Date/time for an event -- either a dateTime (point in time) or date (all-day).
struct EventDateTime: Decodable, Equatable {
    let dateTime: String?
    let date: String?
    let timeZone: String?
}

/// A canonical event from the T-Minus unified calendar store.
/// Maps to the CanonicalEvent type in @tminus/shared.
struct CanonicalEvent: Decodable, Identifiable, Equatable {
    let canonicalEventId: String
    let originAccountId: String
    let originEventId: String
    let title: String?
    let description: String?
    let location: String?
    let start: EventDateTime
    let end: EventDateTime
    let allDay: Bool
    let status: String
    let visibility: String
    let transparency: String
    let recurrenceRule: String?
    let source: String
    let version: Int
    let createdAt: String
    let updatedAt: String

    var id: String { canonicalEventId }

    enum CodingKeys: String, CodingKey {
        case canonicalEventId = "canonical_event_id"
        case originAccountId = "origin_account_id"
        case originEventId = "origin_event_id"
        case title, description, location, start, end
        case allDay = "all_day"
        case status, visibility, transparency
        case recurrenceRule = "recurrence_rule"
        case source, version
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    /// Resolved start date, parsing either dateTime or date field.
    var startDate: Date? {
        if let dt = start.dateTime {
            return ISO8601DateFormatter().date(from: dt)
                ?? DateFormatter.flexibleISO8601.date(from: dt)
        }
        if let d = start.date {
            let fmt = DateFormatter()
            fmt.dateFormat = "yyyy-MM-dd"
            fmt.timeZone = TimeZone(identifier: "UTC")
            return fmt.date(from: d)
        }
        return nil
    }

    /// Resolved end date.
    var endDate: Date? {
        if let dt = end.dateTime {
            return ISO8601DateFormatter().date(from: dt)
                ?? DateFormatter.flexibleISO8601.date(from: dt)
        }
        if let d = end.date {
            let fmt = DateFormatter()
            fmt.dateFormat = "yyyy-MM-dd"
            fmt.timeZone = TimeZone(identifier: "UTC")
            return fmt.date(from: d)
        }
        return nil
    }

    /// Display-friendly time string.
    var timeDisplayString: String {
        guard let s = startDate else { return "" }
        if allDay { return "All day" }
        let fmt = DateFormatter()
        fmt.timeStyle = .short
        fmt.dateStyle = .none
        return fmt.string(from: s)
    }
}

// MARK: - Accounts

/// A linked calendar account.
struct CalendarAccount: Decodable, Identifiable, Equatable {
    let accountId: String
    let provider: String
    let email: String
    let displayName: String?
    let status: String

    var id: String { accountId }

    enum CodingKeys: String, CodingKey {
        case accountId = "account_id"
        case provider, email
        case displayName = "display_name"
        case status
    }
}

// MARK: - Event Creation

/// Request body for POST /v1/events.
struct CreateEventRequest: Codable, Equatable {
    let title: String
    let accountId: String
    let start: String  // ISO 8601
    let end: String    // ISO 8601
    let allDay: Bool
    let description: String?
    let location: String?
    let visibility: String
    let transparency: String

    enum CodingKeys: String, CodingKey {
        case title
        case accountId = "account_id"
        case start, end
        case allDay = "all_day"
        case description, location, visibility, transparency
    }
}

/// Response data from POST /v1/events.
struct CreateEventResponse: Decodable, Equatable {
    let canonicalEventId: String
    let originEventId: String

    enum CodingKeys: String, CodingKey {
        case canonicalEventId = "canonical_event_id"
        case originEventId = "origin_event_id"
    }
}

// MARK: - Scheduling

/// Request body for POST /v1/scheduling/propose.
struct ProposeTimesRequest: Encodable, Equatable {
    let title: String
    let durationMinutes: Int
    let participants: [String]?  // account IDs or email addresses
    let constraints: SchedulingConstraints?

    enum CodingKeys: String, CodingKey {
        case title
        case durationMinutes = "duration_minutes"
        case participants, constraints
    }
}

/// Constraints for scheduling proposals.
struct SchedulingConstraints: Codable, Equatable {
    let preferMorning: Bool?
    let preferAfternoon: Bool?
    let avoidBackToBack: Bool?
    let minimumNotice: Int?  // hours

    enum CodingKeys: String, CodingKey {
        case preferMorning = "prefer_morning"
        case preferAfternoon = "prefer_afternoon"
        case avoidBackToBack = "avoid_back_to_back"
        case minimumNotice = "minimum_notice"
    }
}

/// A scheduling time candidate returned by propose endpoint.
struct SchedulingCandidate: Decodable, Identifiable, Equatable {
    let candidateId: String
    let start: String  // ISO 8601
    let end: String    // ISO 8601
    let score: Double
    let reason: String?

    var id: String { candidateId }

    enum CodingKeys: String, CodingKey {
        case candidateId = "candidate_id"
        case start, end, score, reason
    }

    /// Resolved start date.
    var startDate: Date? {
        ISO8601DateFormatter().date(from: start)
            ?? DateFormatter.flexibleISO8601.date(from: start)
    }

    /// Resolved end date.
    var endDate: Date? {
        ISO8601DateFormatter().date(from: end)
            ?? DateFormatter.flexibleISO8601.date(from: end)
    }
}

/// Response from POST /v1/scheduling/propose.
struct ProposeTimesResponse: Decodable, Equatable {
    let sessionId: String
    let candidates: [SchedulingCandidate]

    enum CodingKeys: String, CodingKey {
        case sessionId = "session_id"
        case candidates
    }
}

/// Request body for POST /v1/scheduling/commit.
struct CommitCandidateRequest: Codable, Equatable {
    let sessionId: String
    let candidateId: String
    let accountId: String

    enum CodingKeys: String, CodingKey {
        case sessionId = "session_id"
        case candidateId = "candidate_id"
        case accountId = "account_id"
    }
}

/// Response from POST /v1/scheduling/commit.
struct CommitCandidateResponse: Decodable, Equatable {
    let canonicalEventId: String
    let originEventId: String

    enum CodingKeys: String, CodingKey {
        case canonicalEventId = "canonical_event_id"
        case originEventId = "origin_event_id"
    }
}

// MARK: - Helpers

extension DateFormatter {
    /// Handles ISO 8601 dates with fractional seconds (common from JS backends).
    static let flexibleISO8601: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSZ"
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()
}
