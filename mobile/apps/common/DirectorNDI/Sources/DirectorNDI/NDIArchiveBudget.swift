import Foundation

/// How many cameras may encode their own archive at once, and how hard each is allowed to try.
///
/// This exists because NDI changes what the scarce resource is. An RTSP camera's archive is a copy
/// of bytes that already arrived, so ten of them cost nothing; an NDI camera's archive is a
/// re-encode, and `docs/architecture.md`'s central claim — encode sessions, not CPU, are what this
/// app runs out of — starts applying per camera rather than once for the programme master.
///
/// Two mechanisms, because there are two different failures:
///
/// - **A hard cap.** Past `capacity`, a camera previews and cuts to programme but does not archive,
///   and its tile says so. That is the existing rule for recording — start if anything at all is
///   writing — applied one level down.
/// - **Decimation.** A camera inside the cap whose encoder cannot keep up halves its archive frame
///   rate instead of losing frames at random. A continuous 15 fps recording is a usable angle; the
///   same camera dropping two frames in three is not, and the difference costs the live picture
///   nothing either way because the encode is already off the receive thread.
///
/// Decimation is reversible: a camera that recovers climbs back to full rate. Nothing here is
/// permanent, because the pressure is usually another camera starting or stopping.
public final class NDIArchiveBudget: @unchecked Sendable {
  public static let shared = NDIArchiveBudget()

  /// Four 1080p archives plus the programme master is five concurrent sessions, which is what the
  /// grid holds and what the hardware has been measured against. Overridable, because the right
  /// number is a property of the device and this is the one place to change it.
  public static let defaultCapacity = 4

  private let lock = NSLock()
  private var capacity = NDIArchiveBudget.defaultCapacity
  private var holders: Set<String> = []

  private init() {}

  public func setCapacity(_ value: Int) {
    lock.lock()
    capacity = max(1, value)
    lock.unlock()
  }

  public var currentCapacity: Int {
    lock.lock()
    defer { lock.unlock() }
    return capacity
  }

  public var inUse: Int {
    lock.lock()
    defer { lock.unlock() }
    return holders.count
  }

  /// Takes a slot for `id`, or returns false if the budget is full. Idempotent: a source that
  /// already holds one keeps it.
  public func acquire(_ id: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if holders.contains(id) { return true }
    guard holders.count < capacity else { return false }
    holders.insert(id)
    return true
  }

  public func release(_ id: String) {
    lock.lock()
    holders.remove(id)
    lock.unlock()
  }
}

/// Decides how many of a camera's frames reach its archive encoder.
///
/// The rule is deliberately slow in both directions. Reacting to a single full backlog would have
/// the archive rate flapping every time the encoder hesitated, and a recording whose frame rate
/// changes twice a second is harder to reason about than one that is simply half rate throughout.
public struct ArchiveDecimator: Sendable {
  /// One frame in `stride` is archived. 1 is every frame.
  public private(set) var stride = 1
  /// Below full rate, an archive is still an archive; below this it is not worth calling one, and
  /// the camera is better served by the tile saying its archive could not be sustained.
  public static let maximumStride = 4

  private var counter = 0
  private var pressure = 0
  private var relief = 0

  /// A leaky integrator rather than a run of consecutive frames: pressure rises on every frame the
  /// encoder had no room for and falls on every frame it did, so a source dropping three frames in
  /// four reaches the threshold in about a second. Requiring consecutive saturation instead meant
  /// the count reset on every frame that happened to fit, and a camera archiving a quarter of its
  /// frames never decimated at all.
  private static let pressureThreshold = 30
  private static let reliefThreshold = 120

  public init() {}

  /// Call once per arriving frame. `backlogFull` is whether the encode queue had no room.
  /// Returns whether this frame should be encoded.
  public mutating func shouldEncode(backlogFull: Bool) -> Bool {
    if backlogFull {
      pressure += 1
      relief = 0
      if pressure >= Self.pressureThreshold, stride < Self.maximumStride {
        stride *= 2
        pressure = 0
      }
    } else {
      pressure = max(0, pressure - 1)
      // Only count relief while the encoder is genuinely keeping up. Climbing back on the strength
      // of the frames decimation itself skipped would undo the decimation that made them fit.
      if pressure == 0 {
        relief += 1
        if relief >= Self.reliefThreshold, stride > 1 {
          stride /= 2
          relief = 0
        }
      }
    }

    counter += 1
    guard counter >= stride else { return false }
    counter = 0
    return true
  }

  public mutating func reset() {
    stride = 1
    counter = 0
    pressure = 0
    relief = 0
  }
}
