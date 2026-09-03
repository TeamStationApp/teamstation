import Foundation

/// Turns a camera's 32-bit RTP timestamp into a tick count that keeps rising across rollovers.
///
/// The wire field is 32 bits and wraps. Measuring the distance from the session's first timestamp
/// as a signed 32-bit delta therefore stops working after 2^31 ticks — 6.6 hours at the 90 kHz
/// video clock, 12.4 hours at 48 kHz audio — and a clamped negative result pins every later frame
/// on the same presentation time, which reads downstream as a picture that has stopped rather than
/// as an error.
///
/// Rollovers are detected from the step between consecutive timestamps rather than from the base,
/// so the count survives any number of them and a session can run as long as the game does.
struct RTPTimestampUnwrapper: Sendable {
  /// Half the circle. A step shorter than this is the clock advancing; anything longer is read as
  /// the short way back, because a camera that repeats or reorders a timestamp must not be treated
  /// as having jumped forward by four billion ticks.
  private static let half = UInt32(1) << 31

  private var previous: UInt32?
  private var elapsed: UInt64 = 0

  /// Ticks since the first timestamp this session, unwrapped.
  var ticks: UInt64 { elapsed }

  var hasStarted: Bool { previous != nil }

  /// A reconnect gives the camera a new timeline, so the count starts again from its first packet.
  mutating func reset() {
    previous = nil
    elapsed = 0
  }

  @discardableResult
  mutating func unwrap(_ timestamp: UInt32) -> UInt64 {
    guard let last = previous else {
      previous = timestamp
      elapsed = 0
      return 0
    }
    previous = timestamp

    let step = timestamp &- last
    if step == 0 { return elapsed }
    if step < Self.half {
      elapsed &+= UInt64(step)
    } else {
      // Backwards. Held at zero rather than wrapping below the session's first timestamp, which
      // would put a frame before the start of the timeline.
      let backwards = UInt64(UInt32.max - step) + 1
      elapsed = elapsed > backwards ? elapsed - backwards : 0
    }
    return elapsed
  }
}
