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
/// Gaps are measured from the end of the previous sweep rather than on a fixed period. A sweep
/// takes a couple of seconds, and a fixed timer shorter than that would start the next one before
/// the last had finished.
public struct CameraSweepPolicy: Sendable, Equatable {
  /// Gap between sweeps when nothing is being recorded or streamed. Discovery costs nothing to
  /// anyone at that point, and the operator is usually looking at the camera list.
  public static let idleGapSeconds: Double = 3

  /// Gap between recovery sweeps, by how long the camera has been missing. A camera that has just
  /// dropped is worth chasing hard; one that has been gone two minutes is probably switched off,
  /// and hammering the segment for the rest of the game helps nobody.
  public static let backoff: [(afterSeconds: Double, gapSeconds: Double)] = [
    (0, 3),
    (60, 6),
    (120, 15)
  ]

  /// The longest gap the backoff reaches. Held from then on rather than growing: a camera that
  /// comes back an hour in should still be found within fifteen seconds.
  public static var maximumGapSeconds: Double { backoff.last?.gapSeconds ?? 15 }

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
  public mutating func gapAfterNextSweep(
    isBusy: Bool,
    anyEnabledCameraMissing: Bool,
    now: Double
  ) -> Double? {
    guard anyEnabledCameraMissing else {
      // Everything enabled is accounted for, so the next dropout starts the backoff again from
      // its shortest gap rather than inheriting the last one's patience.
      missingSince = nil
      return isBusy ? nil : Self.idleGapSeconds
    }

    let since = missingSince ?? now
    missingSince = since

    guard isBusy else { return Self.idleGapSeconds }

    let missingFor = max(0, now - since)
    var gap = Self.backoff[0].gapSeconds
    for step in Self.backoff where missingFor >= step.afterSeconds {
      gap = step.gapSeconds
    }
    return gap
  }

  /// How long the current dropout has lasted, for telemetry. Nil when nothing is missing.
  public func missingForSeconds(now: Double) -> Double? {
    missingSince.map { max(0, now - $0) }
  }
}
