// Test build overlay. Record dispatch-time input timestamps, then delegate to the app.
private class HoldInputStrip(val activity: android.app.Activity) : android.view.View(activity) {
  private val words = IntArray(10)
  private val paint = android.graphics.Paint()
  private var sequence = 0
  private val scale = resources.displayMetrics.density
  private val watched = java.util.WeakHashMap<android.view.Window, Boolean>()
  private var lastRoot: android.view.View? = null

  fun install() {
    val root = activity.window.decorView
    root.post(object : Runnable {
      override fun run() {
        if (activity.isDestroyed) return
        val focused = android.view.inspector.WindowInspector.getGlobalWindowViews()
          .lastOrNull { it.hasWindowFocus() }
        if (focused != null && focused !== lastRoot) {
          if (focused === root) {
            mount(activity.window)
            lastRoot = root
          } else {
            val dialog = findDialog(root, focused)
            if (dialog != null) {
              mount(dialog)
              lastRoot = focused
            }
          }
        }
        root.postDelayed(this, 400)
      }
    })
  }

  private fun findDialog(view: android.view.View, root: android.view.View): android.view.Window? {
    if (view is com.facebook.react.views.modal.ReactModalHostView) {
      val window = view.dialog?.window
      if (window?.decorView === root) return window
    }
    if (view is android.view.ViewGroup) {
      for (i in 0 until view.childCount) {
        val found = view.getChildAt(i)?.let { findDialog(it, root) }
        if (found != null) return found
      }
    }
    return null
  }

  private fun mount(window: android.view.Window) {
    if (window !== activity.window && watched.put(window, true) == null) {
      val callback = window.callback
      window.callback = object : android.view.Window.Callback by callback {
        override fun dispatchTouchEvent(event: android.view.MotionEvent): Boolean {
          record(event, window.decorView)
          return callback.dispatchTouchEvent(event)
        }
      }
    }
    (parent as? android.view.ViewGroup)?.removeView(this)
    val layout = android.widget.FrameLayout.LayoutParams((104 * scale).toInt(), (40 * scale).toInt())
    layout.leftMargin = (2 * scale).toInt()
    layout.topMargin = (32 * scale).toInt()
    window.addContentView(this, layout)
  }

  fun record(e: android.view.MotionEvent, view: android.view.View = activity.window.decorView) {
    val up = when (e.actionMasked) {
      android.view.MotionEvent.ACTION_DOWN, android.view.MotionEvent.ACTION_POINTER_DOWN -> false
      android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_POINTER_UP -> true
      else -> return
    }
    val x = (e.getX(e.actionIndex) / view.width * 2047).toInt().coerceIn(0, 2047)
    val y = (e.getY(e.actionIndex) / view.height * 2047).toInt().coerceIn(0, 2047)
    val slot = 2 + 2 * (sequence % 4)
    words[slot] = e.eventTime.toInt()
    words[slot + 1] = (if (up) 1 shl 22 else 0) or (y shl 11) or x
    words[1] = ++sequence
  }

  override fun onDraw(canvas: android.graphics.Canvas) {
    words[0] = android.os.SystemClock.uptimeMillis().toInt()
    canvas.drawColor(android.graphics.Color.BLACK)
    val cell = width / 26f
    for ((row, value) in words.withIndex()) {
      for (column in 0..25) {
        paint.color = when {
          column == 0 -> android.graphics.Color.MAGENTA
          column == 25 -> android.graphics.Color.CYAN
          (value and (1 shl (column - 1))) != 0 -> android.graphics.Color.WHITE
          else -> continue
        }
        canvas.drawRect(column * cell, row * cell, (column + 1) * cell, (row + 1) * cell, paint)
      }
    }
    postInvalidateOnAnimation()
  }
}
