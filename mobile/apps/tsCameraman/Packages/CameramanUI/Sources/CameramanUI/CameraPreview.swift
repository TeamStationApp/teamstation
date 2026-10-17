import AVFoundation
import CameramanCapture
import SwiftUI
import UIKit

/// Hosts the `AVCaptureVideoPreviewLayer`.
///
/// The layer is attached, turned and detached through `CameraSession.showPreview` and `hidePreview`,
/// so every change to it is made on the capture queue, in order with `start` and `stop`. A layer's
/// session and its connection's angle are the capture session's configuration: set on the main
/// thread while the queue starts or stops the session, `startRunning` or `stopRunning` lands inside
/// that configuration and raises an exception. `resizeAspect` shows the whole encoded frame: a 16:9
/// stream on a wider phone is letterboxed against the black view, so the operator frames exactly
/// what the client receives and the bars either side are where the chrome sits.
public struct CameraPreview: UIViewRepresentable {
  private let camera: CameraSession
  /// Same 0°/180° the encoder is using. Driving preview from UI orientation independently is what
  /// left the front camera inverted: capture had followed the coordinator to 0° while preview
  /// stayed at 180°.
  private let captureRotation: Double

  public init(camera: CameraSession, captureRotation: Double = 180) {
    self.camera = camera
    self.captureRotation = captureRotation
  }

  public func makeUIView(context: Context) -> PreviewView {
    let view = PreviewView()
    view.previewLayer.videoGravity = .resizeAspect
    view.show(camera, captureRotation: captureRotation)
    return view
  }

  public func updateUIView(_ uiView: PreviewView, context: Context) {
    uiView.show(camera, captureRotation: captureRotation)
  }

  public static func dismantleUIView(_ uiView: PreviewView, coordinator: ()) {
    uiView.hide()
  }

  public final class PreviewView: UIView {
    public let previewLayer = AVCaptureVideoPreviewLayer()
    /// The camera the layer is to draw.
    private var camera: CameraSession?
    /// Whether `camera` has been asked to draw the layer.
    private var shown = false
    /// Whether the camera before still has the layer.
    private var releasing = false
    private var rotationAngle: CGFloat = 180

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

    /// Draws `camera` here at the encoder's angle. Only a change goes to the camera, which applies
    /// the angle on its queue and again whenever the connection is rebuilt: when the session starts
    /// and after a flip. The front preview is not mirrored: this is a camera pointed at a scene, and
    /// the operator sees the same picture Producer gets.
    public func show(_ camera: CameraSession, captureRotation: Double) {
      let angle: CGFloat = captureRotation == 180 ? 180 : 0
      if let current = self.camera, current === camera {
        guard angle != rotationAngle else { return }
        rotationAngle = angle
        if shown { camera.showPreview(in: previewLayer, rotationAngle: angle, mirrored: false) }
        return
      }
      release()
      self.camera = camera
      rotationAngle = angle
      showIfReady()
    }

    /// Stops drawing the camera. The camera detaches the layer on its queue.
    public func hide() {
      release()
      camera = nil
    }

    /// The layer goes to another camera only once the camera before has let it go: setting a layer's
    /// session detaches it from the one it had on the calling thread.
    private func release() {
      guard shown, let camera else { return }
      shown = false
      releasing = true
      camera.hidePreview(in: previewLayer) { [weak self] in
        Task { @MainActor in self?.released() }
      }
    }

    private func released() {
      releasing = false
      showIfReady()
    }

    private func showIfReady() {
      guard !releasing, !shown, let camera else { return }
      shown = true
      camera.showPreview(in: previewLayer, rotationAngle: rotationAngle, mirrored: false)
    }
  }
}
