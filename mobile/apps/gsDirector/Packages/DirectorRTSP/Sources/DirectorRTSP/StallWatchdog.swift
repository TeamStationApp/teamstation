import Foundation

/// When a live RTSP session should reconnect because it has gone silent.
///
/// A session that never delivers an access unit used to be invisible to the watchdog: it only
/// compared `now` to `lastAccessUnitAt`, so a connect that hung before the first frame never
/// retried. Using the session start as the origin covers that case.
public enum StallWatchdog: Sendable {
  /// Reconnect when the last picture (or, if none, the session start) is older than `timeout`.
  public static func shouldReconnect(
    now: Date,
    lastAccessUnitAt: Date?,
    sessionStartedAt: Date?,
    timeout: TimeInterval
  ) -> Bool {
    guard let origin = lastAccessUnitAt ?? sessionStartedAt else { return false }
    return now.timeIntervalSince(origin) > timeout
  }
}
