// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DirectorPipeline",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "DirectorPipeline", targets: [ "DirectorPipeline" ])
  ],
  dependencies: [
    .package(path: "../../../common/AdaptiveBitrate"),
    .package(path: "../../common/DirectorCore"),
    .package(path: "../../common/DirectorSources"),
    .package(path: "../DirectorRTMP"),
    .package(path: "../DirectorTestHarness")
  ],
  targets: [
    .target(
      name: "DirectorPipeline",
      dependencies: [ "AdaptiveBitrate", "DirectorCore", "DirectorSources", "DirectorRTMP", "DirectorTestHarness" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
