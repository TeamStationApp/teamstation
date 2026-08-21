// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DirectorUI",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "DirectorUI", targets: [ "DirectorUI" ])
  ],
  dependencies: [
    .package(path: "../DirectorCore"),
    .package(path: "../DirectorSources"),
    .package(path: "../DirectorPipeline"),
    .package(path: "../DirectorDVR"),
    .package(path: "../DirectorRTMP"),
    .package(path: "../DirectorTestHarness")
  ],
  targets: [
    .target(
      name: "DirectorUI",
      dependencies: [
        "DirectorCore",
        "DirectorSources",
        "DirectorPipeline",
        "DirectorDVR",
        "DirectorRTMP",
        "DirectorTestHarness"
      ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
