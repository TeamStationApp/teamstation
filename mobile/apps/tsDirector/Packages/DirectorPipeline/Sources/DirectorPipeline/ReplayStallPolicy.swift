import Foundation

/// Pure stall policy for `ReplayDecoder`. No AVFoundation, no timers.
///
/// Instant replay attaches a decoder, delivers a first frame (tile leaves live), then can sit
/// with an empty FIFO while the file reader is stuck. Live presents are skipped for `.replaying`,
/// so `out=0` with healthy arrival `fps` until something calls `onFinish`. Two seconds without a
/// delivered frame is a dead replay, not slow-mo: even 0.25× still pops the FIFO several times a
/// second.
public struct ReplayStallPolicy: Sendable {
  public var timeout: TimeInterval

  public init(timeout: TimeInterval = 2) {
    self.timeout = max(timeout, 0.1)
  }

  /// `lastDeliveredAt` is 0 until the first picture, matching `StreamStallPolicy`'s "no callback
  /// yet" guard. A decoder that has never shown a frame keeps the tile on live
  /// (`stayLiveUntilFirstFrame`).
  public func shouldFinish(now: CFAbsoluteTime, lastDeliveredAt: CFAbsoluteTime) -> Bool {
    lastDeliveredAt > 0 && now - lastDeliveredAt >= timeout
  }
}
