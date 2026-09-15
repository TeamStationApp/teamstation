// swift-tools-version: 6.0
import PackageDescription

// GS Distributor's REST API on 127.0.0.1:8771: the routes and what they send and take. The app
// answers them through DistributorActions, so the routes are tested without an iPad or a window.
let package = Package(
  name: "DistributorAPI",
  platforms: [ .macOS(.v15) ],
  products: [
    .library(name: "DistributorAPI", targets: [ "DistributorAPI" ])
  ],
  dependencies: [
    .package(path: "../../../common/DistributorWire"),
    .package(path: "../../../common/LoopbackHTTP")
  ],
  targets: [
    .target(
      name: "DistributorAPI",
      dependencies: [ "DistributorWire", "LoopbackHTTP" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    ),
    .testTarget(
      name: "DistributorAPITests",
      dependencies: [ "DistributorAPI", "DistributorWire", "LoopbackHTTP" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
