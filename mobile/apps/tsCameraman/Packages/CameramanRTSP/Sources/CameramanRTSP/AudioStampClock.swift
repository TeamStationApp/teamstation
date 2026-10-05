import Foundation

/// The audio RTP timestamp from where each frame's samples were captured, not from how many frames
/// went before.
///
/// Counting frames from zero made every stamp after a microphone dropout early by the samples the
/// microphone lost, until the next sender report — up to a second later — revealed it as a jump;
/// the receiver then had to treat sound it had already placed as misplaced. Here a frame's stamp is
/// its sample position since the session's first captured sample. Within a run frames are exactly
/// `samplesPerFrame` apart, whatever jitter the capture times carry; when capture says more than
/// half a frame was lost, the stamp skips forward by what was lost, so the receiver sees a gap in
/// the sound at the place the sound was missing. A stamp never goes backwards.
struct AudioStampClock: Sendable {
  /// How much later than the capture clock says this phone's sound was heard, against the pictures
  /// captured with it. Added to every sound capture time before it is stamped and reported, so a
  /// receiver placing sound and pictures by capture time puts them together. Measured on an iPhone
  /// 13 Pro by Big Time's clap/flash through TS Director: the sound sat 56 ms ahead of the picture,
  /// live and recorded alike, with AAC priming already allowed for.
  static let captureTrimSeconds = 0.056

  let sampleRate: Double
  let samplesPerFrame: Int64

  private var firstCapture: Double?
  private var position: Int64 = 0

  /// Samples skipped over for dropouts since the session began.
  private(set) var skippedSamples: Int64 = 0
  /// Dropouts skipped over since the session began.
  private(set) var gaps: Int = 0

  init(sampleRate: Double, samplesPerFrame: Int = 1_024) {
    self.sampleRate = sampleRate
    self.samplesPerFrame = Int64(samplesPerFrame)
  }

  /// A new session starts at zero from its first frame.
  mutating func reset() {
    firstCapture = nil
    position = 0
    skippedSamples = 0
    gaps = 0
  }

  /// The stamp for a frame whose first sample was captured at `capture` (seconds, any clock that
  /// does not jump), and whether it follows a dropout.
  mutating func next(capture: Double) -> (timestamp: UInt32, afterGap: Bool) {
    guard let first = firstCapture else {
      firstCapture = capture
      position = 0
      return (0, false)
    }
    let expected = position + samplesPerFrame
    let captured = Int64(((capture - first) * sampleRate).rounded())
    let lost = captured - expected
    if lost > samplesPerFrame / 2 {
      position = captured
      skippedSamples += lost
      gaps += 1
      return (UInt32(truncatingIfNeeded: position), true)
    }
    position = expected
    return (UInt32(truncatingIfNeeded: position), false)
  }
}

/// When a stream's sender report goes out: with the first packet of a session, ahead of it, so a
/// receiver can place the very first sound and picture it gets, and then about once a second.
struct SenderReportSchedule: Sendable {
  static let interval: TimeInterval = 1

  private var sentThisSession = false
  private var last = Date.distantPast

  mutating func reset() {
    sentThisSession = false
  }

  /// True for a session's first packet: its report goes out before it.
  mutating func reportBeforeFirstPacket(at now: Date) -> Bool {
    guard !sentThisSession else { return false }
    sentThisSession = true
    last = now
    return true
  }

  /// True when a second has passed since the last report.
  mutating func reportIsDue(at now: Date) -> Bool {
    guard now.timeIntervalSince(last) >= Self.interval else { return false }
    last = now
    return true
  }
}
