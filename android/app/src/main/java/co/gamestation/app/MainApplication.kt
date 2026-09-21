package co.gamestation.app

import android.app.Application
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
          // Packages that cannot be autolinked yet can be added manually here, for example:
          // add(MyReactNativePackage())
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
