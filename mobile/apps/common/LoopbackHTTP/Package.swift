// swift-tools-version: 6.0
import PackageDescription

// A small HTTP/1.1 server bound to loopback: GS Director's link to GS Distributor, and GS
// Distributor's own API.
let package = Package(
  name: "LoopbackHTTP",
  platforms: [ .iOS(.v18), .macOS(.v15) ],
  products: [
    .library(name: "LoopbackHTTP", targets: [ "LoopbackHTTP" ])
  ],
  targets: [
    .target(
      name: "LoopbackHTTP",
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    ),
    .testTarget(
      name: "LoopbackHTTPTests",
      dependencies: [ "LoopbackHTTP" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
