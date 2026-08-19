import CameramanTestHarness
import CameramanUI
import SwiftUI
import UIKit

@main
struct CameramanApp: App {
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
