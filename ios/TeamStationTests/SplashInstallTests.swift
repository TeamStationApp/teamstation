import UIKit
import XCTest

/// `SceneDelegate.connect`, which this bundle cannot import. Declaring it lets `AnyObject` call it.
@objc private protocol SplashSceneConnecting {
  func connect(_ scene: UIWindowScene, url: URL?, userActivity: NSUserActivity?)
}

/**
 * The launch splash `AppDelegate.attach` puts over React Native, from inside the running app. The
 * bundle cannot import TeamStationSplash without a second copy of it, so it reads the app
 * delegate's own count and finds the splash by its accessibility identifier.
 */
@MainActor
final class SplashInstallTests: XCTestCase {
  private var scene: UIWindowScene {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first!
  }

  private var installs: Int {
    (UIApplication.shared.delegate as? NSObject)?.value(forKey: "splashInstalls") as? Int ?? -1
  }

  private func splashes(in window: UIWindow) -> [UIView] {
    window.subviews.filter { $0.accessibilityIdentifier == "tsSplash" }
  }

  func testTheLaunchPutUpOneSplash() throws {
    XCTAssertEqual(installs, 1)
    let window = try XCTUnwrap(scene.keyWindow)
    XCTAssertLessThanOrEqual(splashes(in: window).count, 1)
  }

  func testAReconnectPutsUpNoSplash() throws {
    let scene = scene
    let delegate: AnyObject = try XCTUnwrap(scene.delegate)
    let window = try XCTUnwrap(scene.keyWindow)
    let before = splashes(in: window).count
    delegate.connect?(scene, url: nil, userActivity: nil)
    XCTAssertEqual(installs, 1)
    XCTAssertEqual(splashes(in: window).count, before)
  }

  /// The launch screen shows frame 0 rendered for the shape nearest the window's, since a frame
  /// cropped into another shape moves the stadium and the vignette. Every iPhone and iPad shape
  /// the app opens in, either way up, gets a frame within 3% of its own shape, filling the window.
  func testTheLaunchScreenShowsFrameZeroRenderedForTheWindowsShape() throws {
    let phones: [(CGFloat, CGFloat)] = [(390, 844), (402, 874), (430, 932), (440, 956), (375, 667)]
    let pads: [(CGFloat, CGFloat)] = [(834, 1210), (834, 1194), (820, 1180), (744, 1133), (1032, 1376), (1024, 1366), (810, 1080)]
    for (short, long) in phones + pads {
      for (width, height) in [(short, long), (long, short)] {
        let controller = try XCTUnwrap(UIStoryboard(name: "LaunchScreen", bundle: .main).instantiateInitialViewController())
        let view = controller.view!
        let bounds = CGRect(x: 0, y: 0, width: width, height: height)
        view.frame = bounds
        view.layoutIfNeeded()
        let base = try XCTUnwrap(view.subviews.first { $0 is UIImageView } as? UIImageView)
        let gates = view.subviews.filter { $0.clipsToBounds && !$0.isHidden && !($0 is UIImageView) }
        // The highest open gate is the one on screen; with none open, the first frame.
        let open = gates.last { $0.frame.height > 0 }
        let shown = try XCTUnwrap(open.map { $0.subviews.first as? UIImageView } ?? base)
        let name = "\(width)x\(height)"
        for gate in gates { XCTAssertTrue(gate.frame.height == 0 || gate.frame.height == height, name) }
        XCTAssertEqual(shown.superview?.convert(shown.frame, to: view), bounds, name)
        let size = try XCTUnwrap(shown.image?.size, name)
        let shapeError = abs(log((size.height / size.width) / (height / width)))
        XCTAssertLessThan(shapeError, log(1.03), "\(name) shows a \(size.width)x\(size.height) frame")
      }
    }
  }
}
