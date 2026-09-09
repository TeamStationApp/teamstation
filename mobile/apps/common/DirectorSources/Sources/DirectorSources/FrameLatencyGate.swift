import DirectorCore
import Foundation

/// Whether a picture is still worth showing, and whether it is still worth keeping.
///
/// Both questions are asked of every source, whatever transport carried it, so neither belongs in
/// a transport. A source hands the pipeline the same picture twice — decoded for the screen, coded
/// for the archive — and the two consumers want different answers: the monitor is worthless
/// showing action that has already happened, while the recording is watched afterwards, where a
/// late picture is simply a picture and dropping it leaves a hole in the tape. So there are two
/// caps, the disk one the more generous.
///
/// Frames are judged on capture-to-**arrival** age: how old the action already was when the
/// picture reached us, which is what an operator sees when a tile drifts behind the room. Time
/// spent afterwards in the delay line is not staleness — it is the hold that paces the picture,
/// and it has a ceiling of its own. A source that cannot say when it captured a frame is always
/// admitted — refusing on an unknown age would silently blank a camera whose clock has not yet
/// been anchored.
public struct FrameLatencyGate: Sendable {
  public struct Caps: Sendable, Equatable {
    /// Nil means no ceiling: the operator has not turned this cap on.
    public var displaySeconds: Double?
    public var diskSeconds: Double?

    public init(displaySeconds: Double? = nil, diskSeconds: Double? = nil) {
      self.displaySeconds = displaySeconds
      self.diskSeconds = diskSeconds
    }

    public init(config: AppConfig) {
      self.displaySeconds = config.displayLatencyCapEnabled
        ? config.displayLatencyCapMilliseconds / 1_000
        : nil
      self.diskSeconds = config.diskLatencyCapEnabled
        ? config.diskLatencyCapMilliseconds / 1_000
        : nil
    }
  }

  public private(set) var caps: Caps

  public init(caps: Caps = Caps()) {
    self.caps = caps
  }

  public mutating func setCaps(_ caps: Caps) {
    self.caps = caps
  }

  /// Age of a picture in seconds, or nil when the source cannot say when it was captured.
  ///
  /// A capture time in the future is clamped to zero rather than treated as an error: a camera
  /// whose clock is a few milliseconds ahead of ours is ordinary, and reading that as a negative
  /// age would make the frame look infinitely fresh.
  public static func age(captured: WallClock?, now: WallClock) -> Double? {
    guard let captured else { return nil }
    return max(0, now.seconds - captured.seconds)
  }

  public func admitsForDisplay(captured: WallClock?, now: WallClock) -> Bool {
    admits(captured: captured, now: now, cap: caps.displaySeconds)
  }

  public func admitsForDisk(captured: WallClock?, now: WallClock) -> Bool {
    admits(captured: captured, now: now, cap: caps.diskSeconds)
  }

  private func admits(captured: WallClock?, now: WallClock, cap: Double?) -> Bool {
    guard let cap else { return true }
    guard let age = Self.age(captured: captured, now: now) else { return true }
    return age <= cap
  }
}
