package app.teamstation.app.walkup

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/** Registers the `WalkUpMusic` TurboModule; `MainApplication` adds it. */
class WalkUpMusicPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      if (name == NativeWalkUpMusicSpec.NAME) WalkUpMusicModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
        NativeWalkUpMusicSpec.NAME to
            ReactModuleInfo(
                NativeWalkUpMusicSpec.NAME,
                WalkUpMusicModule::class.java.name,
                false,
                false,
                false,
                true))
  }
}
