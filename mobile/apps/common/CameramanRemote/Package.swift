// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "CameramanRemote",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "CameramanRemote", targets: [ "CameramanRemote" ])
  ],
  dependencies: [
    .package(path: "../CameramanCore"),
    .package(path: "../DirectorRTSP")
  ],
  targets: [
    .target(
      name: "CameramanRemote",
      dependencies: [ "CameramanCore", "DirectorRTSP" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
