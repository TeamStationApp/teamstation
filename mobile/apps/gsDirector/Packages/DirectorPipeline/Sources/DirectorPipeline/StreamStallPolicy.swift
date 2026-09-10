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
    lastResetWall: CFAbsoluteTime,
    startedWall: CFAbsoluteTime = 0
  ) -> StreamStallAction {
    let cooledDown = lastResetWall == 0 || now - lastResetWall >= resetCooldown
    let resetDue =
      pendingEncodes > 0
      && lastCallbackWall > 0
      && now - lastCallbackWall >= 2 * gopSeconds
      && cooledDown
    if resetDue { return .resetSession }

    // A stream that has never had a callback since it started. The rule above cannot see it — it
    // measures silence from the last callback — and the stress run's publish that connected and
    // then sent 3,406 bytes and no media is what that blindness looks like. A first encode can be
    // slow, so this waits three GOPs rather than two before rebuilding.
    let firstCallbackOverdue =
      pendingEncodes > 0
      && lastCallbackWall == 0
      && startedWall > 0
      && now - startedWall >= 3 * gopSeconds
      && cooledDown
    if firstCallbackOverdue { return .resetSession }

    // No keyframe since the stream started is overdue the same way a stale one is. Measuring only
    // from the last keyframe left a stream that never produced its first one with no watchdog.
    let keyframeOverdue: Bool
    if lastKeyframeWall > 0 {
      keyframeOverdue = now - lastKeyframeWall >= gopSeconds
    } else {
      keyframeOverdue = startedWall > 0 && now - startedWall >= gopSeconds
    }
    if hasLastFrame, keyframeOverdue { return .encodeIdleIDR }

    return .none
  }
}
