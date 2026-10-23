// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "TeamStationObservability",
  platforms: [.iOS(.v18), .macOS(.v15)],
  products: [.library(name: "TeamStationObservability", targets: ["TeamStationObservability"])],
  targets: [
    .target(name: "TeamStationObservability"),
    .testTarget(name: "TeamStationObservabilityTests", dependencies: ["TeamStationObservability"])
  ]
)
