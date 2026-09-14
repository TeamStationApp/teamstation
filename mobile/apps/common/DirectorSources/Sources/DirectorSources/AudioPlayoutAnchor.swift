import Foundation

/// Keeps a camera's live sound where the programme mix can take it when its picture falls behind.
///
/// Live sound is scheduled through the picture's delay-line offset against the sound's own RTP
/// timeline (`PlayoutController.scheduleTime`), which is what keeps a keyframe burst from stacking a
/// second of sound onto one mix slot. That holds only while picture and sound arrive together. The
/// offset is learned from the picture alone, so when a struggling link delays the picture and not
/// the sound, every sound sample comes due seconds in the future; when the sound is the one held
/// up, it comes due in the past. Neither reaches the mix: the queue it waits in holds 2.56 s and
/// drops its oldest beyond that, and the mixer refuses a buffer that ends before its cursor. On
/// rec-411, First's picture fell 7.4 s behind its sound at 68 minutes and the programme was silent
/// from then to the end of the take, while First's own archive kept every second of it.
///
/// So a sample whose due time the mix cannot use is re-anchored to its own arrival, plus the hold
/// the picture is getting, and the samples after it follow the sound's own timeline from there. The
/// sound plays a little ahead of or behind its picture rather than not at all, and it goes back onto
/// the picture's timing as soon as that is usable again.
public struct AudioPlayoutAnchor: Sendable {
  /// How far ahead a sample may be due and still be mixed. The audio delay queue holds 120 access
  /// units, 2.56 s of 48 kHz AAC, and the mixer refuses anything more than 3 s past its cursor.
  public static let maximumLeadSeconds = 2.0
  /// How late a sample may be due and still be mixed: the mixer emits 20 ms behind the live edge.
  public static let maximumLagSeconds = 0.02

  /// Added to the picture's due time while the sound is re-anchored; nil while it is on the
  /// picture's timing.
  public private(set) var correction: Double?

  public init() {}

  /// When a sample the picture's timing says is due at `due` should actually be released, on the
  /// same uptime clock. `holdSeconds` is the delay line's current hold.
  public mutating func schedule(
    due: Double,
    nowUptime: Double,
    holdSeconds: Double
  ) -> (due: Double, reanchored: Bool) {
    if Self.accepts(due, now: nowUptime) {
      correction = nil
      return (due, false)
    }
    if let correction, Self.accepts(due + correction, now: nowUptime) {
      return (due + correction, false)
    }
    let hold = min(max(holdSeconds, 0), Self.maximumLeadSeconds / 2)
    let fixed = nowUptime + hold - due
    correction = fixed
    return (due + fixed, true)
  }

  public static func accepts(_ due: Double, now: Double) -> Bool {
    due >= now - maximumLagSeconds && due <= now + maximumLeadSeconds
  }
}
