package app.teamstation.app.splash

/** One colour stop of a radial gradient: where it sits (0–1 of the radius), its colour as 0xRRGGBB, and its alpha. */
data class SplashStop(val at: Double, val rgb: Int, val alpha: Double) {
  /** The stop as an Android ARGB colour. */
  val argb: Int
    get() = (Math.round(alpha * 255).toInt().coerceIn(0, 255) shl 24) or (rgb and 0xffffff)
}

/** A CSS `radial-gradient(circle at x y, …)`: a circle reaching the farthest corner of its box. */
data class SplashGradient(val centerX: Double, val centerY: Double, val stops: List<SplashStop>) {
  /** The radius for a [width]×[height] box. */
  fun radius(width: Double, height: Double): Double {
    val dx = maxOf(centerX, 1 - centerX) * width
    val dy = maxOf(centerY, 1 - centerY) * height
    return Math.sqrt(dx * dx + dy * dy)
  }
}

/** One property's keyframes: (offset 0–1 of the run, value). */
data class SplashTrack(val keys: List<Pair<Double, Double>>)

/** A layer's tracks, all eased by the same curve on every segment. */
data class SplashLayerTracks(val easing: List<Double>, val tracks: Map<String, SplashTrack>) {
  /** [easing] as a curve, made once: the view samples every track on every frame. */
  val curve: CubicBezier by lazy { CubicBezier(easing) }

  operator fun get(name: String): SplashTrack = tracks[name] ?: error("No splash track $name")
}

/** A rectangle in units of the mark's side, measured from the mark's centre. */
data class SplashRect(val x: Double, val y: Double, val width: Double, val height: Double)
