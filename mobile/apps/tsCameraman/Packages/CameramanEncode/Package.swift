// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "CameramanEncode",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "CameramanEncode", targets: [ "CameramanEncode" ])
  ],
  dependencies: [
    .package(path: "../../common/CameramanCore")
  ],
  targets: [
    .target(
      name: "CameramanEncode",
      dependencies: [ "CameramanCore" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
