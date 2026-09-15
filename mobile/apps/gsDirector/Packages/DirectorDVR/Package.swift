// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DirectorDVR",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "DirectorDVR", targets: [ "DirectorDVR" ])
  ],
  dependencies: [
    .package(path: "../../common/DirectorCore"),
    .package(path: "../../../common/DirectorExport"),
    .package(path: "../../common/DirectorSources"),
    .package(path: "../DirectorPipeline")
  ],
  targets: [
    .target(
      name: "DirectorDVR",
      dependencies: [ "DirectorCore", "DirectorExport", "DirectorSources", "DirectorPipeline" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
