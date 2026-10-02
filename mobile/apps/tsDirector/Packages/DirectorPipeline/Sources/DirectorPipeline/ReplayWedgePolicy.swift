import Foundation

/// When a tile that believes it is replaying has stopped being a replay.
///
/// Distinct from `ReplayStallPolicy`, which is the decoder's own view: that one asks whether the
/// FIFO has gone quiet and finishes the decoder. This is the backstop for when that never happens
/// — the decoder is gone, or its finish never reached the owner — and the tile is left in
/// `.replaying` with nothing driving it.
///
/// That state is uniquely destructive because of what the router does with it: `.replaying`
/// suppresses both the display present and the programme sink, while arrival counters and frame
/// age keep climbing from the live path. The board reads healthy, the tile reports `live`, and the
/// picture is a still. Found on 2026-09-10 with a tile wedged for **4.4 hours** — arrivals at
/// 60 fps, `displayedFrames` frozen, renderer reporting no failure at all — and cleared instantly
/// by the return-to-live the operator could have pressed at any point.
///
/// Judged on when a picture was last *presented*, not on when one last arrived: arrivals are
/// exactly what keeps flowing through this failure.
public struct ReplayWedgePolicy: Sendable {
  /// How long a replay may present nothing before it is treated as wedged.
  ///
  /// Well clear of anything legitimate. The decoder gives up on its own after two seconds of an
  /// empty FIFO, and even a quarter-speed replay pops a frame several times a second, so five
  /// seconds of a tile in `.replaying` showing nothing is not a slow replay — it is a dead one.
  public var timeout: TimeInterval

  public init(timeout: TimeInterval = 5) {
    self.timeout = max(timeout, 1)
  }

  /// - Parameters:
  ///   - now: seconds since 1970, matching `lastPresentedAt`.
  ///   - lastPresentedAt: when this tile last handed a picture to its display layer, or 0 if never.
  public func shouldReturnToLive(now: TimeInterval, lastPresentedAt: TimeInterval) -> Bool {
    // Zero means nothing has ever been shown on this tile. A replay that has not produced its
    // first frame yet is handled by the decoder's own start path, not here.
    guard lastPresentedAt > 0 else { return false }
    return now - lastPresentedAt >= timeout
  }
}
