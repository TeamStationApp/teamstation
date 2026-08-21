// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DirectorDVR",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "DirectorDVR", targets: [ "DirectorDVR" ])
  ],
  dependencies: [
    .package(path: "../DirectorCore"),
    .package(path: "../DirectorSources"),
    .package(path: "../DirectorPipeline")
  ],
  targets: [
    .target(
      name: "DirectorDVR",
      dependencies: [ "DirectorCore", "DirectorSources", "DirectorPipeline" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
