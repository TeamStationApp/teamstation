// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "ProducerCore",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "ProducerCore", targets: [ "ProducerCore" ])
  ],
  targets: [
    .target(
      name: "ProducerCore",
      swiftSettings: [ .swiftLanguageMode(.v6) ],
      linkerSettings: [ .linkedLibrary("sqlite3") ]
    )
  ]
)
