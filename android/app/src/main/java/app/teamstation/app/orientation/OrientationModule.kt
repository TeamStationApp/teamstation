package app.teamstation.app.orientation

import android.content.pm.ActivityInfo
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

/**
 * Lets one screen turn sideways in an app that is otherwise upright.
 *
 * The manifest holds the activity to portrait, and every screen but the
 * multi-camera view is laid out for that. A `Modal` on Android is a dialog
 * inside the same activity, so it cannot turn on its own: the view asks the
 * activity to follow the phone while it is up, and to stand upright again
 * when it closes. `FULL_USER` keeps to the phone's own rotation lock.
 */
class OrientationModule(context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context) {

  override fun getName(): String = NAME

  @ReactMethod
  fun allowRotation() {
    request(ActivityInfo.SCREEN_ORIENTATION_FULL_USER)
  }

  @ReactMethod
  fun lockPortrait() {
    request(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT)
  }

  private fun request(orientation: Int) {
    UiThreadUtil.runOnUiThread {
      reactApplicationContext.currentActivity?.requestedOrientation = orientation
    }
  }

  companion object {
    const val NAME = "TSOrientation"
  }
}
