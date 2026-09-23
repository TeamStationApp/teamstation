package co.gamestation.app.glass

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/** Registers `GSBlurView`; `MainApplication` adds it. */
class GlassPackage : ReactPackage {
  override fun createViewManagers(
      reactContext: ReactApplicationContext
  ): List<ViewManager<*, *>> = listOf(GSBlurViewManager())
}
