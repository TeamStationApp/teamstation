// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "CameramanTestHarness",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "CameramanTestHarness", targets: [ "CameramanTestHarness" ])
  ],
  dependencies: [
    .package(path: "../CameramanCore")
  ],
  targets: [
    .target(
      name: "CameramanTestHarness",
      dependencies: [ "CameramanCore" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
