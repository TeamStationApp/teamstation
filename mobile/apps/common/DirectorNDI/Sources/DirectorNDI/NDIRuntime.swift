import CNDI
import Foundation

/// The one place `NDIlib_initialize` is called, and the one place it is torn down.
///
/// The SDK is a process-wide singleton with a reference count of its own making: `initialize`
/// starts background discovery and worker threads, and `destroy` stops them for *everyone*. A
/// per-source call pair would therefore have the last camera to stop killing discovery for the
/// ones still running, so the count is held here and `destroy` only ever happens when nothing at
/// all is using NDI.
///
/// It is never destroyed during a normal session. The app keeps a finder alive from launch, so
/// the count does not reach zero; the teardown path exists for tests, which create and discard
/// runtimes in one process.
public final class NDIRuntime: @unchecked Sendable {
  public static let shared = NDIRuntime()

  /// Why NDI is unavailable, if it is. Non-nil is a state the operator has to be told about —
  /// an empty camera list with no explanation reads as a network problem.
  public private(set) var unavailableReason: String?

  private let lock = NSLock()
  private var users = 0
  private var initialized = false

  private init() {}

  /// `NDI SDK APPLE ... 6.3.2.0`, or empty if the library never came up.
  public var version: String {
    guard let raw = NDIlib_version() else { return "" }
    return String(cString: raw)
  }

  /// Whether this CPU has the instructions the SDK's codecs need. Always true on the hardware
  /// this app runs on, and checked anyway because the SDK's own examples do and because a false
  /// here is otherwise a crash inside `initialize`.
  public var isSupportedCPU: Bool { NDIlib_is_supported_CPU() }

  /// Starts the library if it is not already running, and takes a reference.
  ///
  /// Returns false and sets `unavailableReason` rather than throwing: every caller's answer to a
  /// failure is the same — carry on without NDI cameras and say so — and there is nothing to
  /// recover from.
  @discardableResult
  public func acquire() -> Bool {
    lock.lock()
    defer { lock.unlock() }

    if initialized {
      users += 1
      return true
    }
    guard NDIlib_is_supported_CPU() else {
      unavailableReason = "this device's CPU is not supported by the NDI SDK"
      return false
    }
    guard NDIlib_initialize() else {
      unavailableReason = "the NDI library failed to start"
      return false
    }
    initialized = true
    unavailableReason = nil
    users = 1
    return true
  }

  /// Gives back a reference taken by `acquire`. The library is only torn down when the last one
  /// goes, and a release without a matching acquire is ignored rather than driving the count
  /// negative.
  public func release() {
    lock.lock()
    defer { lock.unlock() }
    guard users > 0 else { return }
    users -= 1
    guard users == 0, initialized else { return }
    NDIlib_destroy()
    initialized = false
  }

  /// For the HUD and `/dump-state`, where "NDI is off" and "NDI found nothing" have to look
  /// different.
  public var isRunning: Bool {
    lock.lock()
    defer { lock.unlock() }
    return initialized
  }
}
