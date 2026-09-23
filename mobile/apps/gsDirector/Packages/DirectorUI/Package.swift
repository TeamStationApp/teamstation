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
    .package(path: "../../../common/DirectorExport"),
    .package(path: "../../common/DirectorSources"),
    .package(path: "../../common/DirectorRTSP"),
    .package(path: "../../common/CameramanCore"),
    .package(path: "../../common/CameramanControlUI"),
    .package(path: "../../common/CameramanRemote"),
    .package(path: "../DirectorPipeline"),
    .package(path: "../DirectorDVR"),
    .package(path: "../DirectorRTMP"),
    .package(path: "../DirectorTestHarness"),
    .package(path: "../DirectorLink"),
    .package(path: "../../../common/DistributorWire"),
    .package(path: "../../../common/LoopbackHTTP"),
    .package(path: "../../../common/GameStationKit")
  ],
  targets: [
    .target(
      name: "DirectorUI",
      dependencies: [
        "DirectorCore",
        "DirectorExport",
        "DirectorSources",
        "DirectorRTSP",
        "CameramanCore",
        "CameramanControlUI",
        "CameramanRemote",
        "DirectorPipeline",
        "DirectorDVR",
        "DirectorRTMP",
        "DirectorTestHarness",
        "DirectorLink",
        "DistributorWire",
        // AppEnvironment runs the Distributor link's server and event hub itself, so it links them
        // itself: reached only through DirectorLink, they were missing whenever Xcode built this
        // package as its own framework, which it does once a test bundle links a package directly.
        "LoopbackHTTP",
        "GameStationKit"
      ],
      swiftSettings: [ .swiftLanguageMode(.v6) ],
      linkerSettings: [ .linkedFramework("GameController") ]
    )
  ]
)
