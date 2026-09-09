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

  /// What happened when the transport workaround was applied, for `/dump-state`.
  public private(set) var transportNote = ""

  private init() {}

  /// Where the SDK's configuration is written, and why it is written at all.
  ///
  /// Reliable UDP is NDI's default receive transport, and it is where this SDK crashes. Three
  /// 1080p60 receivers reliably take the app down with a NULL write inside
  /// `ndi::reference::recv::tcp_udp_stream::push`, on the SDK's own QUIC worker thread — measured
  /// at 27 seconds, and reproduced in `gsNdiProbe`, an app that links the SDK and does nothing but
  /// capture a frame and free it. Nothing of ours is required to reach it, so nothing of ours can
  /// fix it. Turning the transport off avoids the code path: the same three receivers then ran
  /// nineteen minutes and 28,000 frames each without incident.
  ///
  /// The documented location is `$HOME/.ndi/ndi-config.v1.json`, which on iOS is the container
  /// root and is not writable — creating it fails with "Operation not permitted" and leaves the
  /// SDK silently on its defaults, which is how this looked fixed once when it was not. The
  /// documentation also says `NDI_CONFIG_DIR` is honoured on every platform if it is set before
  /// the library is initialized, and that is the way in from inside a sandbox.
  ///
  /// The fallback is multi-TCP, then unicast UDP, then plain TCP — all still enabled. Revisit this
  /// when the SDK is next updated: it costs whatever reliable UDP was buying on a lossy network.
  static let reliableUDPDisabled = #"{ "ndi": { "rudp": { "recv": { "enable": false } } } }"#

  /// Set before the first `acquire` to keep reliable UDP on — for measuring what turning it off
  /// costs on a given rig, and for the day the SDK fixes the crash. Default is off.
  public func setReliableUDP(_ enabled: Bool) {
    lock.lock()
    reliableUDPWanted = enabled
    lock.unlock()
  }

  private var reliableUDPWanted = false

  private func configureTransport() {
    guard !reliableUDPWanted else {
      transportNote = "rudp receive ENABLED (crash risk at three cameras)"
      return
    }
    // Application Support rather than Documents: this is ours, not the operator's, and Documents is
    // what the Files app shows and what backups carry.
    let directory = (FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support"))
      .appendingPathComponent("ndi")
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try Self.reliableUDPDisabled.write(
        to: directory.appendingPathComponent("ndi-config.v1.json"),
        atomically: true,
        encoding: .utf8
      )
      setenv("NDI_CONFIG_DIR", directory.path, 1)
      transportNote = "rudp receive disabled"
    } catch {
      // Not fatal: the app still runs, on a transport that is known to crash it at three cameras.
      // Said out loud rather than swallowed, because "it crashed again" and "the workaround did
      // not apply" are otherwise the same observation.
      transportNote = "could not disable rudp: \(error.localizedDescription)"
    }
  }



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
    // Before `initialize`, which is when the SDK reads its configuration.
    configureTransport()
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
