import Foundation
import DirectorCore
import DirectorExport
import Testing

/// What the index remembers about a take that is still rolling.
///
/// The app used to keep all of this in memory, so a crash took it with it: the take was closed
/// from its segments at the next launch and everything about how it was being recorded — which
/// cameras, which one was on air, how far the programme had got — was gone. These are the rows
/// that survive the process.
@Suite("Live session index")
struct LiveSessionIndexTests {
  @Test("The take a live session names survives the sweep that closes the rest")
  func liveTakeSurvivesTheSweep() throws {
    let index = try makeIndex()
    let source = SourceID("cam-0")
    let old = try index.beginRecording(at: WallClock(seconds: 1_000))
    try seed(index: index, recording: old, source: source, start: WallClock(seconds: 1_000))
    let live = try index.beginRecording(at: WallClock(seconds: 5_000))
    try seed(index: index, recording: live, source: source, start: WallClock(seconds: 5_000))
    try index.openLiveSession(recordingID: live, at: WallClock(seconds: 5_000))

    #expect(try index.closeAbandonedRecordings(except: live) == 1)

    let summaries = try index.recordings()
    #expect(try #require(summaries.first { $0.id == old }).endedAt != nil)
    #expect(try #require(summaries.first { $0.id == live }).endedAt == nil)
    #expect(try index.liveRecording()?.id == live)
  }

  @Test("A take from a build that never had a live session closes as it always did")
  func legacyOpenTakeIsClosed() throws {
    let index = try makeIndex()
    let source = SourceID("cam-0")
    let start = WallClock(seconds: 2_000)
    let id = try index.beginRecording(at: start)
    try seed(index: index, recording: id, source: source, start: start, segments: 3, each: 10)

    #expect(try index.liveSession() == nil)
    #expect(try index.liveRecording() == nil)
    #expect(try index.closeAbandonedRecordings(except: nil) == 1)
    #expect(try #require(try index.recordings().first { $0.id == id }).endedAt?.seconds
      == start.seconds + 30)
  }

  @Test("A live session naming a take that has since been closed is stale, not resumable")
  func staleSessionPointerIsCleared() throws {
    let index = try makeIndex()
    let start = WallClock(seconds: 3_000)
    let id = try index.beginRecording(at: start)
    try index.openLiveSession(recordingID: id, at: start)
    try index.endRecording(id, at: WallClock(seconds: 3_600))

    #expect(try index.liveRecording() == nil)
    // The pointer is cleared, and with nothing else live the row goes with it.
    #expect(try index.liveSession() == nil)
  }

  @Test("Recording and streaming open and close their halves independently")
  func halvesAreIndependent() throws {
    let index = try makeIndex()
    let start = WallClock(seconds: 4_000)
    let id = try index.beginRecording(at: start)

    try index.openLiveSession(streaming: true, at: start)
    #expect(try index.liveSession()?.streaming == true)
    #expect(try index.liveSession()?.recordingID == nil)

    try index.openLiveSession(recordingID: id, at: WallClock(seconds: 4_010))
    let both = try #require(try index.liveSession())
    #expect(both.recordingID == id)
    #expect(both.streaming)
    // The session began when the first half did, not when the second joined it.
    #expect(both.startedAt.seconds == start.seconds)

    try index.closeLiveSession(streaming: true)
    #expect(try index.liveSession()?.streaming == false)
    #expect(try index.liveSession()?.recordingID == id)

    try index.closeLiveSession(recording: true)
    #expect(try index.liveSession() == nil)
  }

  @Test("The heartbeat only ever moves forward")
  func heartbeatOnlyMovesForward() throws {
    let index = try makeIndex()
    try index.openLiveSession(streaming: true, at: WallClock(seconds: 100))
    try index.heartbeat(at: WallClock(seconds: 160))
    #expect(try index.liveSession()?.lastAlive.seconds == 160)

    // A clock that went backwards must not make the app look like it has been away for an hour.
    try index.heartbeat(at: WallClock(seconds: 120))
    #expect(try index.liveSession()?.lastAlive.seconds == 160)
  }

  @Test("A thousand heartbeats and a thousand cuts both finish well inside a second")
  func writesAreCheapEnoughToDoOnEveryCut() throws {
    let index = try makeIndex()
    let id = try index.beginRecording(at: WallClock(seconds: 0))
    try index.openLiveSession(recordingID: id, at: WallClock(seconds: 0))

    let cutsStart = Date()
    for step in 0 ..< 1_000 {
      try index.insertProgramCut(
        recordingID: id,
        wall: WallClock(seconds: Double(step)),
        sourceID: SourceID("cam-\(step % 4)"),
        intended: true
      )
    }
    let cutSeconds = Date().timeIntervalSince(cutsStart)

    let beatStart = Date()
    for step in 0 ..< 1_000 {
      try index.heartbeat(at: WallClock(seconds: Double(step)))
    }
    let beatSeconds = Date().timeIntervalSince(beatStart)

    #expect(try index.programCuts(forRecording: id).count == 1_000)
    // A cut is an operator gesture on the main actor; it may not be something they can feel.
    #expect(cutSeconds < 1.0, "1000 cuts took \(cutSeconds)s")
    #expect(beatSeconds < 1.0, "1000 heartbeats took \(beatSeconds)s")
  }

  @Test("The last camera the operator chose is the one a resume puts back on air")
  func lastIntendedCutWins() throws {
    let index = try makeIndex()
    let id = try index.beginRecording(at: WallClock(seconds: 0))
    try index.insertProgramCut(
      recordingID: id, wall: WallClock(seconds: 10), sourceID: SourceID("cam-1"), intended: true
    )
    try index.insertProgramCut(
      recordingID: id, wall: WallClock(seconds: 20), sourceID: SourceID("cam-2"), intended: true
    )
    // cam-2 dropped off and the app fell back on its own. That is not a preference.
    try index.insertProgramCut(
      recordingID: id, wall: WallClock(seconds: 30), sourceID: SourceID("cam-1"), intended: false
    )

    #expect(try index.lastIntendedProgramSource(forRecording: id) == SourceID("cam-2"))
    let cuts = try index.programCuts(forRecording: id)
    #expect(cuts.map(\.sourceID.rawValue) == ["cam-1", "cam-2", "cam-1"])
    #expect(cuts.map(\.intended) == [true, true, false])
  }

  @Test("A resumed programme opens one part past the last one anchored")
  func nextPartFollowsTheAnchors() throws {
    let index = try makeIndex()
    let id = try index.beginRecording(at: WallClock(seconds: 0))
    #expect(try index.nextProgramPart(forRecording: id) == 1)

    try index.insertProgramAnchor(
      recordingID: id, part: 1, programSeconds: 0, wall: WallClock(seconds: 0)
    )
    try index.insertProgramAnchor(
      recordingID: id, part: 1, programSeconds: 3, wall: WallClock(seconds: 3)
    )
    #expect(try index.nextProgramPart(forRecording: id) == 2)

    try index.insertProgramAnchor(
      recordingID: id, part: 2, programSeconds: 0, wall: WallClock(seconds: 120)
    )
    #expect(try index.nextProgramPart(forRecording: id) == 3)
    // Another take's anchors are not this one's.
    let other = try index.beginRecording(at: WallClock(seconds: 500))
    #expect(try index.nextProgramPart(forRecording: other) == 1)
  }

  @Test("The grid a take was recording with round-trips")
  func selectionsRoundTrip() throws {
    let index = try makeIndex()
    let id = try index.beginRecording(at: WallClock(seconds: 0))
    #expect(try index.selections(for: id) == nil)

    let json = Data(#"[{"id":"cam-1","slot":0}]"#.utf8)
    try index.saveSelections(json, for: id)
    #expect(try index.selections(for: id) == json)
  }

  @Test("Resuming is counted on the take")
  func resumesAreCounted() throws {
    let index = try makeIndex()
    let id = try index.beginRecording(at: WallClock(seconds: 0))
    #expect(try #require(try index.recordings().first { $0.id == id }).resumeCount == 0)

    try index.noteResumed(id, at: WallClock(seconds: 300))
    try index.noteResumed(id, at: WallClock(seconds: 600))
    #expect(try #require(try index.recordings().first { $0.id == id }).resumeCount == 2)
  }

  @Test("Deleting a take takes its cuts, anchors, sources and live pointer with it")
  func deleteClearsEverything() throws {
    let index = try makeIndex()
    let roots = try makeRoots()
    let id = try index.beginRecording(at: WallClock(seconds: 0))
    try seed(index: index, recording: id, source: SourceID("cam-0"), start: WallClock(seconds: 0))
    try index.insertProgramCut(
      recordingID: id, wall: WallClock(seconds: 1), sourceID: SourceID("cam-0"), intended: true
    )
    try index.insertProgramAnchor(
      recordingID: id, part: 1, programSeconds: 0, wall: WallClock(seconds: 0)
    )
    _ = try index.noteSource(
      recordingID: id, sourceID: SourceID("cam-0"), transport: "rtsp", archiving: true
    )
    try index.openLiveSession(recordingID: id, streaming: true, at: WallClock(seconds: 0))
    try index.endRecording(id, at: WallClock(seconds: 100))

    try index.deleteRecording(id, roots: roots)

    #expect(try index.programCuts(forRecording: id).isEmpty)
    #expect(try index.programAnchors(recordingID: id).isEmpty)
    #expect(try index.sources(forRecording: id).isEmpty)
    // The stream was still up, so the session row stays — it just no longer names a take.
    #expect(try index.liveSession()?.recordingID == nil)
    #expect(try index.liveSession()?.streaming == true)
  }

  // MARK: - Helpers

  private func makeIndex() throws -> ArchiveIndex {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("live-session-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
  }

  private func makeRoots() throws -> RecordingFileRoots {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("live-session-files-\(UUID().uuidString)", isDirectory: true)
    for leaf in ["Archives", "Program", "Proxies", "Prepared"] {
      try FileManager.default.createDirectory(
        at: root.appendingPathComponent(leaf), withIntermediateDirectories: true
      )
    }
    return RecordingFileRoots(
      archives: root.appendingPathComponent("Archives"),
      program: root.appendingPathComponent("Program"),
      proxies: root.appendingPathComponent("Proxies"),
      prepared: root.appendingPathComponent("Prepared")
    )
  }

  private func seed(
    index: ArchiveIndex,
    recording: Int64,
    source: SourceID,
    start: WallClock,
    segments: Int = 2,
    each seconds: TimeInterval = 5
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
