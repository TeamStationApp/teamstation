import SwiftUI

/// GS Distributor: pulls GS Director's recordings off the iPad over the cable and stitches them
/// with the Director's own code. Its settings and logins are kept on this Mac and on the iPad, so
/// what needs only the Mac works with the iPad away.
@main
struct DistributorApp: App {
  @State private var model: DistributorModel
  private let api: APIServer
  #if DEBUG
  private let harness: DebugHarness
  #endif
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

  init() {
    let model = DistributorModel()
    _model = State(initialValue: model)
    let api = APIServer(model: model)
    self.api = api
    #if DEBUG
    let harness = DebugHarness(model: model)
    self.harness = harness
    #endif
    // Started at launch, not by a window, so the API answers and the cable is watched with no
    // window open.
    AppDelegate.onLaunch = {
      Task { await api.start() }
      Task {
        #if DEBUG
        if DebugHarness.isRequested { harness.start() }
        // `-noIPad` leaves the cable alone, to see and drive the Distributor as it is with no
        // iPad even while one is attached.
        if DebugHarness.ignoresCable { return }
        #endif
        await model.watch()
      }
    }
  }

  var body: some Scene {
    WindowGroup("GS Distributor") {
      RootView(model: model)
        .frame(minWidth: 760, minHeight: 460)
    }
    // Every launch opens the window on what the cable has now, whatever the last one left.
    .defaultLaunchBehavior(.presented)
    .restorationBehavior(.disabled)
    Settings {
      SettingsView(model: model)
    }
    .restorationBehavior(.disabled)
  }
}
