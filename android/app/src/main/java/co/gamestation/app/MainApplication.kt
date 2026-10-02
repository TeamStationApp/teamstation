package co.gamestation.app

import android.app.Application
import co.gamestation.app.glass.GlassPackage
import co.gamestation.app.orientation.OrientationPackage
import co.gamestation.app.walkup.WalkUpMusicPackage
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.common.assets.ReactFontManager
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Expo's modules are linked by `expo-autolinking`, not by React
          // Native's autolinking, so they are added by hand.
          add(ExpoModulesPackage())
          // The app's own TurboModule, which autolinking does not see.
          add(WalkUpMusicPackage())
          // The backdrop blur under the scoring menu button.
          add(GlassPackage())
          // Lets the multi-camera view turn sideways in an upright app.
          add(OrientationPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    registerFonts()
    loadReactNative(this)
  }

  /**
   * The two families the theme names, by the names it uses.
   *
   * Without this React Native looks for `assets/fonts/Space Grotesk.ttf` and,
   * finding nothing, draws the system font — the whole app in the wrong type,
   * with no error anywhere to say so. Registering an XML family instead of a
   * single file is what makes `fontWeight: '500'` and `'600'` land on the
   * faces drawn for them; the assets convention understands bold and nothing
   * else, so two of the app's four weights would silently become regular.
   */
  private fun registerFonts() {
    val fonts = ReactFontManager.getInstance()
    fonts.addCustomFont(this, "Space Grotesk", R.font.space_grotesk)
    fonts.addCustomFont(
        this, "Material Symbols Outlined", R.font.material_symbols_outlined)
  }
}
