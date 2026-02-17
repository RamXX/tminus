// HapticService.swift
// T-Minus iOS -- Haptic feedback abstraction.
//
// Wraps UIImpactFeedbackGenerator and UINotificationFeedbackGenerator
// behind a protocol for testability. Uses #if os(iOS) guards so the
// library compiles on macOS for SPM testing.

import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Feedback intensity levels for haptic events.
enum HapticFeedbackType: Equatable {
    case success
    case warning
    case error
    case lightImpact
    case mediumImpact
    case heavyImpact
    case selectionChanged
}

/// Protocol for haptic feedback, enabling test mocking.
protocol HapticServiceProtocol {
    func trigger(_ type: HapticFeedbackType)
}

/// Production haptic service using UIKit feedback generators.
/// On macOS (SPM tests), trigger() is a no-op.
final class HapticService: HapticServiceProtocol {

    func trigger(_ type: HapticFeedbackType) {
        #if os(iOS)
        switch type {
        case .success:
            let generator = UINotificationFeedbackGenerator()
            generator.prepare()
            generator.notificationOccurred(.success)
        case .warning:
            let generator = UINotificationFeedbackGenerator()
            generator.prepare()
            generator.notificationOccurred(.warning)
        case .error:
            let generator = UINotificationFeedbackGenerator()
            generator.prepare()
            generator.notificationOccurred(.error)
        case .lightImpact:
            let generator = UIImpactFeedbackGenerator(style: .light)
            generator.prepare()
            generator.impactOccurred()
        case .mediumImpact:
            let generator = UIImpactFeedbackGenerator(style: .medium)
            generator.prepare()
            generator.impactOccurred()
        case .heavyImpact:
            let generator = UIImpactFeedbackGenerator(style: .heavy)
            generator.prepare()
            generator.impactOccurred()
        case .selectionChanged:
            let generator = UISelectionFeedbackGenerator()
            generator.prepare()
            generator.selectionChanged()
        }
        #endif
    }
}
