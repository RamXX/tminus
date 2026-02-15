// AccountColorsTests.swift
// T-Minus iOS Tests -- Unit tests for account color assignment.

import XCTest
import SwiftUI
@testable import TMinusLib

final class AccountColorsTests: XCTestCase {

    func testColorForAccountIdIsStable() {
        let accountId = "acc_01ACCT001"
        let color1 = AccountColors.color(for: accountId)
        let color2 = AccountColors.color(for: accountId)
        // Same input always produces same output
        XCTAssertEqual(color1, color2)
    }

    func testDifferentAccountsGetDifferentColors() {
        let color1 = AccountColors.color(for: "acc_01ACCT001")
        let color2 = AccountColors.color(for: "acc_01ACCT002")
        // Different account IDs should usually produce different colors
        // (not guaranteed for all inputs, but these specific ones should differ)
        XCTAssertNotEqual(color1, color2)
    }

    func testColorNameIsStable() {
        let name1 = AccountColors.colorName(for: "acc_01ACCT001")
        let name2 = AccountColors.colorName(for: "acc_01ACCT001")
        XCTAssertEqual(name1, name2)
    }

    func testColorNameAndColorAreConsistent() {
        let accountId = "acc_01ACCT001"
        let color = AccountColors.color(for: accountId)
        let name = AccountColors.colorName(for: accountId)
        // Both use the same hash function, so the index should match
        let hash = accountId.utf8.reduce(0) { (result, byte) in
            result &+ Int(byte) &* 31
        }
        let expectedIndex = abs(hash) % AccountColors.palette.count
        XCTAssertEqual(color, AccountColors.palette[expectedIndex])
        let names = ["Blue", "Red", "Green", "Purple", "Orange",
                     "Teal", "Pink", "Olive", "Dark Purple", "Brown"]
        XCTAssertEqual(name, names[expectedIndex])
    }

    func testPaletteHas10Colors() {
        XCTAssertEqual(AccountColors.palette.count, 10)
    }

    func testEmptyAccountIdDoesNotCrash() {
        // Edge case: empty string should not crash
        let _ = AccountColors.color(for: "")
        let _ = AccountColors.colorName(for: "")
    }
}
