import Foundation

/// Maps a horizontal drag on a tile onto a replay offset.
///
/// Offsets are seconds *behind* the live edge: `0` is live, negative is the past. A swipe is a
/// *delta* from the playhead at finger-down, not a fresh seek from live. That is what makes a
/// second left-swipe go further back, and a right-swipe ease toward now, instead of treating every
/// gesture as if the tape were parked at the end.
///
/// One small-tile width is 60 seconds. Extra travel keeps that rate; the only clamp is available
/// history.
public enum ScrubMapping: Sendable {
  /// A release this close to live is an accidental nudge, not a replay.
  public static let snapToLiveSeconds: Double = 0.5

  /// Seconds represented by dragging across one small source tile.
  public static let secondsPerTileWidth: Double = 60

  /// `translation` is SwiftUI's drag translation: left is negative.
  /// `playheadOffset` is the tile's `offsetSeconds` when the finger went down (`0` if live).
  /// `tileWidth` must be the small source-tile width, even when the gesture is on Output.
  public static func offsetSeconds(
    translation: Double,
    tileWidth: Double,
    historySeconds: Double,
    playheadOffset: Double
  ) -> Double {
    let width = max(tileWidth, 1)
    let history = max(historySeconds, 0)
    let origin = min(0, max(-history, playheadOffset))
    let delta = translation * (secondsPerTileWidth / width)
    return min(0, max(-history, origin + delta))
  }

  /// Whether finger-up should snap to live rather than start replay.
  ///
  /// History shorter than the snap window would otherwise be unreplayable: every release would
  /// look "near live". Any negative offset on a short tape is a real scrub.
  public static func shouldReturnToLive(
    offsetSeconds: Double,
    historySeconds: Double
  ) -> Bool {
    if offsetSeconds >= 0 { return true }
    if historySeconds <= snapToLiveSeconds { return false }
    return offsetSeconds >= -snapToLiveSeconds
  }

  /// Translation to use when the finger lifts. Prefer the lift sample when it is still a
  /// real horizontal drag; otherwise the farthest point during the gesture. SwiftUI often
  /// reports `0` in `onEnded` while Maestro's swipe distance only appeared in `onChanged`.
  public static func endTranslation(
    lift: Double,
    farthest: Double,
    minimumDistance: Double = 12
  ) -> Double {
    if abs(lift) >= minimumDistance { return lift }
    return farthest
  }

  /// Whether finger-up should start the archive decoder. A playlist shorter than a second, or
  /// a start that is already at the live edge of that playlist, plays for a fraction of a
  /// second then `onFinish` snaps to live — which is how "rewind never works" looks.
  public static func shouldStartReplay(
    assemblyDuration: Double,
    startOffset: Double
  ) -> Bool {
    assemblyDuration >= 1 && startOffset < assemblyDuration - 0.25
  }

  /// Instant-replay hotkeys finish after this much *content*, not wall clock. Slow-mo still
  /// returns to live once those seconds of tape have been shown.
  public static func hasPlayedRequestedDuration(
    played: TimeInterval,
    requested: TimeInterval?
  ) -> Bool {
    guard let requested else { return false }
    return played >= requested - 0.02
  }

  /// The assembled playlist ended while the playhead is still behind live. Closed segments lag
  /// the open GOP by up to one segment, so a 5 s rewind would otherwise snap back at about −2 s.
  public static func shouldContinueReplay(currentOffsetSeconds: Double) -> Bool {
    currentOffsetSeconds < -snapToLiveSeconds
  }
}
