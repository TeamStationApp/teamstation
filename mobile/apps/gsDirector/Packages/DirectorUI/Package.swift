// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DirectorUI",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "DirectorUI", targets: [ "DirectorUI" ])
  ],
  dependencies: [
    .package(path: "../../common/DirectorCore"),
    .package(path: "../../common/DirectorSources"),
    .package(path: "../../common/CameramanCore"),
    .package(path: "../../common/CameramanControlUI"),
    .package(path: "../DirectorPipeline"),
    .package(path: "../DirectorDVR"),
    .package(path: "../DirectorRTMP"),
    .package(path: "../DirectorTestHarness")
  ],
  targets: [
    .target(
      name: "DirectorUI",
      dependencies: [
        "DirectorCore",
        "DirectorSources",
        "CameramanCore",
        "CameramanControlUI",
        "DirectorPipeline",
        "DirectorDVR",
        "DirectorRTMP",
        "DirectorTestHarness"
      ],
      swiftSettings: [ .swiftLanguageMode(.v6) ],
      linkerSettings: [ .linkedFramework("GameController") ]
    )
  ]
)
