import UIKit
import XCTest

/// The shape `RCTLinkingManager.getInitialURL` reads, from the app's own copy, called by name
/// because this bundle takes no pods and cannot import the app.
final class LinkLaunchOptionsTests: XCTestCase {
  private let url = URL(string: "teamstation://signin/token")!

  private func options(url: URL?, userActivity: NSUserActivity?) -> [AnyHashable: Any]? {
    let cls: AnyObject = NSClassFromString("TSLinkLaunchOptions")!
    let selector = NSSelectorFromString("optionsWithUrl:userActivity:")
    return cls.perform(selector, with: url, with: userActivity)?
      .takeUnretainedValue() as? [AnyHashable: Any]
  }

  private func webActivity() -> NSUserActivity {
    let activity = NSUserActivity(activityType: NSUserActivityTypeBrowsingWeb)
    activity.webpageURL = URL(string: "https://example.com/signin/token")
    return activity
  }

  func testAUrlIsTheUrlOption() {
    let options = options(url: url, userActivity: nil)
    XCTAssertEqual(options?.count, 1)
    XCTAssertEqual(options?[UIApplication.LaunchOptionsKey.url.rawValue] as? URL, url)
  }

  func testAWebActivityIsTheActivityDictionary() throws {
    let activity = webActivity()
    let options = try XCTUnwrap(options(url: nil, userActivity: activity))
    XCTAssertEqual(options.count, 1)
    let dictionary = try XCTUnwrap(
      options[UIApplication.LaunchOptionsKey.userActivityDictionary.rawValue] as? [String: Any]
    )
    XCTAssertEqual(
      dictionary["UIApplicationLaunchOptionsUserActivityTypeKey"] as? String,
      NSUserActivityTypeBrowsingWeb
    )
    XCTAssertTrue(dictionary["UIApplicationLaunchOptionsUserActivityKey"] as? NSUserActivity === activity)
  }

  func testNoLinkIsNoOptions() {
    XCTAssertNil(options(url: nil, userActivity: nil))
  }

  func testAUrlBeatsAnActivity() {
    let options = options(url: url, userActivity: webActivity())
    XCTAssertEqual(options?.count, 1)
    XCTAssertEqual(options?[UIApplication.LaunchOptionsKey.url.rawValue] as? URL, url)
  }
}
