import SwiftUI

/// GS Distributor: pulls GS Director's recordings off the iPad over the cable and stitches them
/// with the Director's own code. Its settings and logins are kept on this Mac and on the iPad, so
/// what needs only the Mac works with the iPad away.
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
    // Every launch opens on what the cable has now, not on the window as it was left.
    .restorationBehavior(.disabled)

    Settings {
      SettingsView(model: model)
    }
    .restorationBehavior(.disabled)
  }
}
