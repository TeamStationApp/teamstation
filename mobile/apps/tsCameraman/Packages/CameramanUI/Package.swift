// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "CameramanUI",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "CameramanUI", targets: [ "CameramanUI" ])
  ],
  dependencies: [
    .package(path: "../../../common/AdaptiveBitrate"),
    .package(path: "../../common/CameramanCore"),
    .package(path: "../../common/CameramanControlUI"),
    .package(path: "../../../common/EventControl"),
    .package(path: "../../../common/TeamStationKit"),
    .package(path: "../../../common/CameramanCapture"),
    .package(path: "../CameramanEncode"),
    .package(path: "../CameramanRTSP"),
    .package(path: "../CameramanTestHarness")
  ],
  targets: [
    .target(
      name: "CameramanUI",
      dependencies: [
        "AdaptiveBitrate",
        "CameramanCore",
        "CameramanControlUI",
        "CameramanCapture",
        "CameramanEncode",
        "CameramanRTSP",
        "CameramanTestHarness",
        "EventControl",
        "TeamStationKit"
      ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
