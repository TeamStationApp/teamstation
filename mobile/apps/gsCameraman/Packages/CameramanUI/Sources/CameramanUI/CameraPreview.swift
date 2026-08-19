import AVFoundation
import CameramanCapture
import SwiftUI
import UIKit

/// Hosts the `AVCaptureVideoPreviewLayer`.
///
/// The layer is attached on the main thread to a session that runs on the capture queue, which is the
/// arrangement AVFoundation is built for. `resizeAspectFill` matches what the encoder sends: the
/// stream is cropped to the same aspect, so the operator frames what the client receives.
public struct CameraPreview: UIViewRepresentable {
  private let session: AVCaptureSession

  public init(session: AVCaptureSession) {
    self.session = session
  }

  public func makeUIView(context: Context) -> PreviewView {
    let view = PreviewView()
    view.previewLayer.session = session
    view.previewLayer.videoGravity = .resizeAspectFill
    // Landscape only, so the preview orientation is pinned once rather than tracked.
    view.previewLayer.connection?.videoRotationAngle = 0
    return view
  }

  public func updateUIView(_ uiView: PreviewView, context: Context) {}

  public final class PreviewView: UIView {
    public let previewLayer = AVCaptureVideoPreviewLayer()

    override public init(frame: CGRect) {
      super.init(frame: frame)
      backgroundColor = .black
      layer.addSublayer(previewLayer)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
      fatalError("not used")
    }

    override public func layoutSubviews() {
      super.layoutSubviews()
      previewLayer.frame = bounds
    }
  }
}
