import SwiftUI

/// GS Distributor: pulls GS Director's recordings off the iPad over the cable and stitches them
/// with the Director's own code. Nothing is kept on this Mac between launches; settings live on
/// the iPad.
@main
struct DistributorApp: App {
  @State private var model = DistributorModel()

  var body: some Scene {
    WindowGroup("GS Distributor") {
      RootView(model: model)
        .frame(minWidth: 760, minHeight: 460)
        .task { await model.watch() }
    }
    // No saved window state: the Mac keeps nothing of the Distributor's between launches.
    .restorationBehavior(.disabled)
  }

  @NSApplicationDelegateAdaptor(Forgetting.self) private var forgetting
}
