import Foundation

/// Turns a counter that only climbs into a per-second rate, folded once a second.
///
/// The transports count loss cumulatively — RTP sequence gaps, the NDI SDK's dropped frames —
/// which is right for a log and useless on a screen, where "lost 4,812 since we started" says
/// nothing about whether the link is bad *now*. This reads the counter each poll and reports
/// how much it moved over the last whole second, the same way `framesPerSecond` is folded.
///
/// A counter that goes *down* is a new pipeline on the same slot, not negative loss: the
/// baseline restarts and the rate reads zero until a full second has been observed again.
public struct CounterRateTracker: Sendable, Equatable {
  /// The last folded rate, to one decimal. Changes at most once a second.
  public private(set) var perSecond: Double = 0
  private var baseline: UInt64?
  private var since: TimeInterval = 0

  public init() {}

  /// Feeds the counter's current value. Returns the rate as of this sample.
  @discardableResult
  public mutating func record(_ cumulative: UInt64, at now: TimeInterval) -> Double {
    guard let baseline, cumulative >= baseline else {
      self.baseline = cumulative
      since = now
      perSecond = 0
      return perSecond
    }
    let elapsed = now - since
    guard elapsed >= 1 else { return perSecond }
    perSecond = (Double(cumulative - baseline) / elapsed * 10).rounded() / 10
    self.baseline = cumulative
    since = now
    return perSecond
  }
}
