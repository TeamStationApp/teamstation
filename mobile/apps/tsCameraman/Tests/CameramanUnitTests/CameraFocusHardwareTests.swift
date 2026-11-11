import AVFoundation
import CameramanCapture
import CameramanCore
import Foundation
import Testing

/// Opt in on a claimed physical phone with TEST_RUNNER_CAMERAMAN_FOCUS_HARDWARE=1.
/// These assertions compare remote coordinates with AVFoundation itself, then remove
/// the local preview to exercise the headless remote-control path.
@Suite("Physical focus geometry", .serialized,
       .enabled(if: ProcessInfo.processInfo.environment["CAMERAMAN_FOCUS_HARDWARE"] == "1"))
@MainActor
struct CameraFocusHardwareTests {
  @Test func remotePointsMatchPreviewConversionWithoutDependingOnThePreview() async throws {
    let camera = CameraSession()
    let probe = FocusStateProbe()
    camera.onStateChange = { probe.state = $0 }
    camera.configure(position: .back, settings: .default)
    camera.start()
    defer { camera.stop() }
    try await wait { probe.state.isRunning && probe.state.focus.supported }
    let input = try #require(camera.captureSession.inputs.compactMap { $0 as? AVCaptureDeviceInput }
      .first { $0.device.hasMediaType(.video) })
    let device = input.device
    let previousMonitoring = device.isSubjectAreaChangeMonitoringEnabled
    try device.lockForConfiguration()
    device.isSubjectAreaChangeMonitoringEnabled = true
    device.unlockForConfiguration()
    defer {
      if (try? device.lockForConfiguration()) != nil {
        device.isSubjectAreaChangeMonitoringEnabled = previousMonitoring
        device.unlockForConfiguration()
      }
    }
    let layer = AVCaptureVideoPreviewLayer()
    layer.bounds = CGRect(x: 0, y: 0, width: 800, height: 600)
    layer.videoGravity = .resizeAspect

    for zoom in [1.0, 2.0] {
      camera.setDisplayedZoom(zoom)
      try await wait { abs(probe.state.displayedZoom - zoom) < 0.01 }
      for rotation: CGFloat in [0, 180] {
        camera.showPreview(in: layer, rotationAngle: rotation, mirrored: false)
        try await wait { layer.connection?.videoRotationAngle == rotation }
        let picture = layer.layerRectConverted(fromMetadataOutputRect: CGRect(x: 0, y: 0, width: 1, height: 1))
        #expect(picture.width > 0 && picture.height > 0)
        for point in [FocusPoint(x: 0.05, y: 0.1)!, FocusPoint(x: 0.9, y: 0.85)!] {
          let native = try #require(FocusGeometry.unrotated(point, rotation: Int(rotation), mirrored: false))
          let converted = layer.captureDevicePointConverted(fromLayerPoint: CGPoint(
            x: picture.minX + point.x * picture.width, y: picture.minY + point.y * picture.height
          ))
          #expect(abs(converted.x - native.x) < 0.01)
          #expect(abs(converted.y - native.y) < 0.01)
        }
      }
      camera.hidePreview(in: layer)
      try await wait { layer.session == nil }
      let point = FocusPoint(x: 0.15, y: 0.8)!
      let command = try #require(FocusCommand(generation: probe.state.focus.generation,
                                             token: UUID().uuidString, point: point))
      let expected = try #require(FocusGeometry.unrotated(point,
        rotation: Int(probe.state.captureRotationAngle), mirrored: false))
      camera.setFocus(command)
      try await wait { probe.state.focus.request == command.token }
      #expect(probe.state.focus.phase != .failed)
      #expect(abs(device.focusPointOfInterest.x - expected.x) < 0.01)
      #expect(abs(device.focusPointOfInterest.y - expected.y) < 0.01)
      let auto = try #require(FocusCommand(generation: probe.state.focus.generation,
                                         token: UUID().uuidString, point: nil))
      camera.setFocus(auto)
      try await wait { probe.state.focus.request == auto.token }
      #expect(device.focusMode == .continuousAutoFocus)
      #expect(device.focusPointOfInterest == CGPoint(x: 0.5, y: 0.5))
      #expect(device.isSubjectAreaChangeMonitoringEnabled)
    }
  }

  @Test func previewSelectionRecoveryAndSwitchingFollowTheActiveCamera() async throws {
    let camera = CameraSession()
    let probe = FocusStateProbe()
    camera.onStateChange = { probe.state = $0 }
    camera.configure(position: .back, settings: .default)
    camera.start()
    defer { camera.stop() }
    try await wait { probe.state.isRunning && probe.state.focus.supported }
    let device = try #require(camera.captureSession.inputs.compactMap { $0 as? AVCaptureDeviceInput }
      .first { $0.device.hasMediaType(.video) }?.device)
    let old = AVCaptureVideoPreviewLayer()
    old.bounds = CGRect(x: 0, y: 0, width: 800, height: 600)
    old.videoGravity = .resizeAspect
    let current = AVCaptureVideoPreviewLayer()
    current.bounds = CGRect(x: 0, y: 0, width: 600, height: 800)
    current.videoGravity = .resizeAspectFill
    camera.showPreview(in: old, rotationAngle: 0, mirrored: false)
    camera.showPreview(in: current, rotationAngle: 180, mirrored: false)
    try await wait { current.connection?.videoRotationAngle == 180 }
    let point = FocusPoint(x: 0.2, y: 0.7)!
    func check(_ layer: AVCaptureVideoPreviewLayer) async throws {
      let expected = layer.captureDevicePointConverted(fromLayerPoint: CGPoint(
        x: layer.bounds.width * point.x, y: layer.bounds.height * point.y))
      let command = try #require(FocusCommand(generation: probe.state.focus.generation,
        token: UUID().uuidString, point: point))
      camera.setPreviewFocus(command)
      try await wait { probe.state.focus.request == command.token }
      #expect(probe.state.focus.phase != .failed, "Local request failed")
      #expect(abs(device.focusPointOfInterest.x - expected.x) < 0.01, "Actual \(device.focusPointOfInterest), expected \(expected), layer \(layer.bounds)")
      #expect(abs(device.focusPointOfInterest.y - expected.y) < 0.01, "Actual \(device.focusPointOfInterest), expected \(expected), layer \(layer.bounds)")
    }
    try await check(current)
    // AVFoundation can detach the other preview when one is reattached. A stale
    // layer reference must never supply coordinates for the active surface.
    camera.showPreview(in: old, rotationAngle: 0, mirrored: false)
    try await wait { old.connection != nil && old.session === camera.captureSession }
    try await check(old)
    camera.hidePreview(in: current)
    try await wait { current.session == nil }
    try await check(old)
    let switching = device.isVirtualDevice && device.primaryConstituentDeviceSwitchingBehavior != .unsupported
    if switching { #expect(device.primaryConstituentDeviceSwitchingBehavior == .locked) }
    camera.setDisplayedZoom(2)
    try await wait { abs(probe.state.displayedZoom - 2) < 0.01 }
    camera.resetControls()
    try await wait { probe.state.focus.phase == .reset && abs(probe.state.displayedZoom - 1) < 0.01 }
    #expect(device.focusMode == .continuousAutoFocus)
    #expect(device.focusPointOfInterest == CGPoint(x: 0.5, y: 0.5))
    try await check(old)
    NotificationCenter.default.post(name: AVCaptureSession.runtimeErrorNotification,
      object: camera.captureSession, userInfo: [AVCaptureSessionErrorKey: NSError(domain: "camera-test", code: 1)])
    try await wait { probe.state.failure != nil && probe.state.focus.phase == .reset }
    if switching { #expect(device.primaryConstituentDeviceSwitchingBehavior != .locked) }
    camera.configure(position: .back, settings: .default)
    try await wait { probe.state.failure == nil }
    camera.stop()
    try await wait { !probe.state.isRunning }
    // A retained input reference must not bypass reattachment after the session loses its input.
    camera.captureSession.beginConfiguration()
    for input in camera.captureSession.inputs where input is AVCaptureDeviceInput {
      camera.captureSession.removeInput(input)
    }
    camera.captureSession.commitConfiguration()
    camera.configure(position: .back, settings: .default)
    camera.start()
    try await wait { probe.state.isRunning && !camera.captureSession.inputs.isEmpty }
    #expect(probe.state.failure == nil)
    camera.hidePreview(in: old)
  }

  private func wait(_ condition: () -> Bool) async throws {
    for _ in 0..<500 {
      if condition() { return }
      try await Task.sleep(for: .milliseconds(20))
    }
    try #require(condition(), "Camera did not reach the requested state")
  }
}

@MainActor
private final class FocusStateProbe {
  var state = CameraSession.State()
}
