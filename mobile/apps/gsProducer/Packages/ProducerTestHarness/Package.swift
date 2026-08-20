// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "ProducerTestHarness",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "ProducerTestHarness", targets: [ "ProducerTestHarness" ])
  ],
  dependencies: [
    .package(path: "../ProducerCore"),
    .package(path: "../ProducerSources")
  ],
  targets: [
    .target(
      name: "ProducerTestHarness",
      dependencies: [ "ProducerCore", "ProducerSources" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
