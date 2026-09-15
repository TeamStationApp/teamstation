// swift-tools-version: 6.0
import PackageDescription

// GS Director's side of GS Distributor: the loopback server the Mac reaches over the cable.
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
    .package(path: "../../../common/PeerTubeKit")
  ],
  targets: [
    .target(
      name: "DirectorLink",
      dependencies: [ "DirectorCore", "DirectorExport", "DistributorWire", "PeerTubeKit" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    ),
    .testTarget(
      name: "DirectorLinkTests",
      dependencies: [ "DirectorLink", "DirectorCore", "DirectorExport", "DistributorWire", "PeerTubeKit" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
