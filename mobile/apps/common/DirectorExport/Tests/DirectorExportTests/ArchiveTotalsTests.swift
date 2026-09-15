import Foundation
import DirectorCore
import DirectorExport
import Testing

@Suite("Archive totals")
struct ArchiveTotalsTests {
  @Test("Bytes are totalled per recording and camera")
  func bytesBySource() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("archive-totals-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let first = try index.beginRecording(at: WallClock(seconds: 1_000))
    let second = try index.beginRecording(at: WallClock(seconds: 2_000))
    let rows: [(Int64, String, Int, Int64)] = [
      (first, "cam-a", 1, 100), (first, "cam-a", 2, 50), (first, "cam-b", 1, 7), (second, "cam-a", 1, 3)
    ]
    for (recording, source, sequence, bytes) in rows {
      try index.insertSegment(
        recordingID: recording,
        sourceID: SourceID(source),
        sequence: sequence,
        filename: "seg-\(sequence).mp4",
        isInitialization: false,
        startWall: WallClock(seconds: 1_000),
        duration: 3,
        byteCount: bytes,
        firstFrameID: nil
      )
    }

    let totals = try index.bytesBySource()
    #expect(totals[first] == [ SourceID("cam-a"): 150, SourceID("cam-b"): 7 ])
    #expect(totals[second] == [ SourceID("cam-a"): 3 ])
  }
}
