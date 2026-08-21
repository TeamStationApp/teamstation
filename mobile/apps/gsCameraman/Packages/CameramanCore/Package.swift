// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "CameramanCore",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "CameramanCore", targets: [ "CameramanCore" ])
  ],
  targets: [
    .target(
      name: "CameramanCore",
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
