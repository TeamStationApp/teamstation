// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "CameramanRTSP",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "CameramanRTSP", targets: [ "CameramanRTSP" ])
  ],
  dependencies: [
    .package(path: "../CameramanCore"),
    .package(path: "../CameramanEncode")
  ],
  targets: [
    .target(
      name: "CameramanRTSP",
      dependencies: [ "CameramanCore", "CameramanEncode" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
