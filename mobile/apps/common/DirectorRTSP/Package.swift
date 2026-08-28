// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DirectorRTSP",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "DirectorRTSP", targets: [ "DirectorRTSP" ])
  ],
  dependencies: [
    .package(path: "../DirectorCore"),
    .package(path: "../DirectorSources")
  ],
  targets: [
    .target(
      name: "DirectorRTSP",
      dependencies: [ "DirectorCore", "DirectorSources" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
