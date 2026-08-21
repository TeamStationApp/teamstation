import CameramanTestHarness
import CameramanUI
import SwiftUI
import UIKit

/// Landscape only. Declared here as well as in Info.plist because SwiftUI's window can otherwise
/// come up in portrait on a phone that was launched from portrait lock, which then draws the whole
/// UI on its side.
final class CameramanAppDelegate: NSObject, UIApplicationDelegate {
  func application(
    _ application: UIApplication,
    supportedInterfaceOrientationsFor window: UIWindow?
  ) -> UIInterfaceOrientationMask {
    .landscape
  }
}

@main
struct CameramanApp: App {
  @UIApplicationDelegateAdaptor(CameramanAppDelegate.self) private var appDelegate
  @State private var environment: AppEnvironment

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
  }
}
