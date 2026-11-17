package app.teamstation.app.splash

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.os.Handler
import android.os.Looper
import android.view.Choreographer
import android.view.MotionEvent
import android.view.View
import app.teamstation.app.R
import java.util.Locale
import java.util.concurrent.Executors

/**
 * The splash, drawn onto one canvas: the radial gradients as shaders, the stadium scaled about its
 * focus inside an alpha layer, and the brand images cross-faded for their blur. A frame callback
 * samples [SplashSampler] at the clock's time on every frame; a size change lays it out again, and everything a frame
 * draws with is made then, not per frame.
 */
@SuppressLint("ViewConstructor")
class SplashView(context: Context, val frozenMs: Double?) : View(context) {
  private val density = resources.displayMetrics.density
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
  private val adding = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply {
    xfermode = PorterDuffXfermode(PorterDuff.Mode.ADD)
  }
  private var placeholder: Bitmap? = null
  private var images: Images? = null
  private var playing = false
  private var contentReady = false
  private var released = false

  private var layout: Layout? = null
  private val brandBounds = RectF()

  /** The moment drawn now, in milliseconds of the timeline. */
  var currentMs: Double = frozenMs ?: 0.0
    private set

  /** When the timeline started, in uptime milliseconds; null until the images have decoded. */
  var startedAt: Long? = null
    private set

  /** Whether frame 0 is drawn from the small placeholder. */
  val showsPlaceholder: Boolean get() = placeholder != null

  /** Whether the full stadium is drawn: false while frame 0 is the small placeholder. */
  val showsStadium: Boolean get() = images?.stadium != null

  init {
    id = R.id.tsSplash
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    isClickable = true
    updateDescription()
  }

  /** Reads one image; null when it cannot be decoded, so a failed image never fails the launch. */
  internal var decoder: (Int) -> Bitmap? = ::decode

  /**
   * Shows frame 0 now, from the small launch frame, so the splash's first drawn frame is the one
   * the starting window hands over to. Then decodes the brand and the 4K stadium off the main
   * thread, which start the timeline; [started] runs once it has.
   */
  fun start(started: () -> Unit) {
    showPlaceholder(read(R.drawable.splash_launch_frame))
    val main = Handler(Looper.getMainLooper())
    val executor = Executors.newSingleThreadExecutor()
    executor.execute {
      val decoded = Images(
        mark = read(R.drawable.splash_mark),
        markBlurred = read(R.drawable.splash_mark_blurred),
        wordmark = read(R.drawable.splash_wordmark),
        wordmarkBlurred = read(R.drawable.splash_wordmark_blurred),
        stadiumBlurred = read(R.drawable.splash_stadium_blurred),
        stadium = read(R.drawable.splash_stadium),
      )
      main.post {
        if (released) return@post
        begin(decoded)
        started()
      }
    }
    executor.shutdown()
  }

  private fun read(resource: Int): Bitmap? = try {
    decoder(resource)
  } catch (_: Throwable) {
    null
  }

  internal fun showPlaceholder(frame: Bitmap?) {
    if (released) return
    placeholder = frame
    invalidate()
  }

  /**
   * Shows [decoded] and starts the timeline now. Without a stadium, frame 0 stays the placeholder
   * while the brand still plays over it.
   */
  internal fun begin(decoded: Images) {
    images = decoded
    if (decoded.stadium != null) placeholder = null
    startedAt = android.os.SystemClock.uptimeMillis()
    if (frozenMs != null) {
      currentMs = frozenMs
      invalidate()
      return
    }
    playing = true
    Choreographer.getInstance().postFrameCallback(tick)
  }

  /**
   * Each frame draws the moment the clock has reached, as the dismissal policy reads it, whatever
   * the system's animator duration scale is (Remove animations sets it to 0).
   */
  private val tick: Choreographer.FrameCallback = Choreographer.FrameCallback {
    if (!playing) return@FrameCallback
    currentMs = elapsedMs().coerceAtMost(SplashTimeline.DURATION_MS)
    invalidate()
    if (currentMs < SplashTimeline.DURATION_MS) Choreographer.getInstance().postFrameCallback(tick) else playing = false
  }

  /** Milliseconds since the timeline started. */
  fun elapsedMs(now: Long = android.os.SystemClock.uptimeMillis()): Double =
    startedAt?.let { (now - it).toDouble() } ?: 0.0

  /** React Native has drawn: the description says so. */
  fun contentDidAppear() {
    contentReady = true
    updateDescription()
  }

  /** Stops the animation, as the view leaves. */
  fun stop() {
    playing = false
    Choreographer.getInstance().removeFrameCallback(tick)
  }

  /** Stops and lets go of every image, once the splash has gone; a decode still running is dropped. */
  fun release() {
    stop()
    released = true
    placeholder = null
    images = null
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    layout = if (w > 0 && h > 0) Layout(SplashGeometry(w / density.toDouble(), h / density.toDouble())) else null
    updateDescription()
  }

  /** The splash takes the touches meant for the screen beneath it. */
  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean = true

  private fun updateDescription() {
    val w = format(width / density)
    val h = format(height / density)
    contentDescription = "TeamStation, ${if (contentReady) "ready" else "loading"} ${w}x$h@${format(density)}"
  }

  override fun onDraw(canvas: Canvas) {
    val l = layout ?: return
    val f = SplashSampler.frame(currentMs)
    fill(canvas, l.full, l.base, 1.0)
    val decoded = images
    val image = decoded?.stadium
    if (image == null) {
      // Frame 0 with the dark layer already in it.
      placeholder?.let { draw(canvas, it, l.cover(it), 1.0) }
    } else {
      canvas.save()
      canvas.scale(f.stadiumScale.toFloat(), f.stadiumScale.toFloat(), l.pivotX, l.pivotY)
      val layer = canvas.saveLayerAlpha(l.element, alpha(f.stadiumOpacity))
      draw(canvas, image, l.cover, 1.0)
      decoded.stadiumBlurred?.let { draw(canvas, it, l.cover, stadiumBlurMix(f.stadiumBlur)) }
      paint.shader = null
      paint.color = 0xff000000.toInt()
      paint.alpha = alpha(dimming(f.stadiumBrightness))
      canvas.drawRect(l.element, paint)
      canvas.restoreToCount(layer)
      canvas.restore()
      fill(canvas, l.full, l.dark, f.darkOpacity)
    }
    fill(canvas, l.full, l.vignette, 1.0)

    canvas.save()
    canvas.scale(f.glowScale.toFloat(), f.glowScale.toFloat(), l.cx, l.cy)
    fill(canvas, l.glowRect, l.glow, f.glowOpacity)
    canvas.restore()

    if (decoded == null || f.markOpacity <= 0) return
    val blur = brandBlurMix(f.markBlur)
    val ty = ((f.wordmarkTranslateY - SplashTimeline.WORDMARK_REST_Y) * l.k * density).toFloat()
    val ws = f.wordmarkScale.toFloat()
    // The brand layer holds the mark and the wordmark where its move and scale put it.
    brandBounds.set(
      l.box.centerX() + (l.word.left - l.box.centerX()) * ws,
      l.box.centerY() + (l.word.top - l.box.centerY()) * ws + ty,
      l.box.centerX() + (l.word.right - l.box.centerX()) * ws,
      l.box.centerY() + (l.word.bottom - l.box.centerY()) * ws + ty,
    )
    brandBounds.union(l.mark)
    canvas.save()
    canvas.scale(f.markScale.toFloat(), f.markScale.toFloat(), l.cx, l.cy)
    val brand = canvas.saveLayerAlpha(brandBounds, alpha(f.markOpacity))
    crossFade(canvas, decoded.mark, decoded.markBlurred, l.mark, blur)
    if (f.wordmarkOpacity > 0) {
      canvas.save()
      canvas.translate(0f, ty)
      canvas.scale(ws, ws, l.box.centerX(), l.box.centerY())
      val word = canvas.saveLayerAlpha(l.word, alpha(f.wordmarkOpacity))
      crossFade(canvas, decoded.wordmark, decoded.wordmarkBlurred, l.word, blur)
      canvas.restoreToCount(word)
      canvas.restore()
    }
    canvas.restoreToCount(brand)
    canvas.restore()
  }

  /** Fills [rect] with [shader] at [opacity]. */
  private fun fill(canvas: Canvas, rect: RectF, shader: Shader, opacity: Double) {
    if (opacity <= 0) return
    paint.shader = shader
    paint.alpha = alpha(opacity)
    canvas.drawRect(rect, paint)
    paint.shader = null
  }

  /**
   * [sharp] at `1 - blur` and [blurred] at [blur], added rather than layered over each other: the
   * weights sum to one, so an opaque glyph stays opaque all through the blur, as CSS's blur() keeps
   * it. [canvas] is a layer holding nothing else under [rect], so the sum is of the two images alone.
   */
  internal fun crossFade(canvas: Canvas, sharp: Bitmap?, blurred: Bitmap?, rect: RectF, blur: Double) {
    sharp?.let { draw(canvas, it, rect, 1 - blur) }
    if (blurred == null || blur <= 0) return
    adding.alpha = alpha(blur)
    canvas.drawBitmap(blurred, null, rect, adding)
  }

  private fun draw(canvas: Canvas, bitmap: Bitmap, rect: RectF, opacity: Double) {
    if (opacity <= 0) return
    paint.shader = null
    paint.alpha = alpha(opacity)
    canvas.drawBitmap(bitmap, null, rect, paint)
  }

  private fun decode(resource: Int): Bitmap? =
    BitmapFactory.decodeResource(resources, resource, BitmapFactory.Options().apply { inScaled = false })

  /** The decoded images the timeline draws. */
  internal class Images(
    val mark: Bitmap?,
    val markBlurred: Bitmap?,
    val wordmark: Bitmap?,
    val wordmarkBlurred: Bitmap?,
    val stadiumBlurred: Bitmap?,
    val stadium: Bitmap?,
  )

  /** Everything a frame draws with at one size, in pixels. */
  private inner class Layout(g: SplashGeometry) {
    val k = g.k
    val full = RectF(0f, 0f, (g.width * density).toFloat(), (g.height * density).toFloat())
    val element = px(g.element)
    val cover = px(g.cover)
    val pivotX = element.left + element.width() * SplashTimeline.FOCUS_X.toFloat()
    val pivotY = element.top + element.height() * SplashTimeline.FOCUS_Y.toFloat()
    val cx = (g.markCenterX * density).toFloat()
    val cy = (g.markCenterY * density).toFloat()
    private val glowHalf = (SplashTimeline.GLOW_SIZE * g.k * density / 2).toFloat()
    val glowRect = RectF(cx - glowHalf, cy - glowHalf, cx + glowHalf, cy + glowHalf)
    val mark = px(g.brand(SplashTimeline.MARK_IMAGE), cx, cy)
    val box = px(g.brand(SplashTimeline.WORDMARK_BOX), cx, cy)
    val word = px(g.brand(SplashTimeline.WORDMARK_IMAGE), cx, cy)
    val base = shader(full, SplashTimeline.BASE)
    val dark = shader(full, SplashTimeline.DARK)
    val vignette = shader(full, SplashTimeline.VIGNETTE)
    val glow = shader(glowRect, SplashTimeline.GLOW)

    /** Where [frame] covers the element, centred, as the launch storyboard's aspect fill does. */
    fun cover(frame: Bitmap): RectF {
      val scale = maxOf(element.width() / frame.width, element.height() / frame.height)
      val w = frame.width * scale
      val h = frame.height * scale
      return RectF(element.centerX() - w / 2, element.centerY() - h / 2, element.centerX() + w / 2, element.centerY() + h / 2)
    }

    private fun px(box: SplashBox, dx: Float = 0f, dy: Float = 0f): RectF {
      val left = (box.x * density).toFloat() + dx
      val top = (box.y * density).toFloat() + dy
      return RectF(left, top, left + (box.width * density).toFloat(), top + (box.height * density).toFloat())
    }

    /** [gradient]'s circle over [rect], reaching its farthest corner. */
    private fun shader(rect: RectF, gradient: SplashGradient): Shader = RadialGradient(
      rect.left + rect.width() * gradient.centerX.toFloat(),
      rect.top + rect.height() * gradient.centerY.toFloat(),
      gradient.radius(rect.width().toDouble(), rect.height().toDouble()).toFloat(),
      gradient.stops.map { it.argb }.toIntArray(),
      gradient.stops.map { it.at.toFloat() }.toFloatArray(),
      Shader.TileMode.CLAMP,
    )
  }

  companion object {
    /** The black layer's opacity for [brightness], with 1.05 baked into the image. */
    fun dimming(brightness: Double): Double = (1 - brightness / SplashTimeline.BAKED_BRIGHTNESS).coerceAtLeast(0.0)

    /** How much of the pre-blurred stadium shows for a blur of [blur] design points. */
    fun stadiumBlurMix(blur: Double): Double {
      val maximum = SplashTimeline.STADIUM_TRACKS["blur"].keys.maxOf { it.second }
      return (blur / maximum).coerceIn(0.0, 1.0)
    }

    /** How much of the pre-blurred brand images shows for the mark's blur. */
    fun brandBlurMix(blur: Double): Double = (blur / SplashTimeline.MARK_BLUR_MAX).coerceIn(0.0, 1.0)

    fun alpha(opacity: Double): Int = (opacity * 255).toInt().coerceIn(0, 255)

    /** [value] for the description, the same in every locale: up to four decimals, no trailing zeros. */
    fun format(value: Float): String {
      val rounded = Math.round(value)
      if (value == rounded.toFloat()) return rounded.toString()
      return String.format(Locale.ROOT, "%.4f", value).trimEnd('0').trimEnd('.')
    }
  }
}
