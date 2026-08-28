import Foundation

/// Every on-disk location the app uses, in one place, so the Node container-assertion
/// scripts and the Swift code cannot drift apart.
public enum DirectorPaths {
  public static var applicationSupport: URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return base.appendingPathComponent("GSDirector", isDirectory: true)
  }

  public static var documents: URL {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
  }

  /// Per-camera fMP4 segments, one subdirectory per source slug.
  public static var archives: URL { applicationSupport.appendingPathComponent("Archives", isDirectory: true) }

  /// Chunked JPEG blobs backing the 1 fps scrubbing proxy.
  public static var proxies: URL { applicationSupport.appendingPathComponent("Proxies", isDirectory: true) }

  /// Master program output files.
  public static var program: URL { documents.appendingPathComponent("Program", isDirectory: true) }

  /// Export destination, in Documents so it is reachable over Files / iTunes sharing.
  public static var exports: URL { documents.appendingPathComponent("Exports", isDirectory: true) }

  /// Operator-placed Output overlays (images and the saved layout).
  public static var overlays: URL { applicationSupport.appendingPathComponent("Overlays", isDirectory: true) }

  /// Named remote-control templates (button chords → director actions).
  public static var remoteControl: URL {
    applicationSupport.appendingPathComponent("RemoteControl", isDirectory: true)
  }

  public static var overlayManifest: URL { overlays.appendingPathComponent("overlays.json") }

  /// SQLite wall-clock index shared by the archive and the proxy store.
  public static var indexDatabase: URL { applicationSupport.appendingPathComponent("index.sqlite") }

  /// Telemetry JSON written by `gsdirector://test/dump-state`, read by scripts/verifyArchive.js.
  public static var telemetryDump: URL { documents.appendingPathComponent("telemetry.json") }

  public static func archiveDirectory(for source: SourceID) -> URL {
    archives.appendingPathComponent(source.slug, isDirectory: true)
  }

  public static func proxyDirectory(for source: SourceID) -> URL {
    proxies.appendingPathComponent(source.slug, isDirectory: true)
  }

  public static func createAll() throws {
    let manager = FileManager.default
    for url in [ applicationSupport, archives, proxies, program, exports, overlays, remoteControl ] {
      try manager.createDirectory(at: url, withIntermediateDirectories: true)
    }
  }

  /// Free space on the volume backing the archives, used by the disk headroom guard.
  public static func freeDiskBytes() -> Int64 {
    let values = try? applicationSupport.resourceValues(forKeys: [ .volumeAvailableCapacityForImportantUsageKey ])
    return values?.volumeAvailableCapacityForImportantUsage ?? 0
  }
}
