import Foundation

/// Measures a camera's frame rate from the timestamps it is already sending.
///
/// Two transports need this for opposite reasons. RTSP states nothing on the wire: the SDP these
/// cameras return carries `a=framesize` but no `a=framerate`, so the spacing of the timestamps is
/// the only honest source. NDI *does* state a rate in every frame header, and a sender can state
/// it wrongly — a Hollyland Cosmo C2 declares 120/1 while sending 60, measured with its own
/// timestamps and the SDK's dropped-frame counters both agreeing on 60.00.
///
/// Either way the declaration cannot be trusted, and the consequences reach well beyond the HUD:
/// instant replay pumps frames at whatever rate the source reports, so a 60 fps camera described
/// as 30 replays at half speed and mis-times its own trim, and an archive timestamped from a
/// declared 120 while fed 60 writes a video track at half the duration of the audio beside it.
///
/// The **median** interval is taken rather than the mean. A dropped or merged access unit doubles
/// one interval and a burst produces several short ones; either drags an average far enough to
/// snap to the wrong rate, while neither moves the middle of the window.
public struct FrameRateEstimator: Sendable {
  /// The rates worth snapping to. Cameraman's `FormatCatalogue` offers 24 through 240, and the
  /// RTSP cameras in the population send 25 or 30. The broadcast fractional rates are here because
  /// a camera that calls itself 30 is often sending 30000/1001.
  public static let candidates: [Double] = [
    23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 100, 119.88, 120, 240
  ]

  /// How close a measurement must be to a candidate to be reported as that candidate, as a
  /// fraction of the candidate. Every neighbouring pair above is further apart than this except
  /// the fractional twins — 29.97 and 30 are 0.1% apart, so they deliberately collapse onto
  /// whichever is nearer, which is the right answer either way for everything downstream.
  public static let snapTolerance = 0.02

  /// Enough intervals that a keyframe burst cannot carry the median, few enough that the answer
  /// arrives within half a second at 30 fps.
  public static let minimumSamples = 12

  /// Interquartile spread, as a fraction of the median, beyond which the timestamps are taken to be
  /// scattered rather than ticked. A clean clock with drops has a spread of zero — three quarters of
  /// its intervals are identical — so this only ever selects the mean for a sender whose stamps
  /// genuinely wander.
  public static let scatterTolerance = 0.25

  /// Several seconds of history at the rates in use. Long enough that one bad patch cannot define
  /// the answer, short enough to follow a camera that changes format without reconnecting.
  private static let windowSize = 120

  private let clockRate: Double
  private var previous: UInt32?
  private var intervals: [Double] = []

  /// Nil until `minimumSamples` intervals have been seen. Callers are expected to have their own
  /// fallback for that window rather than being handed a guess dressed as a measurement.
  public private(set) var frameRate: Double?

  public init(clockRate: Double = 90_000) {
    self.clockRate = clockRate
  }

  /// Records the gap between one frame and the previous one, in seconds, for transports that do
  /// not carry an RTP-style tick counter. Same window, same median, same snapping — only the unit
  /// of the sample differs.
  @discardableResult
  public mutating func note(intervalSeconds: Double) -> Bool {
    guard intervalSeconds > 0, intervalSeconds.isFinite else { return false }
    return record(interval: intervalSeconds, perSecond: 1)
  }

  /// Records one access unit's RTP timestamp. Returns true when the answer changed, which is a
  /// caller's cue to republish the format.
  @discardableResult
  public mutating func note(timestamp: UInt32) -> Bool {
    let earlier = previous
    previous = timestamp
    guard let earlier else { return false }

    // Wrapping subtraction through `Int32` so the 32-bit RTP clock rolling over reads as a small
    // positive step rather than a four-billion-tick jump. Same form as the presentation timeline.
    let delta = Double(Int32(bitPattern: timestamp &- earlier))
    // Two access units sharing a timestamp are one picture the depacketizer split, not two frames,
    // and a negative step is reordering. Neither says anything about the rate.
    guard delta > 0 else { return false }

    return record(interval: delta, perSecond: clockRate)
  }

  /// The shared half: keep a bounded window, take its middle, and snap. `perSecond` is how many
  /// units of `interval` make a second — the media clock rate for ticks, one for seconds.
  private mutating func record(interval: Double, perSecond: Double) -> Bool {
    intervals.append(interval)
    if intervals.count > Self.windowSize {
      intervals.removeFirst(intervals.count - Self.windowSize)
    }
    guard intervals.count >= Self.minimumSamples else { return false }

    let sorted = intervals.sorted()
    let median = sorted[sorted.count / 2]
    guard median > 0 else { return false }

    // The median is right for a clean clock and wrong for a scattered one. RTP ticks step by
    // exactly one frame, so the middle interval *is* the period and a drop cannot move it. NDI
    // stamps are not ticks: a Cosmo C2 pacing an exact 60.03 fps stamps frames 3–37 ms apart in a
    // skewed spread whose median is 15.7 ms, which read as 63.56 on the Mac and 70.41 on the iPad
    // — and the archive timeline stepped at that. When the middle half of the window is that wide,
    // single intervals say little and the window's total span says everything: the scatter
    // telescopes away, leaving the sender's real pacing.
    let quartileSpread = sorted[sorted.count * 3 / 4] - sorted[sorted.count / 4]
    let period = quartileSpread > median * Self.scatterTolerance
      ? intervals.reduce(0, +) / Double(intervals.count)
      : median

    let resolved = Self.snap(perSecond / period)
    guard resolved != frameRate else { return false }
    frameRate = resolved
    return true
  }

  /// A reconnect restarts the camera's timeline and may find it in another format, so nothing
  /// measured against the old one survives.
  public mutating func reset() {
    previous = nil
    intervals.removeAll(keepingCapacity: true)
    frameRate = nil
  }

  /// The nearest standard rate, or the measurement rounded to two places when it is nowhere near
  /// one — a camera genuinely delivering 17 fps should read as 17 rather than be forced onto a
  /// rate it is not sending.
  public static func snap(_ measured: Double) -> Double {
    guard measured > 0, measured.isFinite else { return measured }
    var best: Double?
    var bestDistance = Double.greatestFiniteMagnitude
    for candidate in candidates {
      let distance = abs(measured - candidate) / candidate
      if distance <= snapTolerance, distance < bestDistance {
        best = candidate
        bestDistance = distance
      }
    }
    return best ?? (measured * 100).rounded() / 100
  }

  /// The measured rate as an exact numerator over denominator, for building a presentation
  /// timeline that does not drift.
  ///
  /// A frame's duration has to be exact: writing 1/59.94 through a rounded timescale is a part in
  /// three thousand, which is a second of drift an hour into a recording. Every rate a camera
  /// actually sends is a whole number or one of the 1001-denominator broadcast rates, so those are
  /// returned as the rationals they are and anything else falls back to a fine timescale.
  public static func rational(for rate: Double) -> (numerator: Int32, denominator: Int32) {
    let exact: [(Double, Int32, Int32)] = [
      (23.976, 24_000, 1_001),
      (29.97, 30_000, 1_001),
      (59.94, 60_000, 1_001),
      (119.88, 120_000, 1_001)
    ]
    for (candidate, numerator, denominator) in exact where abs(rate - candidate) < 0.001 {
      return (numerator, denominator)
    }
    if rate > 0, rate.isFinite, abs(rate.rounded() - rate) < 0.001 {
      return (Int32(rate.rounded()), 1)
    }
    // Not a rate any camera in the population sends. Keep the timescale fine enough that the
    // rounding is smaller than the jitter it is describing.
    let timescale: Int32 = 90_000
    let value = max(1, Int32((Double(timescale) / max(rate, 0.001)).rounded()))
    return (timescale, value)
  }

  /// This estimator's own measurement in that form, once it has one.
  public var rational: (numerator: Int32, denominator: Int32)? {
    frameRate.map { Self.rational(for: $0) }
  }
}
