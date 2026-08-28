// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DirectorCore",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "DirectorCore", targets: [ "DirectorCore" ])
  ],
  targets: [
    .target(
      name: "DirectorCore",
      swiftSettings: [ .swiftLanguageMode(.v6) ],
      linkerSettings: [ .linkedLibrary("sqlite3") ]
    )
  ]
)
