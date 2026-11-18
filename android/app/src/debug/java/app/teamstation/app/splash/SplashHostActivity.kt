package app.teamstation.app.splash

import android.app.Activity
import android.os.Bundle
import android.widget.FrameLayout

/**
 * An activity whose content stands in for React Native's root, empty until a test adds a child:
 * SplashOverlayDeviceTest's host. Debug builds only.
 */
class SplashHostActivity : Activity() {
  lateinit var root: FrameLayout
    private set

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    root = FrameLayout(this)
    setContentView(root)
  }
}
