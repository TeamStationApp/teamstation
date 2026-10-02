import AVFoundation
import CameramanCapture
import CameramanCore
import SwiftUI
import UIKit

/// Hosts the `AVCaptureVideoPreviewLayer`.
///
/// The layer is attached on the main thread to a session that runs on the capture queue, which is the
/// arrangement AVFoundation is built for. `resizeAspect` shows the whole encoded frame: a 16:9
/// stream on a wider phone is letterboxed against the black view, so the operator frames exactly
/// what the client receives and the bars either side are where the chrome sits.
public struct CameraPreview: UIViewRepresentable {
  private let session: AVCaptureSession
  /// Included so a camera flip (same session, different input) still refreshes rotation.
  private let position: CameraPosition
  /// Same 0°/180° the encoder is using. Driving preview from UI orientation independently is what
  /// left the front camera inverted: capture had followed the coordinator to 0° while preview
  /// stayed at 180°.
  private let captureRotation: Double

  public init(
    session: AVCaptureSession,
    position: CameraPosition = .back,
    captureRotation: Double = 180
  ) {
    self.session = session
    self.position = position
    self.captureRotation = captureRotation
  }

  public func makeUIView(context: Context) -> PreviewView {
    let view = PreviewView()
    view.position = position
    view.captureRotation = captureRotation
    view.previewLayer.session = session
    view.previewLayer.videoGravity = .resizeAspect
    view.syncRotation()
    return view
  }

  public func updateUIView(_ uiView: PreviewView, context: Context) {
    if uiView.previewLayer.session !== session {
      uiView.previewLayer.session = session
    }
    uiView.position = position
    uiView.captureRotation = captureRotation
    uiView.syncRotation()
  }

  public final class PreviewView: UIView {
    public let previewLayer = AVCaptureVideoPreviewLayer()
    var position: CameraPosition = .back
    var captureRotation: Double = 180
    nonisolated(unsafe) private var orientationObserver: (any NSObjectProtocol)?
    nonisolated(unsafe) private var runningObserver: (any NSObjectProtocol)?
    private var rotationAttempts = 0

    override public init(frame: CGRect) {
      super.init(frame: frame)
      backgroundColor = .black
      layer.addSublayer(previewLayer)
      UIDevice.current.beginGeneratingDeviceOrientationNotifications()
      orientationObserver = NotificationCenter.default.addObserver(
        forName: UIDevice.orientationDidChangeNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.syncRotation()
      }
      runningObserver = NotificationCenter.default.addObserver(
        forName: .AVCaptureSessionDidStartRunning,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.syncRotation()
      }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
      fatalError("not used")
    }

    deinit {
      if let orientationObserver {
        NotificationCenter.default.removeObserver(orientationObserver)
      }
      if let runningObserver {
        NotificationCenter.default.removeObserver(runningObserver)
      }
    }

    override public func layoutSubviews() {
      super.layoutSubviews()
      previewLayer.frame = bounds
      applyRotation()
      scheduleRotationRetriesIfNeeded()
    }

    /// The connection does not exist until the session has an input and is running, so rotation is
    /// applied from layout and from session-start rather than once in `makeUIView`. Pinning it to 0
    /// there is what put the picture on its side: the connection was still nil, the default 90°
    /// stuck, and landscape UI showed a portrait buffer.
    func syncRotation() {
      applyRotation()
      scheduleRotationRetriesIfNeeded()
    }

    private func scheduleRotationRetriesIfNeeded() {
      guard rotationAttempts == 0 else { return }
      rotationAttempts = 1
      for step in 1...20 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1 * Double(step)) { [weak self] in
          self?.applyRotation()
        }
      }
    }

    private func applyRotation() {
      guard let connection = previewLayer.connection else { return }
      // Front preview is not mirrored: this is a camera pointed at a scene, and the operator
      // should see the same picture Producer gets.
      if connection.isVideoMirroringSupported {
        connection.automaticallyAdjustsVideoMirroring = false
        if connection.isVideoMirrored {
          connection.isVideoMirrored = false
        }
      }
      let preferred = CGFloat(captureRotation == 180 ? 180 : 0)
      for angle in [preferred, 0, 180] {
        if connection.isVideoRotationAngleSupported(angle) {
          if connection.videoRotationAngle != angle {
            connection.videoRotationAngle = angle
          }
          return
        }
      }
    }
  }
}
