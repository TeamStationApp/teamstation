// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "PreviewCore",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "PreviewCore", targets: [ "PreviewCore" ])
  ],
  dependencies: [
    .package(path: "../../common/DirectorCore"),
    .package(path: "../../common/DirectorSources")
  ],
  targets: [
    .target(
      name: "PreviewCore",
      dependencies: [ "DirectorCore", "DirectorSources" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
