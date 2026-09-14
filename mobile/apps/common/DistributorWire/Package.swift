// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DistributorWire",
  platforms: [ .iOS(.v18), .macOS(.v15) ],
  products: [
    .library(name: "DistributorWire", targets: [ "DistributorWire" ])
  ],
  dependencies: [
    .package(path: "../DirectorCore"),
    .package(path: "../DirectorExport")
  ],
  targets: [
    .target(
      name: "DistributorWire",
      dependencies: [ "DirectorCore", "DirectorExport" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    ),
    .testTarget(
      name: "DistributorWireTests",
      dependencies: [ "DistributorWire", "DirectorCore", "DirectorExport" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
