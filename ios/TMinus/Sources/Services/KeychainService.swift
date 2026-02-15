// KeychainService.swift
// T-Minus iOS -- Secure token storage using iOS Keychain.
//
// JWT and refresh tokens are stored in the Keychain with kSecAttrAccessible
// set to kSecAttrAccessibleAfterFirstUnlock for background refresh support.

import Foundation
import Security

/// Protocol for Keychain operations, enabling testability via mock injection.
protocol KeychainServiceProtocol {
    @discardableResult
    func save(key: String, value: String) -> Bool
    func load(key: String) -> String?
    @discardableResult
    func delete(key: String) -> Bool
    @discardableResult
    func deleteAll() -> Bool
}

/// Production Keychain service backed by iOS Security framework.
final class KeychainService: KeychainServiceProtocol {

    /// Bundle identifier used as the Keychain service name.
    private let service: String

    init(service: String = Bundle.main.bundleIdentifier ?? "com.tminus.ios") {
        self.service = service
    }

    func save(key: String, value: String) -> Bool {
        // Delete existing item first to avoid errSecDuplicateItem
        delete(key: key)

        guard let data = value.data(using: .utf8) else { return false }

        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: key,
            kSecValueData: data,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock,
        ]

        let status = SecItemAdd(query as CFDictionary, nil)
        return status == errSecSuccess
    }

    func load(key: String) -> String? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: key,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess,
              let data = result as? Data,
              let string = String(data: data, encoding: .utf8) else {
            return nil
        }
        return string
    }

    @discardableResult
    func delete(key: String) -> Bool {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: key,
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    func deleteAll() -> Bool {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}

// MARK: - Token Keys

/// Well-known Keychain keys for T-Minus tokens.
enum TokenKeys {
    static let jwt = "tminus_jwt"
    static let refreshToken = "tminus_refresh_token"
    static let userId = "tminus_user_id"
    static let userEmail = "tminus_user_email"
}
