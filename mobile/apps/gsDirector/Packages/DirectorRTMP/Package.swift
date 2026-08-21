// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "DirectorRTMP",
  platforms: [ .iOS(.v18) ],
  products: [
    .library(name: "DirectorRTMP", targets: [ "DirectorRTMP" ])
  ],
  targets: [
    .target(
      name: "DirectorRTMP",
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
