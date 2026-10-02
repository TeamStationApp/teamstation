import SwiftUI
import UIKit

public struct DirectorRootView: View {
  @State private var environment: AppEnvironment

  public init(environment: AppEnvironment) {
    _environment = State(initialValue: environment)
  }

  public var body: some View {
    @Bindable var environment = environment
    DirectorGridView()
      .environment(environment)
      .preferredColorScheme(.dark)
      .fullScreenCover(item: $environment.activeSheet) { sheet in
        Group {
          switch sheet {
          case .settings: SettingsView()
          case .perfHarness: PerfHarnessView()
          case .cameras: SourceSelectionView()
          case .recordings: RecordingsView()
          case let .cameraControl(sourceIndex): CameraControlCover(sourceIndex: sourceIndex)
          case let .digitalZoom(sourceIndex): DigitalZoomCover(sourceIndex: sourceIndex)
          }
        }
        .environment(environment)
        .overlay(alignment: .bottom) {
          StatusToast()
            .environment(environment)
        }
      }
      .task { await environment.bootstrap() }
      .onOpenURL { url in
        _ = environment.handle(url: url)
      }
      .background {
        ProgramPictureInPictureAnchor(environment: environment)
          .frame(width: 1, height: 1)
          .allowsHitTesting(false)
          .accessibilityHidden(true)
      }
  }
}

/// Invisible window hook for the off-screen programme sample-buffer layer that Picture-in-Picture
/// reads. SwiftUI can dismantle the Output tile when the scene backgrounds; this view stays in
/// the window so the PiP source is not torn down with it.
struct ProgramPictureInPictureAnchor: UIViewRepresentable {
  let environment: AppEnvironment

  func makeUIView(context: Context) -> ProgramPictureInPictureHostView {
    let view = ProgramPictureInPictureHostView()
    view.backgroundColor = .clear
    view.isUserInteractionEnabled = false
    view.isAccessibilityElement = false
    environment.attachProgramPictureInPicture(host: view)
    return view
  }

  func updateUIView(_ uiView: ProgramPictureInPictureHostView, context: Context) {
    environment.attachProgramPictureInPicture(host: uiView)
  }
}

final class ProgramPictureInPictureHostView: UIView {}
