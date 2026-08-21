// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "CameramanUI",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "CameramanUI", targets: [ "CameramanUI" ])
  ],
  dependencies: [
    .package(path: "../CameramanCore"),
    .package(path: "../CameramanCapture"),
    .package(path: "../CameramanEncode"),
    .package(path: "../CameramanRTSP"),
    .package(path: "../CameramanTestHarness")
  ],
  targets: [
    .target(
      name: "CameramanUI",
      dependencies: [
        "CameramanCore",
        "CameramanCapture",
        "CameramanEncode",
        "CameramanRTSP",
        "CameramanTestHarness"
      ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
