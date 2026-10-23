package app.teamstation.app

import android.app.Application
import app.teamstation.app.browser.ExternalBrowserPackage
import app.teamstation.app.cues.CueSoundsPackage
import app.teamstation.app.feedback.HapticsPackage
import app.teamstation.app.glass.GlassPackage
import app.teamstation.app.navigation.PredictiveBackPackage
import app.teamstation.app.orientation.OrientationPackage
import app.teamstation.app.qrscanner.QrScannerPackage
import app.teamstation.app.stream.PhoneStreamPackage
import app.teamstation.app.video.LivePlaylistPatience
import app.teamstation.app.walkup.DictationMicrophonePackage
import app.teamstation.app.walkup.WalkUpMusicPackage
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
          // The app's own TurboModules, which autolinking does not see.
          add(WalkUpMusicPackage())
          add(DictationMicrophonePackage())
          // The backdrop blur under the scoring menu button.
          add(GlassPackage())
          // Lets the multi-camera view turn sideways in an upright app.
          add(OrientationPackage())
          // Android's back gesture, as the stack navigator's drag back.
          add(PredictiveBackPackage())
          add(ExternalBrowserPackage())
          add(HapticsPackage())
          // The phone's own streaming and recording, and its camera preview.
          add(PhoneStreamPackage())
          // Share Lineup's QR code camera.
          add(QrScannerPackage())
          add(CueSoundsPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    registerFonts()
    // Live viewers wait out a phone's absence instead of failing (LivePlaylistPatience).
    LivePlaylistPatience.register()
    loadReactNative(this)
  }

  /**
   * The families the theme names, by the names it uses: Space Grotesk, the
   * scoreboard's Inter and Quicksand, and the icons.
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
    fonts.addCustomFont(this, "Inter", R.font.inter)
    fonts.addCustomFont(this, "Quicksand", R.font.quicksand)
    fonts.addCustomFont(
        this, "Material Symbols Outlined", R.font.material_symbols_outlined)
  }
}
