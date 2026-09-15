import DirectorCore
import DistributorWire
import Foundation
import MacState
import Testing

@Suite("Mac state")
struct MacStateTests {
  static func folder() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("gs-macstate-\(UUID().uuidString)", isDirectory: true)
  }

  @Test("Settings start at their defaults, and what is saved is what comes back")
  func settingsRoundTrip() throws {
    let folder = Self.folder()
    defer { try? FileManager.default.removeItem(at: folder) }
    let state = MacState(folder: folder)
    #expect(state.settings() == DistributorSettings())

    var settings = DistributorSettings(destinations: [ "MAC-1": "/Movies/GS" ], createCombined: true)
    settings.stamps["createCombined"] = SettingsStamp(modifiedAt: Date(timeIntervalSince1970: 1_800_000_000), by: "MAC-1")
    try state.saveSettings(settings)
    #expect(MacState(folder: folder).settings() == settings)
    #expect(FileManager.default.fileExists(atPath: folder.appendingPathComponent("settings.json").path))
  }

  @Test("The journal keeps when each iPad was last met across launches")
  func journal() throws {
    let folder = Self.folder()
    defer { try? FileManager.default.removeItem(at: folder) }
    let when = Date(timeIntervalSince1970: 1_800_000_000)
    try MacState(folder: folder).updateJournal { $0.lastSynced["D1"] = when }
    #expect(MacState(folder: folder).journal().lastSynced["D1"] == when)
  }

  @Test("Each iPad's last recording list is kept, the newest first")
  func recordings() throws {
    let folder = Self.folder()
    defer { try? FileManager.default.removeItem(at: folder) }
    let state = MacState(folder: folder)
    let listing = RecordingListing(
      id: 361,
      startedAt: WallClock(seconds: 1_000),
      endedAt: WallClock(seconds: 4_600),
      isLive: false,
      hasPrimary: true,
      cameras: [],
      preparedTracks: []
    )
    let first = DirectorRecord(directorID: UUID(), deviceName: "Field iPad")
    let second = DirectorRecord(directorID: UUID(), deviceName: "Spare iPad")
    try state.saveRecordings([ listing ], director: first)
    try state.saveRecordings([], director: second)
    let cached = state.cachedRecordings()
    #expect(cached.map(\.director) == [ second, first ])
    #expect(cached.last?.recordings == [ listing ])
  }
}
