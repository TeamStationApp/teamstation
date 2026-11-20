import SpeedyCore
import SwiftUI
import UIKit

/// What keeps the screen awake: `UIApplication`, or a stand-in under test.
@MainActor
protocol IdleTimerHolder: AnyObject {
  var isIdleTimerDisabled: Bool { get set }
}

extension UIApplication: IdleTimerHolder {}

@main
struct SpeedyApp: App {
  @State private var model: SpeedyModel
  @Environment(\.scenePhase) private var scenePhase

  init() {
    let uiTest = LaunchFlags.isUITest(ProcessInfo.processInfo.arguments)
    let model = SpeedyModel(
      radar: FleetRadar(),
      player: ClipPlayer(capture: uiTest ? SpeechCapture.forUITest() : nil),
      uiTest: uiTest
    )
    _model = State(initialValue: model)
    model.start()
  }

  var body: some Scene {
    WindowGroup {
      ReadoutView(model: model)
        .onOpenURL { model.handle($0) }
        .onAppear { Self.keepAwake(UIApplication.shared) }
    }
    .onChange(of: scenePhase) { _, phase in
      switch phase {
      case .active:
        Self.keepAwake(UIApplication.shared)
        model.resume()
      case .background:
        // A suspended app keeps its Bluetooth link, so the radar is let go here.
        model.pause()
      default:
        break
      }
    }
  }

  /// The readout is watched from across a field, so the screen never dims while it is up.
  static func keepAwake(_ holder: IdleTimerHolder) {
    holder.isIdleTimerDisabled = true
  }
}
