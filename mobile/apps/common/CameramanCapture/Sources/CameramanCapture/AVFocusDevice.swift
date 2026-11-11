import AVFoundation
import Foundation

/// AVFoundation's one-shot autofocus returns to a held lens position when adjustment ends.
final class AVFocusDevice: FocusDriver.Device, @unchecked Sendable {
  private let device: AVCaptureDevice
  private let queue: DispatchQueue
  private var observation: NSKeyValueObservation?
  private var subjectAreaMonitoringBeforeScan: Bool?

  init(_ device: AVCaptureDevice, queue: DispatchQueue) {
    self.device = device
    self.queue = queue
  }

  var supported: Bool {
    device.isFocusPointOfInterestSupported && device.isFocusModeSupported(.autoFocus)
      && device.isFocusModeSupported(.continuousAutoFocus)
  }

  var isFocusLocked: Bool { device.focusMode == .locked && !device.isAdjustingFocus }

  func cancelObservation() { observation = nil }

  func scan(at point: CGPoint, adjusting: @escaping @Sendable (Bool) -> Void) throws {
    try device.lockForConfiguration()
    defer { device.unlockForConfiguration() }
    if device.isFocusModeSupported(.locked) { device.focusMode = .locked }
    observation = device.observe(\.isAdjustingFocus, options: [.new]) { [queue] _, change in
      let value = change.newValue ?? false
      queue.async { adjusting(value) }
    }
    device.focusPointOfInterest = point
    device.focusMode = .autoFocus
    if subjectAreaMonitoringBeforeScan == nil {
      subjectAreaMonitoringBeforeScan = device.isSubjectAreaChangeMonitoringEnabled
    }
    device.isSubjectAreaChangeMonitoringEnabled = false
    if device.isVirtualDevice, device.primaryConstituentDeviceSwitchingBehavior != .unsupported {
      device.setPrimaryConstituentDeviceSwitchingBehavior(.locked, restrictedSwitchingBehaviorConditions: [])
    }
  }

  func continuous() throws {
    try device.lockForConfiguration()
    defer { device.unlockForConfiguration() }
    if device.isFocusPointOfInterestSupported {
      device.focusPointOfInterest = CGPoint(x: 0.5, y: 0.5)
    }
    if let previous = subjectAreaMonitoringBeforeScan {
      device.isSubjectAreaChangeMonitoringEnabled = previous
      subjectAreaMonitoringBeforeScan = nil
    }
    device.focusMode = .continuousAutoFocus
  }
}
