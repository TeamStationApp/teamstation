import CameramanCapture
import CameramanCore
import Foundation
import Testing

private final class FocusDeviceRecorder: FocusDriver.Device, @unchecked Sendable {
  var supported = true
  var isFocusLocked = false
  var calls: [String] = []
  var callbacks: [@Sendable (Bool) -> Void] = []
  var fails = false
  func cancelObservation() { calls.append("cancel") }
  func scan(at point: CGPoint, adjusting: @escaping @Sendable (Bool) -> Void) throws {
    calls.append("scan")
    if fails { throw NSError(domain: "camera", code: 1) }
    callbacks.append(adjusting)
  }
  func continuous() throws {
    calls.append("auto")
    if fails { throw NSError(domain: "camera", code: 1) }
  }
}

@Suite("Capture focus driver")
struct FocusDriverTests {
  @Test func replacingTheAdapterRestoresItsSavedAutomaticConfiguration() {
    let previous = FocusDeviceRecorder()
    let replacement = FocusDeviceRecorder()
    let driver = FocusDriver(schedule: { _, _ in }, changed: { _ in })
    driver.reset(device: previous)
    driver.reset(device: replacement)
    #expect(previous.calls == ["auto", "cancel", "auto"])
    #expect(replacement.calls == ["auto"])
  }

  @Test func scanCompletionAndSupersededCallbacks() throws {
    let device = FocusDeviceRecorder()
    var timers: [@Sendable () -> Void] = []
    let driver = FocusDriver(schedule: { _, action in timers.append(action) }, changed: { _ in })
    driver.reset(device: device)
    let first = try #require(FocusCommand(generation: driver.state.generation, token: "first", point: FocusPoint(x: 0.2, y: 0.8)))
    let second = try #require(FocusCommand(generation: driver.state.generation, token: "second", point: first.point))
    driver.apply(first, devicePoint: CGPoint(x: 0.2, y: 0.8))
    device.callbacks[0](false)
    #expect(driver.state.phase == .focusing)
    driver.apply(second, devicePoint: CGPoint(x: 0.2, y: 0.8))
    device.callbacks[0](true)
    device.callbacks[0](false)
    timers[0]()
    #expect(driver.state.phase == .focusing)
    device.callbacks[1](true)
    device.callbacks[1](false)
    #expect(driver.state.phase == .locked)
    timers[2]()
    #expect(driver.state.phase == .locked)
    driver.apply(second, devicePoint: .zero)
    #expect(device.calls == ["auto", "cancel", "scan", "cancel", "scan"])
    let auto = try #require(FocusCommand(generation: driver.state.generation, token: "auto", point: nil))
    driver.apply(auto, devicePoint: nil)
    #expect(driver.state.phase == .auto)
    #expect(device.calls.suffix(2) == ["cancel", "auto"])
    device.callbacks[1](false)
    #expect(driver.state.phase == .auto)
    driver.reset(device: device)
    driver.apply(first, devicePoint: .zero)
    #expect(driver.state.phase == .reset)
  }

  @Test func completedHardwareScanWithoutAdjustingNotificationIsStillObserved() throws {
    let device = FocusDeviceRecorder()
    var timers: [(TimeInterval, @Sendable () -> Void)] = []
    let driver = FocusDriver(schedule: { timers.append(($0, $1)) }, changed: { _ in })
    driver.reset(device: device)
    let command = try #require(FocusCommand(generation: driver.state.generation, token: "quick", point: FocusPoint(x: 0.3, y: 0.8)))
    driver.apply(command, devicePoint: .zero)
    device.callbacks[0](false)
    #expect(driver.state.phase == .focusing, "a successful write or initial false does not prove completion")
    timers[1].1()
    #expect(driver.state.phase == .focusing)
    device.isFocusLocked = true
    timers[2].1()
    #expect(driver.state.phase == .locked)
    timers[0].1()
    #expect(driver.state.phase == .locked)
    let auto = try #require(FocusCommand(generation: driver.state.generation, token: "auto", point: nil))
    driver.apply(auto, devicePoint: nil)
    timers[2].1()
    #expect(driver.state.phase == .auto, "a stale settle check cannot restore the old lock")
  }

  @Test func timeoutUnsupportedAndDeviceErrors() throws {
    let device = FocusDeviceRecorder()
    var timeout: (@Sendable () -> Void)?
    let driver = FocusDriver(schedule: { delay, action in if delay == 8 { timeout = action } }, changed: { _ in })
    driver.reset(device: device)
    func command(_ token: String, point: FocusPoint? = FocusPoint(x: 0, y: 1)) throws -> FocusCommand {
      try #require(FocusCommand(generation: driver.state.generation, token: token, point: point))
    }
    driver.apply(try command("timeout"), devicePoint: .zero)
    timeout?()
    #expect(driver.state.phase == .failed)
    driver.apply(try command("no-point"), devicePoint: nil)
    #expect(driver.state.phase == .failed)
    driver.apply(try command("invalid-point"), devicePoint: CGPoint(x: CGFloat.nan, y: 0))
    #expect(driver.state.phase == .failed)
    #expect(device.calls.filter { $0 == "scan" }.count == 1)
    device.fails = true
    driver.apply(try command("device-error"), devicePoint: .zero)
    #expect(driver.state.phase == .failed)
    driver.apply(try command("auto-error", point: nil), devicePoint: nil)
    #expect(driver.state.phase == .failed)
    device.supported = false
    driver.reset(device: device)
    driver.apply(try command("fixed-lens"), devicePoint: .zero)
    #expect(driver.state.phase == .unsupported)
    driver.reset(device: nil)
    #expect(driver.state.phase == .unsupported)
  }
}
