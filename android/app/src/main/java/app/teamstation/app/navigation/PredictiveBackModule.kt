package app.teamstation.app.navigation

import android.app.Activity
import androidx.activity.BackEventCompat
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Hands Android's back gesture to the stack navigator, so the screen follows
 * the finger instead of only jumping when it lets go.
 *
 * Under gesture navigation the left edge belongs to the system: the swipe is
 * Back, and it never reaches the app's views. Predictive back gives an app
 * that asks for it the gesture's progress on the activity's
 * `OnBackPressedDispatcher`. This adds one callback there and forwards what it
 * hears as `TSPredictiveBack` events: `started`, `progress` (0 to 1, and the
 * edge it came from), `cancelled`, and `invoked`.
 *
 * It is enabled only while JS says a drag may pop the top (`setEnabled`):
 * when walking the history, which is what Back does, lands on the screen
 * beneath. Disabled, React Native's own callback and `BackHandler` answer
 * Back exactly as before.
 *
 * The dispatcher asks the most recently added enabled callback first, so this
 * one has to be added after React Native's. It is added from `onHostResume`,
 * after `ReactActivity.onCreate` added React Native's, with the activity as
 * its lifecycle owner: both are taken off on `ON_STOP` and put back on
 * `ON_START` in the order they were added, so it stays last through every
 * trip to the background.
 */
class PredictiveBackModule(context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context), LifecycleEventListener {

  private var owner: Activity? = null

  private val callback =
      object : OnBackPressedCallback(false) {
        override fun handleOnBackStarted(backEvent: BackEventCompat) {
          emit("started", backEvent)
        }

        override fun handleOnBackProgressed(backEvent: BackEventCompat) {
          emit("progress", backEvent)
        }

        override fun handleOnBackCancelled() {
          emit("cancelled", null)
        }

        override fun handleOnBackPressed() {
          emit("invoked", null)
        }
      }

  init {
    context.addLifecycleEventListener(this)
  }

  override fun getName(): String = NAME

  @ReactMethod
  fun setEnabled(enabled: Boolean) {
    UiThreadUtil.runOnUiThread { callback.isEnabled = enabled }
  }

  /** `NativeEventEmitter` asks for these; the events go out regardless. */
  @ReactMethod fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {}

  @ReactMethod fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Double) {}

  override fun onHostResume() {
    UiThreadUtil.runOnUiThread {
      val activity = reactApplicationContext.currentActivity as? ComponentActivity
      if (activity == null || activity === owner) return@runOnUiThread
      callback.remove()
      activity.onBackPressedDispatcher.addCallback(activity, callback)
      owner = activity
    }
  }

  override fun onHostPause() {}

  override fun onHostDestroy() {
    UiThreadUtil.runOnUiThread {
      callback.remove()
      owner = null
    }
  }

  /**
   * A reload builds a new module while the activity lives on: this one's
   * callback, still on the dispatcher, would keep answering Back into a dead
   * context, so it goes with the module.
   */
  override fun invalidate() {
    reactApplicationContext.removeLifecycleEventListener(this)
    UiThreadUtil.runOnUiThread {
      callback.remove()
      owner = null
    }
    super.invalidate()
  }

  private fun emit(type: String, event: BackEventCompat?) {
    val payload =
        Arguments.createMap().apply {
          putString("type", type)
          if (event != null) {
            putDouble("progress", event.progress.toDouble())
            putInt("swipeEdge", event.swipeEdge)
          }
        }
    reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(EVENT, payload)
  }

  companion object {
    const val NAME = "TSPredictiveBack"
    const val EVENT = "TSPredictiveBack"
  }
}
