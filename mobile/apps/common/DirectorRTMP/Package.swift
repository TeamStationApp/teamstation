// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DirectorRTMP",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "DirectorRTMP", targets: [ "DirectorRTMP" ])
  ],
  dependencies: [
    // The bitrate controller the stream shares with TS Cameraman's RTSP server; the client measures
    // the link it judges by.
    .package(path: "../AdaptiveBitrate"),
    // The wall-clock SEI every programme frame carries, shared with the Mac-side tests that hold it
    // to the server's vectors.
    .package(path: "../DirectorCore")
  ],
  targets: [
    .target(
      name: "DirectorRTMP",
      dependencies: [ "AdaptiveBitrate", "DirectorCore" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
