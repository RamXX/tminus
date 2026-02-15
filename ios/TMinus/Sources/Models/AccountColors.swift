// AccountColors.swift
// T-Minus iOS -- Color coding for origin accounts.
//
// Each linked calendar account gets a stable, distinguishable color.
// Colors are assigned by hashing the account ID to an index in a
// curated palette. This matches the web UI's approach.

import SwiftUI

/// Palette of 10 distinguishable colors for account color coding.
/// Chosen for accessibility (sufficient contrast on both light/dark backgrounds).
enum AccountColors {

    /// The palette. Ordered so adjacent colors are visually distinct.
    static let palette: [Color] = [
        Color(red: 0.26, green: 0.52, blue: 0.96),  // Blue
        Color(red: 0.85, green: 0.26, blue: 0.33),  // Red
        Color(red: 0.18, green: 0.72, blue: 0.47),  // Green
        Color(red: 0.61, green: 0.35, blue: 0.85),  // Purple
        Color(red: 0.96, green: 0.62, blue: 0.14),  // Orange
        Color(red: 0.00, green: 0.67, blue: 0.76),  // Teal
        Color(red: 0.91, green: 0.42, blue: 0.65),  // Pink
        Color(red: 0.55, green: 0.63, blue: 0.13),  // Olive
        Color(red: 0.40, green: 0.27, blue: 0.60),  // Dark Purple
        Color(red: 0.80, green: 0.50, blue: 0.20),  // Brown
    ]

    /// Returns a stable color for the given account ID.
    /// Uses a simple hash to map account IDs to palette indices.
    static func color(for accountId: String) -> Color {
        let hash = accountId.utf8.reduce(0) { (result, byte) in
            result &+ Int(byte) &* 31
        }
        let index = abs(hash) % palette.count
        return palette[index]
    }

    /// Returns a stable color name string for the given account ID.
    /// Useful for accessibility labels.
    static func colorName(for accountId: String) -> String {
        let names = [
            "Blue", "Red", "Green", "Purple", "Orange",
            "Teal", "Pink", "Olive", "Dark Purple", "Brown"
        ]
        let hash = accountId.utf8.reduce(0) { (result, byte) in
            result &+ Int(byte) &* 31
        }
        let index = abs(hash) % names.count
        return names[index]
    }
}
