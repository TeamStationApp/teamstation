// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DirectorTestHarness",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "DirectorTestHarness", targets: [ "DirectorTestHarness" ])
  ],
  dependencies: [
    .package(path: "../DirectorCore"),
    .package(path: "../DirectorSources")
  ],
  targets: [
    .target(
      name: "DirectorTestHarness",
      dependencies: [ "DirectorCore", "DirectorSources" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
