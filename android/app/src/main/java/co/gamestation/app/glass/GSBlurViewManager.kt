package co.gamestation.app.glass

import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

/**
 * `GSBlurView` for React. A legacy view manager, as iOS's `GSGlassView` is:
 * React Native 0.87 mounts one under Fabric through its interop layer, found
 * by name, without a codegen spec. Sizes arrive in density-independent
 * points and are turned to pixels here.
 */
class GSBlurViewManager : SimpleViewManager<GSBlurView>() {
  override fun getName(): String = NAME

  override fun createViewInstance(context: ThemedReactContext): GSBlurView = GSBlurView(context)

  @ReactProp(name = "blurRadius", defaultFloat = 0f)
  fun setBlurRadius(view: GSBlurView, value: Float) {
    view.blurRadius = PixelUtil.toPixelFromDIP(value)
  }

  @ReactProp(name = "blurTint", defaultInt = 0)
  fun setBlurTint(view: GSBlurView, value: Int) {
    view.tint = value
  }

  @ReactProp(name = "blurSaturation", defaultFloat = 1f)
  fun setBlurSaturation(view: GSBlurView, value: Float) {
    view.saturation = value
  }

  @ReactProp(name = "blurCornerRadius", defaultFloat = 0f)
  fun setBlurCornerRadius(view: GSBlurView, value: Float) {
    view.cornerRadius = PixelUtil.toPixelFromDIP(value)
  }

  companion object {
    const val NAME = "GSBlurView"
  }
}
