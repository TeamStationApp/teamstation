import DistributorWire
import Foundation

/// TS Distributor's one folder on the Mac. Everything it keeps between launches is a JSON file
/// here, written whole and atomically, so a crash leaves the old file or the new one and never
/// half of either.
public final class MacState: @unchecked Sendable {
  public static let keychainPrefix = "app.teamstation.distributor"

  public static var standardFolder: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("TS Distributor", isDirectory: true)
  }

  public let folder: URL
  private let lock = NSLock()

  public init(folder: URL = MacState.standardFolder) {
    self.folder = folder
  }

  var settingsURL: URL { folder.appendingPathComponent("settings.json") }
  var syncURL: URL { folder.appendingPathComponent("sync.json") }
  var recordingsFolder: URL { folder.appendingPathComponent("recordings", isDirectory: true) }

  // MARK: - Settings

  /// The Mac's copy of the settings, or the defaults before there is one.
  public func settings() -> DistributorSettings {
    read(DistributorSettings.self, from: settingsURL) ?? DistributorSettings()
  }

  public func saveSettings(_ settings: DistributorSettings) throws {
    try write(settings, to: settingsURL)
  }

  // MARK: - What is still to go to the iPad

  public func journal() -> SyncJournal {
    read(SyncJournal.self, from: syncURL) ?? SyncJournal()
  }

  public func updateJournal(_ change: (inout SyncJournal) -> Void) throws {
    try lock.withLock {
      var journal = readUnlocked(SyncJournal.self, from: syncURL) ?? SyncJournal()
      change(&journal)
      try writeUnlocked(journal, to: syncURL)
    }
  }

  // MARK: - Recordings last seen

  /// Saves what an iPad listed, so the Distributor can show it while that iPad is away.
  public func saveRecordings(_ recordings: [RecordingListing], director: DirectorRecord) throws {
    let cached = CachedRecordings(director: director, savedAt: Date(), recordings: recordings)
    try write(cached, to: recordingsFolder.appendingPathComponent("\(director.directorID.uuidString).json"))
  }

  /// Every iPad's last list, the most recently saved first.
  public func cachedRecordings() -> [CachedRecordings] {
    let files = (try? FileManager.default.contentsOfDirectory(at: recordingsFolder, includingPropertiesForKeys: nil)) ?? []
    return files
      .filter { $0.pathExtension == "json" }
      .compactMap { read(CachedRecordings.self, from: $0) }
      .sorted { $0.savedAt > $1.savedAt }
  }

  // MARK: - Files

  private func read<Value: Decodable>(_ type: Value.Type, from url: URL) -> Value? {
    lock.withLock { readUnlocked(type, from: url) }
  }

  private func write<Value: Encodable>(_ value: Value, to url: URL) throws {
    try lock.withLock { try writeUnlocked(value, to: url) }
  }

  private func readUnlocked<Value: Decodable>(_ type: Value.Type, from url: URL) -> Value? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(Value.self, from: data)
  }

  private func writeUnlocked<Value: Encodable>(_ value: Value, to url: URL) throws {
    // Dates keep their default encoding, as on the wire, so a settings stamp read back from here
    // compares equal to the same stamp on the iPad.
    let encoder = JSONEncoder()
    encoder.outputFormatting = [ .prettyPrinted, .sortedKeys ]
    let data = try encoder.encode(value)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: url, options: .atomic)
  }
}

/// What the Mac keeps about its meetings with each iPad.
public struct SyncJournal: Codable, Equatable, Sendable {
  /// When the settings were last brought together with each iPad, by `Hello.directorID`.
  public var lastSynced: [String: Date]

  public init(lastSynced: [String: Date] = [:]) {
    self.lastSynced = lastSynced
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    lastSynced = try container.decodeIfPresent([String: Date].self, forKey: .lastSynced) ?? [:]
  }
}

/// Which TS Director a cached list came from.
public struct DirectorRecord: Codable, Equatable, Sendable {
  public var directorID: UUID
  public var deviceName: String

  public init(directorID: UUID, deviceName: String) {
    self.directorID = directorID
    self.deviceName = deviceName
  }
}

public struct CachedRecordings: Codable, Equatable, Sendable {
  public var director: DirectorRecord
  public var savedAt: Date
  public var recordings: [RecordingListing]
}
