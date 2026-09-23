package co.gamestation.app.glass

import android.content.Context
import android.graphics.Canvas
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Outline
import android.graphics.RenderEffect
import android.graphics.RenderNode
import android.graphics.Shader
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.ViewTreeObserver

/**
 * A backdrop blur: what is behind this view, blurred, under a tint.
 *
 * The web blurs what is behind its glass with a CSS `backdrop-filter`, which
 * Android has no view for. So before every frame this view records every view
 * the window draws before it — shifted so the part behind it lands at its
 * origin — into a `RenderNode`, and draws that node blurred.
 *
 * Only what is *behind*: the views before it in drawing order, and none of
 * its own ancestors' later children. Recording the whole window instead would
 * record this view's own display list into its backdrop, a cycle. The scoring
 * field is expo-gl's `TextureView`, which draws into a hardware canvas like
 * any other view, so the field is part of what is recorded.
 *
 * `RenderEffect` is Android 12 (API 31). Before that the tint is drawn alone,
 * which is the web's own fallback where a browser cannot blur.
 */
class GSBlurView(context: Context) : View(context) {
  /** The blur radius, in pixels. */
  var blurRadius: Float = 0f
    set(value) {
      field = value
      effectChanged = true
      invalidate()
    }

  /** The tint over the blur, as ARGB. */
  var tint: Int = 0
    set(value) {
      field = value
      invalidate()
    }

  /** How much more saturated the blurred backdrop is drawn; 1 is unchanged. */
  var saturation: Float = 1f
    set(value) {
      field = value
      effectChanged = true
      invalidate()
    }

  var cornerRadius: Float = 0f
    set(value) {
      field = value
      invalidateOutline()
    }

  private val backdrop: RenderNode? =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) RenderNode("GSBlurView") else null
  private var effectChanged = true
  private val here = IntArray(2)
  private val origin = IntArray(2)
  private val frame =
      ViewTreeObserver.OnPreDrawListener {
        record()
        true
      }

  init {
    clipToOutline = true
    outlineProvider =
        object : ViewOutlineProvider() {
          override fun getOutline(view: View, outline: Outline) {
            outline.setRoundRect(0, 0, view.width, view.height, cornerRadius)
          }
        }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    rootView.viewTreeObserver.addOnPreDrawListener(frame)
  }

  override fun onDetachedFromWindow() {
    rootView.viewTreeObserver.removeOnPreDrawListener(frame)
    backdrop?.discardDisplayList()
    super.onDetachedFromWindow()
  }

  /** Records what is behind this view, before the window draws a frame. */
  private fun record() {
    val node = backdrop ?: return
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
    if (width == 0 || height == 0 || !isShown) return
    val root = rootView
    getLocationInWindow(here)
    root.getLocationInWindow(origin)
    node.setPosition(0, 0, width, height)
    if (effectChanged) {
      node.setRenderEffect(backdropEffect(blurRadius, saturation))
      effectChanged = false
    }
    val canvas = node.beginRecording(width, height)
    try {
      canvas.translate(
          (origin[0] - here[0]).toFloat(), (origin[1] - here[1]).toFloat())
      if (root is ViewGroup) drawBehind(root, canvas)
    } finally {
      node.endRecording()
    }
    // No invalidate: this view's own display list draws the node by
    // reference, so the frame being drawn picks up what was just recorded.
  }

  /**
   * Draws `group`'s children that come before this view, descending into the
   * one that holds it. Returns true once this view is reached: everything
   * after it is in front.
   */
  private fun drawBehind(group: ViewGroup, canvas: Canvas): Boolean {
    for (index in 0 until group.childCount) {
      val child = group.getChildAt(index)
      if (child === this) return true
      if (child.visibility != VISIBLE) continue
      val holds = child is ViewGroup && holds(child)
      canvas.save()
      canvas.translate(
          (child.left - group.scrollX).toFloat(), (child.top - group.scrollY).toFloat())
      if (!child.matrix.isIdentity) canvas.concat(child.matrix)
      val reached =
          if (holds) drawBehind(child as ViewGroup, canvas)
          else {
            child.draw(canvas)
            false
          }
      canvas.restore()
      if (reached) return true
    }
    return false
  }

  private fun holds(group: ViewGroup): Boolean {
    var parent = parent
    while (parent != null) {
      if (parent === group) return true
      parent = parent.parent
    }
    return false
  }

  override fun onDraw(canvas: Canvas) {
    val node = backdrop
    if (node != null &&
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
        canvas.isHardwareAccelerated) {
      canvas.drawRenderNode(node)
    }
    canvas.drawColor(tint)
  }

  companion object {
    /** The blur, after a saturation boost, as the web's `saturate()` does. */
    fun backdropEffect(radius: Float, saturation: Float): RenderEffect? {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || radius <= 0f) return null
      val blur = RenderEffect.createBlurEffect(radius, radius, Shader.TileMode.CLAMP)
      if (saturation == 1f) return blur
      val matrix = ColorMatrix().apply { setSaturation(saturation) }
      return RenderEffect.createChainEffect(
          blur, RenderEffect.createColorFilterEffect(ColorMatrixColorFilter(matrix)))
    }
  }
}
