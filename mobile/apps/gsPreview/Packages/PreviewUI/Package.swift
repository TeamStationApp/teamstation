// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "PreviewUI",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "PreviewUI", targets: [ "PreviewUI" ])
  ],
  dependencies: [
    .package(path: "../PreviewCore"),
    .package(path: "../PreviewTestHarness"),
    .package(path: "../../common/DirectorCore"),
    .package(path: "../../common/DirectorSources"),
    .package(path: "../../common/DirectorRTSP"),
    .package(path: "../../common/CameramanCore"),
    .package(path: "../../common/CameramanControlUI"),
    .package(path: "../../common/CameramanRemote")
  ],
  targets: [
    .target(
      name: "PreviewUI",
      dependencies: [
        "PreviewCore",
        "PreviewTestHarness",
        "DirectorCore",
        "DirectorSources",
        "DirectorRTSP",
        "CameramanCore",
        "CameramanControlUI",
        "CameramanRemote"
      ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
