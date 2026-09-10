import Foundation

/// Evens out a sender's capture timestamps before the delay line schedules against them.
///
/// A delay line releases each frame at its own timestamp plus a fixed offset, so whatever
/// unevenness the timestamps carry goes straight to the screen, however deep the buffer. RTP
/// timestamps are ticks of the camera's media clock and step by exactly one frame; NDI's are not.
/// A Hollyland Cosmo C2 pacing an exact 60.03 fps over 24 s stamps consecutive frames anywhere from
/// 3 ms to 37 ms apart, so the NDI tile stuttered with thirty frames in hand while the RTSP tile
/// beside it, on the same delay, was smooth.
///
/// The fix is the one a PLL makes: predict each frame one period after the last, then move the
/// prediction a small fraction of the way toward what the sender stamped. The fraction is what
/// separates jitter from drift. Jitter averages out across frames and barely moves the timeline;
/// drift — a sender's crystal, or a frame rate measured fractionally wrong — is persistent, so the
/// timeline follows it and the tile never slips behind real time the way stepping a bare counter
/// did.
///
/// Pure and clock-free so it can be tested against a recorded timestamp trace.
public struct CaptureTimelineSmoother: Sendable, Equatable {
  /// How far toward each stamped time the prediction moves. Small enough that a ±15 ms scatter
  /// leaves the output within a couple of milliseconds of even; large enough that a rate error of
  /// a few percent settles to a constant lag of under a frame rather than accumulating.
  public static let gain = 0.05

  /// A stamp further than this from the prediction is a discontinuity — a sender clock restart, or
  /// the receive clock re-estimating its offset — and is taken as the new position rather than
  /// eased toward over the next several seconds of picture.
  public static let reseatSeconds = 0.25

  private var placed: Double?

  public init() {}

  /// Where to put a frame the sender stamped at `capture`, given the frame period.
  public mutating func place(capture: Double, period: Double) -> Double {
    guard let previous = placed, period > 0, period.isFinite else {
      placed = capture
      return capture
    }
    let predicted = previous + period
    let error = capture - predicted
    if abs(error) > Self.reseatSeconds {
      placed = capture
      return capture
    }
    // No attempt to recognise a dropped frame and step over it. With stamps this scattered a drop
    // cannot be told from an ordinary long gap — the Cosmo's pairs put nearly every other frame a
    // full period off prediction — and stepping on a false positive jolts the picture forward. A
    // real drop costs one period of lag that decays over a few dozen frames, well inside the delay
    // line's hold.
    let result = predicted + Self.gain * error
    placed = result
    return result
  }

  /// A new receiver session starts a new timeline.
  public mutating func reset() {
    placed = nil
  }
}
