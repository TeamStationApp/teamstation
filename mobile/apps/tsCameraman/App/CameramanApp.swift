import CameramanTestHarness
import CameramanUI
import SwiftUI
import TeamStationSentry
import TeamStationObservability
import UIKit

/// The camera stays landscape, including when the phone was launched from portrait lock.
/// Settings may be portrait or landscape. The clean-feed window stays landscape either way,
/// so the picture on a USB-C display is never rotated on its way out.
final class CameramanAppDelegate: NSObject, UIApplicationDelegate {
  func application(
    _ application: UIApplication,
    supportedInterfaceOrientationsFor window: UIWindow?
  ) -> UIInterfaceOrientationMask {
    if window?.windowScene?.session.role == .windowExternalDisplayNonInteractive {
      return .landscape
    }
    return InterfaceOrientation.mask
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
    AppLog.start(app: .cameraman)
    SentrySetup.start(appId: "app.teamstation.cameraman")
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
        // A sign-in link from the e-mail, on this app's own link host.
        .onOpenURL { url in environment.handleSignInLink(url) }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
          if let url = activity.webpageURL { environment.handleSignInLink(url) }
        }
    }
    .onChange(of: scenePhase) { _, phase in
      // `isIdleTimerDisabled` stops the screen locking *itself*, but a side-button press, the app
      // switcher, or another app launching still backgrounds this one, and iOS takes the
      // advertisement and the video encoder down on the way out. Nothing restores either on the way
      // back in, so the app has to ask.
      // A screen lock takes the same path: `.background` on lock, `.active` on unlock.
      environment.handleScenePhase(phase)
    }
  }
}
