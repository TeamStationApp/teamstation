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
    .package(path: "../../../common/DirectorCore"),
    .package(path: "../../../common/DirectorMedia"),
    .package(path: "../../../common/DirectorSources"),
    .package(path: "../../../common/DirectorRTMP")
  ],
  targets: [
    .target(
      name: "DirectorPipeline",
      dependencies: [ "AdaptiveBitrate", "DirectorCore", "DirectorMedia", "DirectorSources", "DirectorRTMP" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
