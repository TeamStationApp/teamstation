// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "ProducerUI",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "ProducerUI", targets: [ "ProducerUI" ])
  ],
  dependencies: [
    .package(path: "../ProducerCore"),
    .package(path: "../ProducerSources"),
    .package(path: "../ProducerPipeline"),
    .package(path: "../ProducerDVR"),
    .package(path: "../ProducerTestHarness")
  ],
  targets: [
    .target(
      name: "ProducerUI",
      dependencies: [
        "ProducerCore",
        "ProducerSources",
        "ProducerPipeline",
        "ProducerDVR",
        "ProducerTestHarness"
      ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
