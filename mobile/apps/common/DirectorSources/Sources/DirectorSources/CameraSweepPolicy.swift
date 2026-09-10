import Foundation

/// When to sweep the subnet for cameras, and how hard.
///
/// Discovery normally arrives by itself: NDI listens for mDNS and RTSP watches its own
/// advertisements. A sweep is the fallback for when that fails — a camera transmitting perfectly
/// while advertising a service name with no address behind it is invisible to every receiver on
/// the network, and only an address probe finds it.
///
/// The sweep is not free. Most of a /24 has no host, and each of those costs an ARP broadcast that
/// every device on the segment has to process — cameras included. So it runs freely when nothing
/// is at stake and only on demand when something is: during a recording or a stream the sweep
/// starts *because* an enabled camera has gone missing, and stops when it comes back.
///
/// The dropout itself is noticed within a second — the sweeper re-checks that cheaply while it has
/// nothing to do — so a camera that drops mid-recording is chased straight away, and only then
/// settles into the gap below.
///
/// Gaps are measured from the end of the previous sweep rather than on a fixed period. A sweep
/// takes a couple of seconds, and a fixed timer shorter than that would start the next one before
/// the last had finished.
public struct CameraSweepPolicy: Sendable, Equatable {
  /// When a sweep happens at all: only while the operator is on the camera list, or while an
  /// enabled camera is missing. Never simply because time passed.
  ///
  /// Gap between sweeps, whether the sweep is routine or chasing a camera that dropped.
  ///
  /// Ten seconds rather than the three it began at, because the cost is not the app's to pay: most
  /// of a /24 has no host, and every one of those probes is an ARP broadcast that every device on
  /// the segment must process. Measured on the bench, sweeping every three seconds was enough to
  /// make the iPad's own Wi-Fi noticeably slow, and the Director is the device that can least
  /// afford it.
  ///
  /// One gap for both cases on purpose. The backoff this replaces stepped 3 → 6 → 15 by how long a
  /// camera had been missing, on the reasoning that a camera gone two minutes is probably switched
  /// off. That is still true, but it bought its patience with a burst of broadcasts in the first
  /// minute — exactly when the operator is most likely to be recording.
  public static let gapSeconds: Double = 10

  /// Kept as the name the rest of the app already uses for the routine cadence.
  public static var idleGapSeconds: Double { gapSeconds }

  /// The longest gap between sweeps. Flat now, so a camera that comes back an hour in is still
  /// found within ten seconds rather than fifteen.
  public static var maximumGapSeconds: Double { gapSeconds }

  /// When the current run of recovery sweeps began. Nil when nothing is missing.
  private var missingSince: Double?

  public init() {}

  /// What to do now. Nil means do not sweep.
  ///
  /// - Parameters:
  ///   - isBusy: recording or streaming — the states where a sweep's broadcasts are unwelcome.
  ///   - anyEnabledCameraMissing: an enabled camera that discovery cannot currently see.
  ///   - now: monotonic seconds.
  /// - Returns: the gap to leave after the sweep that follows, or nil to not sweep at all.
  /// - Parameters:
  ///   - isBusy: recording or streaming — the states where a sweep's broadcasts are unwelcome.
  ///   - anyEnabledCameraMissing: an enabled camera that discovery cannot currently see.
  ///   - isBrowsing: the operator is looking at the camera list, so a sweep is what they asked for.
  ///   - now: monotonic seconds.
  public mutating func gapAfterNextSweep(
    isBusy: Bool,
    anyEnabledCameraMissing: Bool,
    isBrowsing: Bool,
    now: Double
  ) -> Double? {
    guard anyEnabledCameraMissing else {
      // Everything enabled is accounted for. Clearing this is what makes the next dropout read as
      // a new one rather than a continuation of the last.
      missingSince = nil
      // Nothing missing and nobody looking: do not sweep at all. Sweeping on a timer through a
      // whole game costs every device on the segment an ARP storm every few seconds to answer a
      // question nobody asked, and it was measured slowing a camera's own delivery.
      return isBrowsing ? Self.gapSeconds : nil
    }

    // Remembered for telemetry, and so a camera that comes back and goes again reads as a fresh
    // dropout rather than a continuation.
    missingSince = missingSince ?? now
    return Self.gapSeconds
  }

  /// How long the current dropout has lasted, for telemetry. Nil when nothing is missing.
  public func missingForSeconds(now: Double) -> Double? {
    missingSince.map { max(0, now - $0) }
  }
}
