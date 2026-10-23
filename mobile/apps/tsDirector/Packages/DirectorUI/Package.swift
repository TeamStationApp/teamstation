// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DirectorUI",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "DirectorUI", targets: [ "DirectorUI" ])
  ],
  dependencies: [
    .package(path: "../../../common/TeamStationObservability"),
    .package(path: "../../common/DirectorCore"),
    .package(path: "../../../common/DirectorExport"),
    .package(path: "../../common/DirectorSources"),
    .package(path: "../../common/DirectorRTSP"),
    .package(path: "../../common/CameramanCore"),
    .package(path: "../../common/CameramanControlUI"),
    .package(path: "../../common/CameramanRemote"),
    .package(path: "../DirectorPipeline"),
    .package(path: "../DirectorDVR"),
    .package(path: "../../../common/DirectorRTMP"),
    .package(path: "../../../common/DirectorMedia"),
    .package(path: "../DirectorTestHarness"),
    .package(path: "../DirectorLink"),
    .package(path: "../../../common/DistributorWire"),
    .package(path: "../../../common/LoopbackHTTP"),
    .package(path: "../../../common/TeamStationKit"),
    .package(path: "../../../common/EventControl")
  ],
  targets: [
    .target(
      name: "DirectorUI",
      dependencies: [
        "TeamStationObservability",
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
        // The programme recorder and streamer, and the stream and recording controllers.
        "DirectorMedia",
        "DirectorTestHarness",
        "DirectorLink",
        "DistributorWire",
        // AppEnvironment runs the Distributor link's server and event hub itself, so it links them
        // itself: reached only through DirectorLink, they were missing whenever Xcode built this
        // package as its own framework, which it does once a test bundle links a package directly.
        "LoopbackHTTP",
        "TeamStationKit",
        // "Set event on nearby devices": the protocol a Director speaks to them.
        "EventControl"
      ],
      swiftSettings: [ .swiftLanguageMode(.v6) ],
      linkerSettings: [ .linkedFramework("GameController") ]
    )
  ]
)
