// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DirectorNDI",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "DirectorNDI", targets: [ "DirectorNDI" ])
  ],
  dependencies: [
    .package(path: "../DirectorCore"),
    .package(path: "../DirectorSources")
  ],
  targets: [
    // Built by `gsDirector/scripts/bootstrapNdi.sh`, not committed: the library is about 380 MB
    // across its slices, and its simulator slice has to be produced on this machine because the
    // stock SDK ships none for arm64.
    .binaryTarget(name: "libndi", path: "Vendor/libndi.xcframework"),
    .target(
      name: "CNDI",
      dependencies: [ "libndi" ],
      linkerSettings: [
        .linkedLibrary("c++"),
        .linkedLibrary("z"),
        .linkedFramework("Accelerate"),
        .linkedFramework("AudioToolbox"),
        .linkedFramework("CoreMedia"),
        .linkedFramework("CoreVideo"),
        .linkedFramework("Foundation"),
        .linkedFramework("Network"),
        .linkedFramework("Security"),
        .linkedFramework("SystemConfiguration"),
        .linkedFramework("VideoToolbox")
      ]
    ),
    .target(
      name: "DirectorNDI",
      dependencies: [ "CNDI", "DirectorCore", "DirectorSources" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
