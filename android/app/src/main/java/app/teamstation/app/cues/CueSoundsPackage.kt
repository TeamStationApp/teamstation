package app.teamstation.app.cues

import app.teamstation.app.walkup.NativeCueSoundsSpec
import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class CueSoundsPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      if (name == NativeCueSoundsSpec.NAME) CueSoundsModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(NativeCueSoundsSpec.NAME to ReactModuleInfo(
      NativeCueSoundsSpec.NAME, CueSoundsModule::class.java.name, false, false, false, true))
  }
}
