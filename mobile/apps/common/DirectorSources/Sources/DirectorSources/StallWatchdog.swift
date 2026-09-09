import Foundation

/// When a live source has gone silent, for any transport.
///
/// Shared because silence is not transport-specific and neither is the remedy. An NDI receiver
/// that stops being fed leaves its tile reading `live` for as long as the app runs, with nothing
/// in telemetry to contradict it — a camera reboot produced exactly that, and the arrival rate
/// went on reporting sixty frames a second while nothing arrived at all.
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

  /// How long a source has been silent past its timeout, or zero while it is healthy.
  ///
  /// Reported rather than only acted on: a tile that has stopped receiving has to say so, because
  /// every other counter on it describes frames that did arrive and none of them can express the
  /// absence of one.
  public static func stalledForSeconds(
    now: Date,
    lastAccessUnitAt: Date?,
    sessionStartedAt: Date?,
    timeout: TimeInterval
  ) -> Double {
    guard let origin = lastAccessUnitAt ?? sessionStartedAt else { return 0 }
    let silent = now.timeIntervalSince(origin)
    return silent > timeout ? silent : 0
  }
}
