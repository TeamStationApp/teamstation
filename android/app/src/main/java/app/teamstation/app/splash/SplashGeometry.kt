package app.teamstation.app.splash

/** A rectangle in dp. */
data class SplashBox(val x: Double, val y: Double, val width: Double, val height: Double)

/** Where everything sits in a [width]×[height] window, in dp. */
class SplashGeometry(val width: Double, val height: Double) {
  /** The mark's side: 210 on the 390×844 design, scaled to fit any window. */
  val side: Double = minOf(
    SplashTimeline.DESIGN_SIDE * width / SplashTimeline.DESIGN_WIDTH,
    SplashTimeline.DESIGN_SIDE * height / SplashTimeline.DESIGN_HEIGHT,
  )

  /** The brand block's scale, `side / 210`; every other length scales by it. */
  val k: Double = side / SplashTimeline.DESIGN_SIDE

  /** The stadium element: the window plus the bleed on every side. */
  val element: SplashBox

  /** The stadium image at scale 1, cover-fit to the element at the focus. */
  val cover: SplashBox

  init {
    val pad = SplashTimeline.BLEED * k
    element = SplashBox(-pad, -pad, width + 2 * pad, height + 2 * pad)
    val scale = maxOf(element.width / SplashTimeline.STADIUM_WIDTH, element.height / SplashTimeline.STADIUM_HEIGHT)
    val w = SplashTimeline.STADIUM_WIDTH * scale
    val h = SplashTimeline.STADIUM_HEIGHT * scale
    cover = SplashBox(
      element.x + (element.width - w) * SplashTimeline.FOCUS_X,
      element.y + (element.height - h) * SplashTimeline.FOCUS_Y,
      w,
      h,
    )
  }

  /** The fraction of the image's width the window shows at scale 1. */
  val visibleWidth: Double get() = minOf(1.0, width / cover.width)

  /** The fraction of the image's height the window shows at scale 1. */
  val visibleHeight: Double get() = minOf(1.0, height / cover.height)

  /** The mark's centre. */
  val markCenterX: Double get() = width * SplashTimeline.MARK_CENTER_X
  val markCenterY: Double get() = height * SplashTimeline.MARK_CENTER_Y

  /** [rect] (mark-side units from the mark's centre) in dp from the mark's centre. */
  fun brand(rect: SplashRect): SplashBox = SplashBox(rect.x * side, rect.y * side, rect.width * side, rect.height * side)
}
