import Foundation

/// Keeps the RTP timestamp this camera sends strictly advancing, without mistaking the field's own
/// rollover for a step backwards.
///
/// Two frames sharing a timestamp are merged by the receiver into one malformed access unit, so a
/// capture clock that repeats a presentation time has to be nudged forward. Deciding that with a
/// plain `<=` breaks once the 32-bit field wraps — 13.3 hours at 90 kHz — because the wrapped value
/// is numerically tiny and every later frame then gets nudged by a single tick instead of a frame
/// interval, which collapses the whole timeline the receiver is asked to record against.
///
/// Distances are therefore measured on the 32-bit circle, where the rollover is just another
/// forward step.
struct RTPTimestampSequencer: Sendable {
  /// Half the circle. A step shorter than this is the clock advancing; anything longer is the short
  /// way back, which is a repeat or a reorder rather than 13 hours of progress in one frame.
  private static let half = UInt32(1) << 31

  private var last: UInt32?

  var lastSent: UInt32? { last }

  mutating func reset() {
    last = nil
  }

  /// The timestamp to put on the wire for a frame whose own clock says `natural`.
  mutating func next(natural: UInt32) -> UInt32 {
    guard let previous = last else {
      last = natural
      return natural
    }
    let step = natural &- previous
    let sent = (step == 0 || step > Self.half) ? previous &+ 1 : natural
    last = sent
    return sent
  }
}
