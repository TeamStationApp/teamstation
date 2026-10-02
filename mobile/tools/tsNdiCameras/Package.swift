// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "tsNdiCameras",
  platforms: [ .macOS(.v14) ],
  targets: [
    // The macOS NDI dylib and headers, staged by `scripts/bootstrapNdiTools.sh` from the same
    // installer Director's library comes from. Not committed, for the same reason.
    .systemLibrary(name: "CNDIMac", path: "Sources/CNDIMac"),
    .executableTarget(
      name: "tsNdiCameras",
      dependencies: [ "CNDIMac" ],
      swiftSettings: [ .swiftLanguageMode(.v6) ],
      // The dylib is staged into Vendor/ by scripts/bootstrapNdiTools.sh and records itself as
      // @rpath/libndi.dylib, so the rpath points back at that directory rather than at the build
      // output. Nothing has to be installed system-wide and DYLD_LIBRARY_PATH is never needed.
      linkerSettings: [
        .unsafeFlags([ "-L", "Vendor", "-lndi", "-Xlinker", "-rpath", "-Xlinker", "@loader_path/../../../Vendor",
          "-Xlinker", "-rpath", "-Xlinker", "@loader_path/../../Vendor",
          "-Xlinker", "-rpath", "-Xlinker", "@loader_path" ])
      ]
    )
  ]
)
