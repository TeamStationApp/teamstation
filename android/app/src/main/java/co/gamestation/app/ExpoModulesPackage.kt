package co.gamestation.app

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager
import expo.modules.ExpoModulesPackageList
import expo.modules.adapters.react.ModuleRegistryAdapter
import expo.modules.core.ModulePriorities

/**
 * Registers the Expo modules (expo-gl's GLView and its WebGL context) with
 * React Native.
 *
 * The `expo` package ships this class as `expo.modules.ExpoModulesPackage`.
 * That package is not installed (src2/MOBILE.md says why), so the app carries
 * the same few lines, over the list `expo-autolinking` generates for it.
 */
class ExpoModulesPackage : ReactPackage {
  private val adapter =
      ModuleRegistryAdapter(
          ExpoModulesPackageList.getPackageList().sortedByDescending {
            ModulePriorities.get(it::class.qualifiedName)
          })

  override fun createNativeModules(
      reactContext: ReactApplicationContext
  ): List<NativeModule> = adapter.createNativeModules(reactContext)

  override fun createViewManagers(
      reactContext: ReactApplicationContext
  ): List<ViewManager<*, *>> = adapter.createViewManagers(reactContext)
}
