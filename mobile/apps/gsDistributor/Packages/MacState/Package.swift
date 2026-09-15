// swift-tools-version: 6.0
import PackageDescription

// What GS Distributor keeps on the Mac between launches: its copy of the settings, the last
// recording list seen from each iPad, and what is still to be sent to the iPad. All of it lives in
// one folder, ~/Library/Application Support/GS Distributor; the logins are in the Keychain.
let package = Package(
  name: "MacState",
  platforms: [ .macOS(.v15) ],
  products: [
    .library(name: "MacState", targets: [ "MacState" ])
  ],
  dependencies: [
    .package(path: "../../../common/DirectorCore"),
    .package(path: "../../../common/DistributorWire")
  ],
  targets: [
    .target(
      name: "MacState",
      dependencies: [ "DirectorCore", "DistributorWire" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    ),
    .testTarget(
      name: "MacStateTests",
      dependencies: [ "MacState", "DirectorCore", "DistributorWire" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
