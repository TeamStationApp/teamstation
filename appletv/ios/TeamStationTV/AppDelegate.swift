import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  func application(_ application: UIApplication,
                   configurationForConnecting session: UISceneSession,
                   options: UIScene.ConnectionOptions) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(name: "TeamStation TV", sessionRole: session.role)
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
             options connectionOptions: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene else { return }
    let delegate = ReactNativeDelegate()
    delegate.dependencyProvider = RCTAppDependencyProvider()
    let factory = RCTReactNativeFactory(delegate: delegate)
    reactNativeDelegate = delegate
    reactNativeFactory = factory
    let window = UIWindow(windowScene: windowScene)
    self.window = window
    var properties: [String: Any] = [
      "apiBaseUrl": Bundle.main.object(forInfoDictionaryKey: "TVApiBaseUrl") as! String
    ]
#if DEBUG
    properties["apiBaseUrl"] = ProcessInfo.processInfo.environment["TV_API_BASE_URL"] ?? properties["apiBaseUrl"]
    properties["probeUrls"] = ProcessInfo.processInfo.environment["TV_PROBE_URLS"] ?? ""
#endif
    factory.startReactNative(withModuleName: "TeamStationTV", in: window,
                             initialProperties: properties, launchOptions: nil)
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    if let address = ProcessInfo.processInfo.environment["TV_METRO_URL"], let url = URL(string: address) { return url }
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
