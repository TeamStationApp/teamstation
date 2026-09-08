import CameramanTestHarness
import CameramanUI
import SwiftUI
import UIKit

/// Landscape only. Declared here as well as in Info.plist because SwiftUI's window can otherwise
/// come up in portrait on a phone that was launched from portrait lock, which then draws the whole
/// UI on its side. The same mask covers the external-display window, so the clean feed is never
/// rotated on its way out.
final class CameramanAppDelegate: NSObject, UIApplicationDelegate {
  func application(
    _ application: UIApplication,
    supportedInterfaceOrientationsFor window: UIWindow?
  ) -> UIInterfaceOrientationMask {
    .landscape
  }

  /// A USB-C display gets the clean-feed scene; everything else is left to SwiftUI, which supplies
  /// its own delegate for the app window when none is named here.
  func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let role = connectingSceneSession.role
    guard role == .windowExternalDisplayNonInteractive else {
      return UISceneConfiguration(name: nil, sessionRole: role)
    }
    let configuration = UISceneConfiguration(name: "Clean Feed", sessionRole: role)
    configuration.delegateClass = ExternalDisplaySceneDelegate.self
    return configuration
  }
}

@main
struct CameramanApp: App {
  @UIApplicationDelegateAdaptor(CameramanAppDelegate.self) private var appDelegate
  @State private var environment: AppEnvironment
  @Environment(\.scenePhase) private var scenePhase

  init() {
    let launch = LaunchConfiguration(
      arguments: Array(ProcessInfo.processInfo.arguments.dropFirst()),
      environment: ProcessInfo.processInfo.environment
    )
    if !launch.unknownKeys.isEmpty {
      // A silently ignored launch argument produces a green run that proved nothing.
      print("CAMERAMAN_UNKNOWN_LAUNCH_KEYS \(launch.unknownKeys.joined(separator: ","))")
    }
    _environment = State(initialValue: AppEnvironment(launch: launch))
  }

  var body: some Scene {
    WindowGroup {
      RootView(environment: environment)
        .onAppear {
          // A screen lock suspends the app, which stops the listener and kills the stream. This is
          // also what makes an unattended device run survive to the end.
          UIApplication.shared.isIdleTimerDisabled = true
        }
    }
    .onChange(of: scenePhase) { _, phase in
      // `isIdleTimerDisabled` stops the screen locking *itself*, but a side-button press, the app
      // switcher, or another app launching still backgrounds this one, and iOS cancels the listener
      // on the way out. Nothing restores it on the way back in, so the app has to ask.
      if phase == .active { environment.handleForeground() }
    }
  }
}
