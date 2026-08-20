// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "ProducerSources",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "ProducerSources", targets: [ "ProducerSources" ])
  ],
  dependencies: [
    .package(path: "../ProducerCore")
  ],
  targets: [
    .target(
      name: "ProducerSources",
      dependencies: [ "ProducerCore" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
