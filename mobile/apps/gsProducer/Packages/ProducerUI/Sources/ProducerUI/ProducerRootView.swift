import SwiftUI

public struct ProducerRootView: View {
  @State private var environment: AppEnvironment

  public init(environment: AppEnvironment) {
    _environment = State(initialValue: environment)
  }

  public var body: some View {
    @Bindable var environment = environment
    ProductionGridView()
      .environment(environment)
      .preferredColorScheme(.dark)
      .statusBarHidden()
      .persistentSystemOverlays(.hidden)
      .sheet(item: $environment.activeSheet) { sheet in
        Group {
          switch sheet {
          case .settings: SettingsView()
          case .perfHarness: PerfHarnessView()
          case .cameras: SourceSelectionView()
          case .recordings: RecordingsView()
          }
        }
        .environment(environment)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationSizing(.page)
        .overlay(alignment: .bottom) {
          StatusToast()
            .environment(environment)
        }
      }
      .sheet(isPresented: $environment.isSharingRecordings) {
        ShareSheet(urls: environment.lastRecordingShare)
      }
      .task { await environment.bootstrap() }
      .onOpenURL { url in
        _ = environment.handle(url: url)
      }
  }
}
