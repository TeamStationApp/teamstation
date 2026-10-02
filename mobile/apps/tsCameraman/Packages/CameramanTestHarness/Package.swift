// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "CameramanTestHarness",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "CameramanTestHarness", targets: [ "CameramanTestHarness" ])
  ],
  dependencies: [
    .package(path: "../../common/CameramanCore"),
    .package(path: "../CameramanEncode")
  ],
  targets: [
    .target(
      name: "CameramanTestHarness",
      dependencies: [ "CameramanCore", "CameramanEncode" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
