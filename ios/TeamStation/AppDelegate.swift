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
    NativeSentryPrivacy.start()
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    // Before any modal exists. A camera modal that reports portrait would
    // otherwise meet an app mask that still allows it.
    CameraGeometry.installModalLock()
    StatusBarAppearance.install()

    return true
  }

  /**
   * Puts the app's window in `scene`. True the first time, when this starts
   * React Native; false when iOS has connected a new scene to a running app.
   *
   * There is one window for the life of the process, moved to whichever scene
   * is connected, because things stay pinned to it: the React root,
   * `SystemVolume`'s hidden slider, Reanimated's measuring view. It stays here
   * rather than on the scene delegate because Reanimated, blob-util and
   * `RCTHaptics` all read `UIApplication.delegate.window`.
   */
  func attach(
    to scene: UIWindowScene,
    launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    if let window {
      window.windowScene = scene
      window.makeKeyAndVisible()
      // No view hears `didMoveToWindow` for this: its window has not changed.
      NotificationCenter.default.post(name: .tsWindowSceneChanged, object: window)
      return false
    }
    let window = UIWindow(windowScene: scene)
    self.window = window
    reactNativeFactory?.startReactNative(
      withModuleName: "TeamStation",
      in: window,
      launchOptions: launchOptions
    )
    return true
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

extension Notification.Name {
  /// The app's window has moved to a newly connected scene.
  static let tsWindowSceneChanged = Notification.Name("TSWindowSceneChanged")
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  /**
   * The app's own screens, upright on an iPhone.
   *
   * `Info.plist` lets an iPhone turn sideways, because the full-screen
   * player does. It is a sheet, a transparent `Modal` presented over this
   * controller rather than in place of it, so it turns only as far as this
   * controller allows: while it is up it asks for rotation
   * (`TSOrientation.allowRotation`), and when it goes it stands the app
   * upright again (`lockPortrait`). An iPad turns everywhere, as it always
   * has.
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
 * What the iPhone's root controller allows, by what is on screen.
 *
 * `portrait` is the rest of the app. `landscape` is the camera view: both
 * landscape directions, so the phone can flip upside down, and never
 * portrait. `any` is the settings sheet over the camera, and the full-screen
 * player's sheet, which may stand upright or lie sideways either way. An
 * iPad asks for landscape while the camera is up, and every orientation
 * otherwise.
 *
 * On an iPad that is a request, not a lock. The app is resizable there
 * (`UIRequiresFullScreen` is false; making it true would take Split View and
 * windows from the whole app, and iPadOS 26 deprecates the key), and on
 * iPadOS 26 a resizable scene follows the device, or the shape of its window,
 * whatever these masks say. `prefersInterfaceOrientationLocked` holds only the orientation
 * the scene already has, so it would keep an iPad held upright upright and
 * stop the flip between the two landscapes. The iPad camera view therefore
 * follows the iPad. The capture stays landscape (`CameraSession` keeps the
 * last landscape angle), so on an upright iPad the preview, which turns with
 * the interface, stands upright while the recording lies on its side; turning
 * the iPad sideways brings them back together.
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

  /**
   * The mask iOS intersects with the top controller. Landscape while the
   * camera is up: both landscape directions, so the phone can flip upside
   * down, and never portrait. `any`, which the settings sheet and the
   * full-screen player's sheet ask for, is the Info.plist set, so they can
   * stand upright or lie sideways. The root controller keeps the other
   * screens upright; the full-screen sheet, a transparent modal over it,
   * turns because the root is allowed to while it is up.
   */
  static var applicationMask: UIInterfaceOrientationMask {
    if mode == .landscape { return .landscape }
    if UIDevice.current.userInterfaceIdiom == .pad { return .all }
    return .allButUpsideDown
  }

  /// Keeps a camera modal from answering portrait while the camera is up.
  static func installModalLock() {
    let selector = NSSelectorFromString("supportedInterfaceOrientations")
    if let cls = reactNativeClass("RCTFabricModalHostViewController") {
      replaceMethod(cls, selector) { original in
        typealias Getter = @convention(c) (AnyObject, Selector) -> UInt
        let getter = unsafeBitCast(original, to: Getter.self)
        let landscape = UIInterfaceOrientationMask.landscape.rawValue
        let block: @convention(block) (AnyObject) -> UInt = { obj in
          if CameraGeometry.mode == .landscape { return landscape }
          return getter(obj, selector)
        }
        return block
      }
    }
  }

  @MainActor
  static func apply(_ mode: Mode) {
    self.mode = mode
    let target = mask
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    for scene in scenes where scene.session.role != .windowExternalDisplayNonInteractive {
      for controller in presentationChain(of: scene) {
        controller.setNeedsUpdateOfSupportedInterfaceOrientations()
      }
      scene.requestGeometryUpdate(.iOS(interfaceOrientations: target)) { _ in }
    }
  }
}

/// Replaces the method `cls` itself implements, never one inherited from UIViewController.
/// `block` is given the original implementation and returns the replacement. These are React
/// Native's private names, so a miss after an upgrade stops a Debug launch rather than leaving
/// the behaviour quietly gone.
private func replaceMethod(_ cls: AnyClass, _ selector: Selector, with block: (IMP) -> Any) {
  var count: UInt32 = 0
  let list = class_copyMethodList(cls, &count)
  defer { free(list) }
  for index in 0..<Int(count) {
    guard let method = list?[index], method_getName(method) == selector else { continue }
    method_setImplementation(method, imp_implementationWithBlock(block(method_getImplementation(method))))
    return
  }
  assertionFailure("\(cls) no longer implements \(selector)")
}

/// A class of React Native's that `replaceMethod` is about to patch.
private func reactNativeClass(_ name: String) -> AnyClass? {
  let cls: AnyClass? = NSClassFromString(name)
  assert(cls != nil, "React Native no longer has \(name)")
  return cls
}

/// The scene's root controller and everything presented over it.
@MainActor
private func presentationChain(of scene: UIWindowScene) -> [UIViewController] {
  guard let root = scene.windows.first?.rootViewController else { return [] }
  return Array(sequence(first: root) { $0.presentedViewController })
}

/**
 * What React Native's `StatusBar` has asked for.
 *
 * Under the scene lifecycle UIKit ignores `UIApplication`'s status bar setters,
 * which are the only thing `RCTStatusBarManager` calls, and asks view controllers
 * instead. So `Info.plist` makes appearance controller-based, which the manager
 * refuses, and `install` routes its two setters here. The root controller answers
 * from this, and so do React Native's modals, which would otherwise read back the
 * scene's own value and never change it.
 */
enum StatusBarAppearance {
  nonisolated(unsafe) static var hidden = false
  nonisolated(unsafe) static var style: UIStatusBarStyle = .default
  nonisolated(unsafe) static var animation: UIStatusBarAnimation = .none

  static func install() {
    if let manager = reactNativeClass("RCTStatusBarManager") {
      let setHidden: @convention(block) (AnyObject, Bool, NSString?) -> Void = { _, hidden, name in
        DispatchQueue.main.async {
          self.hidden = hidden
          animation = animation(named: name as String?)
          refresh(animated: animation != .none)
        }
      }
      let setStyle: @convention(block) (AnyObject, NSString?, Bool) -> Void = { _, name, animated in
        DispatchQueue.main.async {
          style = style(named: name as String?)
          refresh(animated: animated)
        }
      }
      replaceMethod(manager, NSSelectorFromString("setHidden:withAnimation:")) { _ in setHidden }
      replaceMethod(manager, NSSelectorFromString("setStyle:animated:")) { _ in setStyle }
    }

    if let cls = reactNativeClass("RCTFabricModalHostViewController") {
      let prefersHidden: @convention(block) (AnyObject) -> Bool = { _ in hidden }
      let preferredStyle: @convention(block) (AnyObject) -> Int = { _ in style.rawValue }
      let preferredAnimation: @convention(block) (AnyObject) -> Int = { _ in animation.rawValue }
      replaceMethod(cls, NSSelectorFromString("prefersStatusBarHidden")) { _ in prefersHidden }
      replaceMethod(cls, NSSelectorFromString("preferredStatusBarStyle")) { _ in preferredStyle }
      // Inherited, so added rather than replaced.
      class_addMethod(
        cls,
        NSSelectorFromString("preferredStatusBarUpdateAnimation"),
        imp_implementationWithBlock(preferredAnimation),
        "q@:"
      )
    }
  }

  /// The values of React Native's `StatusBarStyle`.
  private static func style(named name: String?) -> UIStatusBarStyle {
    switch name {
    case "light-content": return .lightContent
    case "dark-content": return .darkContent
    default: return .default
    }
  }

  /// The values of React Native's `StatusBarAnimation`.
  private static func animation(named name: String?) -> UIStatusBarAnimation {
    switch name {
    case "fade": return .fade
    case "slide": return .slide
    default: return .none
    }
  }

  @MainActor
  private static func refresh(animated: Bool) {
    let update = {
      let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      for controller in scenes.flatMap(presentationChain) {
        controller.setNeedsStatusBarAppearanceUpdate()
      }
    }
    if animated {
      UIView.animate(withDuration: 0.25, animations: update)
    } else {
      update()
    }
  }
}

/// The interface's orientation for the streaming screen and the full-screen
/// player's sheet, called from `RCTCameraOrientation.mm` (`TSOrientation`).
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

/** Upright on an iPhone until the camera view asks otherwise; on an iPad, any way up, or landscape asked for while the camera is up. */
class PortraitRootViewController: UIViewController {
  override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
    CameraGeometry.mask
  }

  override var prefersStatusBarHidden: Bool {
    StatusBarAppearance.hidden
  }

  override var preferredStatusBarStyle: UIStatusBarStyle {
    StatusBarAppearance.style
  }

  override var preferredStatusBarUpdateAnimation: UIStatusBarAnimation {
    StatusBarAppearance.animation
  }
}
