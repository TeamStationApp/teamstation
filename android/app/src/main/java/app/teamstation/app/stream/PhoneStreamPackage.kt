package app.teamstation.app.stream

import app.teamstation.app.walkup.NativePhoneStreamSpec
import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import com.facebook.react.uimanager.ViewManager

/** Registers the `TSPhoneStream` TurboModule and the `TSPhoneStreamPreview` view; `MainApplication` adds it. */
class PhoneStreamPackage : BaseReactPackage() {
    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        if (name == NativePhoneStreamSpec.NAME) PhoneStreamModule(reactContext) else null

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
        mapOf(
            NativePhoneStreamSpec.NAME to
                ReactModuleInfo(
                    NativePhoneStreamSpec.NAME,
                    PhoneStreamModule::class.java.name,
                    false,
                    false,
                    false,
                    true
                )
        )
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
        listOf(PhoneStreamPreviewManager())
}
