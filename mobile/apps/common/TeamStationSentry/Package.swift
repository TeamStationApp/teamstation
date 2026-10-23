// swift-tools-version: 6.0
import PackageDescription

/// Crash reporting for TS Director and TS Cameraman: the thin glue over sentry-cocoa that applies
/// `TeamStationSentryRules` to every event.
///
/// sentry-cocoa's own package declares seven prebuilt frameworks, and SwiftPM fetches and unpacks
/// every one with a clone of its whole history. The apps link one, the static `Sentry`, so it is
/// named here directly: the same release asset and checksum as sentry-cocoa 9.30.1's `Sentry`
/// product, whose only other part is the libc++ link added below.
let package = Package(
  name: "TeamStationSentry",
  platforms: [ .iOS(.v18), .macOS(.v15) ],
  products: [
    .library(name: "TeamStationSentry", targets: [ "TeamStationSentry" ])
  ],
  dependencies: [
    .package(path: "../TeamStationSentryRules"),
    .package(path: "../TeamStationObservability")
  ],
  targets: [
    .binaryTarget(
      name: "Sentry",
      url: "https://github.com/getsentry/sentry-cocoa/releases/download/9.30.1/Sentry.xcframework.zip",
      checksum: "bf6bc2308b9f1d11cc0d5ad5a324dbe300afa37c8391809ecb6dd3758fa728e2"
    ),
    .target(
      name: "TeamStationSentry",
      dependencies: [
        .product(name: "TeamStationSentryRules", package: "TeamStationSentryRules"),
        .product(name: "TeamStationObservability", package: "TeamStationObservability"),
        "Sentry"
      ],
      swiftSettings: [ .swiftLanguageMode(.v6) ],
      linkerSettings: [ .linkedLibrary("c++"), .linkedLibrary("z") ]
    ),
    .testTarget(name: "TeamStationSentryTests", dependencies: ["TeamStationSentry", "Sentry"])
  ]
)
