import Foundation

/// Where this part's timeline begins on the wall clock, settled once and never revised.
///
/// Sound captured at `wall` goes at `wall - partStartWall`. That is the whole of it: one
/// subtraction, fixed for the part.
///
/// ## Why it is not tracked
///
/// The predecessor placed each buffer at `captureWall + contentOffset`, where `contentOffset` was
/// re-derived from every video frame as the age of the on-air picture. Two things made that
/// ruinous. The estimate was a single unsmoothed sample — arrival jitter within one camera spans
/// 0.18–0.25 s, against a real between-camera difference of 0.04 s, so 93% of what it followed was
/// noise. And its corrections were applied by moving where the next buffer was written into an MP4
/// audio track, whose `stts` is a contiguous run of durations and cannot express a discontinuity:
/// a move later left a gap the muxer closed, a move earlier dropped buffers. Nothing ever gave time
/// back, so a zero-mean wobble was rectified into a one-way loss.
///
/// Measured on take 414: the quantity it chased finished the game 0.114 s from where it started,
/// and the file lost 46.76 s following it there.
///
/// So the offset is not followed. It is seeded and held, and the cost is a *static* error equal to
/// however far the delay line's hold drifts from its opening value over the take — ≤0.39 s on the
/// two damaged games, non-accumulating. If that is ever too loose, the way to tighten it is to
/// resample the sound, not to move it: repositioning is the thing that cannot be done without
/// losing time.
///
/// ## Why the same number the picture uses
///
/// A `ProgramAnchor` stores *content* wall — when the picture on air was captured, not when it was
/// composed — so `partStartWall = wall - programSeconds` already has the delay line's hold folded
/// in. Taking the audio's origin from the same quantity means the master's internal lip sync and
/// its placement against the take's camera archives derive from one number rather than from two
/// mechanisms that have to agree. rec-320, a master 0.55 s adrift from the camera files it was cut
/// from, was those two mechanisms disagreeing.
struct ProgrammeSoundOrigin {
  /// How long the opening is sampled before the origin is fixed.
  ///
  /// One frame would do arithmetically, and inherit that frame's ±0.1 s of jitter as a fixed error
  /// for the whole part for nothing. A median over the opening costs nothing and removes it. The
  /// recording's mix runs seconds behind the live edge, so the first sound that belongs to this
  /// part does not arrive until well after this has settled; nothing is waiting on it.
  ///
  /// `ArchiveIndex.partStart(implied:)` does the same job retrospectively, over the whole take's
  /// anchors, and the export already trusts it.
  static let seedSeconds: Double = 1.5
  /// A ceiling on the samples held while seeding, so a part that somehow never advances its
  /// programme time cannot grow this without bound.
  static let maximumSamples = 240

  private var samples: [Double] = []
  private var openedAt: Double?
  private var settled: Double?

  /// The origin, once fixed.
  var partStartWall: Double? { settled }
  var isSettled: Bool { settled != nil }

  /// Offers one video frame's implied origin: the content wall of the picture, less where it was
  /// placed on this part's timeline. Ignored once settled.
  mutating func offer(impliedPartStart: Double, atProgramme seconds: Double) {
    guard settled == nil, impliedPartStart.isFinite, seconds.isFinite else { return }
    if openedAt == nil { openedAt = seconds }
    samples.append(impliedPartStart)
    let span = seconds - (openedAt ?? seconds)
    guard span >= Self.seedSeconds || samples.count >= Self.maximumSamples else { return }
    settled = Self.median(of: samples)
    samples = []
  }

  /// Where sound captured at `wall` belongs on this part's timeline. Nil before the origin is
  /// settled, and for sound captured before the part began.
  func timeline(forCaptureWall wall: Double) -> Double? {
    guard let settled, wall.isFinite else { return nil }
    let seconds = wall - settled
    return seconds >= 0 ? seconds : nil
  }

  mutating func reset() {
    samples = []
    openedAt = nil
    settled = nil
  }

  static func median(of values: [Double]) -> Double? {
    guard !values.isEmpty else { return nil }
    let sorted = values.sorted()
    let middle = sorted.count / 2
    if sorted.count % 2 == 1 { return sorted[middle] }
    return (sorted[middle - 1] + sorted[middle]) / 2
  }
}
