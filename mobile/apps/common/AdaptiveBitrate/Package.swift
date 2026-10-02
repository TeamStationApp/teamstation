// swift-tools-version: 6.0
import PackageDescription

// The adaptive bitrate controller, shared by TS Cameraman's RTSP server and TS Director's RTMP stream:
// both send over TCP with nothing coming back from the receiver, so both judge the link by their own
// send queue.
let package = Package(
  name: "AdaptiveBitrate",
  platforms: [ .iOS(.v18), .macOS(.v15) ],
  products: [
    .library(name: "AdaptiveBitrate", targets: [ "AdaptiveBitrate" ])
  ],
  targets: [
    .target(
      name: "AdaptiveBitrate",
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    ),
    // Run on the Mac with `swift test`.
    .testTarget(
      name: "AdaptiveBitrateTests",
      dependencies: [ "AdaptiveBitrate" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
