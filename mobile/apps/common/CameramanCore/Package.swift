// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "CameramanCore",
  platforms: [ .iOS(.v18), .macOS(.v15) ],
  products: [
    .library(name: "CameramanCore", targets: [ "CameramanCore" ])
  ],
  dependencies: [ .package(path: "../EventControl") ],
  targets: [
    .target(
      name: "CameramanCore",
      dependencies: [ "EventControl" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    ),
    .testTarget(name: "CameramanCoreTests", dependencies: [ "CameramanCore", "EventControl" ])
  ]
)
