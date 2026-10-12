// swift-tools-version: 6.0
import PackageDescription

// TS Director's programme recorder and streamer, their clocks and sound, and recovery after an
// interruption: what a second host needs to record and stream the way Director does. It builds on
// its own, without DirectorPipeline, which depends on it.
let package = Package(
  name: "DirectorMedia",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "DirectorMedia", targets: [ "DirectorMedia" ])
  ],
  dependencies: [
    .package(path: "../AdaptiveBitrate"),
    .package(path: "../DirectorCore"),
    .package(path: "../DirectorExport"),
    .package(path: "../DirectorRTMP"),
    .package(path: "../DirectorSources")
  ],
  targets: [
    .target(
      name: "DirectorMedia",
      dependencies: [ "AdaptiveBitrate", "DirectorCore", "DirectorExport", "DirectorRTMP", "DirectorSources" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
