// swift-tools-version: 6.0
import PackageDescription

// PeerTube for GameStation: signing in (GS Director keeps the account) and uploading (GS
// Distributor sends the files).
let package = Package(
  name: "PeerTubeKit",
  platforms: [ .iOS(.v18), .macOS(.v15) ],
  products: [
    .library(name: "PeerTubeKit", targets: [ "PeerTubeKit" ])
  ],
  targets: [
    .target(
      name: "PeerTubeKit",
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    ),
    .testTarget(
      name: "PeerTubeKitTests",
      dependencies: [ "PeerTubeKit" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
