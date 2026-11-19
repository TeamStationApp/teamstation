// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "SpeedyCore",
  platforms: [ .iOS(.v18), .macOS(.v15) ],
  products: [
    .library(name: "SpeedyCore", targets: [ "SpeedyCore" ])
  ],
  targets: [
    .target(
      name: "SpeedyCore",
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
