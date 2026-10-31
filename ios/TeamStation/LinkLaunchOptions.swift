import UIKit

/**
 * The link a cold launch came from, where `RCTLinkingManager` looks for it.
 *
 * `Linking.getInitialURL` reads the launch options, but under the scene
 * lifecycle iOS leaves a link out of them and puts it in the scene's
 * connection options. Without this a sign-in link tapped while the app is
 * closed opens the home screen, and does it silently.
 */
@objc(TSLinkLaunchOptions)
final class LinkLaunchOptions: NSObject {
  @objc static func options(
    url: URL?,
    userActivity: NSUserActivity?
  ) -> [UIApplication.LaunchOptionsKey: Any]? {
    if let url { return [.url: url] }
    guard let userActivity else { return nil }
    return [
      .userActivityDictionary: [
        UIApplication.LaunchOptionsKey.userActivityType.rawValue: userActivity.activityType,
        // The name `RCTLinkingManager` reads; UIKit exports no constant for it.
        "UIApplicationLaunchOptionsUserActivityKey": userActivity,
      ],
    ]
  }
}
