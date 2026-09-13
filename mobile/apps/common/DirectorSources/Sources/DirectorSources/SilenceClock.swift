import Foundation

/// How long a source has gone without a picture, across the reconnects meant to fix that.
///
/// Both transports measured silence from their current session: the last picture of this session,
/// or the moment it opened. Every reconnect cleared both, so a source that had died was only ever a
/// few seconds into its latest attempt and read as healthy. The Cosmo went off the network at 19:33
/// and its tile sat on that picture for over two hours, through 565 reconnects, reporting a stall of
/// zero — which also kept it off the list of missing cameras that starts a discovery sweep.
///
/// So silence is measured from the last picture that actually arrived, or from when the source was
/// started if none has, and only stopping the source forgets either. Reconnecting does not.
public struct SilenceClock: Sendable, Equatable {
  private var lastPicture: Date?
  private var startedAt: Date?

  public init() {}

  /// A session opened. Only the first one since the source started counts as the origin.
  public mutating func sessionStarted(at date: Date) {
    if startedAt == nil { startedAt = date }
  }

  public mutating func notePicture(at date: Date) {
    lastPicture = date
  }

  /// The source was stopped on purpose; nothing about its silence carries over.
  public mutating func stop() {
    lastPicture = nil
    startedAt = nil
  }

  public func stalledForSeconds(now: Date, timeout: TimeInterval) -> Double {
    StallWatchdog.stalledForSeconds(
      now: now,
      lastAccessUnitAt: lastPicture,
      sessionStartedAt: startedAt,
      timeout: timeout
    )
  }
}
