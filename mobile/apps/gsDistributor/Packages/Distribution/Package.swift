// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "Distribution",
  platforms: [ .macOS(.v15) ],
  products: [
    .library(name: "Distribution", targets: [ "Distribution" ])
  ],
  dependencies: [
    .package(path: "../DirectorClient"),
    .package(path: "../CombinedVideo"),
    .package(path: "../../../common/DirectorCore"),
    .package(path: "../../../common/DirectorExport"),
    .package(path: "../../../common/DistributorWire"),
    // Tests only: the Mac's stitch is checked against a real server and the iPad's own export.
    .package(path: "../../../gsDirector/Packages/DirectorLink")
  ],
  targets: [
    .target(
      name: "Distribution",
      dependencies: [ "DirectorClient", "CombinedVideo", "DirectorCore", "DirectorExport", "DistributorWire" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    ),
    .testTarget(
      name: "DistributionTests",
      dependencies: [
        "Distribution", "DirectorClient", "DirectorCore", "DirectorExport", "DistributorWire", "DirectorLink"
      ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
