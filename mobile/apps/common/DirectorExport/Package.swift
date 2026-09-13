// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DirectorExport",
  platforms: [ .iOS(.v18), .macOS(.v15) ],
  products: [
    .library(name: "DirectorExport", targets: [ "DirectorExport" ])
  ],
  dependencies: [
    .package(path: "../DirectorCore")
  ],
  targets: [
    .target(
      name: "DirectorExport",
      dependencies: [ "DirectorCore" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
