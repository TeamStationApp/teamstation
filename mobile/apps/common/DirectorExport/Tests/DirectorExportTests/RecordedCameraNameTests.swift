import Foundation
import DirectorCore
import DirectorExport
import Testing

/// A take remembers what its cameras were called, so a camera the Director has since forgotten is
/// still shown by name, and TS Distributor can key what it remembers by that name.
@Suite("Recorded camera names")
struct RecordedCameraNameTests {
  private static let home = SourceID("6F1C2A0E-0000-4000-8000-000000000001")
  private static let away = SourceID("6F1C2A0E-0000-4000-8000-000000000002")
  private static let wide = SourceID("6F1C2A0E-0000-4000-8000-000000000003")

  private func temporaryRoot() throws -> URL {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("camera-names-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }

  @Test("The name a camera joined with is kept, and noting it again without one does not erase it")
  func joinNameIsKept() throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let recordingID = try index.beginRecording(at: WallClock(seconds: 1_000))

    try index.noteSource(
      recordingID: recordingID, sourceID: Self.home, transport: "rtsp", archiving: true, cameraName: "Home"
    )
    try index.noteSource(recordingID: recordingID, sourceID: Self.home, transport: "rtsp", archiving: true)

    #expect(try index.sources(forRecording: recordingID).first?.cameraName == "Home")
    #expect(try index.recordedCameraNames(recordingID: recordingID) == [ Self.home: "Home" ])
  }

  @Test("A rename during the take replaces the stored name")
  func renameMidTake() throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let recordingID = try index.beginRecording(at: WallClock(seconds: 1_000))
    try index.noteSource(
      recordingID: recordingID, sourceID: Self.home, transport: "rtsp", archiving: true, cameraName: "Home"
    )

    try index.nameSource(recordingID: recordingID, sourceID: Self.home, cameraName: "Home Plate")
    #expect(try index.recordedCameraNames(recordingID: recordingID)[Self.home] == "Home Plate")

    // Naming a camera that is not part of the take leaves the take alone.
    try index.nameSource(recordingID: recordingID, sourceID: Self.away, cameraName: "Away")
    #expect(try index.recordedCameraNames(recordingID: recordingID)[Self.away] == nil)
  }

  @Test("An older take falls back to its grid snapshot, preferring the operator's own name")
  func snapshotFallback() throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let recordingID = try index.beginRecording(at: WallClock(seconds: 1_000))
    let grid = """
      [
        {"id":{"rawValue":"\(Self.home.rawValue)"},"kind":"rtsp","advertisedName":"NearStream 1","customName":"Home"},
        {"id":{"rawValue":"\(Self.away.rawValue)"},"kind":"rtsp","advertisedName":"Away","customName":"  "},
        {"id":{"rawValue":"\(Self.wide.rawValue)"},"kind":"rtsp","advertisedName":"Wide"}
      ]
      """
    try index.saveSelections(Data(grid.utf8), for: recordingID)
    // A name stored for the take wins over the snapshot.
    try index.noteSource(
      recordingID: recordingID, sourceID: Self.wide, transport: nil, archiving: true, cameraName: "Outfield"
    )

    #expect(
      try index.recordedCameraNames(recordingID: recordingID)
        == [ Self.home: "Home", Self.away: "Away", Self.wide: "Outfield" ]
    )
  }

  @Test("A take with no names on record has none to give")
  func noNames() throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let recordingID = try index.beginRecording(at: WallClock(seconds: 1_000))
    try index.noteSource(recordingID: recordingID, sourceID: Self.home, transport: "rtsp", archiving: true)

    #expect(try index.recordedCameraNames(recordingID: recordingID).isEmpty)
  }

  @Test("An index made before camera names existed gains the column when it is opened")
  func migratesOlderIndex() throws {
    let root = try temporaryRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let url = root.appendingPathComponent("index.sqlite")
    do {
      let store = try SQLiteStore(url: url)
      try store.execute("""
        CREATE TABLE recording_sources (
          recording_id INTEGER NOT NULL,
          source_id TEXT NOT NULL,
          transport TEXT,
          archiving INTEGER NOT NULL DEFAULT 1,
          reason TEXT,
          PRIMARY KEY (recording_id, source_id)
        );
        """)
      try store.execute(
        "INSERT INTO recording_sources (recording_id, source_id, archiving) VALUES (7, ?, 1);",
        [ .text(Self.home.rawValue) ]
      )
      store.close()
    }

    let index = try ArchiveIndex(url: url)
    #expect(try index.sources(forRecording: 7).first?.cameraName == nil)
    try index.nameSource(recordingID: 7, sourceID: Self.home, cameraName: "Home")
    #expect(try index.recordedCameraNames(recordingID: 7) == [ Self.home: "Home" ])
  }
}
