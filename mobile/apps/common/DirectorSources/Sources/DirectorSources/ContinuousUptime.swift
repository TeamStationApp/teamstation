import Darwin

/// Host uptime that keeps counting while the device sleeps: `mach_continuous_time` in seconds.
///
/// The one clock the sound path places anything on. The iPad's wall clock is stepped by NTP and by
/// the user; anything measured against it moves when it does, so a camera's clock is measured
/// against this instead, and a wall-clock step changes nothing about where sound is placed.
public enum ContinuousUptime {
  private static let secondsPerTick: Double = {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    return Double(info.numer) / Double(info.denom) / 1_000_000_000
  }()

  @Sendable
  public static func seconds() -> Double {
    Double(mach_continuous_time()) * secondsPerTick
  }
}
