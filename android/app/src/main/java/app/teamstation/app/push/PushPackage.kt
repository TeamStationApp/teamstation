package app.teamstation.app.push

import app.teamstation.app.walkup.NativePushSpec
import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class PushPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      if (name == NativePushSpec.NAME) PushModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
        NativePushSpec.NAME to
            ReactModuleInfo(
                NativePushSpec.NAME, PushModule::class.java.name, false, false, false, true))
  }
}
