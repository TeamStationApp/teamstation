import Foundation

/// Measures a camera's frame rate from the RTP timestamps it is already sending.
///
/// Nothing on the wire states it. The SDP these cameras return carries `a=framesize` but no
/// `a=framerate`, so the spacing of the timestamps is the only honest source. That matters well
/// beyond the HUD: instant replay pumps frames at whatever rate the source reports, so a 60 fps
/// camera described as 30 replays at half speed and mis-times its own trim.
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

    intervals.append(delta)
    if intervals.count > Self.windowSize {
      intervals.removeFirst(intervals.count - Self.windowSize)
    }
    guard intervals.count >= Self.minimumSamples else { return false }

    let median = intervals.sorted()[intervals.count / 2]
    guard median > 0 else { return false }

    let resolved = Self.snap(clockRate / median)
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
}
