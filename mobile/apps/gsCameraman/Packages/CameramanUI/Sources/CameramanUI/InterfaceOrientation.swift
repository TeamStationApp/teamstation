import UIKit

/// The camera stays landscape. Settings may turn with the phone.
///
/// The encoded picture does not follow this. Capture rotation comes from the
/// two landscape holds, and a portrait reading is ignored, so opening Settings
/// upright does not turn the stream.
public enum InterfaceOrientation {
  nonisolated(unsafe) public private(set) static var settingsVisible = false

  public static var mask: UIInterfaceOrientationMask {
    settingsVisible ? [.landscape, .portrait] : .landscape
  }

  @MainActor
  public static func setSettingsVisible(_ visible: Bool) {
    guard settingsVisible != visible else { return }
    settingsVisible = visible
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    for scene in scenes where scene.session.role != .windowExternalDisplayNonInteractive {
      scene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { _ in }
      scene.windows.first?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
    }
  }
}
