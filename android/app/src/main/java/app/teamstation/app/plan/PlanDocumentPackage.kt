package app.teamstation.app.plan

import app.teamstation.app.walkup.NativePlanDocumentSpec
import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class PlanDocumentPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
      if (name == NativePlanDocumentSpec.NAME) PlanDocumentModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(NativePlanDocumentSpec.NAME to ReactModuleInfo(
      NativePlanDocumentSpec.NAME, PlanDocumentModule::class.java.name, false, false, false, true))
  }
}
