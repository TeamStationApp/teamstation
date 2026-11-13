package app.teamstation.app.push

import com.facebook.react.bridge.LifecycleEventListener

/**
 * One ask for the notification permission, answered once, which hears the
 * app's lifecycle while it is open. The dialog's listener answers it with
 * the person's choice. React Native keeps that listener on the activity, so
 * an activity recreated while the dialog is up (a locale, font-scale or
 * density change) loses it; the first resume after the dialog then answers
 * it with no choice, as the permission stands, so the app is never left
 * waiting on it. That answer goes through [later], after the rest of the
 * resume, in which a listener the activity kept answers first.
 */
class PushPermissionAsk(
    private val later: (Runnable) -> Unit,
    private val answer: (granted: Boolean?) -> Unit
) : LifecycleEventListener {
  private var left = false
  private var answered = false

  /** The app went off the screen: the dialog is up over it. */
  @Synchronized
  override fun onHostPause() {
    left = true
  }

  /** Back on the screen: an ask the dialog has been up for and still open is answered, later. */
  override fun onHostResume() {
    if (synchronized(this) { left && !answered }) later(Runnable { settle(null) })
  }

  override fun onHostDestroy() {}

  /** Answers the ask with [granted], or null for no choice; true only the first time. */
  fun settle(granted: Boolean?): Boolean {
    synchronized(this) {
      if (answered) return false
      answered = true
    }
    answer(granted)
    return true
  }
}
