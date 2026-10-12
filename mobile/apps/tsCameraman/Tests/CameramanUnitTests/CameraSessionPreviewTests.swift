import AVFoundation
import CameramanCapture
import Foundation
import Testing

/// A preview layer's session and connection are capture-session configuration: AVFoundation opens a
/// `beginConfiguration` for each change, and `startRunning` or `stopRunning` inside one opened on
/// another thread raises "may not be called between calls to beginConfiguration and
/// commitConfiguration". These run a real `AVCaptureSession` (a simulator has no camera, so it has
/// no inputs, which is enough to start and stop it) and change preview layers from the main thread
/// while it starts and stops on its own queue, as the TeamStation camera screen does on Close.
@Suite("Preview layers and the capture queue", .serialized)
@MainActor
struct CameraSessionPreviewTests {
  @Test("Preview layers attached, turned and detached while the session starts and stops")
  func previewChangesBesideStartAndStop() async {
    let camera = CameraSession()
    var layers: [AVCaptureVideoPreviewLayer] = []
    // A simulator takes seconds over each start and stop, so the rounds are few. Setting
    // `layer.session` on the main thread instead, the same rounds raise the exception.
    for round in 0 ..< 3 {
      let layer = AVCaptureVideoPreviewLayer()
      layers.append(layer)
      camera.start()
      camera.showPreview(in: layer, rotationAngle: round.isMultiple(of: 2) ? 0 : 180, mirrored: false)
      camera.showPreview(in: layer, rotationAngle: 180, mirrored: true)
      camera.stop()
      camera.hidePreview(in: layer)
    }
    await drain(camera)
    #expect(layers.allSatisfy { $0.session == nil })
    #expect(!camera.captureSession.isRunning)
  }

  @Test("A layer let go of straight after hiding is still detached on the capture queue")
  func hideKeepsTheLayer() async {
    let camera = CameraSession()
    weak var released: AVCaptureVideoPreviewLayer?
    do {
      let layer = AVCaptureVideoPreviewLayer()
      released = layer
      camera.showPreview(in: layer, rotationAngle: 0, mirrored: false)
      camera.hidePreview(in: layer)
    }
    await drain(camera)
    #expect(released == nil)
  }

  @Test("A layer moves to a new session only once the old session, still starting, has let it go")
  func handOver() async {
    let old = CameraSession()
    let new = CameraSession()
    let layer = AVCaptureVideoPreviewLayer()
    old.showPreview(in: layer, rotationAngle: 0, mirrored: false)
    old.start()
    let released = Released()
    old.hidePreview(in: layer) { released.mark() }
    #expect(await eventually { released.done })
    #expect(layer.session == nil)
    new.showPreview(in: layer, rotationAngle: 0, mirrored: false)
    #expect(await eventually { layer.session === new.captureSession })
    old.stop()
    new.hidePreview(in: layer)
    await drain(new)
    #expect(layer.session == nil)
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

/// Set from the capture queue, read on the main actor.
private final class Released: @unchecked Sendable {
  private let lock = NSLock()
  private var value = false

  var done: Bool {
    lock.lock()
    defer { lock.unlock() }
    return value
  }

  func mark() {
    lock.lock()
    value = true
    lock.unlock()
  }
}
