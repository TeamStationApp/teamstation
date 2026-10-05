import Foundation

/// Wall-clock instant expressed as seconds since 1970. The DVR index, the proxy store and
/// every scrub calculation speak this type rather than `Date` so the test clock can offset
/// them all coherently.
public struct WallClock: Hashable, Sendable, Codable, Comparable, CustomStringConvertible {
  public var seconds: Double

  public init(seconds: Double) {
    self.seconds = seconds
  }

  public init(date: Date) {
    self.seconds = date.timeIntervalSince1970
  }

  public var date: Date { Date(timeIntervalSince1970: seconds) }
  public var description: String { String(format: "%.3f", seconds) }

  public static func < (lhs: WallClock, rhs: WallClock) -> Bool { lhs.seconds < rhs.seconds }

  public static func + (lhs: WallClock, rhs: TimeInterval) -> WallClock {
    WallClock(seconds: lhs.seconds + rhs)
  }

  public static func - (lhs: WallClock, rhs: TimeInterval) -> WallClock {
    WallClock(seconds: lhs.seconds - rhs)
  }

  public static func - (lhs: WallClock, rhs: WallClock) -> TimeInterval {
    lhs.seconds - rhs.seconds
  }
}

/// Injectable clock. Production uses `SystemClock`; tests and the `advance-clock` control
/// command use `TestClock` so retention roll-off and long-timeline behaviour are reachable
/// without waiting in real time.
public protocol DirectorClock: AnyObject, Sendable {
  var now: WallClock { get }
}

/// The steady wall clock (`SteadyWall`): the device's wall clock carried forward on host uptime, so
/// an NTP step of the iPad's clock moves nothing the live path times by it.
public final class SystemClock: DirectorClock, @unchecked Sendable {
  private let steady: SteadyWall

  public init(steady: SteadyWall = .shared) {
    self.steady = steady
  }

  public var now: WallClock { WallClock(seconds: steady.seconds()) }
}

/// The steady wall clock plus a mutable offset. Advancing the offset makes the app believe time has
/// passed without stalling the frame path.
public final class TestClock: DirectorClock, @unchecked Sendable {
  private let lock = NSLock()
  private var offset: TimeInterval = 0

  public init() {}

  public var now: WallClock {
    lock.lock()
    defer { lock.unlock() }
    return WallClock(seconds: SteadyWall.shared.seconds()) + offset
  }

  public var currentOffset: TimeInterval {
    lock.lock()
    defer { lock.unlock() }
    return offset
  }

  public func advance(by seconds: TimeInterval) {
    lock.lock()
    offset += seconds
    lock.unlock()
  }

  public func reset() {
    lock.lock()
    offset = 0
    lock.unlock()
  }
}
