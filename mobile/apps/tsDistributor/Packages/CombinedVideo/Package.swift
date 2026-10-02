// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "CombinedVideo",
  platforms: [ .macOS(.v15) ],
  products: [
    .library(name: "CombinedVideo", targets: [ "CombinedVideo" ])
  ],
  dependencies: [
    .package(path: "../../../common/DistributorWire")
  ],
  targets: [
    .target(
      name: "CombinedVideo",
      dependencies: [ "DistributorWire" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    ),
    .testTarget(
      name: "CombinedVideoTests",
      dependencies: [ "CombinedVideo", "DistributorWire" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
