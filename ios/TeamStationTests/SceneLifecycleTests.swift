import UIKit
import XCTest

/// `SceneDelegate.connect`, which this bundle cannot import. Declaring it lets `AnyObject` call it.
@objc private protocol SceneConnecting {
  func connect(_ scene: UIWindowScene, url: URL?, userActivity: NSUserActivity?)
}

/**
 * The scene lifecycle, from inside the running app: this bundle is hosted by it, so these are the
 * app's real scene, window and delegate. Without a scene the host traps in UIKit before any of
 * this runs, on an iOS 27 SDK build.
 */
@MainActor
final class SceneLifecycleTests: XCTestCase {
  private static let openURL = NSNotification.Name("RCTOpenURLNotification")

  private var scene: UIWindowScene {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first!
  }

  private func expectLink(_ url: URL) -> XCTestExpectation {
    expectation(forNotification: Self.openURL, object: nil) { notification in
      notification.userInfo?["url"] as? String == url.absoluteString
    }
  }

  private func webActivity(_ url: URL) -> NSUserActivity {
    let activity = NSUserActivity(activityType: NSUserActivityTypeBrowsingWeb)
    activity.webpageURL = url
    return activity
  }

  /// Waits for JS to draw. Its first `StatusBar` mounts by sending the bar's defaults, which would
  /// overwrite anything set before then, and a Debug bundle reaches a phone slowly.
  private func waitForReactToRender() throws {
    let root = try XCTUnwrap(scene.keyWindow?.rootViewController?.view)
    func depth(_ view: UIView) -> Int { 1 + view.subviews.map(depth).reduce(0, +) }
    let rendered = expectation(for: NSPredicate { _, _ in depth(root) > 20 }, evaluatedWith: nil)
    wait(for: [rendered], timeout: 120)
  }

  /// React Native's `StatusBar` module, called as JS calls it.
  private func statusBarManager() -> NSObject {
    (NSClassFromString("RCTStatusBarManager") as! NSObject.Type).init()
  }

  private func setStatusBarHidden(_ hidden: Bool, animation: String = "none", on manager: NSObject) {
    typealias Setter = @convention(c) (AnyObject, Selector, Bool, NSString) -> Void
    let selector = NSSelectorFromString("setHidden:withAnimation:")
    unsafeBitCast(manager.method(for: selector), to: Setter.self)(manager, selector, hidden, animation as NSString)
  }

  private func setStatusBarStyle(_ style: String, animated: Bool = false, on manager: NSObject) {
    typealias Setter = @convention(c) (AnyObject, Selector, NSString, Bool) -> Void
    let selector = NSSelectorFromString("setStyle:animated:")
    unsafeBitCast(manager.method(for: selector), to: Setter.self)(manager, selector, style as NSString, animated)
  }

  private func geometry(_ selector: String) {
    let cls: AnyObject = NSClassFromString("TSCameraGeometry")!
    _ = cls.perform(NSSelectorFromString(selector))
  }

  /// The window every `UIApplication.delegate.window` reader and `RCTKeyWindow` find, and that
  /// React Native's modals present from.
  func testTheAppRunsInOneSceneWindow() throws {
    let scene = scene
    XCTAssertEqual(NSStringFromClass(type(of: try XCTUnwrap(scene.delegate))), "TeamStation.SceneDelegate")
    let window = try XCTUnwrap(UIApplication.shared.delegate?.window ?? nil)
    XCTAssertTrue(window === scene.keyWindow)
    let root = try XCTUnwrap(window.rootViewController)
    XCTAssertEqual(NSStringFromClass(type(of: root)), "TeamStation.PortraitRootViewController")

    let presented = expectation(description: "presented")
    root.present(UIViewController(), animated: false) { presented.fulfill() }
    wait(for: [presented], timeout: 5)
    XCTAssertNotNil(root.presentedViewController)
    let dismissed = expectation(description: "dismissed")
    root.dismiss(animated: false) { dismissed.fulfill() }
    wait(for: [dismissed], timeout: 5)
  }

  /// Only the application role: an undeclared external display keeps mirroring.
  func testTheManifestDeclaresOneApplicationScene() throws {
    let manifest = try XCTUnwrap(
      Bundle.main.object(forInfoDictionaryKey: "UIApplicationSceneManifest") as? [String: Any]
    )
    XCTAssertEqual(manifest["UIApplicationSupportsMultipleScenes"] as? Bool, false)
    let configurations = try XCTUnwrap(manifest["UISceneConfigurations"] as? [String: Any])
    XCTAssertEqual(Array(configurations.keys), ["UIWindowSceneSessionRoleApplication"])
  }

  func testAWebLinkWhileRunningReachesReactNative() throws {
    let url = URL(string: "https://example.com/signin/running")!
    let delivered = expectLink(url)
    let delegate = try XCTUnwrap(scene.delegate as? UIWindowSceneDelegate)
    delegate.scene?(scene, continue: webActivity(url))
    wait(for: [delivered], timeout: 5)
  }

  /// Needs this build to be the only one on the device that claims `teamstation://`: another
  /// would be handed the link. `UIOpenURLContext` cannot be constructed to skip iOS.
  func testACustomSchemeLinkWhileRunningReachesReactNative() {
    let url = URL(string: "teamstation://signin/running")!
    let delivered = expectLink(url)
    UIApplication.shared.open(url)
    wait(for: [delivered], timeout: 10)
  }

  /// A reconnect keeps the one window, so what is pinned to it stays put, and its links arrive.
  func testAReconnectKeepsTheWindowAndDeliversItsLink() throws {
    let scene = scene
    let delegate: AnyObject = try XCTUnwrap(scene.delegate)
    let window = try XCTUnwrap(scene.keyWindow)
    let root = window.rootViewController

    let web = URL(string: "https://example.com/signin/reconnect")!
    let webDelivered = expectLink(web)
    delegate.connect?(scene, url: nil, userActivity: webActivity(web))
    wait(for: [webDelivered], timeout: 5)

    let custom = URL(string: "teamstation://signin/reconnect")!
    let customDelivered = expectLink(custom)
    delegate.connect?(scene, url: custom, userActivity: nil)
    wait(for: [customDelivered], timeout: 5)

    // A URL wins over an activity, as it does on a launch.
    let both = URL(string: "teamstation://signin/both")!
    let bothDelivered = expectLink(both)
    let moved = expectation(forNotification: NSNotification.Name("TSWindowSceneChanged"), object: window)
    delegate.connect?(scene, url: both, userActivity: webActivity(web))
    wait(for: [bothDelivered, moved], timeout: 5)

    XCTAssertTrue(scene.keyWindow === window)
    XCTAssertTrue(window.rootViewController === root)
    XCTAssertTrue(UIApplication.shared.delegate?.window ?? nil === window)
  }

  /// UIKit ignores the application's setters under a scene, so a screen that hides the bar would
  /// not, and a modal would read back whatever the scene already had.
  func testTheStatusBarFollowsReactNative() throws {
    try waitForReactToRender()
    let bar = try XCTUnwrap(scene.statusBarManager)
    let module = statusBarManager()
    let modal = (NSClassFromString("RCTFabricModalHostViewController") as! UIViewController.Type).init()
    addTeardownBlock { @MainActor in
      self.setStatusBarHidden(false, on: module)
      self.setStatusBarStyle("default", on: module)
    }
    let settled = { (condition: @escaping () -> Bool) in
      let met = self.expectation(for: NSPredicate { _, _ in condition() }, evaluatedWith: nil)
      self.wait(for: [met], timeout: 3)
    }

    setStatusBarHidden(true, animation: "fade", on: module)
    settled { bar.isStatusBarHidden }
    XCTAssertTrue(modal.prefersStatusBarHidden)
    XCTAssertEqual(modal.preferredStatusBarUpdateAnimation, .fade)
    setStatusBarHidden(false, on: module)
    settled { !bar.isStatusBarHidden }
    XCTAssertFalse(modal.prefersStatusBarHidden)

    setStatusBarStyle("light-content", animated: true, on: module)
    settled { bar.statusBarStyle == .lightContent }
    XCTAssertEqual(modal.preferredStatusBarStyle, .lightContent)
    setStatusBarStyle("dark-content", on: module)
    settled { bar.statusBarStyle == .darkContent }
  }

  /// `CameraGeometry.apply` finds the window through `connectedScenes`.
  func testTheCameraLockTurnsTheScene() throws {
    guard UIDevice.current.userInterfaceIdiom == .phone else {
      throw XCTSkip("An iPad's scene follows the device")
    }
    addTeardownBlock { @MainActor in self.geometry("lockPortrait") }
    let scene = scene

    geometry("lockLandscape")
    let landscape = expectation(for: NSPredicate { _, _ in
      scene.effectiveGeometry.interfaceOrientation.isLandscape
    }, evaluatedWith: nil)
    wait(for: [landscape], timeout: 10)

    geometry("lockPortrait")
    let portrait = expectation(for: NSPredicate { _, _ in
      scene.effectiveGeometry.interfaceOrientation.isPortrait
    }, evaluatedWith: nil)
    wait(for: [portrait], timeout: 10)
  }
}
