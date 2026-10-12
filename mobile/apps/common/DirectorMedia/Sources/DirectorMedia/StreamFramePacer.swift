import Foundation

/// Admits programme frames into the stream encoder at the stream's configured rate.
///
/// The programme is composited at whatever rate its on-air camera delivers, which can be faster
/// than the stream is configured for: a 60 fps camera into a 30 fps stream. Handing the encoder
/// every composited frame then doubles its load and, because VideoToolbox caps a GOP by frame count
/// as well as by duration, cuts a keyframe every second instead of every two. A stream configured
/// at the camera's own rate passes every frame — the bench rig streams at 60, and measured 55
/// frames and about 0.6 keyframes a second on the wire.
///
/// Frames are due one interval after the last one admitted rather than after the last one seen, so
/// 60 fps with ordinary jitter yields a steady 30 rather than a pattern of doubles and gaps. A
/// quarter of an interval early still counts, which is what lets every other frame of a jittery 60
/// through. After a stall the cadence restarts from the next frame instead of admitting a burst to
/// catch up.
public struct StreamFramePacer: Sendable, Equatable {
  public let interval: Double
  private var nextDue: Double?

  public init(frameRate: Int) {
    interval = 1 / Double(max(frameRate, 1))
  }

  public mutating func admit(now: Double) -> Bool {
    guard let due = nextDue else {
      nextDue = now + interval
      return true
    }
    if now < due - interval / 4 { return false }
    // Behind by more than a frame means frames stopped arriving for a while. Start the cadence
    // again from here rather than admitting everything that would have been due.
    nextDue = now - due > interval ? now + interval : due + interval
    return true
  }

  public mutating func reset() {
    nextDue = nil
  }
}
