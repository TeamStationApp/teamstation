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
    .package(path: "../../../common/PeerTubeKit")
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
        "PeerTubeKit"
      ],
      swiftSettings: [ .swiftLanguageMode(.v6) ],
      linkerSettings: [ .linkedFramework("GameController") ]
    )
  ]
)
