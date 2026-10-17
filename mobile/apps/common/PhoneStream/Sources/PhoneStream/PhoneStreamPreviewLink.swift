import AVFoundation
import CoreGraphics

/// A preview layer's hold on the engine's camera.
///
/// The layer draws whichever camera the engine has open, and the angle and mirroring go to the
/// camera it draws. Each change is handed to the camera, which makes it on its capture queue in
/// order with its start and stop. A preview layer attached, turned or detached on the main thread
/// opens a configuration on the capture session there, and a `stopRunning` that lands inside it on
/// the capture queue raises an exception: Close crashed the app that way.
///
/// The layer is shown on a new camera only once the camera before has let it go. Setting a layer's
/// session detaches it from the session it had on the calling thread, so a layer shown on the new
/// camera's queue while the old camera's queue was still starting raised an exception too.
@MainActor
public final class PhoneStreamPreviewLink {
  public let layer: AVCaptureVideoPreviewLayer
  /// The camera the layer is to draw.
  private var device: (any PhoneCaptureDevice)?
  /// Whether `device` has been asked to draw the layer.
  private var shown = false
  /// Whether the camera before still has the layer.
  private var releasing = false
  /// Whether the layer is put away until `unpark`, and no camera may have it.
  private var parked = false
  private var rotationAngle: CGFloat
  private var mirrored: Bool

  public init(layer: AVCaptureVideoPreviewLayer, rotationAngle: CGFloat = 90, mirrored: Bool = false) {
    self.layer = layer
    self.rotationAngle = rotationAngle
    self.mirrored = mirrored
  }

  /// The camera to draw, nil for none. The same camera again changes nothing, and while the link is
  /// parked only none is taken.
  public func follow(_ next: (any PhoneCaptureDevice)?) {
    if parked, next != nil { return }
    if let device, let next, device === next { return }
    if shown, let device {
      releasing = true
      device.hidePreview(in: layer) { [weak self] in
        Task { @MainActor in self?.released() }
      }
    }
    device = next
    shown = false
    showIfReady()
  }

  /// Takes the layer from its camera and keeps it from every camera until `unpark`: a view waiting in
  /// a pool to be used again must not be drawn into when the engine next opens.
  public func park() {
    follow(nil)
    parked = true
  }

  /// Lets `follow` give the layer to a camera again, once its view is in use.
  public func unpark() {
    parked = false
  }

  /// Turns and mirrors the picture. Only a change goes to the camera.
  public func turn(rotationAngle: CGFloat, mirrored: Bool) {
    guard rotationAngle != self.rotationAngle || mirrored != self.mirrored else { return }
    self.rotationAngle = rotationAngle
    self.mirrored = mirrored
    if shown { device?.showPreview(in: layer, rotationAngle: rotationAngle, mirrored: mirrored) }
  }

  private func released() {
    releasing = false
    showIfReady()
  }

  private func showIfReady() {
    guard !releasing, !shown, let device else { return }
    shown = true
    device.showPreview(in: layer, rotationAngle: rotationAngle, mirrored: mirrored)
  }
}
