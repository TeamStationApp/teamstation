import DirectorCore
import DirectorExport
import Foundation

/**
 * The programme recording of one take, from its row in the index to its last part's file.
 *
 * It opens the take's row in `ArchiveIndex` with the encoding it is recorded with, starts the
 * programme master (`ProgramEncoder`) and keeps the take's anchors and sound checks on the take's
 * row. A take interrupted by a crash or a kill is picked up as its next part (`resume`). At Stop the
 * master is finished out to the take's end with the hold fill, and every part's file is listed on
 * the row. It also keeps the live session's heartbeat, which is how the next launch knows how long
 * the app was away.
 *
 * TS Director drives it beside its per-camera archives, which are its own; the phone drives it
 * alone. Anything a host must do between the steps (attach cameras, wait out its display delay,
 * flush its sound) happens between the calls.
 */
@MainActor
public final class RecordingSession {
  public let index: ArchiveIndex
  public let encoder: ProgramEncoder
  private let clock: DirectorClock
  /// Tells the host's programme clock the master's frame rate before the master starts.
  private let setRecordingRate: (Int) -> Void
  private let heartbeatInterval: TimeInterval

  /// The open take, while one is recording.
  public private(set) var recordingID: Int64?
  /// When the open take started: the take's own start, kept across a resume.
  public private(set) var startedAt: WallClock?
  private var heartbeatTimer: Timer?

  /// Every five seconds: frequent enough that the downtime reading is never meaningfully wrong,
  /// rare enough that it is one small write a minute rather than a background load.
  public static let defaultHeartbeatInterval: TimeInterval = 5

  public init(
    index: ArchiveIndex,
    encoder: ProgramEncoder,
    clock: DirectorClock,
    heartbeatInterval: TimeInterval = RecordingSession.defaultHeartbeatInterval,
    setRecordingRate: @escaping (Int) -> Void = { _ in }
  ) {
    self.index = index
    self.encoder = encoder
    self.clock = clock
    self.heartbeatInterval = heartbeatInterval
    self.setRecordingRate = setRecordingRate
    // Set here rather than with the encoder: the encoder is built before the index exists.
    // No main-actor state in either closure: they run on whichever queue delivered the frame, so
    // the recording they belong to is carried in.
    let anchorIndex = index
    encoder.setAnchorSink { recording, part, seconds, wall in
      try? anchorIndex.insertProgramAnchor(
        recordingID: recording,
        part: part,
        programSeconds: seconds,
        wall: wall
      )
    }
    // The part's sound verdict, onto the take's own row: what an export or an upload can still read.
    encoder.setSoundCheckSink { recording, check in
      try? anchorIndex.recordSoundCheck(check, for: recording)
    }
  }

  public var isRecording: Bool { recordingID != nil }

  // MARK: - A take

  /// Opens the take's row, keeps the encoding it is recorded with for its exports, and points the
  /// master's anchors at it. The master itself starts with `startProgramme`.
  @discardableResult
  public func open(at now: WallClock, settings: RecordingSettings) throws -> Int64 {
    let id = try index.beginRecording(at: now)
    recordingID = id
    try? index.saveEncoding(settings.takeEncoding, for: id)
    encoder.setAnchorRecording(id)
    startedAt = now
    return id
  }

  /// Starts the programme master for the open take, and lists its file on the take's row.
  ///
  /// Throws when the master cannot start. The take is still recording: a host's other files of the
  /// take are worth keeping without a master.
  public func startProgramme(at now: WallClock, settings: RecordingSettings) throws {
    encoder.configure(settings.programme)
    setRecordingRate(settings.programme.frameRate)
    try encoder.start(at: now)
    if let id = recordingID, let filename = encoder.outputURL?.lastPathComponent {
      try? index.setProgramFilename(filename, for: id)
    }
  }

  /// Picks up a take that was rolling when the app stopped, as its next part.
  ///
  /// The take's own programme settings are used, so the new part matches the parts before it, and
  /// the part is listed on the row as it opens: a take killed again before it stops must still list
  /// it. Returns how many times the take has now been resumed. Throws when the master cannot be
  /// reopened, after the take has been picked up.
  @discardableResult
  public func resume(
    _ take: LiveSessionResume.Take,
    at now: WallClock,
    settings: RecordingSettings
  ) throws -> Int {
    adopt(take)
    return try resumeProgramme(take, at: now, settings: settings)
  }

  /// The first half of `resume`: the take is the open one again, before anything is written. A
  /// host that announces the take as recording does so between the two halves.
  public func adopt(_ take: LiveSessionResume.Take) {
    recordingID = take.recordingID
    startedAt = take.startedAt
  }

  /// The second half of `resume`: the take's anchors, its resume count, and its next part.
  @discardableResult
  public func resumeProgramme(
    _ take: LiveSessionResume.Take,
    at now: WallClock,
    settings: RecordingSettings
  ) throws -> Int {
    encoder.setAnchorRecording(take.recordingID)
    try? index.noteResumed(take.recordingID, at: now)
    let resumeCount = (try? index.recordings().first { $0.id == take.recordingID })?.resumeCount ?? 1

    let programme = (try? index.encoding(for: take.recordingID))?.programme ?? settings.programme
    encoder.configure(programme)
    setRecordingRate(programme.frameRate)
    try encoder.resume(startedAt: take.startedAt, nextPart: take.nextProgramPart, at: now)
    if let opened = encoder.outputURL?.lastPathComponent {
      let names = programFilenames(of: take.recordingID)
      if !names.contains(opened) {
        try? index.setProgramFilename((names + [opened]).joined(separator: ","), for: take.recordingID)
      }
    }
    return resumeCount
  }

  /// Nothing the master writes after this belongs to the take: finishing fills it out to the stop,
  /// and a live picture arriving during that fill would record the fill's pace as real time.
  public func detachAnchors() {
    encoder.setAnchorRecording(nil)
  }

  /// Finishes the master out to `until` (the take's end, with the host's display delay), filling
  /// the hold so its sound reaches its picture, and answers with the file.
  ///
  /// Off the main actor, as the encoder's own work is: called from it, the finish waited on a busy
  /// main actor between its hold fill and closing the writer, and live pictures that kept arriving
  /// meanwhile ran the picture past the filled sound.
  nonisolated public func finishProgramme(until wall: WallClock) async -> URL? {
    await encoder.finish(until: wall)
  }

  /// Closes the take's row at `endedAt`, listing every part's file: the parts written before a
  /// crash first, so the list still starts with the take's first part.
  public func close(endedAt: WallClock) {
    if let id = recordingID {
      let recorded = programFilenames(of: id)
      let written = encoder.outputURLs.map(\.lastPathComponent).filter { !$0.isEmpty }
      let names = recorded + written.filter { !recorded.contains($0) }
      if !names.isEmpty {
        try? index.setProgramFilename(names.joined(separator: ","), for: id)
      }
      try? index.endRecording(id, at: endedAt)
    }
    recordingID = nil
    encoder.setAnchorRecording(nil)
    startedAt = nil
  }

  private func programFilenames(of id: Int64) -> [String] {
    let listed = (try? index.recordings().first { $0.id == id })?.programFilename ?? ""
    return listed.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }
  }

  // MARK: - The live session

  /// Opens or updates the row that says what this app is doing, and starts the heartbeat.
  /// `isLive` is asked on each beat; a beat with nothing live closes the session.
  public func beginLiveSession(
    recording: Int64? = nil,
    streaming: Bool? = nil,
    isLive: @escaping @MainActor () -> Bool
  ) {
    try? index.openLiveSession(recordingID: recording, streaming: streaming, at: clock.now)
    guard heartbeatTimer == nil else { return }
    heartbeatTimer = Timer.scheduledTimer(withTimeInterval: heartbeatInterval, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.beatLiveSession(isLive: isLive()) }
    }
  }

  /// One heartbeat. With nothing live any more, the session is closed instead.
  public func beatLiveSession(isLive: Bool) {
    guard isLive else {
      endLiveSession(stillLive: false)
      return
    }
    try? index.heartbeat(at: clock.now)
  }

  /// Clears one half of the live session (or all of it, with neither named), and stops the
  /// heartbeat once nothing is live.
  public func endLiveSession(recording: Bool = false, streaming: Bool = false, stillLive: Bool) {
    if recording || streaming {
      try? index.closeLiveSession(recording: recording, streaming: streaming)
    } else {
      try? index.closeLiveSession()
    }
    guard !stillLive else { return }
    stopHeartbeat()
  }

  public func stopHeartbeat() {
    heartbeatTimer?.invalidate()
    heartbeatTimer = nil
  }

  public var isBeating: Bool { heartbeatTimer != nil }
}
