import DirectorCore
import DistributorWire
import Foundation

/// TS Distributor's settings, kept by TS Director in their own file beside its own settings. The
/// Mac keeps a copy too, and the two are brought together whenever it attaches.
public final class DistributorSettingsStore: @unchecked Sendable {
  public static var standardURL: URL {
    DirectorPaths.applicationSupport
      .appendingPathComponent("Distributor", isDirectory: true)
      .appendingPathComponent("settings.json")
  }

  private let url: URL
  private let lock = NSLock()

  public init(url: URL = DistributorSettingsStore.standardURL) {
    self.url = url
  }

  /// The saved settings, or the defaults when there are none or they cannot be read.
  public func load() -> DistributorSettings {
    lock.withLock {
      guard let data = try? Data(contentsOf: url),
            let settings = try? JSONDecoder().decode(DistributorSettings.self, from: data)
      else { return DistributorSettings() }
      return settings
    }
  }

  public func save(_ settings: DistributorSettings) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [ .prettyPrinted, .sortedKeys ]
    let data = try encoder.encode(settings)
    try lock.withLock {
      try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      try data.write(to: url, options: .atomic)
    }
  }

  /// What a Mac's save becomes. Each group comes from whichever copy changed it last, so a Mac
  /// that was away cannot undo a newer change made here or by another Mac; a Mac that stamps
  /// nothing, from before stamps, has everything it sent taken. Either way a Mac may only change
  /// its own download folder: other Macs' folders stay as they were.
  public static func merge(
    _ incoming: DistributorSettings,
    into stored: DistributorSettings,
    mac: String?
  ) -> DistributorSettings {
    let chosen = incoming.stamps.isEmpty ? incoming : incoming.reconciled(with: stored)
    var merged = chosen
    merged.destinations = stored.destinations
    for key in merged.stamps.keys where key.hasPrefix("destination:") {
      merged.stamps[key] = stored.stamps[key]
    }
    if let mac {
      let key = SettingsGroup.destination(mac: mac).key
      merged.destinations[mac] = chosen.destinations[mac]
      merged.stamps[key] = chosen.stamps[key]
    }
    return merged
  }
}
