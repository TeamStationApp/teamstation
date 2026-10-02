package app.teamstation.app.glass

import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

/**
 * `TSBlurView` for React. A legacy view manager, as iOS's `TSGlassView` is:
 * React Native 0.87 mounts one under Fabric through its interop layer, found
 * by name, without a codegen spec. Sizes arrive in density-independent
 * points and are turned to pixels here.
 */
class TSBlurViewManager : SimpleViewManager<TSBlurView>() {
  override fun getName(): String = NAME

  override fun createViewInstance(context: ThemedReactContext): TSBlurView = TSBlurView(context)

  @ReactProp(name = "blurRadius", defaultFloat = 0f)
  fun setBlurRadius(view: TSBlurView, value: Float) {
    view.blurRadius = PixelUtil.toPixelFromDIP(value)
  }

  @ReactProp(name = "blurTint", defaultInt = 0)
  fun setBlurTint(view: TSBlurView, value: Int) {
    view.tint = value
  }

  @ReactProp(name = "blurSaturation", defaultFloat = 1f)
  fun setBlurSaturation(view: TSBlurView, value: Float) {
    view.saturation = value
  }

  @ReactProp(name = "blurCornerRadius", defaultFloat = 0f)
  fun setBlurCornerRadius(view: TSBlurView, value: Float) {
    view.cornerRadius = PixelUtil.toPixelFromDIP(value)
  }

  companion object {
    const val NAME = "TSBlurView"
  }
}
