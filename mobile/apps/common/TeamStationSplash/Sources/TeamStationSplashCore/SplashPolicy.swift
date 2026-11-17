/// When the splash leaves: once the timeline has ended and React Native has
/// drawn its first content, or at the cap after install, whatever state React
/// Native or the image decode is in. A frozen splash (the test hook) never leaves.
public struct SplashPolicy: Sendable, Equatable {
  public enum Decision: Sendable, Equatable {
    case hold
    case dismiss
  }

  public let frozen: Bool
  public private(set) var contentAppeared = false

  public init(frozen: Bool = false) {
    self.frozen = frozen
  }

  public mutating func contentDidAppear() {
    contentAppeared = true
  }

  /// What to do `sinceInstallMs` after the splash went up, `timelineMs` into
  /// its timeline (nil until the timeline has started).
  public func decision(sinceInstallMs: Double, timelineMs: Double?) -> Decision {
    if frozen { return .hold }
    if sinceInstallMs >= SplashTimeline.capMs { return .dismiss }
    if let timelineMs, timelineMs >= SplashTimeline.durationMs, contentAppeared { return .dismiss }
    return .hold
  }
}
