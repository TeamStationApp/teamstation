import Foundation
import DirectorCore
import DirectorExport
import Testing

/// A recording the app never got to close.
///
/// The 2026-09-05 crash left sixteen of these in the index. Each one reported `now - startedAt`
/// as its length, so a 74-minute take read as six hours and grew by a second every second, and
/// the export path skipped it because it had no end.
@Suite("Interrupted recordings")
struct ArchiveIndexInterruptedTests {
  @Test("An unclosed take is as long as the media it wrote, not as long as the app has been up")
  func durationComesFromSegments() throws {
    let index = try makeIndex()
    let source = SourceID("cam-0")
    let start = WallClock(seconds: 1_000)
    let id = try index.beginRecording(at: start)
    try seed(index: index, recording: id, source: source, start: start, segments: 4, each: 6)

    let summary = try #require(try index.recordings().first { $0.id == id })
    #expect(summary.endedAt == nil)
    #expect(summary.wasInterrupted)
    #expect(abs(summary.duration - 24) < 0.001)

    // The old fallback read the wall clock, so the same row measured twice gave two answers.
    let again = try #require(try index.recordings().first { $0.id == id })
    #expect(summary.duration == again.duration)
  }

  @Test("Closing an interrupted take sets its end to the last segment")
  func closingSetsTheEnd() throws {
    let index = try makeIndex()
    let source = SourceID("cam-0")
    let start = WallClock(seconds: 5_000)
    let id = try index.beginRecording(at: start)
    try seed(index: index, recording: id, source: source, start: start, segments: 3, each: 10)

    #expect(try index.closeAbandonedRecordings() == 1)

    let summary = try #require(try index.recordings().first { $0.id == id })
    let ended = try #require(summary.endedAt)
    #expect(abs(ended.seconds - (start.seconds + 30)) < 0.001)
    #expect(abs(summary.duration - 30) < 0.001)
    #expect(!summary.wasInterrupted)
    // Idempotent: a second launch has nothing left to close.
    #expect(try index.closeAbandonedRecordings() == 0)
  }

  @Test("A take that wrote nothing closes at its start rather than inventing a length")
  func emptyTakeClosesAtItsStart() throws {
    let index = try makeIndex()
    let start = WallClock(seconds: 9_000)
    let id = try index.beginRecording(at: start)

    #expect(try index.closeAbandonedRecordings() == 1)

    let summary = try #require(try index.recordings().first { $0.id == id })
    #expect(summary.endedAt?.seconds == start.seconds)
    #expect(summary.duration == 0)
  }

  @Test("Initialisation segments carry no media and do not extend the take")
  func initializationSegmentsAreNotMedia() throws {
    let index = try makeIndex()
    let source = SourceID("cam-0")
    let start = WallClock(seconds: 2_000)
    let id = try index.beginRecording(at: start)
    _ = try index.insertSegment(
      recordingID: id,
      sourceID: source,
      sequence: 0,
      filename: "init.mp4",
      isInitialization: true,
      startWall: WallClock(seconds: start.seconds + 500),
      duration: 0,
      byteCount: 800,
      firstFrameID: nil
    )
    try seed(index: index, recording: id, source: source, start: start, segments: 2, each: 5)

    let summary = try #require(try index.recordings().first { $0.id == id })
    #expect(abs(summary.duration - 10) < 0.001)
  }

  @Test("A closed take keeps the end it was given")
  func closingLeavesFinishedTakesAlone() throws {
    let index = try makeIndex()
    let source = SourceID("cam-0")
    let start = WallClock(seconds: 3_000)
    let id = try index.beginRecording(at: start)
    try seed(index: index, recording: id, source: source, start: start, segments: 2, each: 7)
    try index.endRecording(id, at: WallClock(seconds: start.seconds + 100))

    #expect(try index.closeAbandonedRecordings() == 0)
    let summary = try #require(try index.recordings().first { $0.id == id })
    #expect(summary.endedAt?.seconds == start.seconds + 100)
    #expect(abs(summary.duration - 100) < 0.001)
  }

  // MARK: - Helpers

  private func makeIndex() throws -> ArchiveIndex {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("rec-interrupted-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
  }

  private func seed(
    index: ArchiveIndex,
    recording: Int64,
    source: SourceID,
    start: WallClock,
    segments: Int,
    each seconds: TimeInterval
  ) throws {
    for sequence in 0 ..< segments {
      _ = try index.insertSegment(
        recordingID: recording,
        sourceID: source,
        sequence: sequence + 1,
        filename: "seg-\(sequence).mp4",
        isInitialization: false,
        startWall: WallClock(seconds: start.seconds + Double(sequence) * seconds),
        duration: seconds,
        byteCount: 1_024,
        firstFrameID: nil
      )
    }
  }
}
