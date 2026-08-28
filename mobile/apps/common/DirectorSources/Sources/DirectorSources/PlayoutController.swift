import Foundation
import DirectorCore

/// Decides how far behind its own timestamps a camera has to be played to look smooth.
///
/// These cameras spend roughly half of every second transmitting one keyframe, so frames arrive in
/// a burst and then not at all. Presenting each one the moment it lands reproduces that pattern on
/// the screen; presenting them against their own timestamps removes it, provided enough video is
/// already in hand to cover the quiet half. That amount is what this computes.
///
/// The operative value is `offsetSeconds`: add it to a frame's presentation time to get the wall
/// clock at which the frame should be released. It is deliberately not a fixed delay. The camera's
/// clock and the device's drift apart by tens of parts per million — a hundred milliseconds an hour,
/// enough to empty or overfill a buffer this size — so the offset tracks the arrivals continuously
/// and the same mechanism that follows drift is the one that resizes the buffer.
///
/// Pure and driven by an explicit clock, so convergence can be tested against a recorded arrival
/// trace without a camera.
public struct PlayoutController: Sendable {
  public struct Limits: Sendable {
    /// Below this there is no point buffering at all.
    public var minimumMilliseconds: Double
    /// A camera needing more than this is broken rather than jittery, and the operator is better
    /// served by a stuttering picture than by a preview two seconds behind their hands. The
    /// Performance cap can tighten this; it cannot raise it.
    public var maximumMilliseconds: Double
    /// Headroom over the worst arrival seen: one frame interval, plus what our own decode costs on
    /// the keyframe that caused the burst.
    public var marginMilliseconds: Double
    /// How much history sizing considers. Several keyframe cycles, so one burst cannot define the
    /// buffer forever, and short enough that clock drift does not read as jitter.
    public var windowSeconds: Double
    /// Growth as a fraction of real time. Video at 1.03× is invisible; a step change is not.
    public var growthRate: Double
    /// Shrinking is the risky direction — too far and the stutter returns — so it is slower.
    public var shrinkRate: Double
    /// Quiet period after a late frame before any delay is given back.
    public var settleSeconds: Double

    public init(
      minimumMilliseconds: Double = 50,
      maximumMilliseconds: Double = 2_000,
      marginMilliseconds: Double = 50,
      windowSeconds: Double = 10,
      growthRate: Double = 0.03,
      shrinkRate: Double = 0.01,
      settleSeconds: Double = 20
    ) {
      self.minimumMilliseconds = minimumMilliseconds
      self.maximumMilliseconds = maximumMilliseconds
      self.marginMilliseconds = marginMilliseconds
      self.windowSeconds = windowSeconds
      self.growthRate = growthRate
      self.shrinkRate = shrinkRate
      self.settleSeconds = settleSeconds
    }
  }

  /// A frame's lateness: when it arrived, less where its own timestamp says it belongs.
  private struct Sample {
    let at: Double
    let lateness: Double
  }

  public let limits: Limits
  /// Where this camera's buffer starts before anything has been measured — the value it converged
  /// on last time, if the operator has used it before.
  public let seedMilliseconds: Double

  private var samples: [Sample] = []
  private var offset: Double?
  private var lastAdvanceAt: Double?
  private var lastLateFrameAt: Double?
  private var floorSeconds: Double = 0
  private var ceilingSeconds: Double?
  /// Recomputed whenever the window changes rather than on every read: the drain tick asks for
  /// these hundreds of times a second, and the window holds a sample per frame.
  private var fastest: Double?
  private var slowest: Double?

  public private(set) var lateFrames: UInt64 = 0

  public init(seedMilliseconds: Double = 300, limits: Limits = Limits()) {
    self.limits = limits
    self.seedMilliseconds = min(max(seedMilliseconds, limits.minimumMilliseconds), limits.maximumMilliseconds)
  }

  // MARK: - Reading

  /// Add to a presentation time to get the wall clock the frame is due at. Zero until the first
  /// frame, which is the caller's signal that there is nothing to schedule against yet.
  public var offsetSeconds: Double { offset ?? 0 }

  /// The buffer this camera currently holds, which is the offset measured from the fastest frame
  /// rather than from zero — the absolute offset includes however far behind the camera's clock
  /// runs, which costs nothing and cannot be removed.
  public var bufferMilliseconds: Double {
    guard let offset, let fastest else { return 0 }
    return (offset - fastest) * 1000
  }

  /// How long to hold anything that has no presentation time of its own. Live camera audio does
  /// not use this: it is scheduled through `scheduleTime` against the same offset as the picture.
  public var holdSeconds: Double { bufferMilliseconds / 1000 }

  /// False until the first video frame has given the delay line an offset. Audio arriving before
  /// that cannot be mapped onto the picture's timeline yet.
  public var hasOffset: Bool { offset != nil }

  /// Whether the window is full. Until it is, the buffer is a guess seeded from last time.
  public func isConverged(at now: Double) -> Bool {
    guard let first = samples.first else { return false }
    return now - first.at >= limits.windowSeconds
  }

  public func dueTime(presentationSeconds: Double) -> Double {
    presentationSeconds + offsetSeconds
  }

  /// When this sample should be released, on the same uptime clock the delay line uses.
  ///
  /// Until the first video frame has sized the buffer, audio waits the seed delay from arrival so
  /// it is not mixed at uptime zero. After that it follows its own RTP timeline through the same
  /// offset as the picture, which is what keeps a keyframe burst from stacking a second of audio
  /// onto one mix slot.
  public func scheduleTime(presentationSeconds: Double, nowUptime: Double) -> Double {
    guard hasOffset else {
      return nowUptime + seedMilliseconds / 1_000
    }
    return dueTime(presentationSeconds: presentationSeconds)
  }

  // MARK: - Writing

  /// Records one frame's arrival. Returns true if the frame was already past its due time, which is
  /// the underrun this whole mechanism exists to avoid: the picture stalled waiting for it.
  @discardableResult
  public mutating func note(lateness: Double, at now: Double) -> Bool {
    samples.append(Sample(at: now, lateness: lateness))
    trim(before: now - limits.windowSeconds)
    refreshExtremes()

    guard let current = offset else {
      offset = lateness + seedMilliseconds / 1000
      lastAdvanceAt = now
      return false
    }

    guard lateness > current else { return false }
    // Nothing to hide: the stall has already happened, so the offset jumps rather than easing.
    offset = clamp(lateness + limits.marginMilliseconds / 1000, at: now)
    lastLateFrameAt = now
    lateFrames &+= 1
    return true
  }

  /// The floor imposed from outside, so several cameras on the same screen can be held to a common
  /// delay. A tile 300 ms behind next to one 600 ms behind shows two different moments of the same
  /// game, which is worse than either being late.
  public mutating func setFloor(milliseconds: Double) {
    floorSeconds = min(max(milliseconds, 0), limits.maximumMilliseconds) / 1000
  }

  /// The operator's ceiling from Performance. `nil` leaves the delay line to its own maximum.
  public mutating func setCeiling(milliseconds: Double?) {
    ceilingSeconds = milliseconds.map {
      min(max($0, 0), limits.maximumMilliseconds) / 1000
    }
  }

  /// Moves the offset toward what the measurements now ask for. Called on every drain tick rather
  /// than on arrival, because easing is a function of elapsed time and arrivals are exactly what
  /// stops being regular during a burst.
  public mutating func advance(to now: Double) {
    if trim(before: now - limits.windowSeconds) { refreshExtremes() }
    guard let current = offset else { return }
    let elapsed = max(0, now - (lastAdvanceAt ?? now))
    lastAdvanceAt = now

    let desired = clamp(desiredOffset(default: current), at: now)
    if desired > current {
      offset = min(desired, current + limits.growthRate * elapsed)
      return
    }

    // Give delay back only after the stream has been quiet for a while. Shrinking straight after a
    // late frame is how a buffer ends up oscillating around the size that has just been shown not
    // to work.
    let isSettled = lastLateFrameAt.map { now - $0 >= limits.settleSeconds } ?? true
    guard isSettled else { return }
    offset = max(desired, current - limits.shrinkRate * elapsed)
  }

  /// A reconnect gives the camera a new timeline, so every measurement taken against the old one is
  /// meaningless — but what it converged on is the best available guess for the new session.
  public func reset() -> PlayoutController {
    PlayoutController(
      seedMilliseconds: samples.isEmpty ? seedMilliseconds : bufferMilliseconds,
      limits: limits
    )
  }

  // MARK: - Helpers

  private func desiredOffset(default fallback: Double) -> Double {
    guard let slowest else { return fallback }
    return slowest + limits.marginMilliseconds / 1000
  }

  /// Keeps the offset inside the configured buffer range and above any externally imposed floor.
  /// Measured from the fastest frame, so the part of the offset that is only the camera's clock
  /// sitting behind ours — which costs nothing and cannot be removed — is not counted against the
  /// limits.
  private func clamp(_ proposed: Double, at now: Double) -> Double {
    let base = fastest ?? proposed
    let floor = max(limits.minimumMilliseconds / 1000, floorSeconds)
    let cap = ceilingSeconds ?? (limits.maximumMilliseconds / 1000)
    return min(max(proposed, base + floor), base + cap)
  }

  @discardableResult
  private mutating func trim(before cutoff: Double) -> Bool {
    guard let first = samples.first, first.at < cutoff else { return false }
    samples.removeAll { $0.at < cutoff }
    return true
  }

  private mutating func refreshExtremes() {
    var low = Double.greatestFiniteMagnitude
    var high = -Double.greatestFiniteMagnitude
    for sample in samples {
      low = min(low, sample.lateness)
      high = max(high, sample.lateness)
    }
    fastest = samples.isEmpty ? nil : low
    slowest = samples.isEmpty ? nil : high
  }
}

/// Holds every camera to the same delay.
///
/// Each camera measures its own requirement, but they are watched side by side and cut between, so
/// the one that needs the most sets the delay for all of them. Without this, a cut from a 250 ms
/// tile to a 600 ms tile would jump a third of a second backwards in time.
public final class PlayoutCoordinator: @unchecked Sendable {
  private let lock = NSLock()
  private var reported: [SourceID: Double] = [:]
  private var seeds: [SourceID: Double] = [:]
  private var capMilliseconds: Double?

  public init() {}

  /// What this camera converged on the last time it was used, from the named-camera cache.
  public func seed(_ milliseconds: Double?, for sourceID: SourceID) {
    lock.lock()
    seeds[sourceID] = milliseconds
    lock.unlock()
  }

  public func seedMilliseconds(for sourceID: SourceID) -> Double? {
    lock.lock()
    defer { lock.unlock() }
    return seeds[sourceID]
  }

  /// Publishes one camera's requirement and returns the delay every camera should now be holding.
  @discardableResult
  public func report(_ milliseconds: Double, for sourceID: SourceID) -> Double {
    lock.lock()
    defer { lock.unlock() }
    reported[sourceID] = milliseconds
    return capped(reported.values.max() ?? milliseconds)
  }

  public var programMilliseconds: Double {
    lock.lock()
    defer { lock.unlock() }
    return capped(reported.values.max() ?? 0)
  }

  /// `nil` while the operator has left the delay line unbounded.
  public var latencyCapMilliseconds: Double? {
    lock.lock()
    defer { lock.unlock() }
    return capMilliseconds
  }

  /// Tightens every camera to this ceiling. Passing `nil` restores the engine's own maximum.
  public func setCap(milliseconds: Double?) {
    lock.lock()
    capMilliseconds = milliseconds.map {
      AppConfig.clampedDisplayLatencyCap($0)
    }
    lock.unlock()
  }

  public var perSourceMilliseconds: [SourceID: Double] {
    lock.lock()
    defer { lock.unlock() }
    return reported
  }

  public func retire(_ sourceID: SourceID) {
    lock.lock()
    reported.removeValue(forKey: sourceID)
    lock.unlock()
  }

  private func capped(_ milliseconds: Double) -> Double {
    if let capMilliseconds { return min(milliseconds, capMilliseconds) }
    return milliseconds
  }
}
