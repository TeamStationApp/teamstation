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
    startedWall: CFAbsoluteTime = 0,
    lastOutputWall: CFAbsoluteTime = 0
  ) -> StreamStallAction {
    let cooledDown = lastResetWall == 0 || now - lastResetWall >= resetCooldown

    // Callbacks still arriving, but carrying errors and no picture. A malfunctioning hardware
    // encoder does exactly this — measured in a soak: -12912 (kVTVideoEncoderMalfunctionErr) at 64
    // callbacks a second, keyframes frozen for minutes, the RTMP connection still open — and every
    // other rule here reads it as healthy, because the callbacks are fresh. Only rebuilding the
    // session recovers it. Measured from the last *good* output, or from the start if there has
    // never been one.
    if startedWall > 0 || lastOutputWall > 0, lastCallbackWall > 0, now - lastCallbackWall < gopSeconds {
      let outputSilent = lastOutputWall > 0
        ? now - lastOutputWall >= 2 * gopSeconds
        : now - startedWall >= 3 * gopSeconds
      if outputSilent, cooledDown { return .resetSession }
    }
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
