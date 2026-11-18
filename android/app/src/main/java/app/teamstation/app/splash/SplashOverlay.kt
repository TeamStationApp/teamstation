package app.teamstation.app.splash

import android.app.Activity
import android.app.Dialog
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.WindowManager
import androidx.core.view.WindowCompat
import app.teamstation.app.BuildConfig

/**
 * Puts the splash over the activity at launch and takes it away again: once the timeline has
 * ended and React Native has drawn, or at the cap, with a short fade.
 *
 * The splash has a full-screen window of its own above the activity's. The top window decides
 * the status bar, so its icons stay light over the dark splash while React Native styles the
 * activity's window however it likes; when the splash's window goes, React Native's latest style
 * is simply the one showing. While it is up, React Native's root is hidden from accessibility, so
 * TalkBack and UI tests wait for the real screen.
 */
class SplashOverlay private constructor(
  val view: SplashView,
  private val reactRoot: View?,
  /** The splash's own window. */
  val dialog: Dialog,
  private val activity: Activity,
  private val background: android.graphics.drawable.Drawable?,
) {
  private val policy = SplashPolicy(frozen = view.frozenMs != null)
  private val main = Handler(Looper.getMainLooper())

  /** When the splash went up, in uptime milliseconds: the cap counts from here. */
  private val installedAt = SystemClock.uptimeMillis()
  private var layoutListener: ViewTreeObserver.OnGlobalLayoutListener? = null

  var dismissed = false
    private set

  /** Runs once the splash's window has closed, so its owner can let go of it. */
  var onClosed: (() -> Unit)? = null

  /**
   * Checks at the cap, counted from now, as the splash goes up: however long the images take to
   * decode, or if they never do.
   */
  internal fun capFromInstall() {
    if (!policy.frozen) main.postDelayed({ check() }, SplashTimeline.CAP_MS.toLong())
  }

  /** The timeline has started: check again when it ends. */
  internal fun started() {
    if (policy.frozen) return
    val left = SplashTimeline.DURATION_MS - view.elapsedMs()
    if (left > 0) main.postDelayed({ check() }, left.toLong())
    check()
  }

  internal fun contentDidAppear() {
    if (policy.contentAppeared) return
    policy.contentDidAppear()
    view.contentDidAppear()
    check()
  }

  /** Dismisses when the policy says so. */
  internal fun check(now: Long = SystemClock.uptimeMillis()) {
    if (dismissed) return
    val timelineMs = view.startedAt?.let { view.elapsedMs(now) }
    if (policy.decision((now - installedAt).toDouble(), timelineMs) == SplashPolicy.Decision.DISMISS) dismiss()
  }

  /** Fades the splash out and closes its window. */
  fun dismiss(animated: Boolean = true) {
    if (dismissed) return
    dismissed = true
    main.removeCallbacksAndMessages(null)
    layoutListener?.let { reactRoot?.viewTreeObserver?.removeOnGlobalLayoutListener(it) }
    reactRoot?.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
    view.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    val close = Runnable {
      view.release()
      if (dialog.isShowing) dialog.dismiss()
      activity.window?.setBackgroundDrawable(background)
      onClosed?.invoke()
      onClosed = null
    }
    if (!animated) {
      close.run()
      return
    }
    view.animate().alpha(0f).setDuration(SplashTimeline.FADE_MS.toLong()).withEndAction(close).start()
  }

  /**
   * Closes the splash now, whatever it is doing, as its activity is destroyed: a fade under way is
   * cancelled, so its end never reaches a window that has gone with the activity.
   */
  fun destroy() {
    dismiss(animated = false)
    view.animate().cancel()
    view.release()
    if (dialog.isShowing) dialog.dismiss()
  }

  companion object {
    /**
     * Installs a splash over [activity]'s React Native root and starts it. [frozenMs] is the test
     * hook; by default it is read from the launch intent. [prepare] lets a test set the view up
     * before it starts.
     */
    fun install(
      activity: Activity,
      frozenMs: Double? = SplashLaunchOptions.freezeMs(
        { freezeExtra(activity) },
        debug = BuildConfig.DEBUG,
        emulator = SplashLaunchOptions.isEmulator(Build.HARDWARE),
      ),
      prepare: (SplashView) -> Unit = {},
    ): SplashOverlay {
      val content = activity.findViewById<ViewGroup>(android.R.id.content)
      val reactRoot = content.getChildAt(0)
      // Under the splash's window until it draws: the splash's ground, never the theme's white.
      // The theme's own comes back when the splash leaves.
      val background = activity.window?.decorView?.background
      activity.window?.setBackgroundDrawable(ColorDrawable(SplashTimeline.BASE.stops.first().argb))
      val view = SplashView(activity, frozenMs).also(prepare)
      val dialog = splashWindow(activity, view)
      val overlay = SplashOverlay(view, reactRoot, dialog, activity, background)
      reactRoot?.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
      if (reactRoot is ViewGroup) {
        val listener = ViewTreeObserver.OnGlobalLayoutListener {
          if (reactRoot.childCount > 0) overlay.contentDidAppear()
        }
        overlay.layoutListener = listener
        reactRoot.viewTreeObserver.addOnGlobalLayoutListener(listener)
      }
      dialog.show()
      overlay.capFromInstall()
      view.start { overlay.started() }
      return overlay
    }

    /** A window over the whole screen, under the system bars, with light bar icons and no animation. */
    private fun splashWindow(activity: Activity, view: SplashView): Dialog {
      val dialog = Dialog(activity, android.R.style.Theme_Material_NoActionBar)
      dialog.setCancelable(false)
      dialog.setContentView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
      val window = dialog.window ?: return dialog
      window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
      window.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
      window.setWindowAnimations(0)
      window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
      window.attributes = window.attributes.apply {
        layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
      }
      WindowCompat.setDecorFitsSystemWindows(window, false)
      @Suppress("DEPRECATION")
      window.statusBarColor = Color.TRANSPARENT
      @Suppress("DEPRECATION")
      window.navigationBarColor = Color.TRANSPARENT
      WindowCompat.getInsetsController(window, window.decorView).apply {
        isAppearanceLightStatusBars = false
        isAppearanceLightNavigationBars = false
      }
      return dialog
    }

    /**
     * The hook's extra alone, or null. A launch intent's other extras are never read, and one the
     * app cannot unparcel leaves the hook off rather than failing the launch.
     */
    private fun freezeExtra(activity: Activity): Any? = try {
      @Suppress("DEPRECATION")
      activity.intent?.extras?.get(SplashLaunchOptions.KEY)
    } catch (_: RuntimeException) {
      null
    }
  }
}
