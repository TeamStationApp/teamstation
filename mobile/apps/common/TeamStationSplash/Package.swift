// swift-tools-version: 6.0
import PackageDescription

// The launch splash the TeamStation app and TeamStation TV play while React
// Native starts: the timeline from mobile/icons/splash, sampled and laid out
// by TeamStationSplashCore (Foundation only, tested on the Mac with
// `swift test`), and drawn with Core Animation by TeamStationSplash (UIKit,
// tested on iOS and tvOS simulators with xcodebuild).
let package = Package(
  name: "TeamStationSplash",
  platforms: [.iOS(.v18), .tvOS("15.1"), .macOS(.v15)],
  products: [
    .library(name: "TeamStationSplash", targets: ["TeamStationSplash"])
  ],
  targets: [
    .target(name: "TeamStationSplashCore"),
    .target(
      name: "TeamStationSplash",
      dependencies: ["TeamStationSplashCore"],
      resources: [.process("Resources")]
    ),
    .testTarget(name: "TeamStationSplashCoreTests", dependencies: ["TeamStationSplashCore"]),
    .testTarget(name: "TeamStationSplashTests", dependencies: ["TeamStationSplash"])
  ]
)
