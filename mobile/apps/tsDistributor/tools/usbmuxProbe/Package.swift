// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "usbmuxProbe",
  platforms: [ .macOS(.v15) ],
  targets: [
    .executableTarget(
      name: "usbmuxProbe",
      swiftSettings: [ .swiftLanguageMode(.v6) ]
    )
  ]
)
