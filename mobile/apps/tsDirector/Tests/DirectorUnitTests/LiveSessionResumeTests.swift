import Foundation
import DirectorCore
import DirectorDVR
import Testing

/// What the app decides to do at launch about whatever it was doing when it stopped.
///
/// The decision is kept apart from carrying it out so these rules are reachable at all: there is
/// no way to construct the app's environment in a test, and "an hour away is the difference
/// between a take continuing and a take ending" is not something to find out on a rig.
@Suite("Live session resume")
struct LiveSessionResumeTests {
  private let hour: TimeInterval = 3_600

  @Test("An app that was idle when it stopped has nothing to resume")
  func idleAppResumesNothing() throws {
    let index = try makeIndex()
    #expect(try LiveSessionResume.plan(
      index: index, now: WallClock(seconds: 1_000), limit: hour
    ) == nil)
  }

  @Test("A take that was rolling comes back with its start, its grid and its camera")
  func recordingResumes() throws {
    let index = try makeIndex()
    let start = WallClock(seconds: 10_000)
    let id = try index.beginRecording(at: start)
    try seed(index: index, recording: id, start: start)
    let grid = Data(#"[{"id":"cam-1"}]"#.utf8)
    try index.saveSelections(grid, for: id)
    try index.insertProgramCut(
      recordingID: id, wall: start + 5, sourceID: SourceID("cam-1"), intended: true
    )
    try index.insertProgramCut(
      recordingID: id, wall: start + 40, sourceID: SourceID("cam-2"), intended: true
    )
    // cam-2 dropped and the app fell back on its own; that is not the operator's choice.
    try index.insertProgramCut(
      recordingID: id, wall: start + 50, sourceID: SourceID("cam-1"), intended: false
    )
    try index.insertProgramAnchor(
      recordingID: id, part: 1, programSeconds: 0, wall: start
    )
    _ = try index.noteSource(
      recordingID: id, sourceID: SourceID("cam-1"), transport: "rtsp", archiving: true
    )
    _ = try index.noteSource(
      recordingID: id, sourceID: SourceID("cam-9"), transport: "ndi", archiving: false,
      reason: "budget"
    )
    try index.openLiveSession(recordingID: id, at: start)
    try index.heartbeat(at: start + 100)

    let plan = try #require(
      try LiveSessionResume.plan(index: index, now: start + 220, limit: hour)
    )
    guard case let .resume(recording, streaming) = plan.outcome else {
      Issue.record("expected a resume, got \(plan.outcome)")
      return
    }
    let take = try #require(recording)
    #expect(!streaming)
    #expect(take.recordingID == id)
    // The take's own start, not the moment it was picked up. Every file is measured from here.
    #expect(take.startedAt.seconds == start.seconds)
    #expect(take.selections == grid)
    #expect(take.programSource == SourceID("cam-2"))
    #expect(take.nextProgramPart == 2)
    #expect(take.previouslyArchived == [SourceID("cam-1")])
    // Two minutes, from the heartbeat. Not from the last segment, which is older.
    #expect(abs(plan.downtime - 120) < 0.001)
    #expect(plan.liveRecordingID == id)
  }

  @Test("A session that was only streaming resumes only the stream")
  func streamingOnlyResumesTheStream() throws {
    let index = try makeIndex()
    let start = WallClock(seconds: 20_000)
    try index.openLiveSession(streaming: true, at: start)
    try index.heartbeat(at: start + 30)

    let plan = try #require(
      try LiveSessionResume.plan(index: index, now: start + 90, limit: hour)
    )
    guard case let .resume(recording, streaming) = plan.outcome else {
      Issue.record("expected a resume, got \(plan.outcome)")
      return
    }
    #expect(streaming)
    #expect(recording == nil)
    #expect(plan.liveRecordingID == nil)
    #expect(try index.recordings().isEmpty)
  }

  @Test("A session doing both brings both back")
  func recordingAndStreamingBothResume() throws {
    let index = try makeIndex()
    let start = WallClock(seconds: 30_000)
    let id = try index.beginRecording(at: start)
    try seed(index: index, recording: id, start: start)
    try index.openLiveSession(recordingID: id, streaming: true, at: start)
    try index.heartbeat(at: start + 60)

    let plan = try #require(
      try LiveSessionResume.plan(index: index, now: start + 70, limit: hour)
    )
    guard case let .resume(recording, streaming) = plan.outcome else {
      Issue.record("expected a resume, got \(plan.outcome)")
      return
    }
    #expect(streaming)
    #expect(recording?.recordingID == id)
  }

  @Test("Fifty-nine minutes away resumes; sixty-one does not")
  func theHourIsTheLimit() throws {
    let index = try makeIndex()
    let start = WallClock(seconds: 40_000)

    let inTime = try index.beginRecording(at: start)
    try seed(index: index, recording: inTime, start: start)
    try index.openLiveSession(recordingID: inTime, at: start)
    try index.heartbeat(at: start + 10)
    let near = try #require(
      try LiveSessionResume.plan(index: index, now: start + 10 + 59 * 60, limit: hour)
    )
    #expect(!near.isExpired)
    #expect(near.liveRecordingID == inTime)

    let plan = try #require(
      try LiveSessionResume.plan(index: index, now: start + 10 + 61 * 60, limit: hour)
    )
    #expect(plan.isExpired)
    #expect(plan.liveRecordingID == nil)
    #expect(plan.outcome == .expired(closedRecordingID: inTime))
    #expect(abs(plan.downtime - 61 * 60) < 0.001)
    // Planning does not write. The take is still open until the app closes it.
    #expect(try #require(try index.recordings().first { $0.id == inTime }).endedAt == nil)
  }

  @Test("The limit is measured from the heartbeat, not from the last thing a camera wrote")
  func downtimeIsNotSegmentAge() throws {
    let index = try makeIndex()
    let start = WallClock(seconds: 50_000)
    let id = try index.beginRecording(at: start)
    // Every camera dropped out two hours before the app did. The take kept running with nothing
    // to write, which is a bad night, not a reason to refuse to pick it up.
    try seed(index: index, recording: id, start: start, segments: 2, each: 5)
    try index.openLiveSession(recordingID: id, at: start)
    try index.heartbeat(at: start + 7_200)

    let plan = try #require(
      try LiveSessionResume.plan(index: index, now: start + 7_320, limit: hour)
    )
    #expect(!plan.isExpired)
    #expect(abs(plan.downtime - 120) < 0.001)
  }

  @Test("A session left behind by a clean stop cannot bring a finished take back")
  func staleSessionIsNotAResume() throws {
    let index = try makeIndex()
    let start = WallClock(seconds: 60_000)
    let id = try index.beginRecording(at: start)
    try index.openLiveSession(recordingID: id, at: start)
    try index.heartbeat(at: start + 10)
    try index.endRecording(id, at: start + 600)

    #expect(try LiveSessionResume.plan(index: index, now: start + 620, limit: hour) == nil)
  }

  @Test("The banner says which halves came back and how long the app was away")
  func bannerNamesTheHalvesAndTheDowntime() throws {
    let take = LiveSessionResume.Take(
      recordingID: 1, startedAt: WallClock(seconds: 0), selections: nil,
      programSource: nil, nextProgramPart: 2, previouslyArchived: []
    )
    #expect(LiveSessionResume(
      outcome: .resume(recording: take, streaming: false), downtime: 130
    ).banner(limit: 3_600) == "Resumed recording — app was away 2m 10s")
    #expect(LiveSessionResume(
      outcome: .resume(recording: nil, streaming: true), downtime: 45
    ).banner(limit: 3_600) == "Resumed stream — app was away 45s")
    #expect(LiveSessionResume(
      outcome: .resume(recording: take, streaming: true), downtime: 45
    ).banner(limit: 3_600) == "Resumed recording and stream — app was away 45s")
    #expect(LiveSessionResume(
      outcome: .expired(closedRecordingID: 1), downtime: 5_000
    ).banner(limit: 3_600) == "Take closed — app was away 1h 23m, longer than the 1h 0m resume limit")
  }

  @Test("The resume limit is configuration, clamped to something an operator could mean")
  func limitIsConfigurable() {
    #expect(AppConfig.default.resumeDowntimeLimitSeconds == 3_600)
    #expect(AppConfig(resumeDowntimeLimitSeconds: 1).resumeDowntimeLimitSeconds == 60)
    #expect(AppConfig(resumeDowntimeLimitSeconds: 10_000_000).resumeDowntimeLimitSeconds == 86_400)
    #expect(AppConfig(resumeDowntimeLimitSeconds: 120).resumeDowntimeLimitSeconds == 120)
  }

  // MARK: - Helpers

  private func makeIndex() throws -> ArchiveIndex {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("resume-plan-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
  }

  private func seed(
    index: ArchiveIndex,
    recording: Int64,
    start: WallClock,
    segments: Int = 2,
    each seconds: TimeInterval = 5
  ) throws {
    for sequence in 0 ..< segments {
      _ = try index.insertSegment(
        recordingID: recording,
        sourceID: SourceID("cam-1"),
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
