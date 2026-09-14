// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DirectorExport",
  platforms: [ .iOS(.v18), .macOS(.v15) ],
  products: [
    .library(name: "DirectorExport", targets: [ "DirectorExport" ])
  ],
  dependencies: [
    .package(path: "../DirectorCore"),
    // Tests only: the wall-clock tests paint and read per-frame markers with `FrameMarker`.
    .package(path: "../DirectorSources")
  ],
  targets: [
    .target(
      name: "DirectorExport",
      dependencies: [ "DirectorCore" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    ),
    // Run on the Mac with `swift test`. GS Director's iPad unit tests compile the same files, so
    // both platforms prove the same stitching.
    .testTarget(
      name: "DirectorExportTests",
      dependencies: [ "DirectorExport", "DirectorCore", "DirectorSources" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
