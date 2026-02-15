// HapticServiceTests.swift
// T-Minus iOS Tests -- Tests for haptic feedback service.

import XCTest
@testable import TMinusLib

final class HapticServiceTests: XCTestCase {

    // MARK: - Mock Haptic Service

    func testMockTracksAllTriggers() {
        let mock = MockHapticService()

        mock.trigger(.success)
        mock.trigger(.warning)
        mock.trigger(.error)
        mock.trigger(.lightImpact)
        mock.trigger(.mediumImpact)
        mock.trigger(.heavyImpact)
        mock.trigger(.selectionChanged)

        XCTAssertEqual(mock.triggeredFeedbacks.count, 7)
        XCTAssertEqual(mock.triggeredFeedbacks[0], .success)
        XCTAssertEqual(mock.triggeredFeedbacks[1], .warning)
        XCTAssertEqual(mock.triggeredFeedbacks[2], .error)
        XCTAssertEqual(mock.triggeredFeedbacks[3], .lightImpact)
        XCTAssertEqual(mock.triggeredFeedbacks[4], .mediumImpact)
        XCTAssertEqual(mock.triggeredFeedbacks[5], .heavyImpact)
        XCTAssertEqual(mock.triggeredFeedbacks[6], .selectionChanged)
        XCTAssertEqual(mock.lastTriggered, .selectionChanged)
    }

    func testMockStartsEmpty() {
        let mock = MockHapticService()

        XCTAssertTrue(mock.triggeredFeedbacks.isEmpty)
        XCTAssertNil(mock.lastTriggered)
    }

    // MARK: - Production Haptic Service (macOS no-op)

    func testProductionServiceDoesNotCrash() {
        // On macOS (SPM test), all triggers should be no-ops.
        // On iOS simulator, they may trigger (but not crash).
        let service = HapticService()

        // These should not throw or crash on any platform
        service.trigger(.success)
        service.trigger(.warning)
        service.trigger(.error)
        service.trigger(.lightImpact)
        service.trigger(.mediumImpact)
        service.trigger(.heavyImpact)
        service.trigger(.selectionChanged)
    }

    // MARK: - HapticFeedbackType Equatable

    func testFeedbackTypeEquality() {
        XCTAssertEqual(HapticFeedbackType.success, HapticFeedbackType.success)
        XCTAssertNotEqual(HapticFeedbackType.success, HapticFeedbackType.error)
    }

    func testAllFeedbackTypesAreDistinct() {
        let allTypes: [HapticFeedbackType] = [
            .success, .warning, .error,
            .lightImpact, .mediumImpact, .heavyImpact,
            .selectionChanged
        ]
        for i in 0..<allTypes.count {
            for j in (i+1)..<allTypes.count {
                XCTAssertNotEqual(allTypes[i], allTypes[j],
                    "\(allTypes[i]) should not equal \(allTypes[j])")
            }
        }
    }
}
