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
    .package(path: "../AdaptiveBitrate")
  ],
  targets: [
    .target(
      name: "DirectorRTMP",
      dependencies: [ "AdaptiveBitrate" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
