// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DirectorClient",
  platforms: [ .macOS(.v15) ],
  products: [
    .library(name: "DirectorClient", targets: [ "DirectorClient" ])
  ],
  dependencies: [
    .package(path: "../UsbMux"),
    .package(path: "../../../common/DirectorCore"),
    .package(path: "../../../common/DirectorExport"),
    .package(path: "../../../common/DistributorWire"),
    // Tests only: the client is exercised against the server GS Director actually runs.
    .package(path: "../../../gsDirector/Packages/DirectorLink"),
  ],
  targets: [
    .target(
      name: "DirectorClient",
      dependencies: [ "UsbMux", "DirectorCore", "DirectorExport", "DistributorWire" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    ),
    .testTarget(
      name: "DirectorClientTests",
      dependencies: [ "DirectorClient", "DirectorCore", "DirectorExport", "DistributorWire", "DirectorLink" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
