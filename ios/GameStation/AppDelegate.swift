import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)

    factory.startReactNative(
      withModuleName: "GameStation",
      in: window,
      launchOptions: launchOptions
    )

    return true
  }

  /**
   * A link handed to the app while it is running.
   *
   * Without this the address is dropped on the floor: `Linking.getInitialURL`
   * still answers, because a cold launch carries the address in its launch
   * options, but nothing ever reaches the `url` listener — so an invitation
   * or a sign-in link tapped while the app is open does nothing at all, and
   * does it silently. The template does not include this and the failure is
   * invisible until somebody follows a link.
   */
  func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    RCTLinkingManager.application(app, open: url, options: options)
  }

  /**
   * And a link followed from outside the app — a mail client, a message.
   *
   * These arrive as a user activity rather than as an `openURL`, which is how
   * an ordinary `https://gamestation.co/...` address reaches an installed app
   * rather than the browser. It needs `apple-app-site-association` served from
   * the site before iOS will route one here, but the app's half is this.
   */
  func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    RCTLinkingManager.application(
      application,
      continue: userActivity,
      restorationHandler: restorationHandler
    )
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  /**
   * The app's own screens, upright on an iPhone.
   *
   * `Info.plist` lets an iPhone turn sideways, because the multi-camera view
   * does: it is a full-screen `Modal`, a view controller of its own that
   * declares portrait and landscape and turns with the phone. Everything
   * under it is this controller, which stays upright, so closing the view
   * stands the app up again. An iPad turns everywhere, as it always has.
   */
  override func createRootViewController() -> UIViewController {
    PortraitRootViewController()
  }

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}

/** Upright on an iPhone; any way up on an iPad. */
class PortraitRootViewController: UIViewController {
  override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
    UIDevice.current.userInterfaceIdiom == .pad ? .all : .portrait
  }
}
