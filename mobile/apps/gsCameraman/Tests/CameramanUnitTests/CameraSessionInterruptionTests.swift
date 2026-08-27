import AVFoundation
import CameramanCapture
import Foundation
import Testing

@Suite("Capture interruption names")
struct CameraSessionInterruptionTests {
  @Test("Interruption reasons have stable dump-state names")
  func namedReasons() {
    #expect(
      CameraSession.interruptionReasonName(.videoDeviceNotAvailableInBackground) == "background"
    )
    #expect(CameraSession.interruptionReasonName(.videoDeviceInUseByAnotherClient) == "videoInUse")
    #expect(CameraSession.interruptionReasonName(.audioDeviceInUseByAnotherClient) == "audioInUse")
    #expect(
      CameraSession.interruptionReasonName(.videoDeviceNotAvailableWithMultipleForegroundApps)
        == "splitView"
    )
    #expect(
      CameraSession.interruptionReasonName(.videoDeviceNotAvailableDueToSystemPressure)
        == "systemPressure"
    )
  }

  @Test("A notification without a reason still reports interrupted")
  func missingReason() {
    let notification = Notification(name: AVCaptureSession.wasInterruptedNotification)
    #expect(CameraSession.interruptionReason(from: notification) == "interrupted")
  }

  @Test("A notification with a reason box uses the named form")
  func boxedReason() {
    let notification = Notification(
      name: AVCaptureSession.wasInterruptedNotification,
      userInfo: [
        AVCaptureSessionInterruptionReasonKey:
          NSNumber(value: AVCaptureSession.InterruptionReason.videoDeviceInUseByAnotherClient.rawValue)
      ]
    )
    #expect(CameraSession.interruptionReason(from: notification) == "videoInUse")
  }
}
