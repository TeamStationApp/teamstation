import AVFoundation
import CameramanCapture
import CameramanCore
import Foundation
import Testing

@testable import PhoneStream

extension PhoneStreamTests {
  @Suite("The preview layer's hold on the camera")
  @MainActor
  struct PreviewLink {
    @Test("The layer is attached, turned and detached through the camera it draws")
    func throughTheCamera() async {
      let device = FakeCaptureDevice()
      let link = PhoneStreamPreviewLink(layer: AVCaptureVideoPreviewLayer())
      link.turn(rotationAngle: 0, mirrored: false)
      #expect(device.previews.isEmpty)

      link.follow(device)
      link.follow(device)
      #expect(device.previews == [ "show 0 false" ])

      link.turn(rotationAngle: 180, mirrored: false)
      link.turn(rotationAngle: 180, mirrored: false)
      link.turn(rotationAngle: 180, mirrored: true)
      #expect(device.previews == [ "show 0 false", "show 180 false", "show 180 true" ])

      link.follow(nil)
      #expect(device.previews.last == "hide")
      link.turn(rotationAngle: 0, mirrored: false)
      link.follow(nil)
      #expect(device.previews.count == 4)
    }

    @Test("A parked layer is taken from its camera and given to none until it is unparked")
    func parked() async {
      let first = FakeCaptureDevice()
      let second = FakeCaptureDevice()
      let link = PhoneStreamPreviewLink(layer: AVCaptureVideoPreviewLayer())
      link.follow(first)
      link.park()
      #expect(first.previews == [ "show 90 false", "hide" ])

      // The engine opens again while the view waits in the pool.
      link.follow(second)
      link.turn(rotationAngle: 180, mirrored: false)
      try? await Task.sleep(for: .milliseconds(100))
      #expect(second.previews.isEmpty)

      link.unpark()
      link.follow(second)
      #expect(await waitUntil(2) { second.previews == [ "show 180 false" ] })
    }

    @Test("A new camera gets the layer once the old one has let it go, at the angle last asked for")
    func handOver() async {
      let first = FakeCaptureDevice()
      let second = FakeCaptureDevice()
      let link = PhoneStreamPreviewLink(layer: AVCaptureVideoPreviewLayer())
      link.follow(first)
      link.turn(rotationAngle: 180, mirrored: false)
      link.follow(second)
      #expect(first.previews == [ "show 90 false", "show 180 false", "hide" ])
      #expect(await waitUntil(2) { second.previews == [ "show 180 false" ] })
    }

    @Test("While the old camera's queue is busy, the new camera waits for the layer")
    func busyRelease() async {
      let first = FakeCaptureDevice()
      let second = FakeCaptureDevice()
      first.holdsRelease = true
      let link = PhoneStreamPreviewLink(layer: AVCaptureVideoPreviewLayer())
      link.follow(first)
      // Close, then the camera opened again at once.
      link.follow(nil)
      link.follow(second)
      link.turn(rotationAngle: 0, mirrored: true)
      try? await Task.sleep(for: .milliseconds(100))
      #expect(second.previews.isEmpty)

      first.heldRelease?()
      #expect(await waitUntil(2) { second.previews == [ "show 0 true" ] })
      link.turn(rotationAngle: 180, mirrored: true)
      #expect(second.previews == [ "show 0 true", "show 180 true" ])
    }

    @Test("Close stops the camera before the layer is taken from it, and both go to the camera")
    func closeOrder() async throws {
      let rig = EngineRig(root: try scratchDirectory())
      let device = FakeCaptureDevice()
      let engine = try rig.engine(source: { PhoneCameraSource(input: .camera(device)) })
      let link = PhoneStreamPreviewLink(layer: AVCaptureVideoPreviewLayer())
      try engine.open(angleName: "Home Plate", audioEnabled: false, disabledLenses: [])
      link.follow(engine.previewDevice)
      #expect(device.previews == [ "show 90 false" ])

      await engine.close()
      // What the preview view does when the bridge says the engine closed.
      link.follow(engine.previewDevice)
      #expect(device.calls == [ "start", "show 90 false", "stop", "hide" ])
    }
  }
}
