import UIKit

/// The external-display scene. UIKit instantiates this by name when a display is attached, so it
/// cannot be handed the environment; it finds the one clean-feed controller the app registered and
/// hands the scene over. Everything else — whether to put a window on it, which mode to run it in,
/// what to draw — is the controller's decision, because those change while the display stays
/// connected.
public final class ExternalDisplaySceneDelegate: UIResponder, UIWindowSceneDelegate {
  public func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }
    CleanFeedController.active?.displayConnected(windowScene)
  }

  public func sceneDidDisconnect(_ scene: UIScene) {
    guard let windowScene = scene as? UIWindowScene else { return }
    CleanFeedController.active?.displayDisconnected(windowScene)
  }
}
