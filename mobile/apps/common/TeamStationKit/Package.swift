// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "TeamStationKit",
  platforms: [ .iOS(.v18), .macOS(.v15) ],
  products: [
    .library(name: "TeamStationKit", targets: [ "TeamStationKit" ])
  ],
  dependencies: [
    // For the one canonical server origin, shared with the keys device event control caches.
    .package(path: "../EventControl")
  ],
  targets: [
    .target(
      name: "TeamStationKit",
      dependencies: [ "EventControl" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    ),
    .testTarget(
      name: "TeamStationKitTests",
      dependencies: [ "TeamStationKit" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
