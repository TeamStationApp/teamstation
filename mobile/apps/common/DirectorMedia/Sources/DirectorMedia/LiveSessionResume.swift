import Foundation
import DirectorCore
import DirectorExport

/// What to do at launch about whatever the app was doing when it last stopped running.
///
/// This is a decision, not an action: it reads the index and says resume this, or close that, and
/// the app carries it out. Keeping the two apart is what makes the rules testable — the recording
/// half and the streaming half come back independently, an hour away is the difference between a
/// take continuing and a take ending, and none of that is reachable through a view.
public struct LiveSessionResume: Sendable, Equatable {
  /// Everything needed to put a take back the way it was.
  public struct Take: Sendable, Equatable {
    public let recordingID: Int64
    /// The take's own start, not the moment it was picked up. Every file for this recording is
    /// measured from here, and so is the length the operator sees counting up.
    public let startedAt: WallClock
    /// The grid this take was recording with, as it was at the last change. Applied over the
    /// stores so a take cannot be resumed against cameras it never had.
    public let selections: Data?
    /// The camera the operator last chose for programme.
    public let programSource: SourceID?
    /// The part number a resumed programme encoder should open.
    public let nextProgramPart: Int
    /// Cameras that were archiving when the app stopped. Reported, not enforced: a camera that
    /// has not come back yet is a hole in its own file, not a reason to refuse the take.
    public let previouslyArchived: [SourceID]

    public init(
      recordingID: Int64,
      startedAt: WallClock,
      selections: Data?,
      programSource: SourceID?,
      nextProgramPart: Int,
      previouslyArchived: [SourceID]
    ) {
      self.recordingID = recordingID
      self.startedAt = startedAt
      self.selections = selections
      self.programSource = programSource
      self.nextProgramPart = nextProgramPart
      self.previouslyArchived = previouslyArchived
    }
  }

  public enum Outcome: Sendable, Equatable {
    /// At least one of the two is set. A streaming-only session opens no recording at all.
    case resume(recording: Take?, streaming: Bool)
    /// The app was away too long. The take, if there was one, is closed at its last media by the
    /// ordinary sweep — `closedRecordingID` only names it so the app can say which.
    case expired(closedRecordingID: Int64?)
  }

  public let outcome: Outcome
  /// How long the app was away: now, less the last heartbeat it managed to write.
  ///
  /// Not the age of the last segment. A camera that dropped out twenty minutes before the crash
  /// would make a two-minute outage read as twenty-two, and refuse a take that should plainly
  /// come back.
  public let downtime: TimeInterval

  public init(outcome: Outcome, downtime: TimeInterval) {
    self.outcome = outcome
    self.downtime = downtime
  }

  /// The take to leave open through the launch sweep, if any.
  public var liveRecordingID: Int64? {
    guard case let .resume(recording, _) = outcome else { return nil }
    return recording?.recordingID
  }

  public var isExpired: Bool {
    if case .expired = outcome { return true }
    return false
  }

  /// Reads the index and decides. It does not carry the decision out — no take is closed and
  /// nothing is resumed here — so a launch that falls over halfway through has not already thrown
  /// the session away. The one thing it does write is a repair: a pointer to a take that has since
  /// been closed is cleared, because a session left behind by a clean stop must not be able to
  /// bring a finished recording back.
  ///
  /// Returns nil when the app was idle when it stopped, which is the ordinary case.
  public static func plan(
    index: ArchiveIndex,
    now: WallClock,
    limit: TimeInterval
  ) throws -> LiveSessionResume? {
    guard let session = try index.liveSession(), !session.isEmpty else { return nil }
    let downtime = max(0, now - session.lastAlive)
    // The take the session names, if it is still open. `liveRecording` clears a pointer to a take
    // that has since been closed, so a session left behind by a clean stop cannot resurrect one.
    let summary = try index.liveRecording()

    guard downtime <= limit else {
      return LiveSessionResume(
        outcome: .expired(closedRecordingID: summary?.id),
        downtime: downtime
      )
    }

    var take: Take?
    if let summary {
      take = Take(
        recordingID: summary.id,
        startedAt: summary.startedAt,
        selections: try index.selections(for: summary.id),
        programSource: try index.lastIntendedProgramSource(forRecording: summary.id),
        nextProgramPart: try index.nextProgramPart(forRecording: summary.id),
        previouslyArchived: try index.sources(forRecording: summary.id)
          .filter(\.archiving)
          .map(\.sourceID)
      )
    }

    // The pointer named a take that is gone, and nothing was streaming. There is nothing to come
    // back to, so this is not a resume at all.
    guard take != nil || session.streaming else { return nil }
    return LiveSessionResume(
      outcome: .resume(recording: take, streaming: session.streaming),
      downtime: downtime
    )
  }

  /// How the operator is told, in the one line the status banner has.
  public func banner(limit: TimeInterval) -> String {
    switch outcome {
    case let .resume(recording, streaming):
      let what: String
      switch (recording != nil, streaming) {
      case (true, true): what = "Resumed recording and stream"
      case (true, false): what = "Resumed recording"
      default: what = "Resumed stream"
      }
      return "\(what) — app was away \(Self.spell(downtime))"
    case .expired:
      return "Take closed — app was away \(Self.spell(downtime)), "
        + "longer than the \(Self.spell(limit)) resume limit"
    }
  }

  static func spell(_ seconds: TimeInterval) -> String {
    let whole = Int(seconds.rounded())
    if whole < 60 { return "\(whole)s" }
    let minutes = whole / 60
    if minutes < 60 { return "\(minutes)m \(whole % 60)s" }
    return "\(minutes / 60)h \(minutes % 60)m"
  }
}
