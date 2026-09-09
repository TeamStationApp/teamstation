import CNDI
import Foundation

/// One NDI source as the finder saw it.
public struct NDISource: Hashable, Sendable {
  public let name: NDISourceName
  /// `host:port` or a URL, as the SDK reports it.
  ///
  /// Passed to the receiver alongside the name rather than kept for diagnostics. The SDK does
  /// document the string as internal and changeable, and connecting by name is the ordinary route
  /// — but a receiver given only a name resolves it through a finder of its own, which has none of
  /// the extra IPs the fallback sweep supplies. A camera discovered only because of that sweep is
  /// otherwise listed and unconnectable.
  public let url: String

  public init(name: NDISourceName, url: String) {
    self.name = name
    self.url = url
  }
}

/// `NDIlib_find_*` behind something Swift can hold.
///
/// The SDK's finder is a background mDNS participant: creating one starts discovery and it keeps
/// running until destroyed, which is why the app creates a single finder at launch rather than one
/// per search. `NDIlib_find_get_current_sources` returns memory owned by the finder and valid only
/// until the next call, so every string is copied out before this returns.
///
/// The docs are explicit that `NDIlib_find_get_current_sources` must not be called concurrently on
/// one instance; the lock here is what enforces that.
public final class NDIFinder: @unchecked Sendable {
  private let lock = NSLock()
  private var instance: NDIlib_find_instance_t?
  private let extraIPs: String?

  /// - Parameter extraIPs: comma-separated addresses queried directly, for a camera on another
  ///   subnet or on a network that blocks mDNS between segments. The SDK finds and monitors these
  ///   the same way it does discovered ones.
  public init?(showLocalSources: Bool = true, extraIPs: [String] = []) {
    self.extraIPs = extraIPs.isEmpty ? nil : extraIPs.joined(separator: ",")
    guard NDIRuntime.shared.acquire() else { return nil }

    let created: NDIlib_find_instance_t? = withOptionalCString(self.extraIPs) { ips in
      var settings = NDIlib_find_create_t()
      settings.show_local_sources = showLocalSources
      settings.p_groups = nil
      settings.p_extra_ips = ips
      return NDIlib_find_create_v2(&settings)
    }
    guard let created else {
      NDIRuntime.shared.release()
      return nil
    }
    instance = created
  }

  deinit {
    if let instance { NDIlib_find_destroy(instance) }
    NDIRuntime.shared.release()
  }

  /// How long the SDK is asked to wait in one go.
  ///
  /// The wait has to happen under the same lock as `currentSources`, so its length is also the
  /// longest anything else can be kept waiting for the finder. A five second wait therefore froze
  /// the app for five seconds: opening the camera list calls `searchNow` on the main thread, which
  /// needs `currentSources`, which queued behind the discovery thread's wait. It only showed when
  /// a camera stopped being discoverable — while sources are appearing and disappearing the wait
  /// returns early, and it is a source that never changes that leaves the lock held for the full
  /// timeout, every time round.
  private static let waitSliceMilliseconds: UInt32 = 200

  /// Blocks until the set of sources changes or the timeout expires. Returns true if it changed.
  ///
  /// Waiting is what keeps the discovery thread off the CPU between sightings; polling
  /// `currentSources` in a loop would burn a core for the whole of a game. The wait is taken in
  /// slices so the lock is released between them, which bounds how long the main thread can be
  /// held up without giving up the serialisation the SDK requires.
  public func waitForChange(timeoutMilliseconds: UInt32) -> Bool {
    var remaining = timeoutMilliseconds
    repeat {
      let slice = min(remaining, Self.waitSliceMilliseconds)
      lock.lock()
      guard let instance else {
        lock.unlock()
        return false
      }
      let changed = NDIlib_find_wait_for_sources(instance, slice)
      lock.unlock()
      if changed { return true }
      remaining -= slice
    } while remaining > 0
    return false
  }

  /// The sources visible right now, copied out of the SDK's own storage.
  public var currentSources: [NDISource] {
    lock.lock()
    defer { lock.unlock() }
    guard let instance else { return [] }

    var count: UInt32 = 0
    guard let list = NDIlib_find_get_current_sources(instance, &count), count > 0 else { return [] }

    var sources: [NDISource] = []
    sources.reserveCapacity(Int(count))
    for index in 0 ..< Int(count) {
      let source = list[index]
      guard let rawName = source.p_ndi_name else { continue }
      let name = NDISourceName(full: String(cString: rawName))
      let url = source.p_url_address.map { String(cString: $0) } ?? ""
      sources.append(NDISource(name: name, url: url))
    }
    return sources
  }
}

/// `withCString` that also accepts nothing, so a `nil` SDK field does not need a second code path.
func withOptionalCString<Result>(
  _ string: String?,
  _ body: (UnsafePointer<CChar>?) -> Result
) -> Result {
  guard let string else { return body(nil) }
  return string.withCString { body($0) }
}
