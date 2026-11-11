import CameramanCore
import Foundation

/// The camera queue owns this driver and invokes every callback on that same queue.
/// Hardware remains behind a small port so scan ordering and lifecycle are testable.
public final class FocusDriver: @unchecked Sendable {
  public protocol Device: AnyObject {
    var supported: Bool { get }
    /// Observed after the one-shot request, never inferred from successfully writing the mode.
    var isFocusLocked: Bool { get }
    func cancelObservation()
    func scan(at point: CGPoint, adjusting: @escaping @Sendable (Bool) -> Void) throws
    func continuous() throws
  }

  public private(set) var state = CameraFocus()
  private var device: (any Device)?
  private var sawScan = false
  private let changed: (CameraFocus) -> Void
  private let schedule: (TimeInterval, @escaping @Sendable () -> Void) -> Void

  public init(
    schedule: @escaping (TimeInterval, @escaping @Sendable () -> Void) -> Void,
    changed: @escaping (CameraFocus) -> Void
  ) {
    self.schedule = schedule
    self.changed = changed
  }

  public func reset(device: (any Device)?) {
    self.device?.cancelObservation()
    // Restore the old adapter's saved configuration before replacing it, including when
    // the new adapter wraps the same physical camera after an interruption.
    if let previous = self.device, previous !== device, previous.supported {
      try? previous.continuous()
    }
    self.device = device
    sawScan = false
    state.reset(supported: device?.supported ?? false)
    if state.supported { try? device?.continuous() }
    changed(state)
  }

  public func apply(_ command: FocusCommand, devicePoint: CGPoint?) {
    guard command.generation == state.generation, command.token != state.request else { return }
    guard state.begin(command), let device else { changed(state); return }
    device.cancelObservation()
    sawScan = false
    do {
      if command.point != nil, let devicePoint,
         FocusPoint(x: devicePoint.x, y: devicePoint.y) != nil {
        try device.scan(at: devicePoint) { [weak self] adjusting in
          self?.adjusting(adjusting, command: command)
        }
        schedule(8) { [weak self] in self?.timeout(command) }
        schedule(0.2) { [weak self] in self?.checkCompletion(command) }
      } else if command.point == nil {
        try device.continuous()
      } else {
        state.phase = .failed
      }
    } catch {
      state.phase = .failed
    }
    changed(state)
  }

  private func adjusting(_ value: Bool, command: FocusCommand) {
    guard state.generation == command.generation, state.request == command.token,
          state.phase == .focusing else { return }
    if value { sawScan = true }
    else if sawScan, state.complete(command, success: true) { changed(state) }
  }

  private func checkCompletion(_ command: FocusCommand) {
    guard state.generation == command.generation, state.request == command.token,
          state.phase == .focusing else { return }
    if device?.isFocusLocked == true {
      if state.complete(command, success: true) { changed(state) }
    } else {
      schedule(0.2) { [weak self] in self?.checkCompletion(command) }
    }
  }

  private func timeout(_ command: FocusCommand) {
    if state.complete(command, success: false) { changed(state) }
  }
}
