import CameramanControlUI
import CameramanRemote
import DirectorRTSP
import SwiftUI

/// Cameraman's own operating screen for a phone in the list, full screen, with Preview's decoded
/// stream as the picture. The model is created when the cover appears and stopped when it goes;
/// nothing is retained across opens.
struct CameraControlCover: View {
  let camera: PreviewCamera
  let animatesChrome: Bool
  let onClose: () -> Void

  @State private var model: RemoteCameraControl?

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      if let model {
        CameraView(model: model, onClose: onClose) {
          PreviewVideoView(renderer: camera.renderer)
            .aspectRatio(16 / 9, contentMode: .fit)
        }
      }
    }
    .preferredColorScheme(.dark)
    .onAppear {
      guard model == nil else { return }
      let session = RTSPParameterSession(
        host: camera.endpoint.host,
        port: camera.endpoint.port,
        path: camera.endpoint.path,
        userAgent: PreviewStreamUserAgent.value
      )
      let created = RemoteCameraControl(transport: session, animatesChrome: animatesChrome)
      created.start()
      model = created
    }
    .onDisappear {
      model?.stop()
      model = nil
    }
  }
}

private enum PreviewStreamUserAgent {
  static let value = "TS Preview/1.0"
}
