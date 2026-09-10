import Foundation
import DirectorCore
import DirectorDVR
import Testing

@Suite("Segment provenance")
struct SegmentProvenanceTests {
  private func index() throws -> (ArchiveIndex, URL) {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("prov-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return (try ArchiveIndex(url: root.appendingPathComponent("index.sqlite")), root)
  }

  @Test("A segment remembers the transport, the correction and the rate it was written at")
  func roundTripsProvenance() throws {
    let (index, root) = try index()
    defer { try? FileManager.default.removeItem(at: root) }
    let source = SourceID("cam-0")
    let recording = try index.beginRecording(at: WallClock(seconds: 1_000))
    try index.insertSegment(
      recordingID: recording,
      sourceID: source,
      sequence: 1,
      filename: "seg-00001.mp4",
      isInitialization: false,
      startWall: WallClock(seconds: 1_000),
      duration: 3,
      byteCount: 4,
      firstFrameID: 1,
      transport: "ndi",
      appliedClockOffset: -0.42,
      archiveRate: 15
    )
    let segments = try index.segments(
      for: source,
      from: WallClock(seconds: 1_000),
      to: WallClock(seconds: 1_003)
    )
    #expect(segments.count == 1)
    #expect(segments[0].transport == "ndi")
    #expect(abs((segments[0].appliedClockOffset ?? 0) + 0.42) < 0.001)
    // Half of a nominal 30 fps camera: the decimated case, which is why a flat one-frame
    // tolerance cannot be assumed.
    #expect(abs((segments[0].archiveRate ?? 0) - 15) < 0.001)
  }

  @Test("An archive written before the columns existed still reads")
  func oldRowsReadAsUnknown() throws {
    let (index, root) = try index()
    defer { try? FileManager.default.removeItem(at: root) }
    let source = SourceID("cam-1")
    let recording = try index.beginRecording(at: WallClock(seconds: 2_000))
    try index.insertSegment(
      recordingID: recording,
      sourceID: source,
      sequence: 1,
      filename: "seg-00001.mp4",
      isInitialization: false,
      startWall: WallClock(seconds: 2_000),
      duration: 3,
      byteCount: 4,
      firstFrameID: 1
    )
    let segments = try index.segments(
      for: source,
      from: WallClock(seconds: 2_000),
      to: WallClock(seconds: 2_003)
    )
    #expect(segments[0].transport == nil)
    #expect(segments[0].appliedClockOffset == nil)
    #expect(segments[0].archiveRate == nil)
  }

  @Test("A camera that was live but never archived is nameable at export")
  func recordsUnarchivedSource() throws {
    let (index, root) = try index()
    defer { try? FileManager.default.removeItem(at: root) }
    let recording = try index.beginRecording(at: WallClock(seconds: 3_000))
    try index.noteSource(
      recordingID: recording,
      sourceID: SourceID("cam-a"),
      transport: "ndi",
      archiving: true
    )
    // Past the encode budget: previews and cuts to programme, writes nothing. Without this row an
    // export cannot tell it from a camera the operator never selected.
    try index.noteSource(
      recordingID: recording,
      sourceID: SourceID("cam-b"),
      transport: "ndi",
      archiving: false,
      reason: "archive encode budget"
    )
    let sources = try index.sources(forRecording: recording)
    #expect(sources.count == 2)
    #expect(sources[0].archiving)
    #expect(!sources[1].archiving)
    #expect(sources[1].reason == "archive encode budget")
    #expect(sources[1].transport == "ndi")
  }

  @Test("Noting a source twice updates rather than duplicating")
  func noteIsIdempotent() throws {
    let (index, root) = try index()
    defer { try? FileManager.default.removeItem(at: root) }
    let recording = try index.beginRecording(at: WallClock(seconds: 4_000))
    let source = SourceID("cam-c")
    try index.noteSource(recordingID: recording, sourceID: source, transport: "rtsp", archiving: true)
    try index.noteSource(
      recordingID: recording,
      sourceID: source,
      transport: "rtsp",
      archiving: false,
      reason: "encoder stopped"
    )
    let sources = try index.sources(forRecording: recording)
    #expect(sources.count == 1)
    #expect(!sources[0].archiving)
    #expect(sources[0].reason == "encoder stopped")
  }
}
