// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DirectorCore",
  platforms: [ .iOS(.v18), .macOS(.v15) ],
  products: [
    .library(name: "DirectorCore", targets: [ "DirectorCore" ])
  ],
  targets: [
    .target(
      name: "DirectorCore",
      swiftSettings: [ .swiftLanguageMode(.v6) ],
      linkerSettings: [ .linkedLibrary("sqlite3") ]
    ),
    // Run on the Mac with `swift test`.
    .testTarget(
      name: "DirectorCoreTests",
      dependencies: [ "DirectorCore" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
