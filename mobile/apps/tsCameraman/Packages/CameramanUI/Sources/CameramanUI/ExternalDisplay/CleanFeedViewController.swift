import UIKit

/// Hosts the clean feed full-bleed on an external display. No status bar, no home indicator, and
/// landscape only, matching the app's own orientation so the picture is never rotated on its way
/// out.
public final class CleanFeedViewController: UIViewController {
  public let layerView = CleanFeedLayerView()

  override public func loadView() {
    view = layerView
  }

  override public var prefersStatusBarHidden: Bool { true }
  override public var prefersHomeIndicatorAutoHidden: Bool { true }
  override public var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }
}
