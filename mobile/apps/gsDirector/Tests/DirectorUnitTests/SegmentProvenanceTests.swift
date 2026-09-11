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

@Suite("Programme anchors")
struct ProgramAnchorTests {
  private func index() throws -> (ArchiveIndex, URL) {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("anchor-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return (try ArchiveIndex(url: root.appendingPathComponent("index.sqlite")), root)
  }

  @Test("An anchor says where a part's own timeline starts in real time")
  func partStartFromAnchor() throws {
    let (index, root) = try index()
    defer { try? FileManager.default.removeItem(at: root) }
    let recording = try index.beginRecording(at: WallClock(seconds: 1_000))
    // Nine seconds into part one, and it was 1009 — so part one began at 1000.
    try index.insertProgramAnchor(
      recordingID: recording, part: 1, programSeconds: 9, wall: WallClock(seconds: 1_009)
    )
    let anchors = try index.programAnchors(recordingID: recording)
    #expect(anchors.count == 1)
    #expect(abs(anchors[0].partStartWall - WallClock(seconds: 1_000)) < 0.001)
  }

  @Test("A recovered writer's continuation part is placed where it resumed, not where the last ended")
  func continuationPartKeepsItsGap() throws {
    let (index, root) = try index()
    defer { try? FileManager.default.removeItem(at: root) }
    let recording = try index.beginRecording(at: WallClock(seconds: 1_000))
    // Part one ran from 1000. Part two opened at 1050 after a recovery that cost 20 s — the old
    // behaviour butted it against part one and silently discarded that interval.
    for seconds in stride(from: 3.0, through: 27.0, by: 3.0) {
      try index.insertProgramAnchor(
        recordingID: recording, part: 1, programSeconds: seconds,
        wall: WallClock(seconds: 1_000 + seconds)
      )
    }
    for seconds in stride(from: 3.0, through: 12.0, by: 3.0) {
      try index.insertProgramAnchor(
        recordingID: recording, part: 2, programSeconds: seconds,
        wall: WallClock(seconds: 1_050 + seconds)
      )
    }
    let starts = try index.programPartStarts(recordingID: recording)
    #expect(starts.count == 2)
    #expect(abs((starts[1] ?? WallClock(seconds: 0)) - WallClock(seconds: 1_000)) < 0.001)
    #expect(abs((starts[2] ?? WallClock(seconds: 0)) - WallClock(seconds: 1_050)) < 0.001)
    // Fifty seconds apart, of which thirty were written: the twenty-second hole is now visible
    // rather than being absorbed into the join.
    let gap = (starts[2] ?? WallClock(seconds: 0)) - (starts[1] ?? WallClock(seconds: 0))
    #expect(abs(gap - 50) < 0.001)
  }

  /// rec-409 opened on a phone picture whose capture time was half a second too young, and the
  /// first anchor alone placed the whole of part one 0.47 s behind the cameras.
  @Test("One bad anchor does not move a part: the part starts where most of its anchors say")
  func partStartIgnoresAnOutlier() throws {
    let (index, root) = try index()
    defer { try? FileManager.default.removeItem(at: root) }
    let recording = try index.beginRecording(at: WallClock(seconds: 1_000))
    try index.insertProgramAnchor(
      recordingID: recording, part: 1, programSeconds: 0, wall: WallClock(seconds: 1_000.47)
    )
    for seconds in stride(from: 3.0, through: 30.0, by: 3.0) {
      try index.insertProgramAnchor(
        recordingID: recording, part: 1, programSeconds: seconds,
        wall: WallClock(seconds: 1_000 + seconds)
      )
    }
    let start = try #require(try index.programPartStarts(recordingID: recording)[1])
    #expect(abs(start - WallClock(seconds: 1_000)) < 0.001, "part one placed at \(start.seconds)")
  }

  /// rec-409's shape: most anchors from phone pictures that anchored 0.45 s late, the rest from a
  /// camera whose capture time was honest. The part starts where the honest ones say.
  @Test("A late majority of anchors does not outvote the honest ones")
  func partStartFollowsTheEarliestAgreeingAnchors() throws {
    let (index, root) = try index()
    defer { try? FileManager.default.removeItem(at: root) }
    let recording = try index.beginRecording(at: WallClock(seconds: 1_000))
    for step in 0..<60 {
      let seconds = Double(step) * 3
      let late = step % 3 != 0
      try index.insertProgramAnchor(
        recordingID: recording, part: 1, programSeconds: seconds,
        wall: WallClock(seconds: 1_000 + seconds + (late ? 0.45 : 0.01 * Double(step % 2)))
      )
    }
    let start = try #require(try index.programPartStarts(recordingID: recording)[1])
    #expect(abs(start - WallClock(seconds: 1_000)) < 0.02, "part one placed at \(start.seconds)")
  }

  @Test("A take with no anchors reports none rather than guessing")
  func noAnchorsIsEmpty() throws {
    let (index, root) = try index()
    defer { try? FileManager.default.removeItem(at: root) }
    let recording = try index.beginRecording(at: WallClock(seconds: 2_000))
    #expect(try index.programPartStarts(recordingID: recording).isEmpty)
  }
}
