package app.teamstation.app.orientation

import android.app.Activity
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

  /**
   * The streaming screen's settings: upright or either landscape, turned by
   * the sensor. Unlike `allowRotation`, this ignores the phone's rotation
   * lock, so settings follows the phone in the hand even with auto-rotate
   * off, which would otherwise hold it to the lock's upright. A phone does
   * not turn it upside down.
   */
  @ReactMethod
  fun followSensor() {
    request(ActivityInfo.SCREEN_ORIENTATION_SENSOR)
  }

  @ReactMethod
  fun lockPortrait() {
    request(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT)
  }

  /**
   * The streaming screen records sideways: either landscape, turned by the
   * sensor whatever the rotation lock says, and never upright.
   */
  @ReactMethod
  fun lockLandscape() {
    request(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE)
  }

  private fun request(orientation: Int) {
    Hold.requested = orientation
    UiThreadUtil.runOnUiThread {
      Hold.apply(reactApplicationContext.currentActivity)
    }
  }

  companion object {
    const val NAME = "TSOrientation"
  }
}

/**
 * The orientation the streaming screen or its settings last asked for.
 *
 * A modal on Android is a dialog in this same activity. Opening one can put
 * the activity back on the manifest's portrait, so the activity asks again
 * whenever it resumes or its window focus changes.
 */
object Hold {
  @Volatile var requested: Int = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT

  fun apply(activity: Activity?) {
    activity?.requestedOrientation = requested
  }
}
