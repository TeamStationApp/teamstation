import PreviewTestHarness
import PreviewUI
import SwiftUI
import UIKit

@main
struct PreviewApp: App {
  @State private var environment: AppEnvironment

  init() {
    let launch = LaunchConfiguration.resolve()
    if !launch.unknownKeys.isEmpty {
      print("PREVIEW_UNKNOWN_LAUNCH_KEYS \(launch.unknownKeys.joined(separator: ","))")
    }
    _environment = State(initialValue: AppEnvironment(launch: launch))
  }

  var body: some Scene {
    WindowGroup {
      CameraListView(environment: environment)
        .onAppear {
          UIApplication.shared.isIdleTimerDisabled = true
        }
    }
  }
}
