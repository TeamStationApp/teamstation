import UIKit
import React

/**
 * The app's one scene, which iOS 27 requires of an app built with its SDK:
 * UIKit stops such an app at launch unless it has adopted the scene lifecycle.
 *
 * It also makes this the only place a link arrives. With a scene manifest iOS
 * no longer calls the app delegate's URL methods.
 */
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let scene = scene as? UIWindowScene else { return }
    connect(
      scene,
      url: connectionOptions.urlContexts.first?.url,
      userActivity: connectionOptions.userActivities.first
    )
  }

  /**
   * Puts the app in `scene`, with the link it was opened on, if any.
   *
   * On a launch the link goes to `Linking.getInitialURL` through the launch
   * options. iOS can also disconnect the scene and connect a new one while the
   * process lives on, as it does behind background audio, and a link on that
   * connection is delivered like any other. One that arrives before JS has
   * mounted its `url` listener is lost, as any link at that moment always was.
   *
   * A connection is taken to carry one link: the app declares no other kind of
   * activity, and a URL wins if both ever came, on a launch and here alike.
   *
   * Separate from `scene(_:willConnectTo:options:)` because connection options
   * cannot be constructed, and `SceneLifecycleTests` has to reach this.
   */
  @objc func connect(_ scene: UIWindowScene, url: URL?, userActivity: NSUserActivity?) {
    guard let app = UIApplication.shared.delegate as? AppDelegate else { return }
    let launched = app.attach(
      to: scene,
      launchOptions: LinkLaunchOptions.options(url: url, userActivity: userActivity)
    )
    window = app.window
    if launched { return }
    if let url {
      open(url)
    } else if let userActivity {
      self.scene(scene, continue: userActivity)
    }
  }

  /**
   * A link handed to the app while it is running.
   *
   * Without this the address is dropped on the floor: nothing reaches the
   * `url` listener, so an invitation or a sign-in link tapped while the app is
   * open does nothing at all, and does it silently. The template does not
   * include this and the failure is invisible until somebody follows a link.
   */
  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    for context in URLContexts { open(context.url) }
  }

  /**
   * And a link followed from outside the app — a mail client, a message.
   *
   * These arrive as a user activity rather than as an `openURL`, which is how
   * an ordinary `https://app.teamstation.app/...` address reaches an installed app
   * rather than the browser. It needs `apple-app-site-association` served from
   * the site before iOS will route one here, but the app's half is this.
   */
  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    RCTLinkingManager.application(
      UIApplication.shared,
      continue: userActivity,
      restorationHandler: { _ in }
    )
  }

  private func open(_ url: URL) {
    RCTLinkingManager.application(UIApplication.shared, open: url, options: [:])
  }
}
