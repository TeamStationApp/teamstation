// swift-tools-version: 6.0
import PackageDescription

/// What a crash report from TS Director or TS Cameraman may carry. No dependencies, so its tests
/// run on the Mac in seconds and offline; `TeamStationSentry` applies it over sentry-cocoa.
let package = Package(
  name: "TeamStationSentryRules",
  platforms: [ .iOS(.v18), .macOS(.v15) ],
  products: [
    .library(name: "TeamStationSentryRules", targets: [ "TeamStationSentryRules" ])
  ],
  targets: [
    .target(
      name: "TeamStationSentryRules",
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    ),
    .testTarget(
      name: "TeamStationSentryRulesTests",
      dependencies: [ "TeamStationSentryRules" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
