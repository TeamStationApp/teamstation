import AVFoundation
import CameramanCapture
import CameramanCore
import CoreMedia
import DirectorCore
import DirectorMedia
import DirectorSources
import Foundation
import Testing
@testable import PhoneStream

extension PhoneStreamTests {
  @Suite("Shared landscape rotation", .serialized)
  @MainActor
  struct SharedRotation {
    @Test("Capture waits for a landscape preview, and stop cancels a pending start", arguments: [CGFloat(0), CGFloat(180)])
    func waitsForLandscape(angle: CGFloat) async {
      let camera = CameraSession(rotationSource: .preview)
      let layer = AVCaptureVideoPreviewLayer()
      camera.start()
      camera.showPreview(in: layer, rotationAngle: 90, mirrored: false)
      await drain(camera)
      #expect(!camera.captureSession.isRunning)
      #expect(layer.session == nil)
      camera.stop()
      camera.showPreview(in: layer, rotationAngle: angle, mirrored: false)
      await drain(camera)
      #expect(layer.session === camera.captureSession)
      #expect(!camera.captureSession.isRunning)
      camera.start()
      #expect(await waitUntil(20) { camera.captureSession.isRunning })
      // Portrait and unavailable readings cannot restart or turn the landscape session.
      for invalid in [CGFloat(90), 270, -1] {
        camera.showPreview(in: layer, rotationAngle: invalid, mirrored: true)
      }
      await drain(camera)
      #expect(camera.captureSession.isRunning)
      camera.stop()
      await drain(camera)
      #expect(!camera.captureSession.isRunning)
      camera.start()
      #expect(await waitUntil(20) { camera.captureSession.isRunning })
      camera.stop()
      camera.hidePreview(in: layer)
      await drain(camera)
      #expect(layer.session == nil)
    }

    @Test("The first landscape report releases a pending start")
    func releasesStart() async {
      let camera = CameraSession(rotationSource: .preview)
      let layer = AVCaptureVideoPreviewLayer()
      camera.start()
      camera.showPreview(in: layer, rotationAngle: 180, mirrored: false)
      #expect(await waitUntil(20) { camera.captureSession.isRunning })
      camera.showPreview(in: layer, rotationAngle: 0, mirrored: false)
      camera.start()
      await drain(camera)
      #expect(camera.captureSession.isRunning)
      camera.stop()
      camera.hidePreview(in: layer)
      await drain(camera)
    }

    #if !targetEnvironment(simulator)
    @Test("Physical capture and preview use the same angle through startup, flip and restart",
          .enabled(if: ProcessInfo.processInfo.environment["PHONESTREAM_CAMERA_TESTS"] == "1"))
    func physicalConnections() async throws {
      #expect(await AVCaptureDevice.requestAccess(for: .video))
      // Exercise the actual production factory, not a separately configured lookalike.
      let source = PhoneStreamEnvironment.live().makeSource()
      let camera = try #require(source.device as? CameraSession)
      let layer = AVCaptureVideoPreviewLayer()
      let changes = RotationChanges()
      camera.onCaptureRotationChange = { changes.record() }
      camera.configure(position: .back, settings: CameramanCore.StreamSettings(audioEnabled: false))
      camera.start()
      camera.showPreview(in: layer, rotationAngle: 90, mirrored: false)
      await drain(camera)
      #expect(!camera.captureSession.isRunning)
      #expect(layer.session == nil)
      for angle in [CGFloat(0), 180, 0] {
        camera.showPreview(in: layer, rotationAngle: angle, mirrored: false)
        await drain(camera)
        let output = try #require(camera.captureSession.outputs.first { $0 is AVCaptureVideoDataOutput })
        let connection = try #require(output.connection(with: .video))
        #expect(connection.videoRotationAngle == angle)
        #expect(layer.connection?.videoRotationAngle == angle)
        #expect(camera.captureSession.isRunning)
        camera.showPreview(in: layer, rotationAngle: 270, mirrored: true)
        await drain(camera)
        #expect(connection.videoRotationAngle == angle)
        #expect(layer.connection?.videoRotationAngle == angle)
        #expect(layer.connection?.isVideoMirrored == true)
        #expect(!connection.isVideoMirrored)
      }
      #expect(changes.count >= 2)
      // The front sensor sits half a turn from the back one: the same landscape interface needs the
      // opposite angle, on screen and in the encoded buffers, or the front picture is upside down.
      let beforeFlip = changes.count
      camera.flip()
      await drain(camera)
      #expect(changes.count == beforeFlip + 1)
      #expect(layer.connection?.videoRotationAngle == 180)
      let front = try #require(camera.captureSession.outputs.first { $0 is AVCaptureVideoDataOutput })
      #expect(front.connection(with: .video)?.videoRotationAngle == 180)
      camera.showPreview(in: layer, rotationAngle: 180, mirrored: true)
      await drain(camera)
      #expect(front.connection(with: .video)?.videoRotationAngle == 0)
      #expect(layer.connection?.videoRotationAngle == 0)
      #expect(layer.connection?.isVideoMirrored == true)
      camera.showPreview(in: layer, rotationAngle: 90, mirrored: true)
      await drain(camera)
      #expect(front.connection(with: .video)?.videoRotationAngle == 0)
      camera.flip()
      await drain(camera)
      let back = try #require(camera.captureSession.outputs.first { $0 is AVCaptureVideoDataOutput })
      #expect(back.connection(with: .video)?.videoRotationAngle == 180)
      #expect(layer.connection?.videoRotationAngle == 180)
      camera.showPreview(in: layer, rotationAngle: 0, mirrored: false)
      camera.flip()
      await drain(camera)
      camera.stop()
      await drain(camera)
      camera.start()
      await drain(camera)
      #expect(camera.captureSession.isRunning)
      #expect(front.connection(with: .video)?.videoRotationAngle == layer.connection?.videoRotationAngle)
      camera.stop()
      camera.hidePreview(in: layer)
      await drain(camera)
      // Other camera clients still use the horizon coordinator and start without a preview.
      let legacy = CameraSession()
      legacy.configure(position: .back, settings: CameramanCore.StreamSettings(audioEnabled: false))
      legacy.start()
      await drain(legacy)
      #expect(legacy.captureSession.isRunning)
      let legacyOutput = try #require(legacy.captureSession.outputs.first { $0 is AVCaptureVideoDataOutput })
      #expect([CGFloat(0), 180].contains(try #require(legacyOutput.connection(with: .video)).videoRotationAngle))
      legacy.stop()
      await drain(legacy)
    }
    #endif

    // hidePreview queues the completion behind all preceding capture work without introducing a
    // new orientation (showing a probe preview here would accidentally satisfy the startup gate).
    private func drain(_ camera: CameraSession) async {
      let probe = AVCaptureVideoPreviewLayer()
      await withCheckedContinuation { continuation in
        camera.hidePreview(in: probe) { continuation.resume() }
      }
    }

    @Test("A rotation keyframe follows the delayed picture, including a stopped stream")
    func keyframeAtPictureBoundary() {
      let recording = FakeRecording()
      let stream = FakeStream()
      let programme = PhoneProgramme(recording: recording, stream: stream, clock: FixedClock(1_000), runsMixTimers: false)
      programme.start(runsTimer: false)
      func add(_ capture: Double, _ id: UInt64) {
        programme.add(picture: PixelFrame(
          sourceID: PhoneCameraSource.id,
          pixelBuffer: CMSampleBufferGetImageBuffer(videoSample(at: 0))!,
          presentationTime: .zero, wallClock: WallClock(seconds: capture),
          captureWallClock: WallClock(seconds: capture), frameID: id
        ))
      }
      add(999, 0)
      _ = programme.tick(at: 10, wallNow: 1_000)
      programme.captureRotationChanged()
      add(1_000, 1)
      _ = programme.tick(at: 10.5, wallNow: 1_000.5)
      #expect(stream.keyframes == 0) // still the previous orientation in the delay queue
      _ = programme.tick(at: 11.1, wallNow: 1_001.1)
      #expect(stream.keyframes == 1)
      _ = programme.tick(at: 11.2, wallNow: 1_001.2)
      #expect(stream.keyframes == 1) // held/repeated pictures do not keep requesting keyframes
      stream.isRunning = false
      programme.captureRotationChanged()
      add(1_002, 2)
      _ = programme.tick(at: 13.1, wallNow: 1_003.1)
      #expect(stream.keyframes == 1)
      stream.isRunning = true
      _ = programme.tick(at: 13.2, wallNow: 1_003.2)
      #expect(stream.keyframes == 2)
      programme.stop()
    }
  }
}

private final class RotationChanges: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0
  var count: Int { lock.lock(); defer { lock.unlock() }; return value }
  func record() { lock.lock(); value += 1; lock.unlock() }
}
