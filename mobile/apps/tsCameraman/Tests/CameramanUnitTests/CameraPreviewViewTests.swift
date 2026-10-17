import AVFoundation
import CameramanCapture
import CameramanUI
import Foundation
import Testing

/// Cameraman's own preview attaches, turns and detaches its layer through the camera, on the capture
/// queue. These run a real `AVCaptureSession` (a simulator has no camera, so it has no inputs, which
/// is enough to start and stop it) and drive the preview view from the main thread while the session
/// starts and stops on its own queue. A view that set its layer's session on the main thread raises
/// "may not be called between calls to beginConfiguration and commitConfiguration" here.
@Suite("Cameraman's preview and the capture queue", .serialized)
@MainActor
struct CameraPreviewViewTests {
  @Test("The preview is shown, turned and hidden while the session starts and stops")
  func previewBesideStartAndStop() async {
    let camera = CameraSession()
    var views: [CameraPreview.PreviewView] = []
    for round in 0 ..< 3 {
      let view = CameraPreview.PreviewView()
      views.append(view)
      camera.start()
      view.show(camera, captureRotation: round.isMultiple(of: 2) ? 0 : 180)
      view.show(camera, captureRotation: 180)
      camera.stop()
      view.hide()
    }
    await drain(camera)
    #expect(views.allSatisfy { $0.previewLayer.session == nil })
    #expect(!camera.captureSession.isRunning)
  }

  @Test("Shown, the layer draws the camera's session, and hidden it draws none")
  func showAndHide() async {
    let camera = CameraSession()
    let view = CameraPreview.PreviewView()
    view.show(camera, captureRotation: 180)
    #expect(await eventually { view.previewLayer.session === camera.captureSession })
    view.hide()
    await drain(camera)
    #expect(view.previewLayer.session == nil)
  }

  @Test("The layer moves to another camera only once the first, still starting, has let it go")
  func handOver() async {
    let old = CameraSession()
    let new = CameraSession()
    let view = CameraPreview.PreviewView()
    view.show(old, captureRotation: 180)
    old.start()
    view.show(new, captureRotation: 0)
    #expect(await eventually { view.previewLayer.session === new.captureSession })
    old.stop()
    view.hide()
    await drain(new)
    #expect(view.previewLayer.session == nil)
  }

  /// Waits until the capture queue has done everything asked of it so far: it runs in order, so a
  /// probe layer shown and then hidden behind that work comes back detached only after all of it.
  private func drain(_ camera: CameraSession) async {
    let probe = AVCaptureVideoPreviewLayer()
    camera.showPreview(in: probe, rotationAngle: 0, mirrored: false)
    #expect(await eventually { probe.session === camera.captureSession })
    camera.hidePreview(in: probe)
    #expect(await eventually { probe.session == nil })
  }

  /// Polls the main actor until `condition` holds, for up to two minutes: a simulator takes seconds to
  /// start or stop a session.
  private func eventually(_ condition: () -> Bool) async -> Bool {
    for _ in 0 ..< 6_000 {
      if condition() { return true }
      try? await Task.sleep(for: .milliseconds(20))
    }
    return condition()
  }
}
