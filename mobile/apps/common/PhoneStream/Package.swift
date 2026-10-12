// swift-tools-version: 6.0
import PackageDescription

// The phone's own streaming and recording engine: TS Director's recorder and streamer driven from
// the phone's one camera through TS Cameraman's capture session. No UI; the TeamStation app hosts
// its preview and draws its overlay. Its tests run on an iPhone simulator through the test host in
// Tests/Host (scripts/test-unit.sh), because the encoders need VideoToolbox on iOS.
let package = Package(
  name: "PhoneStream",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "PhoneStream", targets: [ "PhoneStream" ])
  ],
  dependencies: [
    .package(path: "../AdaptiveBitrate"),
    .package(path: "../CameramanCapture"),
    .package(path: "../CameramanCore"),
    .package(path: "../DirectorCore"),
    .package(path: "../DirectorExport"),
    .package(path: "../DirectorMedia"),
    .package(path: "../DirectorRTMP"),
    .package(path: "../DirectorSources"),
    .package(path: "../TeamStationKit")
  ],
  targets: [
    .target(
      name: "PhoneStream",
      dependencies: [
        "AdaptiveBitrate",
        "CameramanCapture",
        "CameramanCore",
        "DirectorCore",
        "DirectorExport",
        "DirectorMedia",
        "DirectorRTMP",
        "DirectorSources",
        "TeamStationKit"
      ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
