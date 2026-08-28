// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DirectorSources",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "DirectorSources", targets: [ "DirectorSources" ])
  ],
  dependencies: [
    .package(path: "../DirectorCore")
  ],
  targets: [
    .target(
      name: "DirectorSources",
      dependencies: [ "DirectorCore" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
