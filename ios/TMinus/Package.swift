// swift-tools-version: 6.1
// Package.swift
// T-Minus iOS -- Swift Package Manager manifest.
//
// This package defines the TMinus library target (all non-App code)
// and test targets. The Xcode project wraps this package and adds
// the app target with the @main entry point.

import PackageDescription

let package = Package(
    name: "TMinus",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(
            name: "TMinusLib",
            targets: ["TMinusLib"]
        ),
    ],
    targets: [
        .target(
            name: "TMinusLib",
            dependencies: [],
            path: "Sources",
            exclude: ["App/TMinusApp.swift"],
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ]
        ),
        .testTarget(
            name: "TMinusTests",
            dependencies: ["TMinusLib"],
            path: "Tests/TMinusTests",
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ]
        ),
    ]
)
