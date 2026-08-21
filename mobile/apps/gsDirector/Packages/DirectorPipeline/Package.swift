// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DirectorPipeline",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "DirectorPipeline", targets: [ "DirectorPipeline" ])
  ],
  dependencies: [
    .package(path: "../DirectorCore"),
    .package(path: "../DirectorSources"),
    .package(path: "../DirectorTestHarness")
  ],
  targets: [
    .target(
      name: "DirectorPipeline",
      dependencies: [ "DirectorCore", "DirectorSources", "DirectorTestHarness" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
