// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "ProducerPipeline",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "ProducerPipeline", targets: [ "ProducerPipeline" ])
  ],
  dependencies: [
    .package(path: "../ProducerCore"),
    .package(path: "../ProducerSources"),
    .package(path: "../ProducerTestHarness")
  ],
  targets: [
    .target(
      name: "ProducerPipeline",
      dependencies: [ "ProducerCore", "ProducerSources", "ProducerTestHarness" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
