// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "UsbMux",
  platforms: [ .macOS(.v15) ],
  products: [
    .library(name: "UsbMux", targets: [ "UsbMux" ])
  ],
  targets: [
    .target(
      name: "UsbMux",
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    ),
    .testTarget(
      name: "UsbMuxTests",
      dependencies: [ "UsbMux" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
