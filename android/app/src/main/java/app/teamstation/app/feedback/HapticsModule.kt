package app.teamstation.app.feedback

import android.util.Log
import android.view.HapticFeedbackConstants
import app.teamstation.app.BuildConfig
import app.teamstation.app.walkup.NativeHapticsSpec
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.uimanager.UIManagerHelper

/** Light, system-setting-aware feedback on the actual Modal-attached view. */
class HapticsModule(context: ReactApplicationContext) : NativeHapticsSpec(context) {
  override fun light(viewTag: Double) {
    UiThreadUtil.runOnUiThread {
      try {
        val tag = viewTag.toInt()
        val view = UIManagerHelper.getUIManagerForReactTag(reactApplicationContext, tag)?.resolveView(tag)
        val accepted = view?.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK) == true
        if (BuildConfig.DEBUG) Log.d("TSHaptics", "light request resolved=${view != null} accepted=$accepted")
      } catch (_: Exception) {
        // The view may have unmounted before this optional request arrived.
        if (BuildConfig.DEBUG) Log.d("TSHaptics", "light request skipped")
      }
    }
  }
}
