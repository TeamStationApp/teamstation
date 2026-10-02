import CameramanControlUI
import SwiftUI

/// Cameraman's own operating screen, full screen over the grid, for the phone on a tile.
///
/// The picture is Director's decoded stream for that tile, through the same second-monitor view
/// the camera picker uses, so the grid, archive and programme underneath keep flowing. The model
/// is created by `openCameraControl` before the cover is presented and stopped when it goes.
struct CameraControlCover: View {
  @Environment(AppEnvironment.self) private var environment
  let sourceIndex: Int

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      if let model = environment.activeCameraControl, let pipeline = environment.router.pipeline(at: sourceIndex) {
        CameraView(model: model, onClose: { environment.closeCameraControl() }) {
          CameraPreviewView(renderer: pipeline.renderer)
            .aspectRatio(16 / 9, contentMode: .fit)
        }
      } else {
        Button("Close") { environment.closeCameraControl() }
          .foregroundStyle(.white)
          .accessibilityIdentifier("camera-close")
      }
    }
    .preferredColorScheme(.dark)
    .onDisappear { environment.stopCameraControl() }
  }
}
