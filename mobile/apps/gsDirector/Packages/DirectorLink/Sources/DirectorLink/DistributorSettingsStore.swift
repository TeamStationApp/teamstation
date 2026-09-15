import DirectorCore
import DistributorWire
import Foundation

/// GS Distributor's settings, kept by GS Director in their own file beside its own settings.
/// The Mac holds none of this between launches.
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

  /// What a Mac's save becomes: everything it sent, except that it may only change its own
  /// download folder. Other Macs' folders stay as they were.
  public static func merge(
    _ incoming: DistributorSettings,
    into stored: DistributorSettings,
    mac: String?
  ) -> DistributorSettings {
    var merged = incoming
    var destinations = stored.destinations
    if let mac {
      destinations[mac] = incoming.destinations[mac]
    }
    merged.destinations = destinations
    return merged
  }
}
