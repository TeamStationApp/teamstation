// swift-tools-version: 6.0
import PackageDescription

// TS Director's side of TS Distributor: the loopback server the Mac reaches over the cable.
// It builds for macOS as well, so its tests run with `swift test` on the Mac.
let package = Package(
  name: "DirectorLink",
  platforms: [ .iOS(.v18), .macOS(.v15) ],
  products: [
    .library(name: "DirectorLink", targets: [ "DirectorLink" ])
  ],
  dependencies: [
    .package(path: "../../../common/DirectorCore"),
    .package(path: "../../../common/DirectorExport"),
    .package(path: "../../../common/DistributorWire"),
    .package(path: "../../../common/LoopbackHTTP"),
  ],
  targets: [
    .target(
      name: "DirectorLink",
      dependencies: [ "DirectorCore", "DirectorExport", "DistributorWire", "LoopbackHTTP" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    ),
    .testTarget(
      name: "DirectorLinkTests",
      dependencies: [ "DirectorLink", "DirectorCore", "DirectorExport", "DistributorWire" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
