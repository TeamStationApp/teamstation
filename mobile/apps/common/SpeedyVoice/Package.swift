// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "SpeedyVoice",
  platforms: [ .iOS(.v18), .macOS(.v15) ],
  products: [
    .library(name: "SpeedyVoice", targets: [ "SpeedyVoice" ])
  ],
  targets: [
    .target(
      name: "SpeedyVoice",
      resources: [ .copy("Clips") ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
