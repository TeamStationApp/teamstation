import Foundation

/// What the RTMP GOP watchdog should do on this tick.
public enum StreamStallAction: Sendable, Equatable {
  case none
  case encodeIdleIDR
  case resetSession
}

/// Pure stall policy for `ProgramStreamer`. No VideoToolbox, no timers.
///
/// A climbing `kfage` with a frozen keyframe count means frames reached `append` and were
/// dropped at the pending-encode cap. The watchdog either re-encodes the last picture as an
/// IDR or, if callbacks have gone silent, invalidates the compression session.
public struct StreamStallPolicy: Sendable {
  public var gopSeconds: Double
  public var resetCooldown: Double

  public init(gopSeconds: Double = 2, resetCooldown: Double = 10) {
    self.gopSeconds = max(gopSeconds, 0.1)
    self.resetCooldown = max(resetCooldown, 0)
  }

  public func action(
    now: CFAbsoluteTime,
    lastKeyframeWall: CFAbsoluteTime,
    lastCallbackWall: CFAbsoluteTime,
    pendingEncodes: Int,
    hasLastFrame: Bool,
    lastResetWall: CFAbsoluteTime
  ) -> StreamStallAction {
    let resetDue =
      pendingEncodes > 0
      && lastCallbackWall > 0
      && now - lastCallbackWall >= 2 * gopSeconds
      && (lastResetWall == 0 || now - lastResetWall >= resetCooldown)
    if resetDue { return .resetSession }

    let idleDue =
      hasLastFrame
      && lastKeyframeWall > 0
      && now - lastKeyframeWall >= gopSeconds
    if idleDue { return .encodeIdleIDR }

    return .none
  }
}
