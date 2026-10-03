package app.teamstation.app.walkup

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/** Registers the `DictationMicrophone` TurboModule; `MainApplication` adds it. */
class DictationMicrophonePackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      if (name == NativeDictationMicrophoneSpec.NAME) DictationMicrophoneModule(reactContext)
      else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
        NativeDictationMicrophoneSpec.NAME to
            ReactModuleInfo(
                NativeDictationMicrophoneSpec.NAME,
                DictationMicrophoneModule::class.java.name,
                false,
                false,
                false,
                true))
  }
}
