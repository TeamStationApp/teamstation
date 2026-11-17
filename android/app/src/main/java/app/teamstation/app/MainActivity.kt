package app.teamstation.app

import android.content.Intent
import android.os.Bundle
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import app.teamstation.app.orientation.Hold
import app.teamstation.app.splash.SplashOverlay

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {
  /** The launch splash, on a fresh start only: never on a recreation or a new intent. */
  var splash: SplashOverlay? = null
    private set

  override fun onCreate(savedInstanceState: Bundle?) {
    // The system's starting window, the splash's dark ground, hands over to
    // the splash's own frame 0 once this activity has drawn.
    installSplashScreen()
    super.onCreate(savedInstanceState)
    if (savedInstanceState == null) {
      splash = SplashOverlay.install(this).apply { onClosed = { splash = null } }
    }
  }

  override fun onDestroy() {
    // Its window belongs to this activity and goes with it.
    splash?.destroy()
    super.onDestroy()
  }

  override fun onNewIntent(intent: Intent) {
    setIntent(intent)
    super.onNewIntent(intent)
  }

  override fun onResume() {
    super.onResume()
    Hold.apply(this)
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    Hold.apply(this)
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "TeamStation"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
