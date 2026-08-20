// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "ProducerRTSP",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "ProducerRTSP", targets: [ "ProducerRTSP" ])
  ],
  dependencies: [
    .package(path: "../ProducerCore"),
    .package(path: "../ProducerSources")
  ],
  targets: [
    .target(
      name: "ProducerRTSP",
      dependencies: [ "ProducerCore", "ProducerSources" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
