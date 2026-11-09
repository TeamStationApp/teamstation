// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "CameramanControlUI",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "CameramanControlUI", targets: [ "CameramanControlUI" ])
  ],
  dependencies: [
    .package(path: "../CameramanCore")
  ],
  targets: [
    .target(
      name: "CameramanControlUI",
      dependencies: [ "CameramanCore" ],
      swiftSettings: [
        .swiftLanguageMode(.v6),
        // Release whole-module optimization aborts while deserializing
        // CameramanCore.SettingsLayout.columns (CGSize.width) into this module.
        .unsafeFlags(["-Onone"], .when(configuration: .release))
      ]
    )
  ]
)
