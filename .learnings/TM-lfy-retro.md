# Retrospective: Epic TM-lfy - Phase 5C: Mobile

**Date:** 2026-02-15
**Stories completed:** 6
**Duration:** 1 day
**Total tests delivered:** 335 (0 failures)

## Summary

Phase 5C delivered a complete iOS mobile stack for T-Minus: native SwiftUI app, push notifications, widgets, Apple Watch complications, event creation, and scheduling. All stories delivered with 100% test coverage and zero build warnings. The mobile implementation followed protocol-based DI patterns for testability and used platform guards for cross-platform SPM testing on macOS.

## Raw Learnings Extracted

### From TM-lfy.4 (Apple Watch Complications)
- watchOS 10+ uses WidgetKit for complications (not ClockKit). The accessoryCircular/accessoryRectangular/accessoryInline families replace the old ClockKit families.
- WCSession.sendMessage requires [String: Any] dictionary -- events must be JSON-encoded into Data first (not nested dictionaries).
- Free time calculation requires interval merging to handle overlapping meetings correctly.
- Platform guards (#if os(watchOS), #if canImport(WatchConnectivity)) are essential for SPM test compatibility -- watchOS frameworks are not available on macOS.

### From TM-lfy.5 (Mobile Event Creation and Scheduling)
- Swift 6.1 strict concurrency requires @MainActor on view models that use @Published
- SchedulingConstraints uses nil values (not false) for unset constraints to keep JSON payload clean
- CreateEventRequest needed Codable (not just Encodable) because OfflineQueue serializes/deserializes it

### From TM-lfy.6 (Phase 5C E2E Validation)
- AccountColors hash function can produce collisions for certain account ID strings -- hash-based color assignment with 10 colors and arbitrary string inputs will occasionally collide. Tests should use account IDs known to be distinct rather than asserting uniqueness for arbitrary inputs.
- @MainActor view model tests must use async test methods to properly exercise the @Published property updates.

## Patterns Identified

1. **Platform-specific testing on macOS** - Seen across 3 stories (TM-lfy.1, TM-lfy.4, TM-lfy.5): Swift Package Manager tests run on macOS, but iOS/watchOS frameworks are platform-specific. Requires platform guards (#if os(iOS), #if os(watchOS), #if canImport(...)) for SPM test compatibility.

2. **Codable vs Encodable for serialization** - Seen in 2 stories (TM-lfy.4, TM-lfy.5): Types that get JSON-encoded for wire transmission AND persisted locally (offline queue, WatchConnectivity) need Codable, not just Encodable. OfflineQueue and WCSession both require round-trip serialization.

3. **Swift concurrency strict mode** - Seen in 2 stories (TM-lfy.5, TM-lfy.6): Swift 6.1 strict concurrency checking requires @MainActor on view models with @Published properties, and test methods must be async to properly exercise state updates.

4. **Hash-based color assignment limitations** - Seen in TM-lfy.6: AccountColors uses stable hashing with 10-color palette. With arbitrary string inputs, collisions are inevitable. Tests should use known-distinct IDs rather than asserting uniqueness.

5. **Nil vs false for optional constraints** - Seen in TM-lfy.5: JSON payloads should use nil (omitted keys) for unset optional constraints rather than false, to keep payloads clean and avoid ambiguity.

## Actionable Insights

### [TESTING] Platform guards required for iOS/watchOS SPM tests

**Priority:** Critical

**Context:** Swift Package Manager tests run on macOS during CI and local development, but iOS/watchOS frameworks (UIKit, WatchConnectivity, WidgetKit) are not available on macOS. Without platform guards, tests fail to compile.

**Recommendation:** For all iOS/watchOS-specific code that is exercised by SPM tests:
1. Use #if os(iOS) / #if os(watchOS) guards around platform-specific APIs
2. Use #if canImport(WatchConnectivity) for framework-specific imports
3. Protocol-based DI allows mock implementations for macOS SPM tests
4. Document in story ACs when platform guards are needed (e.g., "Xcode target for iOS, SPM tests on macOS")

**Applies to:** All iOS/watchOS mobile stories that use SPM for testing

**Source stories:** TM-lfy.1, TM-lfy.4, TM-lfy.5

---

### [ARCHITECTURE] Types used in offline queues must be Codable (not just Encodable)

**Priority:** Critical

**Context:** OfflineQueue and WatchConnectivity both serialize types to Data for persistence/transmission and deserialize them on drain/receive. Types marked Encodable-only fail at decode time with runtime errors.

**Recommendation:** For any request/response type that will be:
- Queued for offline retry (OfflineQueue)
- Sent via WatchConnectivity (WCSession)
- Cached locally with round-trip serialization

Mark as `Codable` (not just `Encodable`), even if the API client only encodes them. Add unit tests for round-trip encode/decode to catch this early.

**Applies to:** All API request types used in offline scenarios or cross-device sync

**Source stories:** TM-lfy.4, TM-lfy.5

---

### [SWIFT] Swift 6.1 concurrency: @MainActor on view models with @Published

**Priority:** Important

**Context:** Swift 6.1 strict concurrency mode requires explicit @MainActor annotation on view models that use @Published properties. Without it, compile-time warnings about main-thread access appear. Tests of @MainActor types must be async to properly exercise state updates.

**Recommendation:** For all SwiftUI view models:
1. Add @MainActor to the class definition if it has @Published properties
2. Write test methods as `func testX() async { ... }` for @MainActor types
3. Use `await` when calling view model methods in tests
4. This pattern applies to AuthViewModel, CalendarViewModel, EventFormViewModel, etc.

**Applies to:** All SwiftUI view model stories

**Source stories:** TM-lfy.5, TM-lfy.6

---

### [WATCHOS] watchOS 10+ uses WidgetKit (not ClockKit) for complications

**Priority:** Important

**Context:** Apple deprecated ClockKit in watchOS 10 in favor of WidgetKit-based complications. The old ComplicationFamily enum is replaced by accessoryCircular, accessoryRectangular, accessoryInline widget families.

**Recommendation:** For Apple Watch complication stories:
- Use WidgetKit timeline providers (not ClockKit complication data sources)
- Target watchOS 10+ and use accessory* families
- Document this in D&F for any future watchOS features
- WidgetKit timeline model provides system-managed updates (better power efficiency)

**Applies to:** All Apple Watch complication stories

**Source stories:** TM-lfy.4

---

### [TESTING] Hash-based color assignment with limited palette causes collisions

**Priority:** Nice-to-have

**Context:** AccountColors uses stable hashing with a 10-color palette. With arbitrary string inputs, hash collisions are inevitable. E2E tests that assert color uniqueness for arbitrary account IDs will fail non-deterministically.

**Recommendation:** For testing account color assignment:
- Use known-distinct account IDs in tests (e.g., "account-1", "account-2", not random UUIDs)
- Test stability (same ID always gets same color) rather than uniqueness
- Document that 10-color palette means collisions are expected with many accounts
- If uniqueness is required, expand palette or use per-user color assignment

**Applies to:** Account color coding in mobile UI

**Source stories:** TM-lfy.6

---

### [API] Optional constraints should use nil (not false) in JSON payloads

**Priority:** Nice-to-have

**Context:** SchedulingConstraints has optional Boolean fields. Using false for unset constraints creates ambiguity (is it "explicitly false" or "unset"?) and bloats payloads.

**Recommendation:** For API request types with optional Boolean constraints:
- Use `var field: Bool?` (not `var field: Bool = false`)
- Encode nil as omitted keys (JSON's natural representation of absence)
- Backend should treat missing keys as "constraint not specified"
- Document this pattern in API design guidelines

**Applies to:** All API request types with optional constraint fields

**Source stories:** TM-lfy.5

## Recommendations for Backlog

- [ ] Update D&F template to include platform guard guidance for iOS/watchOS stories
- [ ] Add "Request types must be Codable if used in offline queue" to API coding standards
- [ ] Document Swift 6.1 concurrency pattern (@MainActor + async tests) in iOS coding guidelines

## Metrics

- Stories accepted first try: 6/6 (100%)
- Stories rejected at least once: 0
- Most common rejection reason: N/A
- Test gap learnings captured: 0 (100% coverage from start)
- Platform-specific learnings: 4 (watchOS WidgetKit, platform guards, WatchConnectivity, Swift concurrency)

## Notes

This epic had zero rejections and zero test gaps, which is exceptional. The team's use of protocol-based DI, platform guards, and strict TDD meant all ACs were met on first delivery. The learnings here are mostly about platform-specific Swift/iOS idioms that will apply to future mobile work (Phase 6 and beyond).
