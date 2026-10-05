import Darwin
import Foundation

/// The wall clock as the live path reads it: the device's wall clock at launch, carried forward on
/// host uptime (`mach_continuous_time`), so it never steps.
///
/// The iPad's own wall clock is stepped by NTP, by a hundred milliseconds at a time on the bench.
/// Every live-path decision compares two instants — when a picture was captured against the
/// programme tick, the mix's chunk against the last one, a stream stamp against the stream's start —
/// and a step between the two reads broke the stream's sound into a new epoch, with an 80 ms gap in
/// its stamps and 20 ms of silence, and stretched one picture by the step. On this clock the same
/// comparisons see only elapsed time. It is anchored once, when the process first reads it, so a label it
/// gives (a file name, a take's start) is off real time only by what NTP has corrected since launch.
public final class SteadyWall: Sendable {
  /// The process's one steady wall clock, anchored at first use.
  public static let shared = SteadyWall()

  private let uptime: @Sendable () -> Double
  /// Wall clock less uptime at the anchor: what turns an uptime into a wall time.
  public let offsetSeconds: Double

  /// `wall` is the device's wall clock in seconds since 1970 and `uptime` host uptime in seconds;
  /// tests pass clocks they can step.
  public init(
    wall: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 },
    uptime: @escaping @Sendable () -> Double = SteadyWall.hostUptime
  ) {
    self.uptime = uptime
    offsetSeconds = wall() - uptime()
  }

  /// Seconds since 1970 on the steady wall clock.
  public func seconds() -> Double {
    uptime() + offsetSeconds
  }

  /// `mach_continuous_time` in seconds: host uptime that keeps counting while the device sleeps.
  @Sendable
  public static func hostUptime() -> Double {
    Double(mach_continuous_time()) * secondsPerTick
  }

  private static let secondsPerTick: Double = {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    return Double(info.numer) / Double(info.denom) / 1_000_000_000
  }()
}
