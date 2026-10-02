// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "PreviewTestHarness",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "PreviewTestHarness", targets: [ "PreviewTestHarness" ])
  ],
  targets: [
    .target(
      name: "PreviewTestHarness",
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
