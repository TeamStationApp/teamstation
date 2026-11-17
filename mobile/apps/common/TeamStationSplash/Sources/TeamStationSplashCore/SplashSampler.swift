/// CSS's `cubic-bezier(x1, y1, x2, y2)`, solved for x by Newton's method with
/// a bisection fallback, as browsers do.
public struct CubicBezier: Sendable {
  private let ax, bx, cx, ay, by, cy: Double

  public init(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) {
    cx = 3 * x1
    bx = 3 * (x2 - x1) - cx
    ax = 1 - cx - bx
    cy = 3 * y1
    by = 3 * (y2 - y1) - cy
    ay = 1 - cy - by
  }

  public init(_ points: [Double]) {
    precondition(points.count == 4, "A cubic-bezier needs four numbers")
    self.init(points[0], points[1], points[2], points[3])
  }

  private func x(_ t: Double) -> Double { ((ax * t + bx) * t + cx) * t }
  private func y(_ t: Double) -> Double { ((ay * t + by) * t + cy) * t }
  private func dx(_ t: Double) -> Double { (3 * ax * t + 2 * bx) * t + cx }

  /// The eased value at `progress` (0–1).
  public func callAsFunction(_ progress: Double) -> Double {
    if progress <= 0 { return 0 }
    if progress >= 1 { return 1 }
    var t = progress
    for _ in 0..<8 {
      let error = x(t) - progress
      if abs(error) < 1e-7 { return y(t) }
      let slope = dx(t)
      if abs(slope) < 1e-6 { break }
      t -= error / slope
    }
    var lo = 0.0
    var hi = 1.0
    t = progress
    while hi - lo > 1e-7 {
      if x(t) < progress { lo = t } else { hi = t }
      t = (lo + hi) / 2
    }
    return y(t)
  }
}

/// Every animated value of the splash at one moment, in design units: lengths
/// are multiplied by `k` (`SplashGeometry`) before they are drawn.
public struct SplashFrame: Sendable, Equatable {
  public var stadiumScale, stadiumOpacity, stadiumBrightness, stadiumContrast, stadiumBlur: Double
  public var darkOpacity: Double
  public var glowOpacity, glowScale: Double
  public var markOpacity, markScale, markBlur: Double
  public var wordmarkOpacity, wordmarkTranslateY, wordmarkScale: Double
}

/// Samples the timeline: each segment between two keyframes is eased by the
/// layer's curve, as CSS applies `animation-timing-function`.
public enum SplashSampler {
  /// `track`'s value at `progress` (0–1 of the run).
  public static func value(_ track: SplashTrack, easing: CubicBezier, progress: Double) -> Double {
    let keys = track.keys
    if progress <= keys[0].0 { return keys[0].1 }
    let last = keys[keys.count - 1]
    if progress >= last.0 { return last.1 }
    // Inside the run, so some keyframe after the first is at or past it.
    var index = 1
    while progress > keys[index].0 { index += 1 }
    let (from, start) = keys[index - 1]
    let (to, end) = keys[index]
    return start + (end - start) * easing((progress - from) / (to - from))
  }

  /// One named track of `layer` at `ms` milliseconds.
  public static func value(_ layer: SplashLayerTracks, _ name: String, ms: Double) -> Double {
    value(layer[name], easing: CubicBezier(layer.easing), progress: progress(ms))
  }

  /// The fraction of the run `ms` milliseconds is, clamped to 0–1.
  public static func progress(_ ms: Double) -> Double {
    min(1, max(0, ms / SplashTimeline.durationMs))
  }

  /// Every animated value at `ms` milliseconds.
  public static func frame(ms: Double) -> SplashFrame {
    let s = SplashTimeline.stadiumTracks
    let d = SplashTimeline.darkTracks
    let g = SplashTimeline.glowTracks
    let m = SplashTimeline.markTracks
    let w = SplashTimeline.wordmarkTracks
    return SplashFrame(
      stadiumScale: value(s, "scale", ms: ms),
      stadiumOpacity: value(s, "opacity", ms: ms),
      stadiumBrightness: value(s, "brightness", ms: ms),
      stadiumContrast: value(s, "contrast", ms: ms),
      stadiumBlur: value(s, "blur", ms: ms),
      darkOpacity: value(d, "opacity", ms: ms),
      glowOpacity: value(g, "opacity", ms: ms),
      glowScale: value(g, "scale", ms: ms),
      markOpacity: value(m, "opacity", ms: ms),
      markScale: value(m, "scale", ms: ms),
      markBlur: value(m, "blur", ms: ms),
      wordmarkOpacity: value(w, "opacity", ms: ms),
      wordmarkTranslateY: value(w, "translateY", ms: ms),
      wordmarkScale: value(w, "scale", ms: ms)
    )
  }
}
