// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "TeamStationKit",
  platforms: [ .iOS(.v18), .macOS(.v15) ],
  products: [
    .library(name: "TeamStationKit", targets: [ "TeamStationKit" ])
  ],
  targets: [
    .target(
      name: "TeamStationKit",
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    ),
    .testTarget(
      name: "TeamStationKitTests",
      dependencies: [ "TeamStationKit" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
