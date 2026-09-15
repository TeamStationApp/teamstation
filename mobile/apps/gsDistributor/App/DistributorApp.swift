import SwiftUI

/// GS Distributor: pulls GS Director's recordings off the iPad over the cable and stitches them
/// with the Director's own code. Nothing is kept on this Mac between launches; settings live on
/// the iPad.
@main
struct DistributorApp: App {
  @State private var model: DistributorModel
  #if DEBUG
  private let harness: DebugHarness
  #endif

  init() {
    let model = DistributorModel()
    _model = State(initialValue: model)
    #if DEBUG
    harness = DebugHarness(model: model)
    #endif
  }

  var body: some Scene {
    WindowGroup("GS Distributor") {
      RootView(model: model)
        .frame(minWidth: 760, minHeight: 460)
        .task {
          #if DEBUG
          if DebugHarness.isRequested { harness.start() }
          #endif
          await model.watch()
        }
    }
    // No saved window state: the Mac keeps nothing of the Distributor's between launches.
    .restorationBehavior(.disabled)

    Settings {
      SettingsView(model: model)
    }
    .restorationBehavior(.disabled)
  }

  @NSApplicationDelegateAdaptor(Forgetting.self) private var forgetting
}
