// swift-tools-version: 6.0
import PackageDescription

// What TS Distributor keeps on the Mac between launches: its copy of the settings, the last
// recording list seen from each iPad, and when it last met each iPad. All of it lives in one
// folder, ~/Library/Application Support/TS Distributor.
let package = Package(
  name: "MacState",
  platforms: [ .macOS(.v15) ],
  products: [
    .library(name: "MacState", targets: [ "MacState" ])
  ],
  dependencies: [
    .package(path: "../../../common/DirectorCore"),
    .package(path: "../../../common/DistributorWire")
  ],
  targets: [
    .target(
      name: "MacState",
      dependencies: [ "DirectorCore", "DistributorWire" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    ),
    .testTarget(
      name: "MacStateTests",
      dependencies: [ "MacState", "DirectorCore", "DistributorWire" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
