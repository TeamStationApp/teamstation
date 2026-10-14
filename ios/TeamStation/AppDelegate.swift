import UIKit
import ObjectiveC
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

    // Before any modal exists. A camera modal that reports portrait would
    // otherwise meet an app mask that still allows it.
    CameraGeometry.installModalLock()

    window = UIWindow(frame: UIScreen.main.bounds)

    factory.startReactNative(
      withModuleName: "TeamStation",
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
   * an ordinary `https://app.teamstation.app/...` address reaches an installed app
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

  /**
   * What iOS intersects with every view controller, including a full-screen modal.
   *
   * The plist allows portrait, because the rest of the app and the multi-camera
   * view do. While the camera is up the mask is landscape only, so a modal
   * that still lists portrait cannot turn the phone upright.
   */
  func application(
    _ application: UIApplication,
    supportedInterfaceOrientationsFor window: UIWindow?
  ) -> UIInterfaceOrientationMask {
    CameraGeometry.applicationMask
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

/**
 * What the iPhone's root controller allows while the camera is up.
 *
 * Portrait is the rest of the app. The camera view, and the settings sheet
 * over it, are landscape either way up: both landscape directions and not
 * portrait. An iPad is the same while the camera is up, and every orientation
 * again once the camera has closed.
 */
enum CameraGeometry {
  enum Mode {
    case portrait
    case landscape
    case any
  }

  nonisolated(unsafe) static var mode: Mode = .portrait

  static var mask: UIInterfaceOrientationMask {
    if UIDevice.current.userInterfaceIdiom == .pad {
      return mode == .landscape ? .landscape : .all
    }
    switch mode {
    case .portrait: return .portrait
    case .landscape: return .landscape
    case .any: return [.portrait, .landscape]
    }
  }

  static var requested: UIInterfaceOrientationMask { mask }

  /**
   * The mask iOS intersects with the top controller. Landscape while the
   * camera is up: both landscape directions, so the phone can flip upside
   * down, and never portrait. `any`, which the settings sheet asks for, is
   * the Info.plist set, so settings can stand upright or lie sideways. The
   * root controller keeps the other screens upright, and the multi-camera
   * view can still turn.
   */
  static var applicationMask: UIInterfaceOrientationMask {
    if mode == .landscape { return .landscape }
    if UIDevice.current.userInterfaceIdiom == .pad { return .all }
    return .allButUpsideDown
  }

  /// Keeps a camera modal from answering portrait while the camera is up.
  static func installModalLock() {
    enum Storage {
      static var blocks: [Any] = []
    }
    let selector = NSSelectorFromString("supportedInterfaceOrientations")
    for name in ["RCTFabricModalHostViewController", "RCTModalHostViewController"] {
      guard let cls: AnyClass = NSClassFromString(name),
            let method = instanceMethod(cls, selector) else { continue }
      let original = method_getImplementation(method)
      typealias Getter = @convention(c) (AnyObject, Selector) -> UInt
      let getter = unsafeBitCast(original, to: Getter.self)
      let landscape = UIInterfaceOrientationMask.landscape.rawValue
      let block: @convention(block) (AnyObject) -> UInt = { obj in
        if CameraGeometry.mode == .landscape { return landscape }
        return getter(obj, selector)
      }
      Storage.blocks.append(block)
      method_setImplementation(method, imp_implementationWithBlock(block))
    }
  }

  /// A method implemented on `cls` itself, never one inherited from UIViewController.
  private static func instanceMethod(_ cls: AnyClass, _ selector: Selector) -> Method? {
    var count: UInt32 = 0
    guard let list = class_copyMethodList(cls, &count) else { return nil }
    defer { free(list) }
    for index in 0..<Int(count) where method_getName(list[index]) == selector {
      return list[index]
    }
    return nil
  }

  @MainActor
  static func apply(_ mode: Mode) {
    self.mode = mode
    let target = requested
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    for scene in scenes where scene.session.role != .windowExternalDisplayNonInteractive {
      refresh(scene.windows.first?.rootViewController)
      scene.requestGeometryUpdate(.iOS(interfaceOrientations: target)) { _ in }
    }
  }

  @MainActor
  private static func refresh(_ controller: UIViewController?) {
    guard let controller else { return }
    controller.setNeedsUpdateOfSupportedInterfaceOrientations()
    refresh(controller.presentedViewController)
  }
}

/// The streaming screen's orientation, called from `RCTCameraOrientation.mm`.
@objc(TSCameraGeometry)
public final class TSCameraGeometry: NSObject {
  @objc public static func lockLandscape() {
    DispatchQueue.main.async { CameraGeometry.apply(.landscape) }
  }

  @objc public static func allowRotation() {
    DispatchQueue.main.async { CameraGeometry.apply(.any) }
  }

  @objc public static func lockPortrait() {
    DispatchQueue.main.async { CameraGeometry.apply(.portrait) }
  }
}

/** Upright on an iPhone until the camera view asks otherwise; any way up on an iPad. */
class PortraitRootViewController: UIViewController {
  override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
    CameraGeometry.mask
  }
}
