import DirectorCore
import Foundation

/// One playout delay for every camera, sized to the worst of them.
///
/// Per-camera adaptive buffers are the thing this replaces. Each one converges to its own delay,
/// they drift apart, and the buffers themselves become the desync source — measured on this rig as
/// tiles sitting seconds apart while every camera reported a healthy frame rate.
///
/// A frame is shown at `capture + delay`. Because capture times are already on one clock, the tiles
/// are aligned by construction rather than by convergence: nothing has to agree about anything at
/// runtime.
///
/// Every constant here is stated rather than left implicit. `PlayoutController` was under-specified
/// in exactly this way — growth of 3% of real time, shrink of 1%, a twenty second settle — and the
/// result took over three minutes to give back a two second excursion, so an offset that should
/// have been bounded at two seconds was measured at 107.
public final class SharedDelayController: @unchecked Sendable {
  /// How far back to look when deciding what the worst camera needs.
  public static let windowSeconds: Double = 10
  /// Read at a high percentile, not the mean: a camera that misses one frame a second still has a
  /// flattering average and a visible stutter.
  public static let percentile: Double = 0.95
  /// Congestion arrives suddenly, so the delay follows it immediately.
  public static let raiseImmediately = true
  /// Recovery is deliberate but not glacial. 50 ms/s gives a one second excursion back in twenty
  /// seconds; the old 1% of real time would have taken a hundred.
  public static let lowerRatePerSecond: Double = 0.050
  /// Never below this, whatever the cameras ask for: a delay of zero means every frame is late by
  /// definition and the monitor conceals continuously.
  public static let floorSeconds: Double = 0.100

  private struct Sample {
    let at: Double
    let required: Double
  }

  private let lock = NSLock()
  private var samples: [SourceID: [Sample]] = [:]
  private var current: Double
  private var lastUpdate: Double?
  /// The operator's ceiling. This is the bound that does not derive from any measurement, which is
  /// the property the per-camera controller lacked — its cap was relative to a baseline that itself
  /// moved, so when the baseline collapsed the bound went with it.
  private var capSeconds: Double

  public init(initialSeconds: Double = 0.500, capSeconds: Double = 2.0) {
    self.current = initialSeconds
    self.capSeconds = capSeconds
  }

  public var delaySeconds: Double {
    lock.lock()
    defer { lock.unlock() }
    return current
  }

  public func setCap(seconds: Double) {
    lock.lock()
    capSeconds = max(Self.floorSeconds, seconds)
    lock.unlock()
  }

  /// Records what one camera currently needs — the age of its newest frame, corrected onto our
  /// clock — and returns the delay every camera should now use.
  @discardableResult
  public func report(requiredSeconds: Double, for source: SourceID, at now: Double) -> Double {
    lock.lock()
    defer { lock.unlock() }

    var list = samples[source] ?? []
    list.append(Sample(at: now, required: max(0, requiredSeconds)))
    list.removeAll { $0.at < now - Self.windowSeconds }
    samples[source] = list
    samples = samples.filter { !$0.value.isEmpty }

    // Each camera's own high percentile first, then the worst of those. Taking the percentile
    // across all cameras pooled would let a well-behaved camera's many good samples hide one bad
    // camera's tail, which is the camera the delay exists for.
    let perCamera = samples.values.compactMap { list -> Double? in
      guard !list.isEmpty else { return nil }
      let sorted = list.map { $0.required }.sorted()
      let index = min(sorted.count - 1, Int(Double(sorted.count - 1) * Self.percentile))
      return sorted[index]
    }
    let needed = (perCamera.max() ?? current) + 0.050

    let elapsed = max(0, now - (lastUpdate ?? now))
    lastUpdate = now
    if needed > current {
      current = needed
    } else {
      current = max(needed, current - Self.lowerRatePerSecond * elapsed)
    }
    current = min(max(current, Self.floorSeconds), capSeconds)
    return current
  }

  public func retire(_ source: SourceID) {
    lock.lock()
    samples[source] = nil
    lock.unlock()
  }
}
