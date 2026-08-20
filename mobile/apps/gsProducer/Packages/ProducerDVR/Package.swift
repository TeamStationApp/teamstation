// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "ProducerDVR",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "ProducerDVR", targets: [ "ProducerDVR" ])
  ],
  dependencies: [
    .package(path: "../ProducerCore"),
    .package(path: "../ProducerSources"),
    .package(path: "../ProducerPipeline")
  ],
  targets: [
    .target(
      name: "ProducerDVR",
      dependencies: [ "ProducerCore", "ProducerSources", "ProducerPipeline" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
