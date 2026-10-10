import Foundation
import os

/// Lines worth keeping about work that used to hold the main thread: how long each free-space
/// measure took and on which thread, and whether each overlay manifest save was written or
/// skipped as unchanged. Info level: held in memory and never written to disk, yet recorded from
/// a device without root by Instruments' Logging template and by a launch with
/// `OS_ACTIVITY_DT_MODE=enable` and its console attached, neither of which shows debug lines.
public enum MainThreadLog {
  public static let logger = Logger(subsystem: "app.teamstation.director", category: "mainThread")

  public static var threadName: String { Thread.isMainThread ? "main" : "background" }
}

/// Free space on the archive volume, measured on a background queue and read from a cache.
///
/// `volumeAvailableCapacityForImportantUsage` costs about 12 ms a call on an iPad Pro, and the
/// telemetry snapshot used to measure it on every read: the main thread's 200 ms poll read the
/// snapshot two or three times a pass, so a Time Profiler trace with Settings open put 68% of the
/// main thread's samples in this one lookup. Free space moves slowly next to that, so the
/// snapshot and Settings read the cached figure, a timer refreshes it every 15 s, and anything
/// about to act on it (the retention sweep, which deletes recordings) takes a fresh measure off
/// the main thread with `measured()`.
public final class FreeDiskSpace: @unchecked Sendable {
  public static let shared = FreeDiskSpace(measure: DirectorPaths.measureFreeDiskBytes)

  public static let refreshInterval: TimeInterval = 15

  private let measure: @Sendable () -> Int64
  private let queue = DispatchQueue(label: "app.teamstation.director.freeDiskSpace", qos: .utility)
  private let lock = NSLock()
  private var bytes: Int64 = 0
  private var measuredOnce = false
  private var timer: DispatchSourceTimer?

  public init(measure: @escaping @Sendable () -> Int64) {
    self.measure = measure
  }

  /// The last figure measured, without touching the disk. Zero until the first measure lands.
  public var cachedBytes: Int64 {
    lock.lock()
    defer { lock.unlock() }
    return bytes
  }

  /// Whether `cachedBytes` holds a real measure yet.
  public var hasMeasured: Bool {
    lock.lock()
    defer { lock.unlock() }
    return measuredOnce
  }

  /// Measures now, on the calling thread, and caches the result. Blocks for the length of the
  /// lookup, so keep it off the main thread; `measured()` and `refresh()` do.
  @discardableResult
  public func measureNow() -> Int64 {
    let started = DispatchTime.now().uptimeNanoseconds
    let value = measure()
    let elapsed = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
    lock.lock()
    bytes = value
    measuredOnce = true
    lock.unlock()
    MainThreadLog.logger.info(
      "free space refreshed: \(value, privacy: .public) bytes in \(elapsed, format: .fixed(precision: 1), privacy: .public) ms on \(MainThreadLog.threadName, privacy: .public) thread"
    )
    return value
  }

  /// A fresh measure taken on the background queue, for a caller about to decide something on it.
  public func measured() async -> Int64 {
    await withCheckedContinuation { continuation in
      queue.async {
        continuation.resume(returning: self.measureNow())
      }
    }
  }

  /// Refreshes the cache on the background queue and returns at once.
  public func refresh() {
    queue.async { self.measureNow() }
  }

  /// Refreshes now and then every `interval` seconds on the background queue. Calling it again
  /// replaces the running timer.
  public func startRefreshing(every interval: TimeInterval = FreeDiskSpace.refreshInterval) {
    let next = DispatchSource.makeTimerSource(queue: queue)
    next.schedule(deadline: .now(), repeating: interval, leeway: .seconds(1))
    next.setEventHandler { [weak self] in self?.measureNow() }
    lock.lock()
    let previous = timer
    timer = next
    lock.unlock()
    previous?.cancel()
    next.resume()
  }

  public func stopRefreshing() {
    lock.lock()
    let previous = timer
    timer = nil
    lock.unlock()
    previous?.cancel()
  }

  /// Waits for every measure already queued to finish. Tests only need it.
  public func waitForPendingRefreshes() {
    queue.sync {}
  }
}
