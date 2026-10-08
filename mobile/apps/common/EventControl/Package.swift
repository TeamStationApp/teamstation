// swift-tools-version: 6.0
import PackageDescription

// Device event control: the app-neutral protocol a Director uses to set the publishing event of
// nearby devices signed in to the same TeamStation account. The wire contract, its state
// machines, and the TCP adapters for both ends. See README.md.
let package = Package(
  name: "EventControl",
  platforms: [ .iOS(.v18), .macOS(.v15) ],
  products: [
    .library(name: "EventControl", targets: [ "EventControl" ])
  ],
  targets: [
    .target(
      name: "EventControl",
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    ),
    .testTarget(
      name: "EventControlTests",
      dependencies: [ "EventControl" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
