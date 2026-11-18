package app.teamstation.app.splash

/** CSS's `cubic-bezier(x1, y1, x2, y2)`, solved for x by Newton's method with a bisection fallback, as browsers do. */
class CubicBezier(x1: Double, y1: Double, x2: Double, y2: Double) {
  constructor(points: List<Double>) : this(points[0], points[1], points[2], points[3]) {
    require(points.size == 4) { "A cubic-bezier needs four numbers" }
  }

  private val cx = 3 * x1
  private val bx = 3 * (x2 - x1) - cx
  private val ax = 1 - cx - bx
  private val cy = 3 * y1
  private val by = 3 * (y2 - y1) - cy
  private val ay = 1 - cy - by

  private fun x(t: Double) = ((ax * t + bx) * t + cx) * t
  private fun y(t: Double) = ((ay * t + by) * t + cy) * t
  private fun dx(t: Double) = (3 * ax * t + 2 * bx) * t + cx

  /** The eased value at [progress] (0–1). */
  operator fun invoke(progress: Double): Double {
    if (progress <= 0) return 0.0
    if (progress >= 1) return 1.0
    var t = progress
    for (i in 0 until 8) {
      val error = x(t) - progress
      if (Math.abs(error) < 1e-7) return y(t)
      val slope = dx(t)
      if (Math.abs(slope) < 1e-6) break
      t -= error / slope
    }
    var lo = 0.0
    var hi = 1.0
    t = progress
    while (hi - lo > 1e-7) {
      if (x(t) < progress) lo = t else hi = t
      t = (lo + hi) / 2
    }
    return y(t)
  }
}

/** Every animated value of the splash at one moment, in design units: lengths are multiplied by `k` before drawing. */
data class SplashFrame(
  val stadiumScale: Double,
  val stadiumOpacity: Double,
  val stadiumBrightness: Double,
  val stadiumContrast: Double,
  val stadiumBlur: Double,
  val darkOpacity: Double,
  val glowOpacity: Double,
  val glowScale: Double,
  val markOpacity: Double,
  val markScale: Double,
  val markBlur: Double,
  val wordmarkOpacity: Double,
  val wordmarkTranslateY: Double,
  val wordmarkScale: Double,
)

/** Samples the timeline: each segment between two keyframes is eased by the layer's curve, as CSS does. */
object SplashSampler {
  /** [track]'s value at [progress] (0–1 of the run). */
  fun value(track: SplashTrack, easing: CubicBezier, progress: Double): Double {
    val keys = track.keys
    if (progress <= keys.first().first) return keys.first().second
    if (progress >= keys.last().first) return keys.last().second
    // Inside the run, so some keyframe after the first is at or past it.
    var index = 1
    while (progress > keys[index].first) index++
    val (from, start) = keys[index - 1]
    val (to, end) = keys[index]
    return start + (end - start) * easing((progress - from) / (to - from))
  }

  /** One named track of [layer] at [ms] milliseconds. */
  fun value(layer: SplashLayerTracks, name: String, ms: Double): Double =
    value(layer[name], layer.curve, progress(ms))

  /** The fraction of the run [ms] milliseconds is, clamped to 0–1. */
  fun progress(ms: Double): Double = (ms / SplashTimeline.DURATION_MS).coerceIn(0.0, 1.0)

  /** Every animated value at [ms] milliseconds. */
  fun frame(ms: Double): SplashFrame {
    val s = SplashTimeline.STADIUM_TRACKS
    val g = SplashTimeline.GLOW_TRACKS
    val m = SplashTimeline.MARK_TRACKS
    val w = SplashTimeline.WORDMARK_TRACKS
    return SplashFrame(
      stadiumScale = value(s, "scale", ms),
      stadiumOpacity = value(s, "opacity", ms),
      stadiumBrightness = value(s, "brightness", ms),
      stadiumContrast = value(s, "contrast", ms),
      stadiumBlur = value(s, "blur", ms),
      darkOpacity = value(SplashTimeline.DARK_TRACKS, "opacity", ms),
      glowOpacity = value(g, "opacity", ms),
      glowScale = value(g, "scale", ms),
      markOpacity = value(m, "opacity", ms),
      markScale = value(m, "scale", ms),
      markBlur = value(m, "blur", ms),
      wordmarkOpacity = value(w, "opacity", ms),
      wordmarkTranslateY = value(w, "translateY", ms),
      wordmarkScale = value(w, "scale", ms),
    )
  }
}
