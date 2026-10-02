package app.teamstation.app.glass

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/** Registers `TSBlurView`; `MainApplication` adds it. */
class GlassPackage : ReactPackage {
  override fun createViewManagers(
      reactContext: ReactApplicationContext
  ): List<ViewManager<*, *>> = listOf(TSBlurViewManager())
}
