import Darwin
import Foundation

/// Holds a thread to a frame schedule accurately enough to generate video with.
///
/// `Thread.sleep` is not accurate enough here, and not by a small margin. Measured in this tool on
/// macOS 26, asking for a 25 ms sleep from a plain command-line process returned after **145 ms**,
/// which paced a declared 30 fps stream at 12. A command-line tool has no run loop and no UI, so
/// the system coalesces its timers aggressively; the same code inside an app would not behave the
/// same way, which is precisely the sort of difference that gets blamed on the app under test.
///
/// `mach_wait_until` is closer but is not enough on its own either. The kernel scales its timer
/// coalescing window with the delay being asked for, so one 33 ms wait from an otherwise idle
/// thread came back after 180 ms — every time, measured. The same 33 ms asked for as a run of
/// short waits does not, so the wait here is sliced into `sliceSeconds` chunks and the last
/// `spinMargin` is spun against the clock. That is what turns a measured 87 ms average frame
/// period back into 33 ms.
///
/// The schedule is a running deadline rather than a repeated interval. Sleeping "one frame" each
/// time accumulates every overshoot and the stream ends up slower than it claims — which would put
/// a systematic error straight into every frame-rate assertion made against this farm.
struct FramePacer {
  private static let timebase: mach_timebase_info_data_t = {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    return info
  }()

  /// How long before the deadline to stop sleeping and start spinning. Two milliseconds covers the
  /// wake latency of a short wait with room to spare, and costs a bounded slice of a core.
  static let spinMargin: Double = 0.002
  /// The longest single `mach_wait_until` this will ask for. Small enough that the coalescing
  /// window stays tight, large enough that a 60 fps frame is three waits rather than thirty.
  static let sliceSeconds: Double = 0.005

  private var deadline: UInt64

  init() {
    deadline = mach_absolute_time()
  }

  static func ticks(seconds: Double) -> UInt64 {
    guard seconds > 0 else { return 0 }
    let nanoseconds = seconds * 1_000_000_000
    return UInt64(nanoseconds * Double(timebase.denom) / Double(timebase.numer))
  }

  static func seconds(ticks: UInt64) -> Double {
    Double(ticks) * Double(timebase.numer) / Double(timebase.denom) / 1_000_000_000
  }

  /// Advances the schedule by `interval` and waits for it, plus `extra` for injected jitter.
  ///
  /// Returns how long it actually waited, so the caller can report whether the generator is
  /// keeping up — a farm that has quietly fallen behind makes every measurement taken against it
  /// wrong in the same direction.
  mutating func wait(interval: Double, extra: Double = 0) -> Double {
    deadline &+= Self.ticks(seconds: interval)
    let target = deadline &+ Self.ticks(seconds: extra)
    let now = mach_absolute_time()
    guard target > now else {
      // More than a frame behind. Restart the schedule from here rather than sending a burst to
      // catch up: a burst is not what a camera that fell behind does, and the app would be tested
      // against a stream no camera produces.
      if now &- deadline > Self.ticks(seconds: interval) {
        deadline = now
      }
      return 0
    }
    let spin = Self.ticks(seconds: Self.spinMargin)
    let slice = Self.ticks(seconds: Self.sliceSeconds)
    let spinFrom = target &- spin
    var current = mach_absolute_time()
    while current < spinFrom {
      let remaining = spinFrom &- current
      mach_wait_until(current &+ min(remaining, slice))
      current = mach_absolute_time()
    }
    while mach_absolute_time() < target {}
    return Self.seconds(ticks: mach_absolute_time() &- now)
  }

  /// Drops the schedule and restarts it from now. What a camera coming back from a stall does.
  mutating func restart() {
    deadline = mach_absolute_time()
  }
}
