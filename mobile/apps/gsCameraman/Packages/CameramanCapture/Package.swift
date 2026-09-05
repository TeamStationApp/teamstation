// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "CameramanCapture",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "CameramanCapture", targets: [ "CameramanCapture" ])
  ],
  dependencies: [
    .package(path: "../../common/CameramanCore")
  ],
  targets: [
    .target(
      name: "CameramanCapture",
      dependencies: [ "CameramanCore" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
